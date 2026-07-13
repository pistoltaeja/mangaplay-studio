/// Reveal a path in the OS file explorer.
///
/// File paths are revealed *with the file selected* on Windows (explorer.exe
/// /select,) and macOS (open -R). On Linux there is no consistent
/// cross-DE select-in-file-manager API, so file paths fall through to opening
/// the parent directory.
///
/// Folder paths open the folder itself on every platform.
///
/// JS callers build paths with `${projectRoot}/project/${name}` (forward
/// slashes), so on Windows we canonicalise + flip separators before handing
/// the path to explorer.exe — otherwise /select, silently fails and Explorer
/// falls back to the user's Desktop.
#[cfg(desktop)]
#[tauri::command]
pub fn app_reveal_in_explorer(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let is_file = p.is_file();
    let exists = p.exists();
    if !exists {
        log::warn!("[reveal] path does not exist: {}", path);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Canonicalise to an absolute path with backslash separators. The
        // \\?\ prefix returned by canonicalize is stripped — explorer.exe
        // does not accept it. Fall back to a manual slash-flip if
        // canonicalize fails (e.g. file was just renamed).
        let normalised: String = match std::fs::canonicalize(p) {
            Ok(abs) => {
                let s = abs.to_string_lossy().to_string();
                s.trim_start_matches(r"\\?\").replace('/', r"\")
            }
            Err(_) => path.replace('/', r"\"),
        };
        log::info!("[reveal] win path: {} -> {}", path, normalised);
        // Use raw_arg so we control the exact command-line. std::Command's
        // default arg escaping wraps a single token like
        //   /select,D:\Foo Bar\file.md
        // in quotes:  "/select,D:\Foo Bar\file.md"  — and Windows
        // explorer.exe silently falls back to opening Desktop in that case
        // when the path contains spaces. The correct cmdline keeps the
        // /select, switch unquoted and quotes ONLY the path:
        //   /select,"D:\Foo Bar\file.md"
        let mut cmd = std::process::Command::new("explorer.exe");
        if is_file {
            cmd.raw_arg(format!("/select,\"{}\"", normalised));
        } else {
            cmd.raw_arg(format!("\"{}\"", normalised));
        }
        let _ = cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        // `open -R <file>` reveals + selects in Finder. If the target is a
        // folder or the file is missing, fall back to `open <path>` (or its
        // parent) so we always get to a real Finder window instead of an
        // error toast.
        let (flag, target): (Option<&str>, String) = if is_file {
            (Some("-R"), path.clone())
        } else if p.is_dir() {
            (None, path.clone())
        } else {
            // Missing path: try the parent directory.
            let parent = p
                .parent()
                .and_then(|q| q.to_str().map(String::from))
                .unwrap_or(path.clone());
            (None, parent)
        };
        log::info!("[reveal] macos: open {} {}", flag.unwrap_or(""), target);
        let mut cmd = std::process::Command::new("open");
        if let Some(f) = flag { cmd.arg(f); }
        cmd.arg(&target);
        let _ = cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        // Linux has no portable "reveal + select" CLI, but the freedesktop
        // D-Bus interface org.freedesktop.FileManager1 is implemented by
        // Nautilus (GNOME), Dolphin (KDE), Nemo (Cinnamon), Caja (MATE) etc.
        // and DOES support selecting items. Try that first via the
        // dbus-send CLI (preinstalled on every Linux desktop); fall back to
        // `xdg-open <parent>` for headless DEs or file managers without the
        // FileManager1 interface (Thunar, PCManFM).
        if is_file {
            let uri = format!("file://{}", path);
            let dbus_ok = std::process::Command::new("dbus-send")
                .args([
                    "--session",
                    "--dest=org.freedesktop.FileManager1",
                    "--type=method_call",
                    "/org/freedesktop/FileManager1",
                    "org.freedesktop.FileManager1.ShowItems",
                    &format!("array:string:{}", uri),
                    "string:",
                ])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            log::info!("[reveal] linux dbus ShowItems uri={} ok={}", uri, dbus_ok);
            if dbus_ok { return Ok(()); }
        }
        // Fallback: open the folder itself (or the file's parent).
        let target: String = if is_file {
            std::path::Path::new(&path)
                .parent()
                .and_then(|q| q.to_str().map(String::from))
                .unwrap_or(path.clone())
        } else {
            path.clone()
        };
        log::info!("[reveal] linux xdg-open: {}", target);
        let _ = std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("unsupported-platform".into())
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn app_reveal_in_explorer(_path: String) -> Result<(), String> {
    Err("reveal-not-available-on-mobile".into())
}
