//! On-disk `registry.json` schema types and atomic load/save.
//!
//! See [`TODO/uuid-file-registry.md`](../../../../TODO/uuid-file-registry.md)
//! Part 1 for the full schema + atomic-write sequence.
//!
//! # Storage layout
//!
//! Every project stores its registry at:
//!
//! ```text
//! <project_root>/_mangaplaystudio/registry.json
//! ```
//!
//! (See `.claude/rules/mangaplay-studio-app.md` for the reserved
//! `_mangaplaystudio/` folder contract.)
//!
//! # Atomic write sequence
//!
//! On save:
//! 1. Serialize registry to `registry.json.tmp` in the same directory,
//!    then `fsync` it.
//! 2. If `registry.json` exists, copy it to `registry.json.bak.tmp`
//!    then rename `registry.json.bak.tmp` → `registry.json.bak`. This
//!    updates `.bak` WITHOUT unlinking primary first, so a crash here
//!    still leaves the old primary in place.
//! 3. Rename `registry.json.tmp` → `registry.json` (atomic replace on
//!    both POSIX and Windows). Primary either points at the OLD payload
//!    (crash before this step) or the NEW payload (crash after) — at
//!    no point does primary vanish.
//! 4. `fsync` the parent directory on POSIX.
//!
//! Atomic rename on both POSIX and Windows via `std::fs::rename`
//! (`renameat` / `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`). A hard
//! power-loss window remains between the rename and the OS write-back
//! — recovery falls back to `registry.json.bak`.
//!
//! The final rename (step 3) uses the same retry-with-backoff pattern as
//! [`crate::fs_helpers::atomic_write_impl`] (0/50/150/450 ms) to survive
//! transient Windows AV / indexer locks. Steps 1 and 2 do not retry:
//! step 1 owns the file we just created (no external contention) and
//! step 2 is best-effort per-attempt (missing primary is normal on first
//! save; failure aborts before touching primary).
//!
//! # Recovery
//!
//! On load:
//! - Try `registry.json`. If parse OK → return.
//! - Else try `registry.json.bak`. If parse OK → return
//!   [`LoadErr::BakRecovered`] with a diagnostic string.
//! - Else return [`LoadErr::Corrupt`].
//! - If neither file exists → [`LoadErr::NotFound`].

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::registry::native_id::NativeId;

/// Basename of the reserved per-project app directory. Matches the
/// convention documented in `.claude/rules/mangaplay-studio-app.md`.
const APP_DIR: &str = "_mangaplaystudio";

/// Registry file basename.
const REGISTRY_FILE: &str = "registry.json";

/// Backup file basename — receives the previous `registry.json` before
/// each successful save. One generation only (no `.bak.1` / `.bak.2`).
const REGISTRY_BAK: &str = "registry.json.bak";

/// Temp file basename used during atomic write.
const REGISTRY_TMP: &str = "registry.json.tmp";

/// Temp basename for the `.bak` copy staging file. Populated by
/// `fs::copy` from the current primary before we touch primary itself,
/// then renamed to [`REGISTRY_BAK`].
const REGISTRY_BAK_TMP: &str = "registry.json.bak.tmp";

/// Current registry schema version. Bump when the on-disk format changes
/// in a non-additive way.
pub const REGISTRY_VERSION: u32 = 2;

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/// One row in the registry — a single tracked file or folder.
///
/// Field order matches the plan's JSON schema. `serde` defaults are set
/// on the optional fields so a v1 registry stays forward-compatible if
/// a later version adds fields (`tombstone`, `content_hash_head`).
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct RegistryEntry
{
    /// Platform-native stable identifier for this file. See
    /// [`NativeId`] for variant semantics.
    pub native_id: NativeId,

    /// Project-relative path with forward slashes (POSIX-style). Rust
    /// joins to `root_path` at use time so this field alone can change
    /// on Windows drive-letter reassignment without invalidating the row.
    pub path: String,

    /// `"file"` or `"folder"`. Kept as a string rather than an enum so
    /// future kinds (e.g. `"link"`) can land without a schema migration
    /// on the read side.
    pub kind: String,

    /// UUID of the parent folder entry, or `None` for the project root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_uuid: Option<Uuid>,

    /// Monotonic revision counter — bumped on any mutation. Used for
    /// optimistic-concurrency (`expected_rev`) in Part 3.
    pub rev: u64,

    /// Tombstoned entries survive one boot cycle so late watcher events
    /// don't crash. Purged on next clean shutdown.
    #[serde(default)]
    pub tombstone: bool,

    /// `sha256(first 4 KiB) + size` — lazily populated. Used as a
    /// cold-start tie-breaker when a native ID has been recycled by the
    /// OS. `None` means "not computed yet"; the resolver falls back to
    /// path matching in that case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash_head: Option<String>,
}

