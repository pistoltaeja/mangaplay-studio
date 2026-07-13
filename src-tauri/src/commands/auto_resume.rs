//! Auto-resume gate + multi-instance detection.
//!
//! `app_should_auto_resume` — bootstrap-time query, true iff the picker
//! should be skipped (env opt-out / `--no-resume` CLI arg / Shift-at-launch
//! on Windows / sibling instance detected all force the picker).
//!
//! `detect_other_instance_and_set_flag` runs ONCE at process start before
//! `tauri::Builder` spins up. It claims a per-user lockfile or, if another
//! live instance owns it, sets `MPS_OTHER_INSTANCE=1` in this process's
//! env so the auto-resume gate falls through to the picker. On Windows it
//! also redirects `WEBVIEW2_USER_DATA_FOLDER` to a sibling per-pid folder
//! so two windows can render independently.

/// Determine whether the bootstrap should auto-resume the top recent
/// project or show the picker instead.
///
/// Precedence (first match wins):
///   1. MPS_NO_AUTO_RESUME=1                  → false (picker)
///   2. --no-resume CLI arg                   → false (picker)
///   3. Shift held at launch (Windows)        → false (picker)
///   4. otherwise                             → true  (auto-resume)
#[tauri::command]
pub fn app_should_auto_resume() -> Result<bool, String> {
    if std::env::var("MPS_NO_AUTO_RESUME").ok().as_deref() == Some("1") {
        return Ok(false);
    }
    if std::env::args().any(|a| a == "--no-resume") {
        return Ok(false);
    }
    // If another live instance was detected at process start, this launch
    // must show the picker (avoid two windows racing on the same project).
    if std::env::var("MPS_OTHER_INSTANCE").ok().as_deref() == Some("1") {
        return Ok(false);
    }
    #[cfg(target_os = "windows")]
    {
        if crate::platform::win32::shift_is_held() {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Detect a live sibling instance via a per-user lock file. When another
/// instance is alive we set MPS_OTHER_INSTANCE=1 in this process's env so
/// app_should_auto_resume() forces the picker — letting both windows
/// coexist without racing on the same auto-resumed project.
///
/// We use the OS pid stored in the lockfile to confirm it's actually alive
/// (so a crash that leaves a stale lockfile doesn't wedge every future
/// launch into the picker forever).
pub fn detect_other_instance_and_set_flag() {
    let lock_dir = match dirs_app_data_dir_blocking() {
        Some(d) => d,
        None => return,
    };
    if std::fs::create_dir_all(&lock_dir).is_err() {
        return;
    }
    let lock_path = lock_dir.join("instance.lock");
    let my_pid = std::process::id();

    let mut other_alive = false;
    if let Ok(raw) = std::fs::read_to_string(&lock_path) {
        if let Ok(pid) = raw.trim().parse::<u32>() {
            if pid != my_pid && pid_is_alive(pid) {
                other_alive = true;
            }
        }
    }

    if other_alive {
        // Don't overwrite — leave the other instance's pid in place. We
        // signal this instance only.
        // SAFETY: `set_var` is `unsafe` in Rust 2024 because env mutation
        // races with other threads reading the env. We're still
        // single-threaded here (this runs before tauri::Builder spins up
        // the runtime in `run()` — call order is
        // `detect_other_instance_and_set_flag()` THEN
        // `tauri::Builder::default()`), so the contract holds.
        #[allow(unsafe_code)]
        unsafe { std::env::set_var("MPS_OTHER_INSTANCE", "1"); }

        // CRITICAL on Windows: WebView2 enforces single-instance per
        // user-data-folder. Without a per-pid override the second .exe
        // launch silently exits when its webview can't attach. Point this
        // instance at a sibling folder so both windows render independently.
        #[cfg(target_os = "windows")]
        {
            let sibling = lock_dir.join("webview-data").join(format!("pid-{}", my_pid));
            let _ = std::fs::create_dir_all(&sibling);
            // SAFETY: same single-threaded pre-runtime contract as the
            // MPS_OTHER_INSTANCE set above.
            #[allow(unsafe_code)]
            unsafe { std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", sibling.to_string_lossy().to_string()); }
        }

        log::info!("[multi-instance] sibling pid detected; forcing picker + isolated webview folder");
    } else {
        // No live sibling. Claim the lock for ourselves and use the
        // default WebView2 data folder (so cookies / cache persist for
        // the user's primary session).
        let _ = std::fs::write(&lock_path, my_pid.to_string());

        // Opportunistic cleanup: when we're the sole instance, sweep any
        // leftover webview-data/pid-* folders whose owning pid is dead.
        // Keeps the app data dir from growing forever after secondary
        // launches accumulate.
        let wv = lock_dir.join("webview-data");
        if let Ok(rd) = std::fs::read_dir(&wv) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(pid_str) = name.strip_prefix("pid-") {
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        if !pid_is_alive(pid) {
                            let _ = std::fs::remove_dir_all(entry.path());
                        }
                    }
                }
            }
        }
    }
}

/// Return the per-user app data dir without spinning up a Tauri AppHandle.
/// Mirrors what `app.path().app_data_dir()` would produce, so the lockfile
/// lives next to recent.json / settings.json.
#[cfg(desktop)]
fn dirs_app_data_dir_blocking() -> Option<std::path::PathBuf> {
    // Windows: %APPDATA%/studio.mangaplay.app
    // macOS:   ~/Library/Application Support/studio.mangaplay.app
    // Linux:   ~/.config/studio.mangaplay.app (Tauri 2 uses XDG_CONFIG_HOME)
    //
    // The identifier MUST match `tauri.conf.json` -> `identifier`. Hardcoded
    // here because the AppHandle isn't built yet at this call site (we run
    // before `tauri::Builder::default()`).
    const ID: &str = "studio.mangaplay.app";
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return Some(std::path::PathBuf::from(appdata).join(ID));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return Some(std::path::PathBuf::from(home)
                .join("Library").join("Application Support").join(ID));
        }
    }
    #[cfg(target_os = "linux")]
    {
        // Tauri 2's `app_data_dir()` maps to XDG_CONFIG_HOME on Linux
        // (~/.config), NOT XDG_DATA_HOME (~/.local/share). Match that so
        // the lockfile sits next to settings.json / recent.json instead of
        // splitting across two XDG dirs.
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            return Some(std::path::PathBuf::from(xdg).join(ID));
        }
        if let Ok(home) = std::env::var("HOME") {
            return Some(std::path::PathBuf::from(home).join(".config").join(ID));
        }
    }
    None
}

#[cfg(not(desktop))]
fn dirs_app_data_dir_blocking() -> Option<std::path::PathBuf> {
    None
}

/// Cross-platform pid liveness check. Replaces the previous pair of
/// `#[cfg]`-gated implementations (Win32 OpenProcess/GetExitCodeProcess and
/// libc kill) with a single `sysinfo` call that compiles cleanly on
/// Windows / macOS / Linux / iOS / Android — the old libc branch excluded
/// the latter two, blocking the mobile port.
fn pid_is_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    let target = Pid::from(pid as usize);
    // Refresh only the one pid we care about. `ProcessesToUpdate::Some`
    // skips the full enumeration, and the empty `ProcessRefreshKind` skips
    // populating fields we don't read.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[target]),
        false,
        ProcessRefreshKind::new(),
    );
    sys.process(target).is_some()
}
