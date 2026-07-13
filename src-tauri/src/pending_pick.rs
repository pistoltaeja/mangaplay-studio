//! Durable pending-pick storage for the Google Drive Picker
//! (`android-prereq-durable-pending` in TODO/drive-picker-desktop-mobile.md).
//!
//! Android may kill the app while the user is completing the picker in
//! the browser (memory pressure, battery optimisation). When the deep-link
//! fires against a cold process, the in-memory `oneshot` sender is gone.
//! This module persists the minimum state needed to resurrect the flow.
//!
//! File: `<user_data_dir>/pending-pick.json`
//!
//! Contract: at most one pending pick per user-data dir. `picker_open`
//! calls `save()` synchronously before opening the browser; every exit
//! path (resolve, reject, timeout, drop) calls `clear()`. On boot,
//! `load_if_fresh()` returns the entry if `now - issued_at < 600s`, else
//! deletes the stale file.
//!
//! Desktop targets touch this module too — the loopback flow is fast
//! enough that resurrection is rarely needed, but the code path exists
//! for symmetry and so a hung tab that outlives an app crash can still
//! be traced.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::user_data::paths::resolve_user_data_dir;

/// Freshness cap. Matches Google's bridge-server `state` expiry (10 min)
/// less a small safety margin so a resurrection race that just misses the
/// bridge cutoff is treated as stale here too.
const FRESH_WINDOW_SECS: u64 = 600;

const FILE_NAME: &str = "pending-pick.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPick
{
    /// The distinct event name embedded in `state` and echoed by the
    /// bridge as a query param. Used to correlate the incoming deep-link
    /// with the (now dead) `oneshot` sender.
    pub event_name: String,
    /// PKCE verifier — needed for the JS-side `/v2/picker/exchange` call.
    pub code_verifier: String,
    /// `mangaplay://picker-callback` on mobile; `http://127.0.0.1:<port>/...`
    /// on desktop. Persisted so Phase 5 can validate that the incoming
    /// deep-link's origin matches the expected return URI.
    pub return_uri: String,
    /// Informational — used by analytics + the JS side when resurrecting
    /// to route the picked file back into the right modal.
    pub kind: Option<String>,
    /// UNIX seconds. Used by `is_fresh()`.
    pub issued_at: u64,
}

impl PendingPick
{
    pub fn age_secs(&self) -> u64
    {
        now_secs().saturating_sub(self.issued_at)
    }

    pub fn is_fresh(&self) -> bool
    {
        self.age_secs() < FRESH_WINDOW_SECS
    }
}

fn now_secs() -> u64
{
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn file_path(app: &tauri::AppHandle) -> Result<PathBuf, String>
{
    Ok(resolve_user_data_dir(app)?.join(FILE_NAME))
}

/// Persist a pending pick. Overwrites any existing entry — only one
/// picker session is allowed at a time (see `PICKER_IN_FLIGHT`).
pub fn save(app: &tauri::AppHandle, entry: &PendingPick) -> Result<(), String>
{
    let path = file_path(app)?;
    let json = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Delete the pending-pick file if it exists. Safe to call even when no
/// pick is in flight — a missing file is not an error.
pub fn clear(app: &tauri::AppHandle) -> Result<(), String>
{
    let path = match file_path(app)
    {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };
    match fs::remove_file(&path)
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Load the pending pick if the file exists AND `is_fresh()`. A stale
/// file is deleted as a side-effect so the next boot starts clean.
/// Missing / corrupted files return `Ok(None)` — the caller treats them
/// as "no pending pick", not as errors.
pub fn load_if_fresh(app: &tauri::AppHandle) -> Result<Option<PendingPick>, String>
{
    let path = file_path(app)?;
    let raw = match fs::read_to_string(&path)
    {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    let entry: PendingPick = match serde_json::from_str(&raw)
    {
        Ok(v) => v,
        Err(_) =>
        {
            // Corrupted — treat as stale + wipe.
            let _ = fs::remove_file(&path);
            return Ok(None);
        }
    };

    if !entry.is_fresh()
    {
        let _ = fs::remove_file(&path);
        return Ok(None);
    }

    Ok(Some(entry))
}

#[cfg(test)]
mod tests
{
    use super::*;

    #[test]
    fn fresh_within_window()
    {
        let entry = PendingPick
        {
            event_name: "app:picker-redirect-1".into(),
            code_verifier: "v".into(),
            return_uri: "mangaplay://picker-callback".into(),
            kind: Some("slide".into()),
            issued_at: now_secs(),
        };
        assert!(entry.is_fresh());
    }

    #[test]
    fn stale_beyond_window()
    {
        let entry = PendingPick
        {
            event_name: "e".into(),
            code_verifier: "v".into(),
            return_uri: "mangaplay://picker-callback".into(),
            kind: None,
            issued_at: now_secs() - FRESH_WINDOW_SECS - 1,
        };
        assert!(!entry.is_fresh());
    }
}
