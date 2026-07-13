//! OAuth flow + keyring-backed token store.
//!
//! - `auth_listen_loopback` — RFC 8252 §7.3 loopback HTTP listener; renders
//!   the neutral callback page inline (`auth_success_page_html`).
//! - `auth_open_browser` — desktop opens via tauri-plugin-opener (Linux
//!   honours `$BROWSER` first); mobile returns a "not yet wired" error.
//! - `auth_raise_window` — best-effort focus restore when the OAuth round
//!   trip ends.
//! - `auth_token_store_{get,set,clear}` — keyring-backed credential store
//!   on desktop. Mobile stubs return `mobile_storage_not_implemented`
//!   for get/set and Ok(()) for clear (signOut stays graceful).
//!
//! Android storage backend is intentionally deferred. The `keyring` crate
//! v3 has no native Android backend; the third-party `android-keyring`
//! crate is explicitly marked "not production-ready" by its maintainer
//! (see TODO/AuthRefreshToken/06-keyring-android-coverage.md). Refresh
//! tokens are higher-value than 1-hour access tokens — the Android
//! backend MUST be at least as strong as iOS Keychain before shipping.
//! Candidate solutions: tauri-plugin-stronghold (Argon2id-encrypted file)
//! or a JNI bridge to EncryptedSharedPreferences.
//!
//! `auth_success_page_html` is re-exported at the crate root for
//! `tests/auth_success_page.rs`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Emitter, Manager};

