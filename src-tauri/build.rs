fn main() {
    // Re-emit MPS_UX_MODE from the cargo environment into the binary as a
    // rustc-env so it's accessible via option_env!("MPS_BUILD_UX_MODE") at
    // compile time. This is the authoritative UX-mode source on every target:
    //   - macOS: `current_exe()` returns the inner Mach-O path, never the
    //     renamed .app bundle name — filename inspection cannot work.
    //   - iOS / Android: no per-variant binary name; there IS no filename
    //     hint to inspect.
    //   - Windows: also honoured — the renamed .exe filename stays as a
    //     secondary fallback for cases where cargo cache serves a stale
    //     binary without the bake.
    println!("cargo:rerun-if-env-changed=MPS_UX_MODE");
    if let Ok(mode) = std::env::var("MPS_UX_MODE") {
        println!("cargo:rustc-env=MPS_BUILD_UX_MODE={}", mode);
    }
    tauri_build::build()
}
