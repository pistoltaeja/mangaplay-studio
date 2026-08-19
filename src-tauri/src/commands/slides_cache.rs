//! Slides-sync per-project deck-image store.
//!
//! Owns `<projectRoot>/_mangaplaystudio/storyboard/<presentationId>/`.
//! Three Tauri commands: stat / write / gc. Each mutating command holds an
//! exclusive `fs2` file lock on `<deck>/.lock` for the whole transaction so
//! concurrent windows serialise.
//!
//! Naming: the folder used to be `storyboard/slides-cache/<pid>/` — users
//! read "cache" as "throwaway" and worried it wouldn't survive. Renamed the
//! folder AND the Tauri command surface (`slides_deck_*`) so the store's
//! persistence contract is obvious from the shell too. See
//! `migrate_legacy_slides_cache()` for the one-shot migration.
//!
//! Atomicity contract:
//! 1. Per-presentation exclusive file lock.
//! 2. Image bytes → `<file>.tmp` → fsync → rename.
//! 3. Manifest RMW → `manifest.json.tmp` → fsync → rename. Manifest written LAST.
//! 4. A crash between step 2 and step 3 leaves an orphan png cleaned up by
//!    `slides_deck_gc` on the next successful prep pass.

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::commands::project::storyboard_dir;
use crate::commands::slides_validation::validate_slug;
use crate::fs_helpers::chrono_iso_now;

// ── Types ────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestEntry
{
    pub crc: String,
    /// Filename relative to `<presentationId>/`, e.g. `"0001.png"`.
    pub path: String,
    #[serde(rename = "downloadedAt")]
    pub downloaded_at: String,
}

#[derive(Serialize, Debug)]
pub struct StatResult
{
    pub manifest: HashMap<String, ManifestEntry>,
    #[serde(rename = "orphanPaths")]
    pub orphan_paths: Vec<String>,
    #[serde(rename = "cacheDirExists")]
    pub cache_dir_exists: bool,
}

#[derive(Serialize, Debug)]
pub struct WriteResult
{
    /// Absolute path to the written PNG.
    pub path: String,
}

#[derive(Serialize, Debug)]
pub struct GcResult
{
    #[serde(rename = "removedPaths")]
    pub removed_paths: Vec<String>,
    pub kept: usize,
}

// ── Path helpers (module-private) ────────────────────────────────────────

/// `<projectRoot>/_mangaplaystudio/storyboard/<presentationId>/`. The old
/// layout nested an extra `slides-cache/` segment — dropped so the folder
/// name no longer reads as "throwaway".
fn presentation_dir(project_root: &Path, presentation_id: &str) -> Result<PathBuf, String>
{
    validate_slug(presentation_id, "bad-presentation-id", 200)?;
    Ok(storyboard_dir(project_root).join(presentation_id))
}

/// 8 lowercase hex chars.
fn validate_crc(crc: &str) -> Result<(), String>
{
    if crc.len() != 8 { return Err("bad-crc".into()); }
    if !crc.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    {
        return Err("bad-crc".into());
    }
    Ok(())
}

fn manifest_path(pres_dir: &Path) -> PathBuf
{
    pres_dir.join("manifest.json")
}

/// Remove `path`, treating a missing file as a silent no-op. Returns `true`
/// when a file was actually removed, `false` when it was already gone. Any
/// other I/O error is logged via `log::warn!` (the `ctx` phrase followed by
/// the path and error) and swallowed — best-effort cleanup must not abort
/// the caller's transaction.
fn remove_file_soft(path: &Path, ctx: &str) -> bool
{
    match std::fs::remove_file(path)
    {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) =>
        {
            log::warn!("{} {}: {}", ctx, path.display(), e);
            false
        }
    }
}

fn lock_path(pres_dir: &Path) -> PathBuf
{
    pres_dir.join(".lock")
}

// ── One-shot migration from the old layout ───────────────────────────────

