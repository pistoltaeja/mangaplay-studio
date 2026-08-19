//! App-info commands: platform metadata, recents list, version JSON.
//!
//! Pure `*_impl` helpers exposed `pub` so `tests/recent_case_rename.rs`
//! can call them without a Tauri runtime.

use tauri::Manager;

use crate::commands::project::{read_project_json_field, read_project_json_locked};
use crate::fs_helpers::trash_or_remove;
use crate::user_data::paths::resolve_user_data_dir;
use crate::user_data::settings::drop_project_session_impl;
use crate::{chrono_iso_now, PACKAGED_APP_VERSION_INFO_JSON};

#[tauri::command]
pub fn app_platform(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let os = std::env::consts::OS;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    // app_log_dir is a separate location from app_data_dir on Windows
    // (Local vs Roaming). Expose it so any UI showing "where logs go"
    // points users to the right folder. Falls back to app_data_dir/logs
    // for consistency with the lib.rs boot setup.
    let app_log_dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| app_data_dir.join("logs"));

    Ok(serde_json::json!({
        "os": os,
        "appDataDir": app_data_dir.to_string_lossy(),
        "appLogDir":  app_log_dir.to_string_lossy(),
        "version": env!("CARGO_PKG_VERSION")
    }))
}

#[tauri::command]
pub fn app_recent(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let recent_path = app_data_dir.join("recent.json");

    if !recent_path.exists() {
        return Ok(serde_json::json!([]));
    }

    let contents = std::fs::read_to_string(&recent_path).map_err(|e| e.to_string())?;
    let mut recent: Vec<serde_json::Value> =
        serde_json::from_str(&contents).map_err(|e| e.to_string())?;

    // Tag each entry with `exists` and resolve a `resolvedName` (per-machine
    // override → shared project.json displayName → folder basename). Entries
    // are kept even when missing — the UI handles muted styling, and the user
    // removes via app_remove_recent.
    for entry in recent.iter_mut() {
        let path_str = entry
            .get("path")
            .and_then(|p| p.as_str())
            .map(|s| s.to_string());
        let exists = match &path_str {
            Some(p) => std::path::Path::new(p).is_dir(),
            None => false,
        };

        // Try to read the SHARED displayName from project.json on disk —
        // only if the folder still exists.
        let shared_name: Option<String> = if exists {
            path_str.as_ref()
                .and_then(|p| read_project_json_field(std::path::Path::new(p), "displayName"))
        } else {
            None
        };

        let local_override = entry.get("displayNameOverride")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let folder_name = path_str.as_ref()
            .and_then(|p| std::path::Path::new(p).file_name()
                .map(|n| n.to_string_lossy().to_string()))
            .unwrap_or_default();

        let resolved = local_override
            .or(shared_name)
            .unwrap_or(folder_name);

        let locked = if exists {
            path_str.as_ref()
                .map(|p| read_project_json_locked(std::path::Path::new(p)))
                .unwrap_or(false)
        } else {
            false
        };

        if let Some(obj) = entry.as_object_mut() {
            obj.insert("exists".into(), serde_json::Value::Bool(exists));
            obj.insert("resolvedName".into(), serde_json::Value::String(resolved));
            obj.insert("locked".into(), serde_json::Value::Bool(locked));
        }
    }
    Ok(serde_json::Value::Array(recent))
}

