//! Google Drive Picker — native command.
//!
//! Opens the Google Drive Picker in the user's system browser via the
//! `trigger_onepick=true` OAuth flow, waits for the return callback, and
//! hands the raw exchange payload back to JS. JS finishes the token
//! exchange against `https://api.absolutelyskint.com/v2/picker/exchange`.
//!
//! Transport is chosen at call time from the runtime OS:
//!
//! - Desktop (`windows` / `macos` / `linux`) — ephemeral loopback on
//!   `127.0.0.1:0`, RFC 8252 §7.3. Return URI encoded in the signed
//!   `state` blob at the bridge server. Modelled on
//!   `commands/auth.rs::auth_listen_loopback` but with a distinct event
//!   name so an in-flight sign-in's callback is never stolen.
//! - Mobile (`android` / `ios`) — deep-link `mangaplay://picker-callback`.
//!   Wiring is Phase 5; this command currently returns a
//!   `picker_transport_not_wired` error on those platforms so the
//!   command still links but is a clear no-op.
//!
//! Debounce — a module-level `PICKER_IN_FLIGHT: AtomicBool` guarded by a
//! Drop-guard prevents rage-clicks from spawning multiple browser tabs.
//! Second call while true returns `picker_already_in_flight`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write as IoWrite};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::pending_pick::{self, PendingPick};

// ─────────────────────────────────────────────────────────────────────────
// Debounce
// ─────────────────────────────────────────────────────────────────────────

/// Global in-flight guard. Set synchronously before the browser opens;
/// cleared on ALL exit paths (resolve, cancel, timeout, error) via the
/// `InFlightGuard` Drop impl below.
static PICKER_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// RAII clearer for `PICKER_IN_FLIGHT`. Constructing this after a
/// successful `compare_exchange(false → true)` guarantees the flag is
/// released even on early-return / `?` propagation / panic-unwind.
///
/// Also unlinks the durable pending-pick JSON on drop
/// (`android-prereq-durable-pending`) — every non-panicking exit path
/// (resolve, cancel, timeout, error) tears the flag AND the file down
/// together so a next-boot resurrection never sees a stale entry from a
/// completed session.
struct InFlightGuard
{
    app: Option<tauri::AppHandle>,
}

impl Drop for InFlightGuard
{
    fn drop(&mut self)
    {
        PICKER_IN_FLIGHT.store(false, Ordering::Release);
        if let Some(app) = self.app.take()
        {
            if let Err(e) = pending_pick::clear(&app)
            {
                log::warn!("pending-pick clear failed: {}", e);
            }
        }
    }
}

/// Test-only introspection so integration tests can assert clean release.
#[doc(hidden)]
pub fn picker_in_flight_for_test() -> bool
{
    PICKER_IN_FLIGHT.load(Ordering::Acquire)
}

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

/// Command input. `kind` is informational (analytics side); Rust only
/// forwards `mimetypes` and `allow_multiple` to the bridge server.
#[derive(Debug, Deserialize)]
pub struct PickerArgs
{
    #[serde(default)]
    #[allow(dead_code)]
    pub kind: Option<String>,
    #[serde(default)]
    pub mimetypes: Vec<String>,
    #[serde(default)]
    pub allow_multiple: bool,
    #[serde(default)]
    pub hint: Option<String>,
}

/// Callback payload handed back to JS. JS finishes the exchange against
/// `/v2/picker/exchange` — we deliberately do NOT ship the tokens across
/// the bridge from Rust so we can reuse the existing JS fetch layer +
/// error-classifier and avoid pulling `reqwest`/`ureq` into src-tauri.
#[derive(Debug, Serialize)]
pub struct PickerResult
{
    /// PKCE verifier generated in Rust, needed for the JS exchange.
    pub code_verifier: String,
    /// Return URI Google will 302 to after the picker resolves (via the
    /// api.absolutelyskint.com bridge). Must be sent verbatim to the
    /// exchange endpoint — Google's redirect_uri check is byte-exact.
    pub redirect_uri: String,
    /// Google's authorization code — one-shot, valid ~10 minutes.
    pub code: String,
    /// File IDs the user picked. Comma-joined by Google; parsed here.
    pub picked_file_ids: Vec<String>,
    /// Distinct event name used for the emit — echoed back so callers
    /// can distinguish concurrent picker sessions if we ever go plural.
    pub event_name: String,
}

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/// Bridge server root. Matches the client-registry allow-list on
/// api.absolutelyskint.com — must NOT be changed without a coordinated
/// deploy of `pickerReturnUris` on the server.
const PICKER_START_URL: &str = "https://api.absolutelyskint.com/v2/picker/start";

