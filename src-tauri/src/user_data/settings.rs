use std::path::PathBuf;

use super::SETTINGS_WRITE_LOCK;
use super::paths::{resolve_user_data_dir, user_settings_path};
use crate::atomic_write_impl;

/// Default `user-settings.json` shape. Distinct from the per-window
/// `settings.json` owned by `app_settings_get/set` — that one carries
/// view-mode/theme/font/HW-accel and lives in `app_data_dir`. This one
/// carries cross-cutting preferences (language, last project for auto-open)
/// and lives in the resolved user-data dir (portable-aware).
fn default_user_settings() -> serde_json::Value
{
    // Keys here must match USER_SETTINGS_KNOWN. `editorMode` and
    // `editorTabBehavior` were previously KNOWN-but-undefaulted, so a fresh
    // load returned them as absent even though writers could persist them.
    serde_json::json!({
        "format": "user-settings:v1",
        "defaultLanguage": "en",
        "createdVersion": serde_json::Value::Null,
        "currentVersion": serde_json::Value::Null,
        "lastMigrationAttempt": serde_json::Value::Null,
        "lastProjectPath": serde_json::Value::Null,
        "onboardingCompleted": false,
        "lastSettingsTab": "general",
        "lastMobileExplorerTab": "files",
        "mobileExplorerSwipeHintShown": false,
        "editorMode": serde_json::Value::Null,
        "editorTabBehavior": serde_json::Value::Null,
        "spellcheckEnabled": true,
        "spellcheckLanguage": serde_json::Value::Null,
        "personalDictionary": serde_json::json!([]),
        "googleProfile": serde_json::Value::Null,
        "googleScopeVersion": 0,
        "projectSessions": serde_json::json!({})
    })
}

const USER_SETTINGS_KNOWN: &[&str] = &[
    "defaultLanguage",
    // Back-compat read only — removal tracked in follow-up ticket.
    "appVersionCreated",
    "createdVersion",
    "currentVersion",
    "lastMigrationAttempt",
    "lastProjectPath",
    "onboardingCompleted",
    "lastSettingsTab",
    "lastMobileExplorerTab",
    "mobileExplorerSwipeHintShown",
    "editorMode",
    "editorTabBehavior",
    "spellcheckEnabled",
    "spellcheckLanguage",
    "personalDictionary",
    "googleProfile",
    "googleScopeVersion",
    "projectSessions",
];

/// Shallow-merge `partial` over `base`, keeping only known top-level keys
/// and re-stamping format + updatedAt. Unknown keys drop silently.
///
/// `projectSessions` is an opaque map keyed by project UUID — its inner
/// schema is owned by the JS side. Merge preserves entries that appear in
/// `base` but not `partial`, so a partial write for one project's session
/// does not clobber other projects' entries. A per-uuid entry in `partial`
/// wholly replaces the corresponding entry in `base` (JS callers layer
/// shallow-merge of the inner fields themselves before calling save).
fn merge_user_settings(
    base: &serde_json::Value,
    partial: &serde_json::Value,
) -> serde_json::Value
{
    let mut out = default_user_settings();
    if let Some(b) = base.as_object()
    {
        for k in USER_SETTINGS_KNOWN
        {
            if let Some(v) = b.get(*k) { out[*k] = v.clone(); }
        }
    }
    if let Some(p) = partial.as_object()
    {
        for k in USER_SETTINGS_KNOWN
        {
            if let Some(v) = p.get(*k)
            {
                if *k == "projectSessions"
                {
                    out[*k] = merge_project_sessions(out.get(*k), v);
                }
                else
                {
                    out[*k] = v.clone();
                }
            }
        }
    }
    out["format"] = serde_json::Value::String("user-settings:v1".into());
    out["updatedAt"] = serde_json::Value::String(chrono::Utc::now().to_rfc3339());
    out
}

/// Merge the `projectSessions` sub-map. Per-uuid entries in `partial` replace
/// the same key in `base`; every other uuid in `base` survives untouched.
/// Non-object inputs are treated as empty maps.
fn merge_project_sessions(
    base: Option<&serde_json::Value>,
    partial: &serde_json::Value,
) -> serde_json::Value
{
    let mut out = serde_json::Map::new();
    if let Some(b) = base.and_then(|v| v.as_object())
    {
        for (k, v) in b { out.insert(k.clone(), v.clone()); }
    }
    if let Some(p) = partial.as_object()
    {
        for (k, v) in p { out.insert(k.clone(), v.clone()); }
    }
    serde_json::Value::Object(out)
}

/// Read user-settings.json. Missing file → defaults (in-memory, no scaffold).
/// Unparseable file → defaults silently (no quarantine in MVP — settings
/// rebuild on next write).
///
/// Pure persistence helper. The host-validity guard on `lastProjectPath`
/// lives in `apply_last_project_path_guard` and is applied by the Tauri
/// command, not here — so unit tests can round-trip without filesystem
/// side effects.
///
/// Transient flags this layer may inject (NOT in `USER_SETTINGS_KNOWN`, so
/// they drop on the next save):
/// - `_isFresh: true` — set when the on-disk file did not exist before
///   merge. Used by the user-data version gate to distinguish fresh-install
///   first-boot from an existing user whose settings need migrating.
/// - `lastProjectPathInvalid: true` — see `apply_last_project_path_guard`.
pub fn user_settings_load_impl(dir: &PathBuf) -> Result<serde_json::Value, String>
{
    let path = user_settings_path(dir);
    let was_fresh = !path.exists();
    let mut value = if was_fresh
    {
        default_user_settings()
    }
    else
    {
        let body = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&body);
        match parsed
        {
            Ok(v) => merge_user_settings(&default_user_settings(), &v),
            Err(_) => default_user_settings(),
        }
    };

    if was_fresh
    {
        value["_isFresh"] = serde_json::Value::Bool(true);
    }

    Ok(value)
}

