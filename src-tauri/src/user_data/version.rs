use std::path::PathBuf;

use super::SETTINGS_WRITE_LOCK;
use super::paths::{resolve_user_data_dir, user_settings_path};
use super::settings::{user_settings_load_impl, user_settings_write_unlocked};
use super::PACKAGED_APP_VERSION_INFO_JSON;

/// Phase 2 of user-data versioning: gate command invoked from JS at boot.
///
/// Holds `SETTINGS_WRITE_LOCK` across the path-exists check and (if fresh)
/// the seed-write so two windows racing the boot path can't both see "no
/// file" and double-stamp defaults.
///
/// Returns one of:
/// - `{ "result": "fresh", "currentVersion": "<userDataVersion>" }` — file
///   did not exist; defaults stamped + written.
/// - `{ "result": "needs-decision", "onDisk": "<version>", "packaged":
///   "<userDataVersion>" }` — file exists; JS compares versions via semver
///   and decides whether to call `user_data_apply_rung` per rung.
///
/// Version comparison stays in JS (semver pre-release tags) so the Rust
/// side never tries to parse versions itself.
#[tauri::command]
pub fn user_data_ensure_version(app: tauri::AppHandle) -> Result<serde_json::Value, String>
{
    let _g = SETTINGS_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = resolve_user_data_dir(&app)?;
    user_data_ensure_version_impl(&dir)
}

/// Lock-free implementation of `user_data_ensure_version`. Caller MUST
/// hold `SETTINGS_WRITE_LOCK` (or be a hermetic test that doesn't share
/// state). Extracted so integration tests can exercise the decision
/// branches without needing a `tauri::AppHandle`.
pub fn user_data_ensure_version_impl(dir: &PathBuf) -> Result<serde_json::Value, String>
{
    let path = user_settings_path(dir);

    let packaged: serde_json::Value = serde_json::from_str(PACKAGED_APP_VERSION_INFO_JSON)
        .map_err(|e| e.to_string())?;
    let user_data_version = packaged
        .get("userDataVersion")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing userDataVersion in packaged app-version-info".to_string())?;

    if !path.exists()
    {
        let partial = serde_json::json!({
            "createdVersion": user_data_version,
            "currentVersion": user_data_version
        });
        user_settings_write_unlocked(dir, partial)?;
        return Ok(serde_json::json!({
            "result": "fresh",
            "currentVersion": user_data_version
        }));
    }

    // File exists. Read tolerantly — same silent-fall-through as
    // `user_settings_load_impl` so a malformed file still surfaces a
    // decision (with sentinel "1.0.0") rather than hard-erroring.
    let body = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .unwrap_or(serde_json::Value::Null);
    let on_disk = parsed
        .get("currentVersion")
        .and_then(|v| v.as_str())
        .or_else(|| parsed.get("appVersionCreated").and_then(|v| v.as_str()))
        .unwrap_or("1.0.0")
        .to_string();

    Ok(serde_json::json!({
        "result": "needs-decision",
        "onDisk": on_disk,
        "packaged": user_data_version
    }))
}

/// Apply a single migration rung. JS produces the data patch and calls this
/// command, which holds the user-settings mutex across read + stale-check +
/// merge + write.
///
/// Stale-check guards against two windows both walking the ladder past the
/// same rung: if on-disk `currentVersion` already moved past `from`, return
/// `{ result: "stale", onDisk }` without writing. JS treats stale as "fine,
/// someone else applied it" and re-reads.
///
/// On success: merges patch, force-sets `currentVersion = to` and
/// `lastMigrationAttempt = null`, writes atomically.
#[tauri::command]
pub fn user_data_apply_rung(
    app: tauri::AppHandle,
    from: String,
    to: String,
    patch: serde_json::Value,
) -> Result<serde_json::Value, String>
{
    let _g = SETTINGS_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = resolve_user_data_dir(&app)?;
    user_data_apply_rung_impl(&dir, from, to, patch)
}

