//! TOCTOU-safe UUID → open-file resolver.
//!
//! See [`TODO/uuid-file-registry.md`](../../../../TODO/uuid-file-registry.md)
//! Part 3 — TOCTOU-safe resolution — for the design.
//!
//! # Flow
//!
//! 1. Look up the UUID in the loaded registry.
//! 2. Open the file by `root_path.join(entry.path)`, keep the handle.
//! 3. Read the native ID from the handle (TOCTOU-safe — the value
//!    corresponds to the actual inode we opened, not the path).
//! 4. If the native ID matches the registry, return `(File, RegistryEntry)`.
//! 5. Mismatch (or `NotFound` at open time) → drop the handle, walk the
//!    parent directory looking for our expected native ID, heal
//!    `entry.path` in the registry, retry ONCE.
//! 6. Second mismatch or heal failure → [`FsErr::Stale`].
//!
//! Windows currently returns [`NativeId::Unknown`] from
//! [`crate::registry::native_id_read::read_native_id`], so on Windows the
//! resolver treats any file at the expected path as authoritative — the
//! healing path is Linux/macOS-only until the real Windows reader lands.

use std::fs::{File, OpenOptions};
use std::path::Path;

use uuid::Uuid;

use crate::registry::fs_err::FsErr;
use crate::registry::native_id::NativeId;
use crate::registry::native_id_read::read_native_id;
use crate::registry::state::LoadedRegistry;
use crate::registry::store::RegistryEntry;

/// Resolve a UUID to an open [`File`] plus its validated [`RegistryEntry`].
///
/// **TOCTOU-safe**: after opening by last-known-path, the native ID is read
/// from the handle, not re-derived from the path. The returned handle is
/// what the caller should read/write from — never re-open by path.
///
/// The caller must hold `reg` mutably (via
/// [`crate::registry::ProjectRegistryState::with_loaded`]) because the heal
/// path mutates `entry.path` and bumps `entry.rev`.
///
/// # Behaviour
///
/// - `write: true` opens with `read + write` (no create — the file must
///   exist; healing handles the moved-file case).
/// - Returns `Ok((File, entry.clone()))` on success. The cloned entry
///   reflects the state AFTER any heal — so `entry.path` and `entry.rev`
///   match what's now in the registry.
/// - Returns [`FsErr::UnknownUuid`] / [`FsErr::Deleted`] /
///   [`FsErr::Stale`] on the failure paths.
///
/// # Non-goals for Part 3a
///
/// - Full-project rescan on heal failure (Part 5).
/// - Content-hash tie-break on native-ID recycling (later pass).
/// - Windows native-ID verification (needs the real reader — deferred).
pub fn resolve_and_open(
    reg: &mut LoadedRegistry,
    uuid: Uuid,
    write: bool,
) -> Result<(File, RegistryEntry), FsErr>
{
    // Two attempts total: first with the entry's current path, second
    // after `locate_by_native_id` heals `entry.path`. A second mismatch
    // gives up and returns Stale.
    for attempt in 0..2
    {
        let entry = reg
            .entries
            .get(&uuid)
            .ok_or_else(|| FsErr::UnknownUuid { uuid: uuid.to_string() })?
            .clone();

        if entry.tombstone
        {
            return Err(FsErr::Deleted { uuid: uuid.to_string() });
        }

        let abs = reg.root_path.join(&entry.path);
        let open_result = OpenOptions::new()
            .read(true)
            .write(write)
            .open(&abs);

        let file = match open_result
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound =>
            {
                // File gone at the expected path. Fall through to healing
                // on attempt 0; on attempt 1 give up.
                if attempt == 0 && try_heal(reg, uuid, &entry)?
                {
                    continue;
                }
                return Err(FsErr::Stale
                {
                    uuid: uuid.to_string(),
                    last_known_path: entry.path.clone(),
                });
            }
            Err(e) => return Err(FsErr::from(e)),
        };

        // Verify native ID against the registry.
        let live = read_native_id(&file).map_err(|m| FsErr::Internal { message: m })?;

        // Fast path: match, or either side unknown (Windows placeholder /
        // cold-start entries created before platform readers landed).
        if live == entry.native_id
            || matches!(live, NativeId::Unknown)
            || matches!(entry.native_id, NativeId::Unknown)
        {
            return Ok((file, entry));
        }

        // Slow path: drop the handle, try to heal on attempt 0; give up
        // on attempt 1.
        drop(file);
        if attempt == 0 && try_heal(reg, uuid, &entry)?
        {
            continue;
        }

        return Err(FsErr::Stale
        {
            uuid: uuid.to_string(),
            last_known_path: entry.path.clone(),
        });
    }

    // Unreachable — loop body always returns.
    Err(FsErr::Internal
    {
        message: "resolve-and-open:exhausted-retries".to_string(),
    })
}