/// Global registry of in-flight loopback listener abort flags, keyed by
/// listener id (the UUID returned from `auth_listen_loopback`). Used by
/// `auth_abort_loopback` to signal a running listener thread to break
/// its accept-poll loop immediately instead of waiting for the 60-second
/// deadline.
///
/// Cleanup contract: EVERY exit path out of the spawned listener thread
/// must remove its id via `AbortFlagGuard`'s Drop — accept success,
/// timeout, or abort. Skipping cleanup leaks an `Arc<AtomicBool>` per
/// stalled sign-in for the process lifetime.
fn abort_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>>
{
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// RAII cleanup for the abort-flag HashMap entry. Removing on Drop
/// guarantees the entry vanishes on ANY exit path from the listener
/// thread (accept success, timeout, abort, panic-caught early return).
struct AbortFlagGuard
{
    id: String,
}

impl Drop for AbortFlagGuard
{
    fn drop(&mut self)
    {
        if let Ok(mut flags) = abort_flags().lock()
        {
            flags.remove(&self.id);
        }
    }
}

// Test-only accessors. Exposed unconditionally (not gated on
// `#[cfg(test)]`) so integration tests in the sibling `tests/` crate
// can reach them — `#[cfg(test)]` only applies to unit tests inside
// this crate. Not intended for production callers.
#[doc(hidden)]
pub fn abort_flags_len_for_test() -> usize
{
    abort_flags().lock().map(|m| m.len()).unwrap_or(0)
}

#[doc(hidden)]
pub fn abort_flags_insert_for_test(id: &str) -> Arc<AtomicBool>
{
    let flag = Arc::new(AtomicBool::new(false));
    abort_flags().lock().unwrap().insert(id.to_string(), flag.clone());
    flag
}

#[doc(hidden)]
pub fn abort_flags_contains_for_test(id: &str) -> bool
{
    abort_flags().lock().unwrap().contains_key(id)
}

#[doc(hidden)]
pub fn abort_flags_clear_for_test()
{
    abort_flags().lock().unwrap().clear();
}

// Unified across the whole product family (Windows, macOS, Linux, Android,
// iOS) — matches the Tauri identifier in `tauri.conf.json` and every other
// `studio.mangaplay.app` reference in the tree. Renamed 2026-07-01 from
// `studio.mangaplay.desktop` as part of the identifier consolidation.
// No migration was shipped alongside — users signed in against the old
// keyring service on the next launch will see an empty account and need
// to re-consent once via the Google sign-in flow. Their local projects
// and settings under the old AppData identifier are similarly reset.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const KEYRING_SERVICE: &str = "studio.mangaplay.app";

/// Inline-rendered OAuth callback page. NOT a redirect — keeps the
/// entire flow off the wire after Google → loopback (RFC 8252 §8.10).
///
/// **Deliberately does NOT claim sign-in success.** The page is served
/// the moment Rust accepts the loopback HTTP request — BEFORE the JS
/// side exchanges the code with the BFF, BEFORE keyring writes, and
/// BEFORE id_token.sub verification. The actual signed-in state lives
/// in the app window, which is the only source of truth users should
/// believe. Saying "You're signed in" here would lie any time a
/// downstream step fails (network, BFF 5xx, keyring write, sub
/// mismatch).
///
/// **TODO — i18n.** The neutral copy ("Return to Mangaplay Studio" /
/// "Finishing sign-in in the app…") is currently hard-coded English.
/// Translations already exist in `localisation/*.json` under
/// `mangaplay-studio.auth.success.{title,subtitle}` for all 14 locales.
/// To wire them through, extend `auth_listen_loopback` to accept an
/// optional `strings: { title, body }` parameter (HTML-escape on
/// receipt), and have the JS side at
/// `mangaplay-studio/src/auth/transports/loopback-desktop.js` resolve
/// + pass them. Kept English-only for now because the page is
/// short-lived and the wiring affects a hot OAuth code path that
/// already works correctly.
///
/// `window.close()` self-close timer was removed — top-level navigation
/// tabs are not script-closable in Safari or Firefox (Chrome/Edge are
/// inconsistent), so the timer was a near-no-op anyway.
///
/// The mascot PNG is embedded at compile time via `include_bytes!` and
/// served as a `data:` URI so the page renders without a second loopback
/// request. Path is relative to THIS source file (src-tauri/src/lib.rs).
pub fn auth_success_page_html() -> String
{
    // Shim — preserves the pre-existing zero-arg ABI used by
    // `tests/auth_success_page.rs` and by `lib.rs` re-export. Delegates
    // to the neutral variant of the multi-variant renderer below.
    auth_callback_page_html(None)
}

/// Render the OAuth loopback callback page. Three variants:
///
/// - `None` — neutral "return to app" page (success path AND unknown
///   query). Preserved by `auth_success_page_html()` for callers that
///   pre-date error handling.
/// - `Some("access_denied")` / `Some("invalid_scope")` — cancelled /
///   permission-declined variant. Google returns the same
///   `access_denied` for both consent-cancel and per-scope decline;
///   `error_subtype` is a Microsoft AAD field and does not apply here.
/// - `Some(<other>)` — generic failure variant. The escaped `<other>`
///   is shown inline so the user (and support) can see what Google
///   sent back.
///
/// Copy stays English-hardcoded, matching the existing TODO at
/// `auth.rs:49-59`. If localisation lands later, this function grows
/// a locale-string parameter and the three-variant scheme survives.
pub fn auth_callback_page_html(error_code: Option<&str>) -> String
{
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    const MASCOT_PNG: &[u8] = include_bytes!("../../../src/img/master-foreground.png");
    let mascot_b64 = STANDARD.encode(MASCOT_PNG);

    let (heading, sentence) = match error_code
    {
        None => (
            "Return to Mangaplay Studio".to_string(),
            "Finishing sign-in in the app&hellip; You can close this tab.".to_string(),
        ),
        Some(code) if code == "access_denied" || code == "invalid_scope" => (
            "Sign-in cancelled".to_string(),
            "Sign-in was cancelled or a permission was declined \
             &mdash; return to Mangaplay Studio to try again.".to_string(),
        ),
        Some(code) => (
            "Sign-in didn't finish".to_string(),
            format!(
                "Sign-in failed (<code>{}</code>) &mdash; return to Mangaplay Studio to try again.",
                html_escape(code)
            ),
        ),
    };

    // Raw string uses TWO hash delimiters because the HTML body contains
    // `"#hexcolor"` patterns (e.g. `fill="#4285F4"`) which would close a
    // single-hash `r#"..."#` literal at the first `"#` sequence.
    // `format!` requires CSS / JS braces to be doubled (`{{` / `}}`).
    format!(r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mangaplay Studio</title>
<style>
:root {{ color-scheme: light dark; }}
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
       display: flex; flex-direction: column; align-items: center;
       justify-content: center; min-height: 100vh; margin: 0;
       background: #fafafa; color: #222; padding: 32px; text-align: center; }}
@media (prefers-color-scheme: dark) {{
    body {{ background: #111; color: #eee; }}
}}
.logo {{ width: 160px; height: auto; margin-bottom: 24px; }}
h1 {{ font-size: 24px; font-weight: 600; margin: 0 0 12px; }}
p {{ font-size: 16px; color: #666; max-width: 360px; line-height: 1.5; }}
code {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
       font-size: 0.9em; padding: 1px 5px; border-radius: 3px;
       background: rgba(0,0,0,0.06); }}
@media (prefers-color-scheme: dark) {{
    p {{ color: #aaa; }}
    code {{ background: rgba(255,255,255,0.08); }}
}}
</style>
</head>
<body>
<img class="logo" alt="Mangaplay Studio" src="data:image/png;base64,{mascot}">
<h1>{heading}</h1>
<p>{sentence}</p>
</body>
</html>"##, mascot = mascot_b64, heading = heading, sentence = sentence)
}

/// Extract the `error=<code>` value from a raw HTTP request-line
/// path+query like `/?error=access_denied&state=…`. Returns `None`
/// when no `error` param is present. Google only ever emits ASCII
/// identifier codes (`access_denied`, `invalid_scope`, etc.) so we
/// deliberately do NOT pull in a full `url` crate for percent-decode
/// — only `+` → space normalisation is applied.
fn extract_error_param(path_and_query: &str) -> Option<String>
{
    let (_, query) = path_and_query.split_once('?')?;
    for pair in query.split('&')
    {
        if let Some((k, v)) = pair.split_once('=')
        {
            if k == "error"
            {
                return Some(v.replace('+', " "));
            }
        }
    }
    None
}

/// Minimal HTML escape — sufficient for interpolating an untrusted
/// `error_code` string into a `<code>` element in the callback page.
fn html_escape(s: &str) -> String
{
    s.replace('&', "&amp;")
     .replace('<', "&lt;")
     .replace('>', "&gt;")
     .replace('"', "&quot;")
     .replace('\'', "&#39;")
}

/// OAuth loopback listener (RFC 8252 §7.3).
///
/// Binds 127.0.0.1 on an ephemeral port, spawns a thread that accepts ONE
/// HTTP GET request, parses the `code` + `state` query params, returns an
/// inline-rendered HTML success page, then emits `app:auth-redirect`
/// with `{ id, url }`. 60-second hard timeout — if no redirect arrives,
/// the listener is dropped and the JS side observes a timeout.
///
/// MUST bind to 127.0.0.1 specifically (not 0.0.0.0) — RFC 8252 §8.3
/// (loopback MITM mitigation on multi-user boxes).
#[tauri::command]
pub fn auth_listen_loopback(app: tauri::AppHandle) -> Result<serde_json::Value, String>
{
    use std::io::{BufRead, BufReader, Write as IoWrite};
    use std::net::TcpListener;
    use std::time::Duration;

    // Web-type OAuth client requires byte-exact redirect URI match — Google
    // no longer permits ephemeral loopback ports as it did for Desktop-type
    // clients. Two fixed ports are registered on the client: 9876 primary
    // and 9877 fallback. Both use path `/auth-callback`.
    let (listener, port) = match TcpListener::bind("127.0.0.1:9876")
    {
        Ok(l) => (l, 9876u16),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse =>
        {
            match TcpListener::bind("127.0.0.1:9877")
            {
                Ok(l) => (l, 9877u16),
                Err(e2) if e2.kind() == std::io::ErrorKind::AddrInUse =>
                {
                    return Err("bind failed: both ports 9876 and 9877 in use".to_string());
                }
                Err(e2) => return Err(format!("bind failed: {}", e2)),
            }
        }
        Err(e) => return Err(format!("bind failed: {}", e)),
    };
    let redirect_uri = format!("http://127.0.0.1:{}/auth-callback", port);
    let id = uuid::Uuid::new_v4().to_string();
    let id_for_thread = id.clone();
    let _redirect_uri_clone = redirect_uri.clone();

    // Set blocking mode BEFORE inserting the abort flag — if this fails
    // we return Err without ever spawning the thread, and no HashMap
    // entry is created. Inserting before the last fallible step would
    // leak the entry for process lifetime (guard is constructed inside
    // the spawned thread, which never runs on this error path).
    listener
        .set_nonblocking(false)
        .map_err(|e| format!("set_nonblocking failed: {}", e))?;

    // Register an abort flag for this listener id BEFORE spawning the
    // accept thread so a JS-side `abortInteractiveSignIn()` racing the
    // spawn can still find and flip it. Guard-drop in the spawned
    // thread removes the entry on every exit path.
    let abort_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = abort_flags().lock().map_err(|e| e.to_string())?;
        flags.insert(id.clone(), abort_flag.clone());
    }

    std::thread::spawn(move || {
        // RAII guard — removes the HashMap entry when this thread exits
        // via ANY path (accept success, timeout, abort, panic-caught
        // early return). No naked `remove` calls anywhere below.
        let _abort_guard = AbortFlagGuard { id: id_for_thread.clone() };

        // 60-second deadline. Accept one connection, parse the request
        // line, send the success page, then close. Break early on abort.
        let _ = listener.set_nonblocking(true);
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        let mut stream_opt = None;
        while std::time::Instant::now() < deadline {
            // Precedence: an accept() that already succeeded in the
            // previous iteration wins even if the abort flag flipped a
            // millisecond later — see the `Some(stream)` branch below,
            // which never checks the flag. This bare `load` runs BEFORE
            // the next `accept()` call, closing the socket without
            // emitting the redirect event once the flag is set.
            if abort_flag.load(Ordering::Relaxed) { break; }
            match listener.accept() {
                Ok((s, _)) => { stream_opt = Some(s); break; }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    log::warn!("[auth] loopback accept error: {}", e);
                    return;
                }
            }
        }

        // Precedence rule: if we DID accept a connection, the redirect
        // wins even when the abort flag flipped in the same tick. The
        // successful redirect is already in-flight from Google; emitting
        // "aborted" now would cause the JS side to classify a valid
        // sign-in as user_cancelled. Only fall into the aborted branch
        // when `stream_opt` is None (loop exited via the flag or the
        // deadline, not via accept success).
        let Some(mut stream) = stream_opt else {
            if abort_flag.load(Ordering::Relaxed) {
                log::info!("[auth] loopback aborted by user");
                let _ = app.emit("app:auth-redirect", serde_json::json!({
                    "id": id_for_thread,
                    "url": serde_json::Value::Null,
                    "aborted": true
                }));
            } else {
                log::info!("[auth] loopback timed out waiting for redirect");
                let _ = app.emit("app:auth-redirect", serde_json::json!({
                    "id": id_for_thread,
                    "url": serde_json::Value::Null,
                    "timeout": true
                }));
            }
            return;
        };

        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

        let mut reader = BufReader::new(match stream.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        });
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).is_err() { return; }

        // Drain remaining headers.
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).is_err() { break; }
            if header.trim().is_empty() { break; }
        }

        let parts: Vec<&str> = request_line.trim().splitn(3, ' ').collect();
        if parts.len() < 2 { return; }
        let path_and_query = parts[1];

        // Reconstruct the full redirect URL.
        let full_url = format!("http://127.0.0.1:{}{}", port, path_and_query);

        // Render the callback page per the query — cancelled variant
        // for `access_denied`/`invalid_scope`, generic variant for any
        // other `error=<code>`, neutral variant otherwise.
        let error_code = extract_error_param(path_and_query);
        let body = auth_callback_page_html(error_code.as_deref());
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();

        // Raise the main window BEFORE emitting the redirect event so the
        // user's attention shifts back to the app while JS exchanges the
        // code for tokens. Any downstream failure (network drop, BFF 5xx,
        // keyring write fail, sub mismatch) then surfaces in the app UI
        // with the window already focused — the browser tab no longer
        // claims success on its own.
        if let Some(win) = app.get_webview_window("main") {
            #[cfg(desktop)]
            let _ = win.unminimize();
            let _ = win.set_focus();
        }

        let _ = app.emit("app:auth-redirect", serde_json::json!({
            "id": id_for_thread,
            "url": full_url,
            "timeout": false
        }));
    });

    Ok(serde_json::json!({
        "id": id,
        "port": port,
        "redirect_uri": redirect_uri
    }))
}

/// Signal an in-flight `auth_listen_loopback` to abort its accept-poll
/// loop and release the socket immediately. Idempotent — repeated calls
/// with the same id are safe; a call for an id that has already exited
/// (completed / timed out) returns `Ok(false)` rather than an error.
///
/// The listener thread emits `app:auth-redirect` with `{ aborted: true }`
/// on the way out, which the JS transport maps to a `AbortedError` →
/// `auth.user_cancelled` classification. The Cancel button in Settings→
/// Account and Publish→Login funnel through here.
#[tauri::command]
pub fn auth_abort_loopback(id: String) -> Result<bool, String>
{
    let flags = abort_flags().lock().map_err(|e| e.to_string())?;
    match flags.get(&id)
    {
        Some(flag) =>
        {
            flag.store(true, Ordering::Relaxed);
            Ok(true)
        }
        // Unknown id — the listener already exited (timed out, completed
        // successfully, or aborted on a previous call). Not an error;
        // the JS side treats "no in-flight" as a no-op.
        None => Ok(false),
    }
}

/// Bring the main window forward — used by the JS auth path when an
/// OAuth flow finishes (success OR failure) so the user sees the
/// outcome even if the app was occluded behind the browser. Best-
/// effort: any of `unminimize` / `set_focus` may be denied by the
/// platform's focus-steal policy (notably GNOME / macOS), in which case
/// `request_user_attention` flags the dock/taskbar entry as a fallback.
#[tauri::command]
pub fn auth_raise_window(app: tauri::AppHandle) -> Result<(), String>
{
    let win = app.get_webview_window("main")
        .ok_or_else(|| "main window not available".to_string())?;
    #[cfg(desktop)]
    {
        let _ = win.unminimize();
        let _ = win.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
    let _ = win.set_focus();
    Ok(())
}

/// Open the OAuth authorization URL in the user's default browser.
/// On desktop, delegates to tauri-plugin-opener. On mobile (future),
/// route through tauri-plugin-web-auth (ASWebAuthenticationSession on iOS,
/// Chrome Custom Tabs on Android) — for now mobile builds return an error
/// so misrouting is caught at compile time, not silently broken.
///
/// Linux fallback: tauri-plugin-opener already wraps `xdg-open` internally,
/// so a re-spawn of `xdg-open` on failure adds nothing. The real win is
/// honouring the POSIX `$BROWSER` env var FIRST — distros, dotfile setups
/// and corporate-locked machines often set it explicitly. Under Flatpak
/// or Snap the spawned binary still runs inside the sandbox; we detect
/// `FLATPAK_ID` / `SNAP` and tag the error message so support can
/// disambiguate "no browser configured" from "sandbox blocked launch."
#[tauri::command]
pub async fn auth_open_browser(app: tauri::AppHandle, url: String) -> Result<(), String>
{
    #[cfg(desktop)]
    {
        use tauri_plugin_opener::OpenerExt;

        #[cfg(target_os = "linux")]
        {
            // Try $BROWSER first. Per POSIX convention the value can be a
            // colon-separated list — try each in order, stopping at the
            // first successful spawn.
            if let Ok(browser_var) = std::env::var("BROWSER") {
                for candidate in browser_var.split(':').filter(|s| !s.is_empty()) {
                    match std::process::Command::new(candidate).arg(&url).spawn() {
                        Ok(_) => return Ok(()),
                        Err(e) => log::debug!("[auth] $BROWSER candidate '{}' failed: {}", candidate, e),
                    }
                }
            }

            // Fall through to plugin opener::open_url() — wraps xdg-open / portal.
            if let Err(e) = app.opener().open_url(&url, None::<&str>) {
                let sandbox = if std::env::var("FLATPAK_ID").is_ok() { " (Flatpak)" }
                              else if std::env::var("SNAP").is_ok() { " (Snap)" }
                              else { "" };
                return Err(format!("Could not open browser{}: {}", sandbox, e));
            }
            return Ok(());
        }

        #[cfg(not(target_os = "linux"))]
        {
            app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string())
        }
    }
    #[cfg(mobile)]
    {
        let _ = app;
        let _ = url;
        Err("mobile-not-yet-wired: add tauri-plugin-web-auth".to_string())
    }
}

/// Get a value from the OS credential vault. Returns `null` if not set.
/// Linux cascade: secret-service first, keyutils fallback if libsecret
/// has no default collection (headless / WSL boxes).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn auth_token_store_get(account: String) -> Result<Option<String>, String>
{
    let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| format!("keyring entry init failed: {}", e))?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            log::warn!("[auth] keyring get failed: {}", e);
            Ok(None)
        }
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn auth_token_store_get(_account: String) -> Result<Option<String>, String>
{
    Err("mobile_storage_not_implemented: refresh-token persistence on mobile is deferred — see TODO/AuthRefreshToken/06".to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn auth_token_store_set(account: String, value: String) -> Result<(), String>
{
    let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| format!("keyring entry init failed: {}", e))?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn auth_token_store_set(_account: String, _value: String) -> Result<(), String>
{
    Err("mobile_storage_not_implemented: refresh-token persistence on mobile is deferred — see TODO/AuthRefreshToken/06".to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn auth_token_store_clear(account: String) -> Result<(), String>
{
    let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| format!("keyring entry init failed: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn auth_token_store_clear(_account: String) -> Result<(), String>
{
    // Idempotent on platforms where storage doesn't exist — nothing to
    // clear. Returning Ok() rather than the not-implemented error so
    // signOut() succeeds gracefully on mobile even though sign-in itself
    // is blocked.
    Ok(())
}
