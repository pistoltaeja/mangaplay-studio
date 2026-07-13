//! App Settings (`settings.json`) — atomic read/write of UI preferences.
//!
//! `SETTINGS_WRITE_LOCK` lives at the crate root because user-data and
//! user-settings code locks it too. We acquire it as `crate::SETTINGS_WRITE_LOCK`.
//!
//! Pure `*_impl` helpers exposed `pub` so `tests/app_settings.rs` can
//! exercise them without a Tauri runtime.

use std::path::PathBuf;

use tauri::Manager;

use crate::{atomic_write_impl, SETTINGS_WRITE_LOCK};

pub(crate) const KNOWN_KEYS: &[&str] = &[
    "format",
    "updatedAt",
    "skin",
    "hardwareAcceleration",
    "smoothMotion",
    "smoothScrolling",
    "automaticUpdates",
    "language",
    "appFont",
    "editorFont",
    "screenplayFont",
    // TODO: consumers read this via app_settings_get once diagnostics pipeline exists
    "diagnosticsEnabled",
    "analyticsEnabled",
    "leftPaneWidth",
    "storyboardWidth",
    "leftPaneCollapsed",
    "storyboardCollapsed",
    "viewMode",
    "lastSoloMode",
    "activeSubview",
    "windowMaximized",
    "windowWidth",
    "windowHeight",
];

/// Fresh-install defaults. `ux_mode` picks between standalone and
/// mobile/tablet variants: on mobile + tablet, both collapse-panels start
/// collapsed because the toggle buttons for those panels are hidden by
/// `app.css` in those modes — leaving them open would strand the user
/// with no way to close them. Standalone keeps the historical open-by-default.
pub(crate) fn default_settings(ux_mode: &str) -> serde_json::Value
{
    let collapsed_by_default = ux_mode == "mobile" || ux_mode == "tablet";
    // Keys here must match KNOWN_KEYS exactly. A key in KNOWN_KEYS without
    // a default would round-trip if a writer set it but be absent on a fresh
    // read — `language` was previously orphaned this way.
    serde_json::json!({
        "format": "settings:v1",
        "updatedAt": chrono::Utc::now().to_rfc3339(),
        "skin": "default",
        "hardwareAcceleration": true,
        "smoothMotion": true,
        "smoothScrolling": true,
        "automaticUpdates": true,
        "language": serde_json::Value::Null,
        "appFont": "default",
        "editorFont": "default",
        "screenplayFont": "default",
        "diagnosticsEnabled": true,
        "analyticsEnabled": true,
        "leftPaneWidth": serde_json::Value::Null,
        "storyboardWidth": serde_json::Value::Null,
        "leftPaneCollapsed": collapsed_by_default,
        "storyboardCollapsed": collapsed_by_default,
        "viewMode": "dual",
        "lastSoloMode": "solo-storyboard",
        "activeSubview": "folder",
        "windowMaximized": false,
        "windowWidth": serde_json::Value::Null,
        "windowHeight": serde_json::Value::Null
    })
}

fn settings_path(app_data_dir: &PathBuf) -> PathBuf
{
    app_data_dir.join("settings.json")
}

