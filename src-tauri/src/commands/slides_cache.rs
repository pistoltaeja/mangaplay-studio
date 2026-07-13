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
//! Atomicity contract per `TODO/sync-existing-slides-prepare.md`:
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
    validate_presentation_id(presentation_id)?;
    Ok(storyboard_dir(project_root).join(presentation_id))
}

/// Reject presentation IDs with path separators or `..` segments. Defence in
/// depth — the ID originates from a user-pasted URL parsed on the JS side.
fn validate_presentation_id(id: &str) -> Result<(), String>
{
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.contains('\0')
    {
        return Err("bad-presentation-id".into());
    }
    Ok(())
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

/// Reject page IDs that would let a caller escape the presentation dir.
fn validate_page_id(page_id: &str) -> Result<(), String>
{
    if page_id.is_empty()
        || page_id.contains('/')
        || page_id.contains('\\')
        || page_id.contains("..")
        || page_id.contains('\0')
    {
        return Err("bad-page-id".into());
    }
    Ok(())
}

fn manifest_path(pres_dir: &Path) -> PathBuf
{
    pres_dir.join("manifest.json")
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
    validate_page_id(page_id)?;
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
            match std::fs::remove_file(&full)
            {
                Ok(()) => removed_paths.push(full.to_string_lossy().to_string()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => log::warn!(
                    "[slides_deck_gc] failed to remove {}: {}",
                    full.display(), e
                ),
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
        match std::fs::remove_file(&full)
        {
            Ok(()) => removed_paths.push(full.to_string_lossy().to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!(
                "[slides_deck_gc] failed to remove orphan {}: {}",
                full.display(), e
            ),
        }
    }

    let kept = manifest.len();
    write_manifest(&pres_dir, &manifest)?;

    Ok(GcResult { removed_paths, kept })
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

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests
{
    use super::*;
    use tempfile::TempDir;

    const PID: &str = "presABC123";

    fn make_project() -> TempDir
    {
        let td = TempDir::new().unwrap();
        // Scaffold storyboard dir the same way `project_open` does.
        std::fs::create_dir_all(storyboard_dir(td.path())).unwrap();
        td
    }

    #[test]
    fn stat_no_cache_dir()
    {
        let td = make_project();
        let r = slides_deck_stat_impl(td.path(), PID).unwrap();
        assert!(!r.cache_dir_exists);
        assert!(r.manifest.is_empty());
        assert!(r.orphan_paths.is_empty());
    }

    #[test]
    fn write_two_then_stat()
    {
        let td = make_project();
        slides_deck_write_impl(td.path(), PID, "0001", "abcdef01", b"one").unwrap();
        slides_deck_write_impl(td.path(), PID, "0002", "12345678", b"two").unwrap();
        let r = slides_deck_stat_impl(td.path(), PID).unwrap();
        assert!(r.cache_dir_exists);
        assert_eq!(r.manifest.len(), 2);
        assert_eq!(r.manifest.get("0001").unwrap().crc, "abcdef01");
        assert_eq!(r.manifest.get("0002").unwrap().path, "0002.png");
        assert!(r.orphan_paths.is_empty());
    }

    #[test]
    fn write_same_page_twice_replaces_png()
    {
        // With the CRC-less filename the second write atomically replaces
        // the first — no orphan is produced for update-in-place. Manifest
        // reflects the new crc. Older test expected an orphan; that only
        // held when the filename embedded the crc.
        let td = make_project();
        slides_deck_write_impl(td.path(), PID, "0001", "aaaaaaaa", b"v1").unwrap();
        slides_deck_write_impl(td.path(), PID, "0001", "bbbbbbbb", b"v2").unwrap();
        let r = slides_deck_stat_impl(td.path(), PID).unwrap();
        assert_eq!(r.manifest.get("0001").unwrap().crc, "bbbbbbbb");
        assert_eq!(r.manifest.get("0001").unwrap().path, "0001.png");
        assert!(r.orphan_paths.is_empty(),
            "expected no orphans after in-place rewrite; got {:?}", r.orphan_paths);

        // And the on-disk bytes are the new version.
        let contents = std::fs::read(presentation_dir(td.path(), PID).unwrap().join("0001.png"))
            .unwrap();
        assert_eq!(contents, b"v2");
    }

    #[test]
    fn gc_removes_dropped_pages()
    {
        let td = make_project();
        slides_deck_write_impl(td.path(), PID, "0001", "aaaaaaaa", b"a").unwrap();
        slides_deck_write_impl(td.path(), PID, "0002", "bbbbbbbb", b"b").unwrap();
        let keep = vec!["0001".to_string()];
        let g = slides_deck_gc_impl(td.path(), PID, &keep).unwrap();
        assert_eq!(g.kept, 1);
        assert_eq!(g.removed_paths.len(), 1);
        let r = slides_deck_stat_impl(td.path(), PID).unwrap();
        assert_eq!(r.manifest.len(), 1);
        assert!(r.manifest.contains_key("0001"));
        assert!(r.orphan_paths.is_empty());
    }

    #[test]
    fn gc_idempotent()
    {
        let td = make_project();
        slides_deck_write_impl(td.path(), PID, "0001", "aaaaaaaa", b"a").unwrap();
        let keep = vec!["0001".to_string()];
        let g1 = slides_deck_gc_impl(td.path(), PID, &keep).unwrap();
        let g2 = slides_deck_gc_impl(td.path(), PID, &keep).unwrap();
        assert_eq!(g1.kept, 1);
        assert_eq!(g2.kept, 1);
        assert!(g2.removed_paths.is_empty());
    }

    #[test]
    fn gc_missing_cache_dir_ok()
    {
        let td = make_project();
        let g = slides_deck_gc_impl(td.path(), PID, &[]).unwrap();
        assert_eq!(g.kept, 0);
        assert!(g.removed_paths.is_empty());
    }

    #[test]
    fn reject_page_id_with_separators()
    {
        let td = make_project();
        assert!(slides_deck_write_impl(td.path(), PID, "a/b", "abcdef01", b"x").is_err());
        assert!(slides_deck_write_impl(td.path(), PID, "a\\b", "abcdef01", b"x").is_err());
        assert!(slides_deck_write_impl(td.path(), PID, "..", "abcdef01", b"x").is_err());
        assert!(slides_deck_write_impl(td.path(), PID, "..hidden", "abcdef01", b"x").is_err());
        assert!(slides_deck_write_impl(td.path(), PID, "", "abcdef01", b"x").is_err());
    }

    #[test]
    fn reject_bad_crc()
    {
        let td = make_project();
        // Uppercase.
        assert!(slides_deck_write_impl(td.path(), PID, "0001", "ABCDEF01", b"x").is_err());
        // Wrong length.
        assert!(slides_deck_write_impl(td.path(), PID, "0001", "abc", b"x").is_err());
        // Non-hex.
        assert!(slides_deck_write_impl(td.path(), PID, "0001", "gggggggg", b"x").is_err());
    }

    #[test]
    fn reject_bad_presentation_id()
    {
        let td = make_project();
        assert!(slides_deck_stat_impl(td.path(), "a/b").is_err());
        assert!(slides_deck_stat_impl(td.path(), "..").is_err());
        assert!(slides_deck_write_impl(td.path(), "a\\b", "0001", "abcdef01", b"x").is_err());
    }

    #[test]
    fn concurrent_lock_returns_lock_held()
    {
        use std::sync::{Arc, Mutex};
        use std::sync::mpsc;

        let td = make_project();
        let pres_dir = presentation_dir(td.path(), PID).unwrap();
        std::fs::create_dir_all(&pres_dir).unwrap();

        // Spawn a thread that acquires the lock and holds it until signalled.
        let held = Arc::new(Mutex::new(()));
        let (grab_tx, grab_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let pres_dir_c = pres_dir.clone();
        let held_c = held.clone();
        let holder = std::thread::spawn(move ||
        {
            let _hg = held_c.lock().unwrap();
            let _guard = acquire_lock(&pres_dir_c).unwrap();
            grab_tx.send(()).unwrap();
            // Hold until the main thread signals release.
            release_rx.recv().unwrap();
        });

        // Wait for the holder to actually acquire.
        grab_rx.recv().unwrap();

        // Second call must fail with LOCK_HELD.
        let err = slides_deck_write_impl(td.path(), PID, "0001", "abcdef01", b"x")
            .expect_err("expected LOCK_HELD");
        assert_eq!(err, "LOCK_HELD");
        let err2 = slides_deck_gc_impl(td.path(), PID, &[]).expect_err("expected LOCK_HELD");
        assert_eq!(err2, "LOCK_HELD");

        // Release the holder.
        release_tx.send(()).unwrap();
        holder.join().unwrap();

        // Now the write succeeds.
        slides_deck_write_impl(td.path(), PID, "0001", "abcdef01", b"x").unwrap();
    }

    #[test]
    fn migration_moves_legacy_dir_up_one_level()
    {
        // Pre-populate the legacy layout: storyboard/slides-cache/<pid>/*.
        let td = make_project();
        let legacy = storyboard_dir(td.path())
            .join("slides-cache")
            .join(PID);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("0001.png"), b"legacy-png").unwrap();
        std::fs::write(
            legacy.join("manifest.json"),
            r#"{"0001":{"crc":"abcdef01","path":"0001.png","downloadedAt":"2026-01-01T00:00:00Z"}}"#,
        ).unwrap();

        // First `stat` call triggers migration.
        let r = slides_deck_stat_impl(td.path(), PID).unwrap();
        assert!(r.cache_dir_exists);
        assert_eq!(r.manifest.len(), 1);
        assert_eq!(r.manifest.get("0001").unwrap().crc, "abcdef01");

        // New layout on disk.
        let new_dir = storyboard_dir(td.path()).join(PID);
        assert!(new_dir.is_dir(), "expected new-layout dir {}", new_dir.display());
        assert!(new_dir.join("0001.png").is_file());

        // Legacy dir emptied + removed.
        assert!(!storyboard_dir(td.path()).join("slides-cache").exists(),
            "legacy slides-cache/ should be gone");
    }

    #[test]
    fn migration_idempotent_when_target_exists()
    {
        // Pre-populate BOTH legacy AND new layouts for the same pid — the
        // migration must not clobber a pre-existing target.
        let td = make_project();
        let legacy = storyboard_dir(td.path()).join("slides-cache").join(PID);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("0001.png"), b"legacy").unwrap();

        let new_dir = storyboard_dir(td.path()).join(PID);
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::write(new_dir.join("0001.png"), b"new").unwrap();

        // Migration should NOT overwrite the new dir.
        let _ = slides_deck_stat_impl(td.path(), PID).unwrap();
        assert!(legacy.is_dir(), "legacy dir must remain when target exists");
        let contents = std::fs::read(new_dir.join("0001.png")).unwrap();
        assert_eq!(contents, b"new", "new-layout png must not be clobbered");
    }
}