/// Caseless, separator-normalised path equality for recent.json entries.
/// `path_eq_caseless` (fs_events) compares raw strings, so `D:\x` != `D:/x`
/// — recent.json accumulated duplicate entries for the same project.
fn recent_path_eq(a: &str, b: &str) -> bool {
    a.replace('\\', "/").trim_end_matches('/').to_lowercase()
        == b.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

#[tauri::command]
pub fn app_remove_recent(app: tauri::AppHandle, project_path: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    app_remove_recent_impl(&app_data_dir, &project_path)
}

/// Drops every recent.json entry whose `path` field matches `project_path`
/// under `recent_path_eq` (caseless + separator-normalised). Idempotent;
/// ignores missing recent.json.
pub fn app_remove_recent_impl(app_data_dir: &std::path::Path, project_path: &str) -> Result<(), String> {
    let recent_path = app_data_dir.join("recent.json");
    if !recent_path.exists() {
        return Ok(());
    }
    let s = std::fs::read_to_string(&recent_path).map_err(|e| e.to_string())?;
    let mut recent: Vec<serde_json::Value> = serde_json::from_str(&s).unwrap_or_default();
    recent.retain(|v| {
        match v.get("path").and_then(|p| p.as_str()) {
            Some(stored) => !recent_path_eq(stored, project_path),
            None => true,
        }
    });

    let tmp = recent_path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&recent).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &recent_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn app_update_recent(app: tauri::AppHandle, project_path: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    app_update_recent_impl(&app_data_dir, &project_path)
}

/// Prepend (or move-to-front) `project_path` in recent.json under `app_data_dir`.
/// On case-only rename the existing entry is replaced (not duplicated), the
/// preserved `displayNameOverride` carries over, and the `name` is refreshed
/// from the new path's basename. Truncates to 10 entries.
pub fn app_update_recent_impl(app_data_dir: &std::path::Path, project_path: &str) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let recent_path = app_data_dir.join("recent.json");

    let mut recent: Vec<serde_json::Value> = if recent_path.exists() {
        let s = std::fs::read_to_string(&recent_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).unwrap_or_default()
    } else {
        Vec::new()
    };

    // Try to read project.json id so this recent entry survives folder renames.
    let project_id = read_project_json_field(std::path::Path::new(project_path), "id");

    // Preserve any per-machine displayName override that was on the old entry.
    let prev_override = recent.iter()
        .find(|v| v.get("path").and_then(|p| p.as_str())
            .map(|stored| recent_path_eq(stored, project_path))
            .unwrap_or(false))
        .and_then(|v| v.get("displayNameOverride").cloned());

    // Remove existing entry for this path (all separator/case variants).
    recent.retain(|v| {
        match v.get("path").and_then(|p| p.as_str()) {
            Some(stored) => !recent_path_eq(stored, project_path),
            None => true,
        }
    });
    // Prepend new entry
    let name = std::path::Path::new(project_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut entry = serde_json::json!({
        "path": project_path,
        "name": name,
        "lastOpened": chrono_iso_now(),
    });
    if let Some(id) = project_id {
        entry["id"] = serde_json::Value::String(id);
    }
    if let Some(o) = prev_override {
        entry["displayNameOverride"] = o;
    }
    recent.insert(0, entry);
    recent.truncate(10);

    // Atomic write
    let tmp = recent_path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&recent).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &recent_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn app_delete_project(app: tauri::AppHandle, project_path: String) -> Result<(), String>
{
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let user_data_dir = resolve_user_data_dir(&app)?;
    app_delete_project_impl(&app_data_dir, &user_data_dir, &project_path)
}

/// Delete a Mangaplay project atomically:
///   1. Guard: `<project_path>/_mangaplaystudio/project.json` must exist
///      and `project_path` must be a directory. Otherwise → `not-a-project`.
///   2. Read `project.json` `id` (may be None — sessions cleanup is a no-op).
///   3. `trash_or_remove(project_path)` — desktop → Recycle Bin / Trash,
///      mobile → hard delete. On error → return; nothing else touched.
///   4. `app_remove_recent_impl(app_data_dir, project_path)` — best-effort.
///   5. `drop_project_session_impl(user_data_dir, id)` — best-effort.
///
/// Steps 4 and 5 self-heal (missing recent entry / stale session key are
/// harmless), so a partial failure there does NOT fail the whole call.
pub fn app_delete_project_impl(
    app_data_dir: &std::path::Path,
    user_data_dir: &std::path::PathBuf,
    project_path: &str,
) -> Result<(), String>
{
    if project_path.is_empty()
    {
        return Err("not-a-project".to_string());
    }
    let path = std::path::Path::new(project_path);
    if !path.is_dir()
    {
        return Err("not-a-project".to_string());
    }
    let pj = path.join("_mangaplaystudio").join("project.json");
    if !pj.exists()
    {
        return Err("not-a-project".to_string());
    }

    if read_project_json_locked(path)
    {
        return Err("project-locked".to_string());
    }

    let project_id = read_project_json_field(path, "id");

    trash_or_remove(path)?;

    if let Err(e) = app_remove_recent_impl(app_data_dir, project_path)
    {
        eprintln!("[app_delete_project] recent scrub failed: {}", e);
    }

    if let Some(id) = project_id
    {
        if let Err(e) = drop_project_session_impl(user_data_dir, &id)
        {
            eprintln!("[app_delete_project] projectSessions drop failed: {}", e);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn app_version_info() -> Result<serde_json::Value, String>
{
    serde_json::from_str(PACKAGED_APP_VERSION_INFO_JSON).map_err(|e| e.to_string())
}