/// Best-effort migration: move any `<storyboard>/slides-cache/<pid>/` up one
/// level to `<storyboard>/<pid>/` and delete the empty legacy folder.
///
/// Idempotent — no-op after the first successful run. Called from
/// `slides_deck_stat_impl` so every deck touch runs the check exactly once
/// per boot's-worth of first-access. Errors are logged but never surfaced —
/// the migration is opportunistic and must not block callers.
fn migrate_legacy_slides_cache(project_root: &Path)
{
    let legacy = storyboard_dir(project_root).join("slides-cache");
    if !legacy.is_dir()
    {
        return;
    }
    let read = match std::fs::read_dir(&legacy)
    {
        Ok(r) => r,
        Err(e) =>
        {
            log::warn!(
                "[slides_deck] migrate: read_dir({}) failed: {}",
                legacy.display(), e
            );
            return;
        }
    };
    for entry in read.flatten()
    {
        let file_type = match entry.file_type()
        {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !file_type.is_dir()
        {
            continue;
        }
        let name = entry.file_name();
        let target = storyboard_dir(project_root).join(&name);
        if target.exists()
        {
            // A new-layout dir already exists for this presentation id —
            // don't clobber. The legacy copy will be left behind so the
            // user can inspect and delete manually.
            log::warn!(
                "[slides_deck] migrate: target {} already exists; leaving {} in place",
                target.display(), entry.path().display()
            );
            continue;
        }
        if let Err(e) = std::fs::rename(entry.path(), &target)
        {
            log::warn!(
                "[slides_deck] migrate: rename {} → {} failed: {}",
                entry.path().display(), target.display(), e
            );
        }
    }
    // Best-effort cleanup — only succeeds when the legacy dir is empty.
    let _ = std::fs::remove_dir(&legacy);
}

// ── Manifest read / write ────────────────────────────────────────────────

fn read_manifest(pres_dir: &Path) -> HashMap<String, ManifestEntry>
{
    let mp = manifest_path(pres_dir);
    let raw = match std::fs::read_to_string(&mp)
    {
        Ok(s) => s,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_str::<HashMap<String, ManifestEntry>>(&raw)
    {
        Ok(m) => m,
        Err(e) =>
        {
            log::warn!("[slides_deck] manifest corrupt at {}: {} — treating as empty",
                mp.display(), e);
            HashMap::new()
        }
    }
}

/// Write manifest via tmp + fsync + rename.
fn write_manifest(pres_dir: &Path, m: &HashMap<String, ManifestEntry>) -> Result<(), String>
{
    let mp = manifest_path(pres_dir);
    let tmp = mp.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    let mut f = File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, &mp).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Locking ──────────────────────────────────────────────────────────────

/// Guard that releases the lock on drop.
struct LockGuard
{
    file: Option<File>,
}

impl Drop for LockGuard
{
    fn drop(&mut self)
    {
        if let Some(f) = self.file.take()
        {
            let _ = fs2::FileExt::unlock(&f);
        }
    }
}

/// Try-acquire an exclusive lock on `<pres_dir>/.lock`. Returns
/// `Err("LOCK_HELD")` when another process/thread already holds it.
fn acquire_lock(pres_dir: &Path) -> Result<LockGuard, String>
{
    std::fs::create_dir_all(pres_dir).map_err(|e| e.to_string())?;
    let f = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path(pres_dir))
        .map_err(|e| e.to_string())?;
    match FileExt::try_lock_exclusive(&f)
    {
        Ok(()) => Ok(LockGuard { file: Some(f) }),
        Err(_) => Err("LOCK_HELD".into()),
    }
}

// ── Directory scan for orphan detection ──────────────────────────────────

/// Enumerate `<pres_dir>/*.png` (top-level only), skipping `.lock` /
/// `manifest.json`. Returns filenames relative to `<pres_dir>`.
fn list_png_files(pres_dir: &Path) -> Vec<String>
{
    let mut out = Vec::new();
    let read = match std::fs::read_dir(pres_dir)
    {
        Ok(r) => r,
        Err(_) => return out,
    };
    for entry in read.flatten()
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".lock" || name == "manifest.json" || name.ends_with(".tmp")
        {
            continue;
        }
        // Only consider regular .png files at the top level.
        if !name.ends_with(".png") { continue; }
        if let Ok(ft) = entry.file_type()
        {
            if ft.is_file() { out.push(name); }
        }
    }
    out
}

