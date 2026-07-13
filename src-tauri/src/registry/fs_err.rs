//! Structured error taxonomy for UUID-boundary Tauri commands.
//!
//! See [`TODO/uuid-file-registry.md`](../../../../TODO/uuid-file-registry.md)
//! Part 3 — Error taxonomy additions.
//!
//! `#[tauri::command]` handlers ultimately return `Result<T, String>` — the
//! JSON marshalling of a rich error type isn't automatic. To keep the JS
//! side single-parser, we serialise [`FsErr`] to JSON and prefix it with the
//! `"fs-err:"` marker so the JS boundary can `startsWith("fs-err:")` /
//! `JSON.parse(err.slice(7))` without ambiguity against legacy string errors.
//!
//! `SafGrantRevoked` (Android) is intentionally NOT in this enum yet — see
//! Part 6 of the plan.

use serde::Serialize;

/// Serde-tagged error union returned from UUID-boundary commands to JS.
///
/// The `#[serde(tag = "kind", rename_all = "kebab-case")]` attribute means
/// each variant serialises as `{ "kind": "unknown-uuid", "uuid": "..." }`
/// etc. Match the plan's Part 3 error list exactly — the JS side parses
/// these values verbatim.
///
/// Serde's `rename_all` on a `#[serde(tag = ...)]` enum applies to VARIANT
/// TAGS only, not to fields inside variants. Payload fields with
/// underscores therefore carry an explicit `#[serde(rename = "kebab-case")]`
/// attribute so the JS side sees a consistent hyphenated shape across the
/// whole boundary. See `fs_err_serde_kebab_case` in
/// `tests/registry_resolve.rs` for the locked contract.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FsErr
{
    /// JS holds a UUID the Rust registry doesn't recognise. The client
    /// should force a tree refresh.
    UnknownUuid
    {
        uuid: String,
    },

    /// Entry exists but is tombstoned. Client should close the tab and drop
    /// the UUID from the UI.
    Deleted
    {
        uuid: String,
    },

    /// Native-ID mismatch and the parent-dir scan couldn't heal it. The
    /// file has moved outside the project or been replaced by a different
    /// inode. `last_known_path` is the best-effort display hint.
    Stale
    {
        uuid: String,
        #[serde(rename = "last-known-path")]
        last_known_path: String,
    },

    /// Optimistic-concurrency conflict. `expected_rev` on the incoming
    /// command didn't match the current registry rev.
    StaleRev
    {
        uuid: String,
        #[serde(rename = "current-rev")]
        current_rev: u64,
        #[serde(rename = "expected-rev")]
        expected_rev: u64,
    },

    /// OS-level permission denied. Passthrough from `std::io::Error`.
    PermissionDenied
    {
        message: String,
    },

    /// Command was invoked with no project loaded. The JS side should
    /// prompt for project-open before retrying.
    NoProjectOpen,

    /// Any other I/O error (not-found, other, etc.).
    Io
    {
        message: String,
    },

    /// Unexpected internal state. Something went wrong that isn't the
    /// caller's fault (e.g. mutex poisoned, invariant broken).
    Internal
    {
        message: String,
    },
}

impl From<std::io::Error> for FsErr
{
    fn from(e: std::io::Error) -> Self
    {
        match e.kind()
        {
            std::io::ErrorKind::PermissionDenied => FsErr::PermissionDenied
            {
                message: e.to_string(),
            },
            _ => FsErr::Io
            {
                message: e.to_string(),
            },
        }
    }
}

/// Convert a `Result<T, FsErr>` into the `Result<T, String>` shape that
/// `#[tauri::command]` handlers must return.
///
/// The Err arm is serialised as JSON and prefixed with `"fs-err:"` so the JS
/// side can detect a structured error with a single `startsWith` check and
/// then `JSON.parse` the remainder. Non-`FsErr` errors keep their existing
/// stable-string format — the two paths don't collide.
///
/// If JSON serialisation itself fails (should be impossible for the current
/// enum), the fallback message names the failing variant so we can trace it.
pub fn to_command_result<T>(r: Result<T, FsErr>) -> Result<T, String>
{
    r.map_err(|err|
    {
        match serde_json::to_string(&err)
        {
            Ok(json) => format!("fs-err:{}", json),
            Err(e) => format!(
                "fs-err:{{\"kind\":\"internal\",\"message\":\"serialize-fs-err:{}\"}}",
                e,
            ),
        }
    })
}