/// Validates `lastProjectPath` against the current host. If non-null and
/// either non-absolute or non-existent (e.g. a Windows path persisted by
/// another OS, or a deleted folder), nulls it out and sets the transient
/// `lastProjectPathInvalid: true` flag so the start-screen UI can render
/// a muted note. The flag is NOT in USER_SETTINGS_KNOWN so
/// `merge_user_settings` drops it on save — it never round-trips to disk.
pub fn apply_last_project_path_guard(value: &mut serde_json::Value)
{
    let needs_clear = value
        .get("lastProjectPath")
        .and_then(|v| v.as_str())
        .map(|p|
        {
            let candidate = std::path::Path::new(p);
            !candidate.is_absolute() || !candidate.exists()
        })
        .unwrap_or(false);
    if needs_clear
    {
        if let Some(p) = value.get("lastProjectPath").and_then(|v| v.as_str())
        {
            log::warn!("[user_settings] lastProjectPath {:?} invalid for current platform — clearing", p);
        }
        value["lastProjectPath"] = serde_json::Value::Null;
        value["lastProjectPathInvalid"] = serde_json::Value::Bool(true);
    }
}

/// Write user-settings.json (merging partial into existing) WITHOUT acquiring
/// `SETTINGS_WRITE_LOCK`. Callers MUST hold the lock themselves. Used by
/// `user_settings_save_impl` and by the user-data version commands which
/// already hold the lock across a read+decide+write window.
pub(super) fn user_settings_write_unlocked(
    dir: &PathBuf,
    partial: serde_json::Value,
) -> Result<(), String>
{
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let path = user_settings_path(dir);
    let existing = if path.exists()
    {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .unwrap_or_else(default_user_settings)
    }
    else
    {
        default_user_settings()
    };

    let merged = merge_user_settings(&existing, &partial);
    let body = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    let path_str = path.to_str().ok_or("non-utf8 path")?;
    atomic_write_impl(path_str, &body)
}

/// Write user-settings.json (merging partial into existing). Mutex-serialized.
pub fn user_settings_save_impl(
    dir: &PathBuf,
    partial: serde_json::Value,
) -> Result<(), String>
{
    let _g = SETTINGS_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    user_settings_write_unlocked(dir, partial)
}

/// Remove `projectSessions[id]` from user-settings.json.
///
/// The shallow-merge `user_settings_save_impl` path can only add / replace
/// per-uuid entries — it has no "delete" primitive. Delete-project flows
/// need to actually drop the entry, so this helper does a direct
/// read-modify-atomic-write while holding `SETTINGS_WRITE_LOCK`.
///
/// Idempotent: missing file, missing `projectSessions` map, or missing `id`
/// are all no-ops that return `Ok(())`.
pub fn drop_project_session_impl(
    dir: &PathBuf,
    id: &str,
) -> Result<(), String>
{
    let _g = SETTINGS_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let path = user_settings_path(dir);
    if !path.exists()
    {
        return Ok(());
    }
    let body = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut value: serde_json::Value = match serde_json::from_str(&body)
    {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    let removed = value
        .get_mut("projectSessions")
        .and_then(|v| v.as_object_mut())
        .and_then(|m| m.remove(id))
        .is_some();
    if !removed
    {
        return Ok(());
    }
    let body = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    let path_str = path.to_str().ok_or("non-utf8 path")?;
    atomic_write_impl(path_str, &body)
}

#[tauri::command]
pub fn user_settings_load(app: tauri::AppHandle) -> Result<serde_json::Value, String>
{
    let dir = resolve_user_data_dir(&app)?;
    let mut value = user_settings_load_impl(&dir)?;
    apply_last_project_path_guard(&mut value);
    Ok(value)
}

#[tauri::command]
pub fn user_settings_save(
    app: tauri::AppHandle,
    value: serde_json::Value,
) -> Result<(), String>
{
    let dir = resolve_user_data_dir(&app)?;
    user_settings_save_impl(&dir, value)
}

/// Cheap path-exists probe used by the auto-open-last-project boot flow.
/// Returns false on missing path, broken symlink, or any IO error — the
/// caller treats false as "fall through to start screen".
#[tauri::command]
pub fn path_exists(path: String) -> bool
{
    std::path::Path::new(&path).exists()
}

/// Resolve the user-data directory (portable-aware). Used by the mobile
/// auto-create flow to pick the parent dir for `MyFirstProject`.
#[tauri::command]
pub fn user_data_dir(app: tauri::AppHandle) -> Result<String, String>
{
    let dir = resolve_user_data_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}