/// Legacy v1 on-disk shape. Used only for backward-compatible
/// deserialization — new saves always use [`RegistryFile`] (v2).
#[derive(Debug, Deserialize, Clone)]
pub(crate) struct RegistryFileV1
{
    pub version: u32,
    pub project_uuid: Uuid,
    pub root_path: PathBuf,
    pub root_native_id: NativeId,
    pub entries: HashMap<String, RegistryEntry>,
}

/// On-disk registry document (schema v2).
///
/// Platform-portable: no absolute paths stored. The project root is
/// always supplied by the runtime context at load time.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct RegistryFile
{
    /// Schema version. Always [`REGISTRY_VERSION`] (2) on write.
    pub version: u32,

    /// Stable UUID for the project itself.
    pub project_uuid: Uuid,

    /// Per-file / per-folder entries, keyed by UUID string.
    pub entries: HashMap<String, RegistryEntry>,
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/// Failure modes for [`load_from_disk`].
#[derive(Debug)]
pub enum LoadErr
{
    /// Neither `registry.json` nor `registry.json.bak` exists — this
    /// is a fresh project and the caller should trigger a rebuild-from-
    /// scan (Part 5) instead of treating it as an error.
    NotFound,

    /// Primary was missing or unparseable but `.bak` succeeded. The
    /// caller receives the recovered `RegistryFile` and SHOULD save it
    /// back immediately to restore the primary from the backup.
    BakRecovered
    {
        registry: RegistryFile,
        warning: String,
    },

    /// Both files exist but neither parsed. The caller must fall back to
    /// full rebuild-from-scan. Both underlying error strings are
    /// captured for diagnostics.
    Corrupt
    {
        primary_err: String,
        bak_err: String,
    },
}

impl std::fmt::Display for LoadErr
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
    {
        match self
        {
            LoadErr::NotFound =>
            {
                write!(f, "registry-load-error:not-found")
            }
            LoadErr::BakRecovered { warning, .. } =>
            {
                write!(f, "registry-load-warning:bak-recovered:{}", warning)
            }
            LoadErr::Corrupt { primary_err, bak_err } =>
            {
                write!(
                    f,
                    "registry-load-error:corrupt:primary={};bak={}",
                    primary_err, bak_err,
                )
            }
        }
    }
}

impl std::error::Error for LoadErr {}

/// Failure modes for [`save_atomic`].
#[derive(Debug)]
pub enum SaveErr
{
    /// Serde failed to encode the [`RegistryFile`] to JSON. Practically
    /// impossible for the current schema; kept as a distinct variant so
    /// future schema additions surface serialisation bugs loudly.
    Serialize(String),

    /// An I/O step failed. The `step` field names the failing operation
    /// (`"mkdir"`, `"write-tmp"`, `"fsync-tmp"`, `"copy-primary-to-bak-tmp"`,
    /// `"rename-bak-tmp-to-bak"`, `"rename-tmp-to-primary"`,
    /// `"fsync-parent"`) so callers can distinguish transient contention
    /// from a hard filesystem error.
    Io
    {
        step: &'static str,
        error: String,
    },
}

impl std::fmt::Display for SaveErr
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
    {
        match self
        {
            SaveErr::Serialize(e) =>
            {
                write!(f, "registry-write-error:serialize:{}", e)
            }
            SaveErr::Io { step, error } =>
            {
                write!(f, "registry-write-error:{}:{}", step, error)
            }
        }
    }
}

impl std::error::Error for SaveErr {}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Registry directory inside a project (`<project_root>/_mangaplaystudio`).
///
/// Kept as a helper so callers never compose the literal `"_mangaplaystudio"`
/// string themselves — matches the convention in
/// `.claude/rules/mangaplay-studio-app.md`.
pub fn registry_dir(project_root: &Path) -> PathBuf
{
    project_root.join(APP_DIR)
}

/// Path to `registry.json` inside a project.
pub fn registry_path(project_root: &Path) -> PathBuf
{
    registry_dir(project_root).join(REGISTRY_FILE)
}

