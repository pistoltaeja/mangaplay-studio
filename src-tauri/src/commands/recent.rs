//! Recent-projects-list maintenance helpers.
//!
//! Pure `*_impl` helpers exposed `pub` so `tests/recent_case_rename.rs`
//! can call them without a Tauri runtime.

use tauri::Manager;

use crate::commands::file_ops::fs_events::path_eq_caseless;

/// Rewrite one entry's path in recent.json. Tauri-handle wrapper around
/// `update_recent_path_impl`.
pub fn update_recent_path(
    app: &tauri::AppHandle,
    old_path: &str,
    new_path: &str,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    update_recent_path_impl(&app_data_dir, old_path, new_path)
}

/// Rewrite one entry's path in recent.json. Matches via `path_eq_caseless` so
/// a case-only rename on Windows / macOS finds the existing entry instead of
/// silently leaving a duplicate.
pub fn update_recent_path_impl(
    app_data_dir: &std::path::Path,
    old_path: &str,
    new_path: &str,
) -> Result<(), String> {
    let recent_path = app_data_dir.join("recent.json");
    if !recent_path.exists() {
        return Ok(());
    }
    let s = std::fs::read_to_string(&recent_path).map_err(|e| e.to_string())?;
    let mut recent: Vec<serde_json::Value> = serde_json::from_str(&s).unwrap_or_default();
    for entry in recent.iter_mut() {
        let matches = entry
            .get("path")
            .and_then(|p| p.as_str())
            .map(|stored| path_eq_caseless(std::path::Path::new(stored), std::path::Path::new(old_path)))
            .unwrap_or(false);
        if matches {
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("path".into(), serde_json::Value::String(new_path.into()));
                // Also refresh the cached `name` to the new basename.
                let nm = std::path::Path::new(new_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                obj.insert("name".into(), serde_json::Value::String(nm));
            }
        }
    }
    let tmp = recent_path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&recent).unwrap())
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &recent_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Set/clear an arbitrary field on one recent.json entry by path. Tauri-handle
/// wrapper around `update_recent_field_impl`.
pub fn update_recent_field(
    app: &tauri::AppHandle,
    project_path: &str,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    update_recent_field_impl(&app_data_dir, project_path, key, value)
}

/// Set/clear an arbitrary field on the recent.json entry whose `path` matches
/// `project_path` under `path_eq_caseless`. A null `value` removes the key
/// rather than writing `null` into it.
pub fn update_recent_field_impl(
    app_data_dir: &std::path::Path,
    project_path: &str,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let recent_path = app_data_dir.join("recent.json");
    if !recent_path.exists() {
        return Ok(());
    }
    let s = std::fs::read_to_string(&recent_path).map_err(|e| e.to_string())?;
    let mut recent: Vec<serde_json::Value> = serde_json::from_str(&s).unwrap_or_default();
    let target = std::path::Path::new(project_path);
    for entry in recent.iter_mut() {
        let matches = entry.get("path").and_then(|p| p.as_str())
            .map(|stored| path_eq_caseless(std::path::Path::new(stored), target))
            .unwrap_or(false);
        if matches {
            if let Some(obj) = entry.as_object_mut() {
                if value.is_null() {
                    obj.remove(key);
                } else {
                    obj.insert(key.into(), value.clone());
                }
            }
        }
    }
    let tmp = recent_path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&recent).unwrap())
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &recent_path).map_err(|e| e.to_string())?;
    Ok(())
}