/// Same OAuth client as `google-oauth.js` (Windows Web type, mangaplaystudio
/// GCP project). Repeated here rather than imported because Rust has no
/// runtime access to JS module state; kept in sync manually — the value
/// is a public identifier, not a secret.
const OAUTH_CLIENT_ID: &str =
    "661305516089-nk6i26qc8hlk0c37f9ucadjstq0isuhr.apps.googleusercontent.com";

/// Hard timeout for the whole browser round-trip. Google's `trigger_onepick`
/// beta caps `state` freshness at 10 min server-side; we cap at 5 min so
/// a stale bridge callback never lands on a listener that's already gone.
const PICKER_TIMEOUT: Duration = Duration::from_secs(300);

// ─────────────────────────────────────────────────────────────────────────
// PKCE helpers
// ─────────────────────────────────────────────────────────────────────────

/// Base64url-encode without padding. Matches `pkce.js::generateCodeVerifier`
/// so a Rust-generated verifier is byte-compatible with what the JS side
/// expects from a `_exchangeCodeForToken`-style caller.
fn b64url(bytes: &[u8]) -> String
{
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.encode(bytes)
}

/// 64 random bytes → base64url (86 chars). Within RFC 7636 43-128.
fn generate_code_verifier() -> String
{
    let mut buf = [0u8; 64];
    // `uuid::Uuid::new_v4()` seeds from `getrandom` — reuse it twice
    // rather than pulling `rand` into the tree. Same entropy source
    // as the loopback id generation.
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let c = uuid::Uuid::new_v4();
    let d = uuid::Uuid::new_v4();
    buf[0..16].copy_from_slice(a.as_bytes());
    buf[16..32].copy_from_slice(b.as_bytes());
    buf[32..48].copy_from_slice(c.as_bytes());
    buf[48..64].copy_from_slice(d.as_bytes());
    b64url(&buf)
}

/// SHA-256 of the verifier → base64url. Sent as `code_challenge` with
/// `code_challenge_method=S256`. Mirrors `pkce.js::codeChallenge`.
fn code_challenge(verifier: &str) -> String
{
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(verifier.as_bytes());
    let digest = h.finalize();
    b64url(&digest)
}

// ─────────────────────────────────────────────────────────────────────────
// URL encoding
// ─────────────────────────────────────────────────────────────────────────

