//! JS → Rust log forwarder.
//!
//! Release builds have no DevTools, so console.log/warn/error from the JS
//! side is invisible to users (and to us when triaging bugs). This command
//! forwards a single JS log line into the Rust log facade so
//! `tauri-plugin-log` writes it to `app.log` alongside the Rust-side
//! messages.
//!
//! Levels: `error` | `warn` | `info` | `debug`. Anything else is treated
//! as info. `tag` is a short label included in the message for
//! grep-ability.
//!
//! Called from the JS bootstrap which wires `console.error` /
//! `console.warn` / `window.onerror` / `window.onunhandledrejection` to
//! this command. Keep the surface narrow: ONE command, plain strings, no
//! PII.

#[tauri::command]
pub fn app_log_message(level: String, tag: String, message: String)
{
    let line = format!("[js:{}] {}", tag, message);
    match level.as_str()
    {
        "error" => log::error!("{}", line),
        "warn"  => log::warn!("{}", line),
        "info"  => log::info!("{}", line),
        "debug" => log::debug!("{}", line),
        _       => log::info!("{}", line),
    }
}