/// Lock-free implementation of `user_data_apply_rung`. Caller MUST hold
/// `SETTINGS_WRITE_LOCK` (or be a hermetic test). Extracted so
/// integration tests can exercise the stale-check + atomic-write
/// without needing a `tauri::AppHandle`.
pub fn user_data_apply_rung_impl(
    dir: &PathBuf,
    from: String,
    to: String,
    patch: serde_json::Value,
) -> Result<serde_json::Value, String>
{
    let mut existing = user_settings_load_impl(dir)?;
    // Strip transient flag so it never round-trips. _isFresh is not in
    // USER_SETTINGS_KNOWN so merge would drop it, but be explicit.
    if let Some(obj) = existing.as_object_mut()
    {
        obj.remove("_isFresh");
    }

    let on_disk = existing
        .get("currentVersion")
        .and_then(|v| v.as_str())
        .or_else(|| existing.get("appVersionCreated").and_then(|v| v.as_str()))
        .unwrap_or("1.0.0")
        .to_string();

    if on_disk != from
    {
        return Ok(serde_json::json!({
            "result": "stale",
            "onDisk": on_disk
        }));
    }

    // Build the partial: patch (must be object, treat null as empty) +
    // forced currentVersion + cleared lastMigrationAttempt. Last writes win
    // inside the partial so the version/attempt fields can't be overridden
    // by a malformed patch.
    let mut partial = match patch
    {
        serde_json::Value::Object(map) => serde_json::Value::Object(map),
        serde_json::Value::Null => serde_json::Value::Object(serde_json::Map::new()),
        _ => return Err("patch must be a JSON object".to_string()),
    };
    if let Some(obj) = partial.as_object_mut()
    {
        obj.insert("currentVersion".to_string(), serde_json::Value::String(to.clone()));
        obj.insert("lastMigrationAttempt".to_string(), serde_json::Value::Null);
    }

    user_settings_write_unlocked(dir, partial)?;
    Ok(serde_json::json!({
        "result": "applied",
        "currentVersion": to
    }))
}

/// Record a failed migration rung for the backoff/skip UX. Writes
/// `lastMigrationAttempt = { from, to, error, attemptedAt,
/// consecutiveFailures }` in a single mutex-held atomic write. Does NOT
/// touch `currentVersion` — a failed rung must leave the gate where it was.
///
/// No stale-check: recording the failure is unconditional. JS is the source
/// of truth for the attempt count; Rust only persists what it's told.
#[tauri::command]
pub fn user_data_record_failure(
    app: tauri::AppHandle,
    from: String,
    to: String,
    error: String,
    attempted_at: String,
    consecutive_failures: u32,
) -> Result<(), String>
{
    let _g = SETTINGS_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = resolve_user_data_dir(&app)?;
    user_data_record_failure_impl(&dir, from, to, error, attempted_at, consecutive_failures)
}

/// Lock-free implementation of `user_data_record_failure`. Caller MUST
/// hold `SETTINGS_WRITE_LOCK` (or be a hermetic test).
pub fn user_data_record_failure_impl(
    dir: &PathBuf,
    from: String,
    to: String,
    error: String,
    attempted_at: String,
    consecutive_failures: u32,
) -> Result<(), String>
{
    let partial = serde_json::json!({
        "lastMigrationAttempt": {
            "from": from,
            "to": to,
            "error": error,
            "attemptedAt": attempted_at,
            "consecutiveFailures": consecutive_failures
        }
    });
    user_settings_write_unlocked(dir, partial)
}

/// Skip a rung that's deterministically failing (offered after 2nd
/// consecutive failure of the same rung). Bumps `currentVersion` to the
/// rung's `to` WITHOUT applying the patch, clears `lastMigrationAttempt`.
///
/// Same stale-check as `user_data_apply_rung` — if another window already
/// moved past this rung, return `stale` without writing.
#[tauri::command]
pub fn user_data_skip_rung(
    app: tauri::AppHandle,
    from: String,
    to: String,
) -> Result<serde_json::Value, String>
{
    let _g = SETTINGS_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = resolve_user_data_dir(&app)?;
    user_data_skip_rung_impl(&dir, from, to)
}

/// Lock-free implementation of `user_data_skip_rung`. Caller MUST hold
/// `SETTINGS_WRITE_LOCK` (or be a hermetic test).
pub fn user_data_skip_rung_impl(
    dir: &PathBuf,
    from: String,
    to: String,
) -> Result<serde_json::Value, String>
{
    let mut existing = user_settings_load_impl(dir)?;
    if let Some(obj) = existing.as_object_mut()
    {
        obj.remove("_isFresh");
    }

    let on_disk = existing
        .get("currentVersion")
        .and_then(|v| v.as_str())
        .or_else(|| existing.get("appVersionCreated").and_then(|v| v.as_str()))
        .unwrap_or("1.0.0")
        .to_string();

    if on_disk != from
    {
        return Ok(serde_json::json!({
            "result": "stale",
            "onDisk": on_disk
        }));
    }

    let partial = serde_json::json!({
        "currentVersion": to,
        "lastMigrationAttempt": serde_json::Value::Null
    });
    user_settings_write_unlocked(dir, partial)?;
    Ok(serde_json::json!({
        "result": "skipped",
        "currentVersion": to
    }))
}