/// Minimal RFC 3986 percent-encode for query values. Deliberately not
/// pulling `url` into the always-on dep tree — only used for a fixed
/// set of parameters we control (redirect_uri, mimetypes, code_challenge).
fn pct(s: &str) -> String
{
    let mut out = String::with_capacity(s.len());
    for b in s.bytes()
    {
        match b
        {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' =>
            {
                out.push(b as char);
            }
            _ =>
            {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────
// Query parsing
// ─────────────────────────────────────────────────────────────────────────

/// Parse `?a=1&b=2` (or `foo?a=1&b=2`) into a map. Percent-decodes
/// values (`+` → space, `%NN` → byte). Best-effort; malformed keys are
/// dropped rather than errored — the caller inspects specific keys.
fn parse_query(path_and_query: &str) -> HashMap<String, String>
{
    let mut out = HashMap::new();
    let query = match path_and_query.split_once('?')
    {
        Some((_, q)) => q,
        None => return out,
    };
    for pair in query.split('&')
    {
        if let Some((k, v)) = pair.split_once('=')
        {
            out.insert(k.to_string(), pct_decode(v));
        }
    }
    out
}

fn pct_decode(s: &str) -> String
{
    // `+` → space, `%NN` → byte, else passthrough.
    let bytes = s.replace('+', " ");
    let bytes = bytes.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len()
    {
        if bytes[i] == b'%' && i + 2 < bytes.len()
        {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo)
            {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ─────────────────────────────────────────────────────────────────────────
// Deep-link transport (mobile) — pending-sender registry
// ─────────────────────────────────────────────────────────────────────────
//
// Correlation model — an in-flight `picker_open` on Android/iOS pre-registers
// a `SyncSender<CallbackPayload>` under its unique `event_name` (the same
// name Google echoes back on the `mangaplay://picker-callback?event=...`
// URL). When the deep-link fires, `handle_deep_link_callback` parses the
// URL, looks up the sender, forwards the payload, then removes the entry.
//
// Why `std::sync::mpsc::SyncSender` rather than `tokio::sync::oneshot` —
// we already avoid the tokio direct-dep cost (see `tauri::async_runtime`
// indirection elsewhere in this file) and a bounded channel of capacity 1
// gives the same "one-shot" semantics: send is non-blocking, the receiver
// only reads once.
//
// The map key is the FULL `event_name` (e.g. `app:picker-redirect-<uuid>`),
// not a bare nonce, so a stale deep-link firing after a previous session
// has already resolved can't land on a fresh session by accident — a UUID
// collision would need to reuse the entire event-name string.

/// One-shot payload delivered by the deep-link handler to the mobile-side
/// `picker_open` awaiter. Mirrors the fields the loopback transport
/// extracts from its GET query — `code` + `picked_file_ids`.
#[derive(Debug)]
struct CallbackPayload
{
    code: String,
    picked_file_ids: Vec<String>,
}

/// Global registry — `event_name` → one-shot sender. `OnceLock` so
/// initialisation is lazy + thread-safe without an `unsafe` static-init
/// dance. `Mutex` because insert/remove happen from different threads
/// (`picker_open` on the async worker; `handle_deep_link_callback` from
/// `on_open_url` which fires on the Tauri main thread).
static PENDING_SENDERS: OnceLock<Mutex<HashMap<String, SyncSender<CallbackPayload>>>> =
    OnceLock::new();

fn pending_senders() -> &'static Mutex<HashMap<String, SyncSender<CallbackPayload>>>
{
    PENDING_SENDERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Install a sender under `event_name`. Overwrites any prior entry with
/// the same key — a second `picker_open` for the same event name would be
/// an internal bug, but rather than panic we prefer the newer sender to
/// win so the old (orphaned) awaiter times out cleanly.
fn register_pending(event_name: String, tx: SyncSender<CallbackPayload>)
{
    if let Ok(mut map) = pending_senders().lock()
    {
        map.insert(event_name, tx);
    }
}

/// Remove a sender by `event_name`. Called on every exit path in
/// `picker_open` (resolve/reject/timeout) via `PendingSenderGuard`.
fn unregister_pending(event_name: &str)
{
    if let Ok(mut map) = pending_senders().lock()
    {
        map.remove(event_name);
    }
}

/// RAII cleanup for a pending sender. If the awaiter is dropped before
/// the deep-link fires (timeout / error), we still want the map cleaned.
struct PendingSenderGuard
{
    event_name: String,
}

impl Drop for PendingSenderGuard
{
    fn drop(&mut self)
    {
        unregister_pending(&self.event_name);
    }
}

/// Public entry point invoked from `lib.rs::on_open_url` when the incoming
/// URL matches `mangaplay://picker-callback`. Non-picker `mangaplay://`
/// URLs must never reach here.
///
/// Parses the query, resolves the sender by `event=` param, forwards
/// `{ code, picked_file_ids }`. Missing / unknown event name → drop
/// silently; the awaiter (if any) will time out on its own. This keeps
/// the deep-link path idempotent — a rogue duplicate delivery from the
/// OS is harmless.
pub fn handle_deep_link_callback(url: &str)
{
    // Accept both `mangaplay://picker-callback?...` and
    // `mangaplay://picker-callback/?...` (Android's URI normaliser
    // sometimes inserts a trailing slash). Split on the first `?`.
    let Some((_, query_str)) = url.split_once('?') else
    {
        log::warn!("picker deep-link had no query string: {}", url);
        return;
    };
    // `parse_query` expects a path-prefixed input; synthesise one so we
    // can reuse the existing helper untouched.
    let synthetic = format!("/picker-callback?{}", query_str);
    let query = parse_query(&synthetic);

    let event = match query.get("event")
    {
        Some(e) if !e.is_empty() => e.clone(),
        _ =>
        {
            log::warn!("picker deep-link missing `event` param: {}", url);
            return;
        }
    };

    let picked_file_ids = query
        .get("picked_file_ids")
        .map(|s| {
            s.split(',')
                .filter(|x| !x.is_empty())
                .map(|x| x.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let code = query
        .get("code")
        .cloned()
        .unwrap_or_default();

    // Look up + remove the sender in a single lock scope so a second
    // delivery finds nothing (idempotency).
    let tx_opt = {
        match pending_senders().lock()
        {
            Ok(mut map) => map.remove(&event),
            Err(_) => None,
        }
    };

    match tx_opt
    {
        Some(tx) =>
        {
            let payload = CallbackPayload { code, picked_file_ids };
            if let Err(e) = tx.send(payload)
            {
                // Receiver already dropped — awaiter timed out between
                // the map lookup and here. Non-fatal.
                log::warn!("picker deep-link send failed for {}: {}", event, e);
            }
        }
        None =>
        {
            log::info!(
                "picker deep-link dropped — no awaiter for event={}",
                event
            );
        }
    }
}

/// Install a listener for a resurrected pending pick.
///
/// Called from `lib.rs::setup()` when `pending_pick::load_if_fresh()`
/// returns an entry — Android may have killed the app while the user was
/// still in the browser, so the deep-link is queued by the OS for
/// delivery after the new process is up. We register a one-shot sender
/// under the same `event_name` BEFORE any `app:ready`-style JS event
/// fires, then spawn a background waiter that:
///
/// - Emits `app:picker-resurrected` with the callback payload if the
///   deep-link arrives within `PICKER_TIMEOUT`.
/// - Clears the pending file + logs a diagnostic if the timeout elapses
///   (the queued intent never fired — user cancelled from browser, or
///   OS dropped the intent).
///
/// Note the intentional narrowness — this function does NOT try to
/// re-run the OAuth exchange. That's a JS concern; the resurrected event
/// carries the raw `{ code, picked_file_ids, code_verifier, return_uri,
/// event_name }` payload so JS can complete `/v2/picker/exchange`
/// exactly as it would on the live path.
pub fn register_resurrected_pending(app: &tauri::AppHandle, entry: PendingPick)
{
    let (tx, rx) = sync_channel::<CallbackPayload>(1);
    let event_name = entry.event_name.clone();
    register_pending(event_name.clone(), tx);

    let app = app.clone();
    let pending = entry;
    std::thread::spawn(move || {
        // Block on the channel with a matching freshness cap. The
        // `PENDING_SENDERS` registry entry is removed either by
        // `handle_deep_link_callback` (on delivery) or by the timeout
        // branch below.
        let outcome = rx.recv_timeout(PICKER_TIMEOUT);
        // Always cleanup registry — timeout OR receive both mean the
        // event_name is no longer live.
        unregister_pending(&event_name);

        match outcome
        {
            Ok(payload) =>
            {
                log::info!(
                    "picker resurrected — event={} ids={}",
                    event_name,
                    payload.picked_file_ids.len()
                );
                let emit_payload = serde_json::json!({
                    "event_name": event_name,
                    "code": payload.code,
                    "picked_file_ids": payload.picked_file_ids,
                    "code_verifier": pending.code_verifier,
                    "return_uri": pending.return_uri,
                    "kind": pending.kind,
                });
                let _ = app.emit("app:picker-resurrected", emit_payload);
                if let Err(e) = pending_pick::clear(&app)
                {
                    log::warn!(
                        "pending-pick clear after resurrection failed: {}",
                        e
                    );
                }
            }
            Err(_) =>
            {
                log::info!(
                    "picker resurrection timed out — event={} (age={}s at start)",
                    event_name,
                    pending.age_secs()
                );
                if let Err(e) = pending_pick::clear(&app)
                {
                    log::warn!(
                        "pending-pick clear after resurrection timeout failed: {}",
                        e
                    );
                }
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Loopback transport (desktop)
// ─────────────────────────────────────────────────────────────────────────

/// Result of the browser round-trip. `Received(code, ids)` → success;
/// other variants funnel to distinct error strings in `picker_open`.
enum CallbackOutcome
{
    Received { code: String, picked_file_ids: Vec<String> },
    TimedOut,
    Malformed(String),
    AcceptError(String),
}

/// Bind an ephemeral loopback socket + run the accept loop until either
/// a picker callback arrives or `PICKER_TIMEOUT` elapses. Returns the
/// bound port so the caller can compose the redirect URI, and a boxed
/// closure that blocks on the outcome — separating the two lets us set
/// `state` (which encodes the port) BEFORE we spawn the accept thread.
///
/// NOT a hyper server — matches `auth_listen_loopback`'s std-only
/// pattern for parity + zero-dep-cost. Existing OAuth loopback has run
/// this way in production for months.
fn bind_loopback() -> Result<TcpListener, String>
{
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind failed: {}", e))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("set_nonblocking failed: {}", e))?;
    // NOTE: SO_REUSEADDR left at OS default (false on Windows). Rebinding
    // an ephemeral port after a stale close is not a concern here — the
    // kernel assigns a fresh port on every `picker_open` call — and the
    // Windows-specific "stale bind lingering" case only bites long-lived
    // listeners. Explicit `set_reuse_address(false)` would need a
    // socket2 dep; not worth the weight.
    Ok(listener)
}

/// Block on the loopback accept loop. Runs on the caller's thread —
/// `picker_open` is `async` so Tauri runs it on the runtime worker pool
/// and blocking here does not stall the WebView. Mirrors the pattern in
/// `auth_listen_loopback` (which uses `std::thread::spawn` because that
/// command is sync + emit-based; here we can just block).
fn wait_for_callback(listener: TcpListener) -> CallbackOutcome
{
    let deadline = Instant::now() + PICKER_TIMEOUT;
    let mut stream_opt = None;

    while Instant::now() < deadline
    {
        match listener.accept()
        {
            Ok((s, _)) =>
            {
                stream_opt = Some(s);
                break;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) =>
            {
                return CallbackOutcome::AcceptError(e.to_string());
            }
        }
    }

    let Some(mut stream) = stream_opt else
    {
        return CallbackOutcome::TimedOut;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

    let mut reader = match stream.try_clone()
    {
        Ok(s) => BufReader::new(s),
        Err(e) => return CallbackOutcome::AcceptError(e.to_string()),
    };

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err()
    {
        return CallbackOutcome::Malformed("empty request".to_string());
    }
    // Drain headers.
    loop
    {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() { break; }
        if header.trim().is_empty() { break; }
    }

    let parts: Vec<&str> = request_line.trim().splitn(3, ' ').collect();
    if parts.len() < 2
    {
        return CallbackOutcome::Malformed("no path in request line".to_string());
    }
    let query = parse_query(parts[1]);

    let response = "HTTP/1.1 302 Found\r\nLocation: https://mangaplay.studio/picker-return\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();

    // Google's `picked_file_ids` is comma-joined even for a single pick.
    let picked = query
        .get("picked_file_ids")
        .map(|s| {
            s.split(',')
                .filter(|x| !x.is_empty())
                .map(|x| x.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let code = match query.get("code")
    {
        Some(c) if !c.is_empty() => c.clone(),
        _ =>
        {
            // Google returned `error=access_denied` or similar — surface
            // it verbatim so the JS classifier can bucket it. When the
            // bridge omits `error` too, we synthesise `no_code`.
            let err = query
                .get("error")
                .cloned()
                .unwrap_or_else(|| "no_code".to_string());
            return CallbackOutcome::Malformed(err);
        }
    };

    CallbackOutcome::Received { code, picked_file_ids: picked }
}

// ─────────────────────────────────────────────────────────────────────────
// URL construction
// ─────────────────────────────────────────────────────────────────────────

fn build_start_url(
    return_uri: &str,
    challenge: &str,
    mimetypes: &[String],
    allow_multiple: bool,
    event_name: &str,
    kind: Option<&str>,
    hint: Option<&str>,
) -> String
{
    let mut url = format!(
        "{start}?client_id={cid}&return_uri={ru}&code_challenge={cc}&code_challenge_method=S256&event_name={ev}&allow_multiple={am}",
        start = PICKER_START_URL,
        cid = pct(OAUTH_CLIENT_ID),
        ru = pct(return_uri),
        cc = pct(challenge),
        ev = pct(event_name),
        am = if allow_multiple { "true" } else { "false" },
    );
    if !mimetypes.is_empty()
    {
        let joined = mimetypes.join(",");
        url.push_str("&mimetypes=");
        url.push_str(&pct(&joined));
    }
    if let Some(k) = kind
    {
        url.push_str("&kind=");
        url.push_str(&pct(k));
    }
    if let Some(h) = hint
    {
        if !h.is_empty()
        {
            url.push_str("&login_hint=");
            url.push_str(&pct(h));
        }
    }
    url
}

// ─────────────────────────────────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────────────────────────────────

/// Open the Google Drive Picker, wait for the callback, and return the
/// raw exchange inputs. JS finishes the token exchange.
///
/// Error strings (matched by `picker-client.js`):
///
/// - `picker_already_in_flight` — a previous `picker_open` is still
///   awaiting a callback.
/// - `picker_transport_not_wired` — Android / iOS deep-link transport
///   ships in Phase 5; the command exists on those targets so JS can
///   still call it, but returns this error immediately.
/// - `picker_cancelled:<google_error>` — Google reported an error via
///   the bridge callback (`access_denied`, `invalid_scope`, `no_code`).
/// - `picker_timeout` — no callback within `PICKER_TIMEOUT`.
/// - Anything else — Rust-side failure (bind, accept, malformed request).
#[tauri::command]
pub async fn picker_open(
    app: tauri::AppHandle,
    args: PickerArgs,
) -> Result<PickerResult, String>
{
    // Debounce — synchronous compare_exchange before any browser open.
    // Once we own the flag, the Drop guard releases it on every exit
    // path (Ok, Err, panic-unwind).
    if PICKER_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("picker_already_in_flight".to_string());
    }
    let _guard = InFlightGuard { app: Some(app.clone()) };

    // Runtime transport selection. Desktop → loopback; Android/iOS →
    // deep-link. Compile-time `#[cfg]` would break `generate_handler!`
    // parity across targets, so the branch is a runtime match.
    let os = tauri_plugin_os::platform();
    let is_mobile = matches!(os, "android" | "ios");

    // ── PKCE + event name ─────────────────────────────────────────────
    let code_verifier = generate_code_verifier();
    let challenge = code_challenge(&code_verifier);
    let event_name = format!("app:picker-redirect-{}", uuid::Uuid::new_v4());

    if is_mobile
    {
        return picker_open_mobile(
            app,
            args,
            code_verifier,
            challenge,
            event_name,
        )
        .await;
    }

    // ── Loopback bind ─────────────────────────────────────────────────
    let listener = bind_loopback().map_err(|e| format!("picker_bind_failed: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("picker_addr_failed: {}", e))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{}/picker-callback", port);

    // Durable pending-pick JSON (`android-prereq-durable-pending`).
    // Written BEFORE the browser opens so a crash between now and callback
    // still leaves resurrection breadcrumbs. Cleared by `InFlightGuard`
    // on every exit path.
    let issued_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let pending = PendingPick
    {
        event_name: event_name.clone(),
        code_verifier: code_verifier.clone(),
        return_uri: redirect_uri.clone(),
        kind: args.kind.clone(),
        issued_at,
    };
    if let Err(e) = pending_pick::save(&app, &pending)
    {
        // Non-fatal — resurrection is a nice-to-have on desktop and the
        // flow still completes via the live oneshot. Log + continue.
        log::warn!("pending-pick save failed: {}", e);
    }

    // ── Build start URL + open browser ────────────────────────────────
    let start_url = build_start_url(
        &redirect_uri,
        &challenge,
        &args.mimetypes,
        args.allow_multiple,
        &event_name,
        args.kind.as_deref(),
        args.hint.as_deref(),
    );

    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(&start_url, None::<&str>)
            .map_err(|e| format!("picker_open_browser_failed: {}", e))?;
    }

    // ── Wait for the callback ─────────────────────────────────────────
    // Run the blocking accept loop on a dedicated thread so the async
    // runtime worker isn't tied up. `tauri::async_runtime` is the
    // Tauri-blessed indirection over tokio + tauri's async runtime so
    // we don't add tokio as a direct dep.
    let outcome = tauri::async_runtime::spawn_blocking(move || wait_for_callback(listener))
        .await
        .map_err(|e| format!("picker_join_failed: {}", e))?;

    let (code, picked_file_ids) = match outcome
    {
        CallbackOutcome::Received { code, picked_file_ids } =>
        {
            (code, picked_file_ids)
        }
        CallbackOutcome::TimedOut =>
        {
            return Err("picker_timeout".to_string());
        }
        CallbackOutcome::Malformed(reason) =>
        {
            return Err(format!("picker_cancelled:{}", reason));
        }
        CallbackOutcome::AcceptError(msg) =>
        {
            return Err(format!("picker_accept_error: {}", msg));
        }
    };

    // Best-effort focus grab — mirror the auth loopback's UX shift so
    // the user's attention returns to the app while JS finishes the
    // exchange. Fire-and-forget event too so the JS side can log the
    // native round-trip time even before the exchange completes.
    let _ = app.emit(
        &event_name,
        serde_json::json!({
            "port": port,
            "picked_file_ids": picked_file_ids,
        }),
    );

    Ok(PickerResult
    {
        code_verifier,
        redirect_uri,
        code,
        picked_file_ids,
        event_name,
    })
}

// ─────────────────────────────────────────────────────────────────────────
// Deep-link transport (mobile) — command path
// ─────────────────────────────────────────────────────────────────────────

/// Mobile (Android/iOS) transport branch of `picker_open`. Registers a
/// `SyncSender` under `event_name`, opens the system browser at
/// `PICKER_START_URL`, blocks on the channel until either the deep-link
/// fires or `PICKER_TIMEOUT` elapses.
///
/// The caller (`picker_open`) already holds `InFlightGuard`, so the file
/// cleanup + `PICKER_IN_FLIGHT` release both happen when this returns.
/// The `PendingSenderGuard` here handles the deep-link-specific registry
/// cleanup on early return.
async fn picker_open_mobile(
    app: tauri::AppHandle,
    args: PickerArgs,
    code_verifier: String,
    challenge: String,
    event_name: String,
) -> Result<PickerResult, String>
{
    let return_uri = "mangaplay://picker-callback".to_string();

    // Persist BEFORE registering the sender + opening the browser — a
    // crash between here and the deep-link firing should still leave
    // enough breadcrumbs on disk for a next-boot resurrection.
    let issued_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let pending = PendingPick
    {
        event_name: event_name.clone(),
        code_verifier: code_verifier.clone(),
        return_uri: return_uri.clone(),
        kind: args.kind.clone(),
        issued_at,
    };
    if let Err(e) = pending_pick::save(&app, &pending)
    {
        log::warn!("pending-pick save failed: {}", e);
    }

    // Register the pending sender BEFORE opening the browser. The
    // deep-link handler will look this up when the callback fires.
    let (tx, rx) = sync_channel::<CallbackPayload>(1);
    register_pending(event_name.clone(), tx);
    let _sender_guard = PendingSenderGuard { event_name: event_name.clone() };

    // Build the start URL exactly as desktop does — the bridge doesn't
    // care whether the return_uri is loopback or a custom scheme, only
    // that it matches the `pickerReturnUris` allow-list on the server.
    let start_url = build_start_url(
        &return_uri,
        &challenge,
        &args.mimetypes,
        args.allow_multiple,
        &event_name,
        args.kind.as_deref(),
        args.hint.as_deref(),
    );

    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(&start_url, None::<&str>)
            .map_err(|e| format!("picker_open_browser_failed: {}", e))?;
    }

    // Block the async worker on the channel via `spawn_blocking` — the
    // deep-link handler runs on the Tauri main thread and calls
    // `tx.send()` which is instant, so the receive returns immediately
    // in the happy path.
    let payload = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(PICKER_TIMEOUT)
    })
    .await
    .map_err(|e| format!("picker_join_failed: {}", e))?;

    let payload = match payload
    {
        Ok(p) => p,
        Err(_) => return Err("picker_timeout".to_string()),
    };

    if payload.code.is_empty()
    {
        return Err("picker_cancelled:no_code".to_string());
    }

    let _ = app.emit(
        &event_name,
        serde_json::json!({
            "transport": "deep-link",
            "picked_file_ids": payload.picked_file_ids,
        }),
    );

    Ok(PickerResult
    {
        code_verifier,
        redirect_uri: return_uri,
        code: payload.code,
        picked_file_ids: payload.picked_file_ids,
        event_name,
    })
}

// ─────────────────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests
{
    use super::*;

    #[test]
    fn b64url_no_padding()
    {
        assert_eq!(b64url(b""), "");
        assert_eq!(b64url(b"f"), "Zg");
        assert_eq!(b64url(b"fo"), "Zm8");
        assert_eq!(b64url(b"foo"), "Zm9v");
    }

    #[test]
    fn code_verifier_length()
    {
        // 64 bytes base64url-no-pad = ceil(64/3)*4 minus padding = 86.
        assert_eq!(generate_code_verifier().len(), 86);
    }

    #[test]
    fn code_challenge_matches_known_vector()
    {
        // RFC 7636 Appendix B test vector.
        let v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(v),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn pct_encodes_reserved()
    {
        assert_eq!(pct("hello world"), "hello%20world");
        assert_eq!(pct("a/b"), "a%2Fb");
        assert_eq!(pct("a.b_c-d~e"), "a.b_c-d~e");
    }

    #[test]
    fn parse_query_extracts_pairs()
    {
        let m = parse_query("/picker-callback?code=abc&picked_file_ids=1%2C2%2C3");
        assert_eq!(m.get("code").map(String::as_str), Some("abc"));
        assert_eq!(m.get("picked_file_ids").map(String::as_str), Some("1,2,3"));
    }

    #[test]
    fn parse_query_no_query_string()
    {
        let m = parse_query("/picker-callback");
        assert!(m.is_empty());
    }

    #[test]
    fn build_start_url_includes_mimetypes_when_present()
    {
        let u = build_start_url(
            "http://127.0.0.1:5000/picker-callback",
            "CHAL",
            &["application/vnd.google-apps.presentation".to_string()],
            false,
            "app:picker-redirect-abc",
            Some("slides"),
            None,
        );
        assert!(u.starts_with(PICKER_START_URL));
        assert!(u.contains("client_id="));
        assert!(u.contains("code_challenge=CHAL"));
        assert!(u.contains("code_challenge_method=S256"));
        assert!(u.contains("event_name=app%3Apicker-redirect-abc"));
        assert!(u.contains("mimetypes=application%2Fvnd.google-apps.presentation"));
        assert!(u.contains("allow_multiple=false"));
        assert!(u.contains("kind=slides"));
        assert!(!u.contains("login_hint="));
    }

    #[test]
    fn build_start_url_omits_mimetypes_when_empty()
    {
        let u = build_start_url(
            "http://127.0.0.1:5000/picker-callback",
            "CHAL",
            &[],
            true,
            "app:picker-redirect-abc",
            None,
            None,
        );
        assert!(!u.contains("mimetypes="));
        assert!(u.contains("allow_multiple=true"));
        assert!(!u.contains("kind="));
        assert!(!u.contains("login_hint="));
    }

    #[test]
    fn build_start_url_includes_login_hint_when_present()
    {
        let u = build_start_url(
            "http://127.0.0.1:5000/picker-callback",
            "CHAL",
            &[],
            false,
            "app:picker-redirect-abc",
            None,
            Some("user@example.com"),
        );
        assert!(u.contains("login_hint=user%40example.com"));
    }

    #[test]
    fn deep_link_registry_delivers_payload()
    {
        // Register a sender under a unique event name, simulate the
        // deep-link handler firing, verify the receiver gets the payload
        // and the entry is removed.
        let event = "app:picker-redirect-test-deliver".to_string();
        let (tx, rx) = sync_channel::<CallbackPayload>(1);
        register_pending(event.clone(), tx);

        handle_deep_link_callback(&format!(
            "mangaplay://picker-callback?event={}&code=abc123&picked_file_ids=id1%2Cid2",
            event
        ));

        let received = rx.recv_timeout(Duration::from_secs(1))
            .expect("callback should have delivered");
        assert_eq!(received.code, "abc123");
        assert_eq!(received.picked_file_ids, vec!["id1", "id2"]);

        // Second delivery is a no-op — sender already removed.
        assert!(pending_senders().lock().unwrap().get(&event).is_none());
    }

    #[test]
    fn deep_link_missing_event_is_ignored()
    {
        // No `event=` param → drop silently. Must not panic. There's
        // nothing observable to assert other than "doesn't blow up".
        handle_deep_link_callback(
            "mangaplay://picker-callback?code=abc&picked_file_ids=1",
        );
    }

    #[test]
    fn deep_link_unknown_event_is_dropped()
    {
        // Unknown `event=` → drop silently. Registry stays untouched.
        let event = "app:picker-redirect-test-unknown".to_string();
        let (tx, _rx) = sync_channel::<CallbackPayload>(1);
        register_pending(event.clone(), tx);

        handle_deep_link_callback(
            "mangaplay://picker-callback?event=nope&code=x&picked_file_ids=1",
        );

        // Our registered sender is still there.
        assert!(pending_senders().lock().unwrap().get(&event).is_some());
        unregister_pending(&event);
    }

    #[test]
    fn deep_link_no_query_is_ignored()
    {
        // No `?...` → drop silently.
        handle_deep_link_callback("mangaplay://picker-callback");
    }

    #[test]
    fn pending_sender_guard_cleans_up_on_drop()
    {
        let event = "app:picker-redirect-test-guard".to_string();
        let (tx, _rx) = sync_channel::<CallbackPayload>(1);
        register_pending(event.clone(), tx);
        assert!(pending_senders().lock().unwrap().get(&event).is_some());
        {
            let _g = PendingSenderGuard { event_name: event.clone() };
        }
        assert!(pending_senders().lock().unwrap().get(&event).is_none());
    }
}
