//! Advisory publish-lock for Google Slides.
//!
//! Two independent publishes (two windows / two devices) against the same
//! presentation would let `presentations.batchUpdate` calls interleave.
//! `slides_publish_lock_acquire` writes a lease file at
//! `<project>/_mangaplaystudio/slides-lock/<presentation-id>.json` that
//! subsequent acquirers check before running `commitSlidesSync` /
//! `commitLocalUpload`. A stale lease past `expiresAt` is a takeover
//! candidate.
//!
//! Desktop + mobile — the lease is a plain file under the project's
//! reserved app dir, no OS-level file locking. No network. Cheap.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::commands::project::app_dir;

/// One lease record — serialised as JSON. `acquired_at` / `expires_at` are
/// unix-millis timestamps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishLease
{
    #[serde(rename = "acquiredAt")]
    pub acquired_at: u64,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
    #[serde(rename = "holderId")]
    pub holder_id: String,
    #[serde(rename = "presentationId")]
    pub presentation_id: String,
}

/// Result of an acquire attempt. `ok=true` when the caller now holds the
/// lease; `ok=false` when a live lease is held by someone else. `held_by`
/// is populated on the contended path.
#[derive(Debug, Clone, Serialize)]
pub struct LockResult
{
    pub ok: bool,
    #[serde(rename = "heldBy", skip_serializing_if = "Option::is_none")]
    pub held_by: Option<PublishLease>,
    #[serde(rename = "expiresInMs", skip_serializing_if = "Option::is_none")]
    pub expires_in_ms: Option<i64>,
}

fn validate_presentation_id(id: &str) -> Result<(), String>
{
    if id.is_empty()
        || id.len() > 200
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.contains('\0')
    {
        return Err("bad-presentation-id".into());
    }
    Ok(())
}

fn validate_holder_id(id: &str) -> Result<(), String>
{
    if id.is_empty() || id.len() > 200 || id.contains('\0')
    {
        return Err("bad-holder-id".into());
    }
    Ok(())
}

fn lock_dir(project_dir: &Path) -> PathBuf
{
    let mut p = app_dir(project_dir);
    p.push("slides-lock");
    p
}

fn lease_path(project_dir: &Path, presentation_id: &str) -> PathBuf
{
    let mut p = lock_dir(project_dir);
    p.push(format!("{presentation_id}.json"));
    p
}

