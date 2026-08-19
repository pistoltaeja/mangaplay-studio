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
// Downloads Slides page image bytes via a shared reqwest client (keep-alive
// + gzip + HTTP/2 + backoff). Replaces the plugin-http fetch path used
// previously. Desktop-only — uses rand, reqwest, tokio::time which are
// not available on mobile. Mobile stub returns an error string.
pub mod slides_image_fetch;
pub mod slides_link;
// Advisory publish-lock — file I/O only, no network. Works on every
// platform, so no need for a desktop-only cfg. Custom `#[tauri::command]`
// functions inherit the `core:default` permit from
// `capabilities/default.json` (and the Android capability set) — no
// separate permission entry needed.
pub mod slides_lock;
// Shared slug/opaque validators used by every `slides_*` command module.
pub mod slides_validation;
// Reserved `slides_upload_images` command name — the upload flow actually
// runs in JS (`slides-upload-transport.js`). There is NO cfg gate and no
// mobile-specific stub: the command body returns a `"not-implemented"`
// error on every target, keeping the name bookable in `lib.rs`'s
// invoke_handler! for a possible future desktop-only Rust migration.
pub mod slides_upload;
// Copies local PNGs into a deck's `<presentationId>/` dir and rewrites the
// deck manifest. Works on every target — file I/O only, no network.
pub mod storyboard_import;
pub mod test_driver;
pub mod window_theme;
// System font enumeration + path resolution for PDF font embedding.
// The two commands compile on every target — mobile stubs return an error
// string so JS falls back to Courier Prime.  fontdb itself is linked only on
// desktop (see Cargo.toml desktop-only target block); the inner
// `#[cfg(not(any(target_os="android", target_os="ios")))]` guards in fonts.rs
// prevent the mobile build from referencing it.
pub mod fonts;