// ── Impl helpers ─────────────────────────────────────────────────────────

pub fn slides_deck_stat_impl(
    project_path: &Path,
    presentation_id: &str,
) -> Result<StatResult, String>
{
    // Opportunistic one-shot migration from the old `slides-cache/` layout.
    // Runs before `presentation_dir` resolution so first-access after ship
    // sees files in the new location on the very same call.
    migrate_legacy_slides_cache(project_path);

    let pres_dir = presentation_dir(project_path, presentation_id)?;
    if !pres_dir.is_dir()
    {
        return Ok(StatResult
        {
            manifest: HashMap::new(),
            orphan_paths: Vec::new(),
            cache_dir_exists: false,
        });
    }
    let manifest = read_manifest(&pres_dir);
    let known: std::collections::HashSet<String> = manifest
        .values()
        .map(|e| e.path.clone())
        .collect();
    let mut orphan_paths: Vec<String> = list_png_files(&pres_dir)
        .into_iter()
        .filter(|name| !known.contains(name))
        .collect();
    orphan_paths.sort();
    Ok(StatResult
    {
        manifest,
        orphan_paths,
        cache_dir_exists: true,
    })
}

pub fn slides_deck_write_impl(
    project_path: &Path,
    presentation_id: &str,
    page_id: &str,
    crc: &str,
    bytes: &[u8],
) -> Result<WriteResult, String>
{
    validate_crc(crc)?;
    validate_slug(page_id, "bad-page-id", usize::MAX)?;
    let pres_dir = presentation_dir(project_path, presentation_id)?;
    std::fs::create_dir_all(&pres_dir).map_err(|e| e.to_string())?;

    let _guard = acquire_lock(&pres_dir)?;

    // CRC is no longer in the filename — the manifest owns change-detection
    // via its per-page `crc` field. Filename is deterministic so re-writes
    // of the same page atomically replace the previous image via
    // tmp+rename; no orphan is produced for update-in-place.
    let filename = format!("{}.png", page_id);
    let target = pres_dir.join(&filename);
    let tmp = pres_dir.join(format!("{}.tmp", filename));

    // Image write: bytes → tmp → fsync → rename.
    {
        let mut f = File::create(&tmp).map_err(|e|
        {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
        if let Err(e) = f.write_all(bytes)
        {
            drop(f);
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        if let Err(e) = f.sync_all()
        {
            drop(f);
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
    }
    if let Err(e) = std::fs::rename(&tmp, &target)
    {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }

    // Manifest RMW — written LAST so a crash between image-write and this
    // step leaves at most an orphaned png (cleaned up by `slides_deck_gc`).
    let mut m = read_manifest(&pres_dir);
    m.insert(page_id.to_string(), ManifestEntry
    {
        crc: crc.to_string(),
        path: filename.clone(),
        downloaded_at: chrono_iso_now(),
    });
    write_manifest(&pres_dir, &m)?;

    Ok(WriteResult { path: target.to_string_lossy().to_string() })
}

pub fn slides_deck_gc_impl(
    project_path: &Path,
    presentation_id: &str,
    keep_page_ids: &[String],
) -> Result<GcResult, String>
{
    let pres_dir = presentation_dir(project_path, presentation_id)?;
    if !pres_dir.is_dir()
    {
        return Ok(GcResult { removed_paths: Vec::new(), kept: 0 });
    }

    let _guard = acquire_lock(&pres_dir)?;

    let mut manifest = read_manifest(&pres_dir);
    let keep: std::collections::HashSet<&str> =
        keep_page_ids.iter().map(|s| s.as_str()).collect();

    let mut removed_paths: Vec<String> = Vec::new();

    // Step 1: drop manifest entries not in the keep list and delete their pngs.
    let drop_keys: Vec<String> = manifest
        .keys()
        .filter(|k| !keep.contains(k.as_str()))
        .cloned()
        .collect();
    for k in &drop_keys
    {
        if let Some(entry) = manifest.remove(k)
        {
            let full = pres_dir.join(&entry.path);
            if remove_file_soft(&full, "[slides_deck_gc] failed to remove")
            {
                removed_paths.push(full.to_string_lossy().to_string());
            }
        }
    }

    // Step 2: scan for orphan pngs (not referenced by the UPDATED manifest)
    // and delete them too.
    let known: std::collections::HashSet<String> = manifest
        .values()
        .map(|e| e.path.clone())
        .collect();
    for name in list_png_files(&pres_dir)
    {
        if known.contains(&name) { continue; }
        let full = pres_dir.join(&name);
        if remove_file_soft(&full, "[slides_deck_gc] failed to remove orphan")
        {
            removed_paths.push(full.to_string_lossy().to_string());
        }
    }

    let kept = manifest.len();
    write_manifest(&pres_dir, &manifest)?;

    Ok(GcResult { removed_paths, kept })
}

#[derive(Serialize, Debug)]
pub struct DeleteResult
{
    #[serde(rename = "removedFiles")]
    pub removed_files: usize,
}

/// Delete every file belonging to `presentation_id` — all `<pageId>.png`
/// files referenced by the manifest AND the manifest itself. Other decks'
/// subdirectories are untouched because each deck lives in its own
/// `<presentationId>/` folder.
///
/// Missing deck (dir doesn't exist) is `Ok({ removed_files: 0 })`, not an
/// error — this is the recovery-path idempotent case.
///
/// The lock file is released and cleaned up as part of the same operation
/// so the empty `<presentationId>/` dir can be removed on completion.
pub fn slides_deck_delete_impl(
    project_path: &Path,
    presentation_id: &str,
) -> Result<DeleteResult, String>
{
    let pres_dir = presentation_dir(project_path, presentation_id)?;
    if !pres_dir.is_dir()
    {
        return Ok(DeleteResult { removed_files: 0 });
    }

    let mut removed_files: usize = 0;

    // Scope the lock guard so we can drop the .lock file at the end.
    {
        let _guard = acquire_lock(&pres_dir)?;

        let manifest = read_manifest(&pres_dir);
        for entry in manifest.values()
        {
            let full = pres_dir.join(&entry.path);
            if remove_file_soft(&full, "[slides_deck_delete] failed to remove")
            {
                removed_files += 1;
            }
        }

        // Manifest itself.
        let mp = manifest_path(&pres_dir);
        if remove_file_soft(&mp, "[slides_deck_delete] failed to remove manifest")
        {
            removed_files += 1;
        }

        // Sweep any lingering tmp files so remove_dir succeeds below.
        if let Ok(read) = std::fs::read_dir(&pres_dir)
        {
            for e in read.flatten()
            {
                let name = e.file_name().to_string_lossy().to_string();
                if name.ends_with(".tmp")
                {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    // Lock released. Remove the .lock file itself, then attempt to remove
    // the (now-empty) presentation dir. Best-effort — a leftover file
    // authored outside our command surface leaves the dir behind.
    let _ = std::fs::remove_file(lock_path(&pres_dir));
    let _ = std::fs::remove_dir(&pres_dir);

    Ok(DeleteResult { removed_files })
}

// ── Tauri commands ───────────────────────────────────────────────────────

#[tauri::command]
pub fn slides_deck_stat(
    project_path: String,
    presentation_id: String,
) -> Result<StatResult, String>
{
    slides_deck_stat_impl(Path::new(&project_path), &presentation_id)
}

#[tauri::command]
pub fn slides_deck_write(
    project_path: String,
    presentation_id: String,
    page_id: String,
    crc: String,
    bytes: Vec<u8>,
) -> Result<WriteResult, String>
{
    slides_deck_write_impl(
        Path::new(&project_path),
        &presentation_id,
        &page_id,
        &crc,
        &bytes,
    )
}

#[tauri::command]
pub fn slides_deck_gc(
    project_path: String,
    presentation_id: String,
    keep_page_ids: Vec<String>,
) -> Result<GcResult, String>
{
    slides_deck_gc_impl(
        Path::new(&project_path),
        &presentation_id,
        &keep_page_ids,
    )
}

#[tauri::command]
pub fn slides_deck_delete(
    project_path: String,
    presentation_id: String,
) -> Result<DeleteResult, String>
{
    slides_deck_delete_impl(Path::new(&project_path), &presentation_id)
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "slides_cache_tests.rs"]
mod tests;