fn now_ms() -> u64
{
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_lease(project_dir: &Path, presentation_id: &str) -> Option<PublishLease>
{
    let p = lease_path(project_dir, presentation_id);
    let bytes = fs::read(&p).ok()?;
    serde_json::from_slice::<PublishLease>(&bytes).ok()
}

fn write_lease(project_dir: &Path, lease: &PublishLease) -> Result<(), String>
{
    let dir = lock_dir(project_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let p = lease_path(project_dir, &lease.presentation_id);
    let body = serde_json::to_vec_pretty(lease).map_err(|e| format!("json: {e}"))?;
    fs::write(&p, body).map_err(|e| format!("write: {e}"))
}

fn remove_lease(project_dir: &Path, presentation_id: &str) -> Result<bool, String>
{
    let p = lease_path(project_dir, presentation_id);
    if !p.exists() { return Ok(false); }
    fs::remove_file(&p).map(|_| true).map_err(|e| format!("remove: {e}"))
}

// ── Impls ────────────────────────────────────────────────────────────────

pub fn acquire_impl(
    project_path: &str,
    presentation_id: &str,
    holder_id: &str,
    ttl_ms: u64,
) -> Result<LockResult, String>
{
    validate_presentation_id(presentation_id)?;
    validate_holder_id(holder_id)?;
    let project_dir = Path::new(project_path);
    let now = now_ms();
    if let Some(existing) = read_lease(project_dir, presentation_id)
    {
        if existing.expires_at > now && existing.holder_id != holder_id
        {
            let expires_in_ms = (existing.expires_at as i64) - (now as i64);
            return Ok(LockResult
            {
                ok: false,
                held_by: Some(existing),
                expires_in_ms: Some(expires_in_ms),
            });
        }
        // Same holder OR expired — takeover is fine.
    }
    let lease = PublishLease
    {
        acquired_at: now,
        expires_at: now.saturating_add(ttl_ms),
        holder_id: holder_id.to_string(),
        presentation_id: presentation_id.to_string(),
    };
    write_lease(project_dir, &lease)?;
    Ok(LockResult { ok: true, held_by: None, expires_in_ms: None })
}

pub fn release_impl(
    project_path: &str,
    presentation_id: &str,
    holder_id: &str,
) -> Result<bool, String>
{
    validate_presentation_id(presentation_id)?;
    validate_holder_id(holder_id)?;
    let project_dir = Path::new(project_path);
    // Only remove the lease if we own it — otherwise a second window's
    // release wouldn't accidentally free the first window's live lease.
    if let Some(existing) = read_lease(project_dir, presentation_id)
    {
        if existing.holder_id != holder_id
        {
            return Ok(false);
        }
    }
    remove_lease(project_dir, presentation_id)
}

pub fn heartbeat_impl(
    project_path: &str,
    presentation_id: &str,
    holder_id: &str,
    ttl_ms: u64,
) -> Result<bool, String>
{
    validate_presentation_id(presentation_id)?;
    validate_holder_id(holder_id)?;
    let project_dir = Path::new(project_path);
    let existing = match read_lease(project_dir, presentation_id)
    {
        Some(e) => e,
        None => return Ok(false),
    };
    if existing.holder_id != holder_id
    {
        return Ok(false);
    }
    let now = now_ms();
    let refreshed = PublishLease
    {
        acquired_at: existing.acquired_at,
        expires_at: now.saturating_add(ttl_ms),
        holder_id: existing.holder_id,
        presentation_id: existing.presentation_id,
    };
    write_lease(project_dir, &refreshed)?;
    Ok(true)
}

// ── Tauri commands ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn slides_publish_lock_acquire(
    project_path: String,
    presentation_id: String,
    holder_id: String,
    ttl_ms: u64,
) -> Result<LockResult, String>
{
    acquire_impl(&project_path, &presentation_id, &holder_id, ttl_ms)
}

#[tauri::command]
pub async fn slides_publish_lock_release(
    project_path: String,
    presentation_id: String,
    holder_id: String,
) -> Result<bool, String>
{
    release_impl(&project_path, &presentation_id, &holder_id)
}

#[tauri::command]
pub async fn slides_publish_lock_heartbeat(
    project_path: String,
    presentation_id: String,
    holder_id: String,
    ttl_ms: u64,
) -> Result<bool, String>
{
    heartbeat_impl(&project_path, &presentation_id, &holder_id, ttl_ms)
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests
{
    use super::*;
    use tempfile::TempDir;

    fn make_project() -> TempDir
    {
        let td = TempDir::new().unwrap();
        std::fs::create_dir_all(app_dir(td.path())).unwrap();
        td
    }

    #[test]
    fn acquire_then_release()
    {
        let td = make_project();
        let pp = td.path().to_str().unwrap();
        let r = acquire_impl(pp, "PRES1", "holder-A", 60_000).unwrap();
        assert!(r.ok);
        let released = release_impl(pp, "PRES1", "holder-A").unwrap();
        assert!(released);
    }

    #[test]
    fn contested_acquire_returns_held_by()
    {
        let td = make_project();
        let pp = td.path().to_str().unwrap();
        let _ = acquire_impl(pp, "PRES1", "holder-A", 60_000).unwrap();
        let r = acquire_impl(pp, "PRES1", "holder-B", 60_000).unwrap();
        assert!(!r.ok);
        assert_eq!(r.held_by.as_ref().unwrap().holder_id, "holder-A");
        assert!(r.expires_in_ms.unwrap() > 0);
    }

    #[test]
    fn same_holder_reacquire_succeeds()
    {
        let td = make_project();
        let pp = td.path().to_str().unwrap();
        let _ = acquire_impl(pp, "PRES1", "holder-A", 60_000).unwrap();
        // Re-acquire from same holder → allowed (refresh).
        let r = acquire_impl(pp, "PRES1", "holder-A", 60_000).unwrap();
        assert!(r.ok);
    }

    #[test]
    fn expired_lease_can_be_taken_over()
    {
        let td = make_project();
        let pp = td.path().to_str().unwrap();
        // ttl=0 → expires_at == acquired_at → contested check `> now` fails.
        let _ = acquire_impl(pp, "PRES1", "holder-A", 0).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let r = acquire_impl(pp, "PRES1", "holder-B", 60_000).unwrap();
        assert!(r.ok);
    }

    #[test]
    fn release_wrong_holder_is_noop()
    {
        let td = make_project();
        let pp = td.path().to_str().unwrap();
        let _ = acquire_impl(pp, "PRES1", "holder-A", 60_000).unwrap();
        let ok = release_impl(pp, "PRES1", "holder-B").unwrap();
        assert!(!ok, "wrong holder must not free the live lease");
        // Lease still present.
        assert!(read_lease(td.path(), "PRES1").is_some());
    }

    #[test]
    fn heartbeat_extends_ttl()
    {
        let td = make_project();
        let pp = td.path().to_str().unwrap();
        let _ = acquire_impl(pp, "PRES1", "holder-A", 100).unwrap();
        let first = read_lease(td.path(), "PRES1").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let ok = heartbeat_impl(pp, "PRES1", "holder-A", 60_000).unwrap();
        assert!(ok);
        let after = read_lease(td.path(), "PRES1").unwrap();
        assert!(after.expires_at > first.expires_at);
    }

    #[test]
    fn heartbeat_wrong_holder_returns_false()
    {
        let td = make_project();
        let pp = td.path().to_str().unwrap();
        let _ = acquire_impl(pp, "PRES1", "holder-A", 60_000).unwrap();
        let ok = heartbeat_impl(pp, "PRES1", "holder-B", 60_000).unwrap();
        assert!(!ok);
    }

    #[test]
    fn bad_presentation_id_rejected()
    {
        let td = make_project();
        let pp = td.path().to_str().unwrap();
        let e = acquire_impl(pp, "", "h", 100).unwrap_err();
        assert_eq!(e, "bad-presentation-id");
        let e = acquire_impl(pp, "../evil", "h", 100).unwrap_err();
        assert_eq!(e, "bad-presentation-id");
    }
}
