/// UX mode resolved at startup. Exposed via Tauri managed state so the
/// setup() closure doesn't re-read process state. Values: "standalone" |
/// "mobile" | "tablet".
pub struct UxModeState(pub String);

/// Which resolution branch produced the returned mode. Callers log this
/// alongside the mode string so cold-boot logs answer "why did the app
/// open in this mode?" without needing to attach a debugger.
#[derive(Debug, Clone, Copy)]
pub enum UxModeSource {
    RuntimeEnv,
    CompileTimeBake,
    ExeFilename,
    Fallback,
}

impl UxModeSource {
    pub fn as_str(self) -> &'static str {
        match self {
            UxModeSource::RuntimeEnv => "runtime env MPS_UX_MODE",
            UxModeSource::CompileTimeBake => "compile-time MPS_BUILD_UX_MODE",
            UxModeSource::ExeFilename => "exe filename",
            UxModeSource::Fallback => "fallback default",
        }
    }
}

/// Resolve UX mode at startup. Order of precedence:
///   1. `MPS_UX_MODE` runtime env — test harness, launcher .bat, manual override.
///   2. `MPS_BUILD_UX_MODE` compile-time constant — baked in by build.rs from
///      the cargo build env. Authoritative on macOS/iOS/Android where filename
///      inspection can't work (macOS `current_exe()` returns the inner Mach-O
///      path, not the `.app` bundle name; iOS/Android don't have a per-variant
///      binary name at all).
///   3. `.exe` filename inspection — works on Windows where the release .exe
///      is renamed to MangaplayStudioMobile.exe / MangaplayStudioTablet.exe.
///   4. Fallback "standalone".
///
/// IMPORTANT: this runs BEFORE tauri-plugin-log is initialised inside
/// `.setup()`, so any `log::*!` call from here is dropped on the floor.
/// Callers use `resolve_ux_mode_with_source()` and log the result AFTER
/// the log plugin comes online.
pub fn resolve_ux_mode() -> String {
    resolve_ux_mode_with_source().0
}

pub fn resolve_ux_mode_with_source() -> (String, UxModeSource) {
    if let Ok(m) = std::env::var("MPS_UX_MODE") {
        let v = m.to_lowercase();
        if v == "mobile" || v == "tablet" || v == "standalone" {
            return (v, UxModeSource::RuntimeEnv);
        }
    }
    let build_mode = option_env!("MPS_BUILD_UX_MODE").unwrap_or("").to_lowercase();
    if build_mode == "mobile" || build_mode == "tablet" || build_mode == "standalone" {
        return (build_mode, UxModeSource::CompileTimeBake);
    }
    if let Some(name) = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
    {
        if name.contains("Mobile") {
            return ("mobile".to_string(), UxModeSource::ExeFilename);
        }
        if name.contains("Tablet") {
            return ("tablet".to_string(), UxModeSource::ExeFilename);
        }
    }
    ("standalone".to_string(), UxModeSource::Fallback)
}