/// Resolve the directory holding `settings.json`. When the `MPS_SETTINGS_DIR`
/// env var is set (test harness), that takes precedence; otherwise the OS
/// app-data directory is used. Kept narrow so test specs can isolate
/// settings state in a per-spec tempdir.
pub(crate) fn resolve_settings_dir(app: &tauri::AppHandle) -> Result<PathBuf, String>
{
    if let Ok(dir) = std::env::var("MPS_SETTINGS_DIR")
    {
        if !dir.is_empty()
        {
            return Ok(PathBuf::from(dir));
        }
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn settings_tmp_path(app_data_dir: &PathBuf) -> PathBuf
{
    app_data_dir.join("settings.json.tmp")
}

/// Merge `partial` over `base`, retaining only known top-level keys.
/// New tokens stamped onto `updatedAt`. `ux_mode` seeds the default
/// scaffold so any keys missing from BOTH `base` and `partial` inherit
/// the mode-appropriate defaults (mobile/tablet → collapsed panels).
fn merge_settings(
    base: &serde_json::Value,
    partial: &serde_json::Value,
    ux_mode: &str,
) -> serde_json::Value
{
    let mut out = default_settings(ux_mode);
    if let Some(b) = base.as_object()
    {
        for k in KNOWN_KEYS
        {
            if let Some(v) = b.get(*k) { out[*k] = v.clone(); }
        }
    }
    if let Some(p) = partial.as_object()
    {
        for k in KNOWN_KEYS
        {
            if let Some(v) = p.get(*k) { out[*k] = v.clone(); }
        }
    }
    out["updatedAt"] = serde_json::Value::String(chrono::Utc::now().to_rfc3339());
    out["format"] = serde_json::Value::String("settings:v1".into());
    out
}

/// Read settings.json from disk. Behaviour:
/// - Missing file → returns defaults (in-memory, does NOT scaffold)
/// - Stray `.tmp` next to a valid file → deletes the `.tmp`
/// - Parse failure → renames bad file to `settings.json.corrupt-<unix-ts>`,
///   returns defaults with `__recovered` set so the caller can toast.
pub fn app_settings_get_impl(app_data_dir: &PathBuf, ux_mode: &str) -> Result<serde_json::Value, String>
{
    let path = settings_path(app_data_dir);
    let tmp = settings_tmp_path(app_data_dir);

    if !path.exists()
    {
        // Sweep dangling tmp (force-kill leftover) before returning defaults.
        if tmp.exists() { let _ = std::fs::remove_file(&tmp); }
        return Ok(default_settings(ux_mode));
    }

    // Try parse; on failure quarantine + return defaults.
    let body = match std::fs::read_to_string(&path)
    {
        Ok(s) => s,
        Err(_) => return Ok(default_settings(ux_mode)),
    };
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(&body);
    match parsed
    {
        Ok(v) =>
        {
            // Valid file. If a stray .tmp exists alongside, it's a leftover.
            if tmp.exists() { let _ = std::fs::remove_file(&tmp); }
            // Shallow-merge over defaults so any missing fields fill in,
            // and unknown keys drop silently.
            Ok(merge_settings(&default_settings(ux_mode), &v, ux_mode))
        }
        Err(_) =>
        {
            // Quarantine the bad file.
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let corrupt = app_data_dir.join(format!("settings.json.corrupt-{ts}"));
            let _ = std::fs::rename(&path, &corrupt);
            let mut def = default_settings(ux_mode);
            def["__recovered"] = serde_json::json!({
                "from": corrupt.to_string_lossy(),
                "at": chrono::Utc::now().to_rfc3339()
            });
            Ok(def)
        }
    }
}

/// Write settings (merging partial into existing). Mutex-serialized.
pub fn app_settings_set_impl(
    app_data_dir: &PathBuf,
    partial: serde_json::Value,
    ux_mode: &str,
) -> Result<(), String>
{
    let _g = SETTINGS_WRITE_LOCK.lock().map_err(|e| e.to_string())?;

    // Ensure dir exists (first-launch fix).
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;

    // Read existing (without recovery side-effects — read raw).
    let path = settings_path(app_data_dir);
    let existing = if path.exists()
    {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .unwrap_or_else(|| default_settings(ux_mode))
    }
    else
    {
        default_settings(ux_mode)
    };

    let merged = merge_settings(&existing, &partial, ux_mode);
    let body = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    let path_str = path.to_str().ok_or("non-utf8 path")?;
    atomic_write_impl(path_str, &body)
}

#[tauri::command]
pub fn app_settings_get(
    app: tauri::AppHandle,
    ux_mode: tauri::State<'_, crate::UxModeState>,
) -> Result<serde_json::Value, String>
{
    let dir = resolve_settings_dir(&app)?;
    app_settings_get_impl(&dir, &ux_mode.0)
}

#[tauri::command]
pub fn app_settings_set(
    app: tauri::AppHandle,
    ux_mode: tauri::State<'_, crate::UxModeState>,
    value: serde_json::Value,
) -> Result<(), String>
{
    let dir = resolve_settings_dir(&app)?;
    app_settings_set_impl(&dir, value, &ux_mode.0)
}
