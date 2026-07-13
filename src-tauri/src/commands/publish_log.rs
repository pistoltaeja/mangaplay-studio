//! Publish-log store: append-only log at `<app_data_dir>/publish-log.json`,
//! rotated to `publish-log-NNN.json` at 200 entries.
//!
//! Pure `*_impl` helpers exposed `pub` so `tests/publish_log_store.rs` can
//! exercise them without a Tauri runtime.

use tauri::Manager;

#[tauri::command]
pub fn publish_log_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    publish_log_load_impl(&app_data_dir)
}

/// Load the active publish log at `<app_data_dir>/publish-log.json`.
/// Returns `{"entries": []}` when the file is missing or malformed.
pub fn publish_log_load_impl(app_data_dir: &std::path::Path) -> Result<serde_json::Value, String> {
    let path = app_data_dir.join("publish-log.json");
    if !path.exists() {
        return Ok(serde_json::json!({ "entries": [] }));
    }
    let s = match std::fs::read_to_string(&path) {
        Ok(v) => v,
        Err(_) => return Ok(serde_json::json!({ "entries": [] })),
    };
    match serde_json::from_str::<serde_json::Value>(&s) {
        Ok(v) if v.get("entries").map(|e| e.is_array()).unwrap_or(false) => Ok(v),
        _ => Ok(serde_json::json!({ "entries": [] })),
    }
}

#[tauri::command]
pub fn publish_log_append(app: tauri::AppHandle, entry: serde_json::Value) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    publish_log_append_impl(&app_data_dir, entry)
}

/// Prepend `entry` to the active publish log. When the log would exceed 200
/// entries, the existing file is rotated to `publish-log-NNN.json` (next free
/// integer suffix, default 1) and a fresh active file is started containing
/// only the new entry. Malformed/missing active files behave as empty.
pub fn publish_log_append_impl(app_data_dir: &std::path::Path, entry: serde_json::Value) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let path = app_data_dir.join("publish-log.json");

    let existing = publish_log_load_impl(app_data_dir)?;
    let mut entries: Vec<serde_json::Value> = existing
        .get("entries")
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();

    if entries.len() >= 200 {
        let next_n = next_free_publish_log_number(app_data_dir);
        let archived = app_data_dir.join(format!("publish-log-{}.json", next_n));
        if path.exists() {
            std::fs::rename(&path, &archived).map_err(|e| e.to_string())?;
        }
        entries = Vec::new();
    }

    entries.insert(0, entry);
    let doc = serde_json::json!({ "entries": entries });

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&doc).unwrap())
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Scan `app_data_dir` for `publish-log-NNN.json` files and return `max(N) + 1`.
/// Defaults to 1 when no archived files exist.
pub fn next_free_publish_log_number(app_data_dir: &std::path::Path) -> u32 {
    let mut max_n: u32 = 0;
    if let Ok(rd) = std::fs::read_dir(app_data_dir) {
        for entry in rd.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(rest) = name.strip_prefix("publish-log-") {
                if let Some(num_str) = rest.strip_suffix(".json") {
                    if let Ok(n) = num_str.parse::<u32>() {
                        if n > max_n { max_n = n; }
                    }
                }
            }
        }
    }
    max_n + 1
}
