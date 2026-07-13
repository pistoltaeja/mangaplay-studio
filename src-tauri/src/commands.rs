//! Tauri command modules.
//!
//! Each submodule groups related `#[tauri::command]` functions plus any
//! pure `*_impl` helpers they delegate to. The macro registry in
//! `lib.rs::run()` references them via `crate::commands::<mod>::<fn>`.

pub mod app_info;
pub mod auth;
pub mod auto_flatten;
pub mod auto_resume;
pub mod onboarding;
pub mod console_capture;
pub mod file_ops;
pub mod lifecycle;
pub mod mangaart;
pub mod picker;
pub mod project;
pub mod project_mutations;
pub mod publish_log;
pub mod recent;
pub mod registry_cmds;
pub mod reveal;
pub mod script_map;
pub mod settings;
pub mod slides_cache;
pub mod slides_link;
// Advisory publish-lock — file I/O only, no network. Works on every
// platform, so no need for a desktop-only cfg. Custom `#[tauri::command]`
// functions inherit the `core:default` permit from
// `capabilities/default.json` (and the Android capability set) — no
// separate permission entry needed.
pub mod slides_lock;
// Uploads local PNGs + issues `slides.batchUpdate` — desktop-only path.
// The `slides_upload_images` command body itself is gated via
// `#[cfg(not(target_os = "android"))]`; the module is compiled on every
// target so `lib.rs`'s invoke_handler! macro still references it, but the
// mobile stub returns a permission error.
pub mod slides_upload;
pub mod test_driver;