/// Try to heal an entry whose file is missing or has a mismatched native ID.
///
/// Walks the SAME parent directory as `entry.path` looking for a file whose
/// native ID matches `entry.native_id`. On hit, updates
/// `reg.entries[uuid].path`, bumps `rev`, sets `reg.dirty = true`, and
/// returns `Ok(true)` so the outer loop can retry the open.
///
/// Returns `Ok(false)` when no candidate is found — caller then produces
/// [`FsErr::Stale`].
///
/// The reverse-lookup indices (`path_index`, `native_id_index`) are rebuilt
/// at the end of this call — callers do NOT need to invoke
/// [`LoadedRegistry::rebuild_indices`] manually.
fn try_heal(
    reg: &mut LoadedRegistry,
    uuid: Uuid,
    entry: &RegistryEntry,
) -> Result<bool, FsErr>
{
    match locate_by_native_id(&reg.root_path, &entry.native_id, &entry.path)?
    {
        Some(new_rel) =>
        {
            let slot = reg.entries.get_mut(&uuid).ok_or_else(|| FsErr::UnknownUuid
            {
                uuid: uuid.to_string(),
            })?;
            slot.path = new_rel;
            slot.rev = slot.rev.saturating_add(1);
            reg.dirty = true;
            // Reverse-lookup indices now point at the old path — refresh.
            reg.rebuild_indices();
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Walk the parent directory of `hint_rel_path` (project-relative) looking
/// for a file whose handle-read native ID matches `target`. Returns the new
/// project-relative path (forward-slashes) on hit, `Ok(None)` if the parent
/// exists but no candidate matches.
///
/// # Scope for Part 3a
///
/// Single-directory scan only. Recursive full-project rescan is deferred to
/// Part 5 — we don't want a stray failed open to trigger a walk of a huge
/// project.
///
/// If the parent directory itself is missing, returns `Ok(None)` — the
/// caller surfaces `Stale`.
pub fn locate_by_native_id(
    root_path: &Path,
    target: &NativeId,
    hint_rel_path: &str,
) -> Result<Option<String>, FsErr>
{
    // A target of `Unknown` cannot be matched by definition — bail early.
    if matches!(target, NativeId::Unknown)
    {
        return Ok(None);
    }

    // Compute the parent directory of the hint, project-relative.
    // If the hint has no slash, the parent IS the project root ("").
    let (parent_rel, _basename) = match hint_rel_path.rsplit_once('/')
    {
        Some((p, b)) => (p, b),
        None => ("", hint_rel_path),
    };

    let parent_abs = if parent_rel.is_empty()
    {
        root_path.to_path_buf()
    }
    else
    {
        root_path.join(parent_rel)
    };

    let read_dir = match std::fs::read_dir(&parent_abs)
    {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(FsErr::from(e)),
    };

    for entry in read_dir.flatten()
    {
        let path = entry.path();
        // Only regular files can match a file's native ID via
        // `OpenOptions::read` — skip directories to keep the scan cheap and
        // avoid opening things like `_mangaplaystudio/`.
        let ft = match entry.file_type()
        {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_file()
        {
            continue;
        }

        // Read-only open — cannot fail on permissions we already hold.
        let f = match OpenOptions::new().read(true).open(&path)
        {
            Ok(f) => f,
            Err(_) => continue,
        };

        let live = match read_native_id(&f)
        {
            Ok(id) => id,
            Err(_) => continue,
        };

        if &live == target
        {
            // Reconstruct project-relative forward-slash path.
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let new_rel = if parent_rel.is_empty()
            {
                file_name
            }
            else
            {
                format!("{}/{}", parent_rel, file_name)
            };
            return Ok(Some(new_rel));
        }
    }

    Ok(None)
}
