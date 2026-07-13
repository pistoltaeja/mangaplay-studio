use std::path::PathBuf;
use tauri::Manager;

/// Pure helper backing the resolver — given an exe parent and a default dir,
/// applies the portable-mode rules. Extracted so tests can exercise the
/// branch logic without touching the real filesystem `current_exe()` returns.
///
/// Returns `Some(portable_dir)` when:
///   1. The host OS isn't macOS.
///   2. `<exe_parent>/portable` exists.
///   3. `<exe_parent>/userdata/` is creatable + write-probe succeeds.
///
/// Otherwise `None` — caller falls back to the default dir.
pub fn resolve_user_data_dir_for_exe(
    exe_parent: &std::path::Path,
) -> Option<PathBuf>
{
    if cfg!(target_os = "macos") { return None; }

    let marker = exe_parent.join("portable");
    if !marker.exists() { return None; }

    let candidate = exe_parent.join("userdata");
    if std::fs::create_dir_all(&candidate).is_err() { return None; }

    let probe = candidate.join(".write-probe");
    if std::fs::write(&probe, b"").is_err() { return None; }
    let _ = std::fs::remove_file(&probe);

    Some(candidate)
}

/// Resolve the user-data directory. Order:
///   1. `MPS_USER_DATA_DIR` env var (test harness).
///   2. Portable mode (see `resolve_user_data_dir_for_exe`).
///   3. `app.path().app_config_dir()` — OS-correct default.
///
/// The directory is created if missing. Errors only when both the env var
/// path AND `app_config_dir()` fail; portable mode silently falls through.
pub fn resolve_user_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String>
{
    if let Ok(dir) = std::env::var("MPS_USER_DATA_DIR")
    {
        if !dir.is_empty()
        {
            let p = PathBuf::from(dir);
            std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
            return Ok(p);
        }
    }

    if let Ok(exe) = std::env::current_exe()
    {
        if let Some(parent) = exe.parent()
        {
            if let Some(portable) = resolve_user_data_dir_for_exe(parent)
            {
                return Ok(portable);
            }
        }
    }

    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub(super) fn user_settings_path(dir: &PathBuf) -> PathBuf
{
    dir.join("user-settings.json")
}