/// Path to `registry.json.bak` inside a project.
pub fn registry_bak_path(project_root: &Path) -> PathBuf
{
    registry_dir(project_root).join(REGISTRY_BAK)
}

/// Path to `registry.json.tmp` inside a project.
fn registry_tmp_path(project_root: &Path) -> PathBuf
{
    registry_dir(project_root).join(REGISTRY_TMP)
}

/// Path to `registry.json.bak.tmp` inside a project.
fn registry_bak_tmp_path(project_root: &Path) -> PathBuf
{
    registry_dir(project_root).join(REGISTRY_BAK_TMP)
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/// Load the registry for `project_root` from disk.
///
/// Recovery cascade:
/// 1. Try `registry.json`. Parse OK → return `Ok`.
/// 2. Else try `registry.json.bak`. Parse OK → return
///    `Err(LoadErr::BakRecovered { registry, warning })` — the recovered
///    payload is inside the error so the caller can promote it back to
///    primary on the next save.
/// 3. Else if both files existed but neither parsed → `LoadErr::Corrupt`.
/// 4. Else neither exists → `LoadErr::NotFound`.
///
/// Pure I/O — no locks, no state. The caller (Part 2 managed-state
/// wiring) is responsible for serialising concurrent load/save on the
/// same project root.
pub fn load_from_disk(project_root: &Path) -> Result<RegistryFile, LoadErr>
{
    let primary = registry_path(project_root);
    let bak = registry_bak_path(project_root);

    let primary_result = read_and_parse(&primary);
    let bak_result = read_and_parse(&bak);

    match (primary_result, bak_result)
    {
        (ReadResult::Ok(reg), _) => Ok(reg),

        (ReadResult::Err(primary_err), ReadResult::Ok(reg)) =>
        {
            Err(LoadErr::BakRecovered
            {
                registry: reg,
                warning: format!("primary unreadable: {}", primary_err),
            })
        }

        (ReadResult::Missing, ReadResult::Ok(reg)) =>
        {
            Err(LoadErr::BakRecovered
            {
                registry: reg,
                warning: "primary missing; recovered from .bak".to_string(),
            })
        }

        (ReadResult::Err(primary_err), ReadResult::Err(bak_err)) =>
        {
            Err(LoadErr::Corrupt { primary_err, bak_err })
        }

        (ReadResult::Err(primary_err), ReadResult::Missing) =>
        {
            Err(LoadErr::Corrupt
            {
                primary_err,
                bak_err: "no .bak on disk".to_string(),
            })
        }

        (ReadResult::Missing, ReadResult::Missing) => Err(LoadErr::NotFound),

        (ReadResult::Missing, ReadResult::Err(bak_err)) =>
        {
            // Primary gone, .bak corrupt — treat as full corruption; caller
            // must rebuild.
            Err(LoadErr::Corrupt
            {
                primary_err: "no primary on disk".to_string(),
                bak_err,
            })
        }
    }
}

/// Three-way outcome for a single-file read attempt. Distinguishing
/// "file not present" from "file present but parse failed" is what
/// lets [`load_from_disk`] pick the right `LoadErr` variant.
enum ReadResult
{
    Ok(RegistryFile),
    Missing,
    Err(String),
}

/// Version-only peek for choosing the right deserialization target.
#[derive(Deserialize)]
struct VersionPeek
{
    version: u32,
}

fn read_and_parse(path: &Path) -> ReadResult
{
    match fs::read(path)
    {
        Ok(bytes) =>
        {
            let ver = match serde_json::from_slice::<VersionPeek>(&bytes)
            {
                Ok(v) => v.version,
                Err(e) => return ReadResult::Err(
                    format!("registry-parse-error:version-peek:{}", e)
                ),
            };
            match ver
            {
                1 =>
                {
                    match serde_json::from_slice::<RegistryFileV1>(&bytes)
                    {
                        Ok(v1) => ReadResult::Ok(RegistryFile
                        {
                            version: REGISTRY_VERSION,
                            project_uuid: v1.project_uuid,
                            entries: v1.entries,
                        }),
                        Err(e) => ReadResult::Err(
                            format!("registry-parse-error:v1:{}", e)
                        ),
                    }
                }
                2 =>
                {
                    match serde_json::from_slice::<RegistryFile>(&bytes)
                    {
                        Ok(reg) => ReadResult::Ok(reg),
                        Err(e) => ReadResult::Err(
                            format!("registry-parse-error:v2:{}", e)
                        ),
                    }
                }
                _ =>
                {
                    ReadResult::Err(
                        format!("registry-parse-error:unknown-version:{}", ver)
                    )
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound =>
        {
            ReadResult::Missing
        }
        Err(e) => ReadResult::Err(format!("registry-read-error:{}", e)),
    }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/// Save `reg` to `<project_root>/_mangaplaystudio/registry.json` atomically.
///
/// See the module-level docs for the full write sequence and retry policy.
/// The `_mangaplaystudio/` directory is created if missing.
pub fn save_atomic(project_root: &Path, reg: &RegistryFile) -> Result<(), SaveErr>
{
    let dir = registry_dir(project_root);
    let primary = registry_path(project_root);
    let bak = registry_bak_path(project_root);
    let bak_tmp = registry_bak_tmp_path(project_root);
    let tmp = registry_tmp_path(project_root);

    // 0. Ensure the app dir exists. Idempotent.
    fs::create_dir_all(&dir).map_err(|e| SaveErr::Io
    {
        step: "mkdir",
        error: e.to_string(),
    })?;

    // 1. Serialize.
    let bytes = serde_json::to_vec_pretty(reg).map_err(|e| SaveErr::Serialize(e.to_string()))?;

    // 2. Write tmp + fsync.
    {
        let mut f = fs::File::create(&tmp).map_err(|e| SaveErr::Io
        {
            step: "write-tmp",
            error: e.to_string(),
        })?;
        f.write_all(&bytes).map_err(|e| SaveErr::Io
        {
            step: "write-tmp",
            error: e.to_string(),
        })?;
        f.sync_all().map_err(|e| SaveErr::Io
        {
            step: "fsync-tmp",
            error: e.to_string(),
        })?;
    }

    // 3. Refresh `.bak` from the current primary WITHOUT unlinking
    //    primary first. Copy → rename means:
    //      - if `fs::copy` fails, primary is untouched and we abort.
    //      - if the follow-up rename fails, primary is still untouched
    //        and we abort.
    //      - if either succeeds, primary either still points at the
    //        old payload OR we advance to step 4. No "no primary" gap.
    //
    //    First save has no primary → skip; .bak stays absent until the
    //    second save.
    if primary.exists()
    {
        // Wipe any leftover from a previous crashed save so `rename`
        // has a clean destination on Windows.
        let _ = fs::remove_file(&bak_tmp);

        if let Err(e) = fs::copy(&primary, &bak_tmp)
        {
            let _ = fs::remove_file(&bak_tmp);
            return Err(SaveErr::Io
            {
                step: "copy-primary-to-bak-tmp",
                error: e.to_string(),
            });
        }

        // Overwrite any stale `.bak` — atomic replace on POSIX and
        // Windows.
        if let Err(e) = fs::rename(&bak_tmp, &bak)
        {
            let _ = fs::remove_file(&bak_tmp);
            return Err(SaveErr::Io
            {
                step: "rename-bak-tmp-to-bak",
                error: e.to_string(),
            });
        }
    }

    // 4. Rename tmp → primary with retry/backoff. Mirrors the pattern
    //    in `fs_helpers::atomic_write_impl` to survive transient
    //    Windows AV / indexer locks on the destination slot.
    let mut last_err = String::new();
    let mut renamed = false;
    for delay_ms in [0u64, 50, 150, 450]
    {
        if delay_ms > 0
        {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
        match fs::rename(&tmp, &primary)
        {
            Ok(()) =>
            {
                renamed = true;
                break;
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    if !renamed
    {
        // Best-effort cleanup of the leftover tmp so the next save starts clean.
        let _ = fs::remove_file(&tmp);
        return Err(SaveErr::Io
        {
            step: "rename-tmp-to-primary",
            error: last_err,
        });
    }

    // 5. fsync parent dir on POSIX so the rename itself is durable.
    //    Windows: `std::fs::rename` uses
    //    `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` — no `WRITE_THROUGH`
    //    flag — so a hard power-loss window remains between the rename
    //    and the OS write-back. Recovery falls back to
    //    `registry.json.bak`.
    #[cfg(unix)]
    {
        if let Ok(dir_handle) = fs::File::open(&dir)
        {
            // Best-effort — not all POSIX filesystems (e.g. some FUSE mounts)
            // support directory fsync. Failure here is not a save failure.
            let _ = dir_handle.sync_all();
        }
    }

    Ok(())
}
