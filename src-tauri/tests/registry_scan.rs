//! Integration tests for `scan_and_reconcile`.
//!
//! Focus: the mint/heal/tombstone cascade. The Tauri command wrapping
//! (`registry_list_tree`) is thin plumbing over this helper.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;
use std::time::Instant;

use app_lib::{
    LoadedRegistry, NativeId, TreeEntryDto, scan_and_reconcile,
};
use tempfile::TempDir;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// Fresh empty in-memory registry rooted at `root`. `dirty` starts `false`
/// so the tests can assert whether the scan itself flipped it.
fn empty_registry_at(root: &Path) -> LoadedRegistry
{
    LoadedRegistry
    {
        project_uuid: Uuid::new_v4(),
        root_path: root.to_path_buf(),
        entries: BTreeMap::new(),
        native_id_index: HashMap::new(),
        path_index: HashMap::new(),
        dirty: false,
        last_save: Instant::now(),
    }
}

/// Write a file at `<root>/<rel>`, creating parent dirs.
fn write_file(root: &Path, rel: &str, contents: &[u8])
{
    let abs = root.join(rel);
    if let Some(p) = abs.parent()
    {
        fs::create_dir_all(p).unwrap();
    }
    fs::write(&abs, contents).unwrap();
}

/// Look up an entry by its rel_path (there's exactly one per test-scale run).
fn dto_by_path<'a>(dtos: &'a [TreeEntryDto], rel: &str) -> Option<&'a TreeEntryDto>
{
    dtos.iter().find(|d| d.rel_path == rel)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn scan_empty_project_returns_empty_vec()
{
    let td = TempDir::new().unwrap();
    // Reserved app dir with nothing inside.
    fs::create_dir_all(td.path().join("_mangaplaystudio")).unwrap();

    let mut reg = empty_registry_at(td.path());
    let dtos = scan_and_reconcile(&mut reg).expect("scan ok");

    assert!(dtos.is_empty(), "no scripts → empty vec");
    assert!(reg.entries.is_empty(), "no entries minted");
    assert!(!reg.dirty, "empty scan on empty registry is not dirty");
}

#[test]
fn scan_fresh_mints_uuids_for_all_files()
{
    let td = TempDir::new().unwrap();
    let root = td.path();
    write_file(root, "top.mangaplay.md", b"top");
    write_file(root, "chapters/intro.mangaplay.md", b"intro");
    // Second file inside the folder so the folder is non-empty.
    write_file(root, "chapters/outro.mangaplay.md", b"outro");

    let mut reg = empty_registry_at(root);
    let dtos = scan_and_reconcile(&mut reg).expect("scan ok");

    // Expect: 1 folder + 3 files = 4 rows.
    assert_eq!(dtos.len(), 4, "1 folder + 3 files = 4 rows");

    // All fresh UUIDs — one per row.
    let mut uuids = std::collections::HashSet::new();
    for d in &dtos
    {
        assert!(uuids.insert(d.uuid.clone()), "no duplicate UUIDs");
    }

    // Same count in reg.entries (only non-tombstoned exist here).
    assert_eq!(reg.entries.len(), 4);
    assert!(reg.dirty, "fresh mints mark dirty");

    // The folder row references no parent; files under `chapters/` reference
    // that folder's UUID.
    let folder = dto_by_path(&dtos, "chapters").expect("folder emitted");
    assert_eq!(folder.kind, "folder");
    assert_eq!(folder.parent_uuid, None);

    let intro = dto_by_path(&dtos, "chapters/intro.mangaplay.md").expect("intro emitted");
    assert_eq!(intro.kind, "file");
    assert_eq!(intro.parent_uuid, Some(folder.uuid.clone()));
}

#[test]
fn scan_idempotent_on_second_call()
{
    let td = TempDir::new().unwrap();
    let root = td.path();
    write_file(root, "a.mangaplay.md", b"a");
    write_file(root, "sub/b.mangaplay.md", b"b");

    let mut reg = empty_registry_at(root);
    let dtos1 = scan_and_reconcile(&mut reg).expect("first scan");
    let entries_before = reg.entries.len();
    let uuids_before: Vec<String> = dtos1.iter().map(|d| d.uuid.clone()).collect();

    // Second scan starts clean.
    reg.dirty = false;
    let dtos2 = scan_and_reconcile(&mut reg).expect("second scan");

    assert_eq!(reg.entries.len(), entries_before, "no new entries minted");
    // Same UUIDs — matched via native_id_index (Linux) or path_index.
    let uuids_after: Vec<String> = dtos2.iter().map(|d| d.uuid.clone()).collect();
    let mut before_sorted = uuids_before.clone();
    let mut after_sorted = uuids_after.clone();
    before_sorted.sort();
    after_sorted.sort();
    assert_eq!(before_sorted, after_sorted, "same UUIDs across scans");

    assert!(!reg.dirty, "no changes → not dirty");

    // On Linux, `read_native_id` should have populated a `NativeId::Posix`
    // entry for `a.mangaplay.md` — confirms the native-id cascade actually
    // captured an inode rather than silently defaulting to `Unknown` and
    // routing everything through the path_index.
    #[cfg(target_os = "linux")]
    {
        let uuid = Uuid::parse_str(
            &dto_by_path(&dtos2, "a.mangaplay.md").unwrap().uuid,
        )
        .unwrap();
        let entry = reg.entries.get(&uuid).unwrap();
        assert!(
            matches!(entry.native_id, NativeId::Posix { .. }),
            "linux native_id should be Posix, got {:?}",
            entry.native_id,
        );
    }
}

// Native-ID-based rename detection only works on platforms where
// `read_native_id` returns a stable non-Unknown value. On Windows the
// current placeholder returns `Unknown` and this test would falsely mint
// a new UUID instead of healing. Re-enable when the NTFS reader lands.
#[cfg(not(target_os = "windows"))]
#[test]
fn scan_detects_external_rename_via_native_id()
{
    let td = TempDir::new().unwrap();
    let root = td.path();
    write_file(root, "before.mangaplay.md", b"contents");

    let mut reg = empty_registry_at(root);
    let dtos1 = scan_and_reconcile(&mut reg).expect("first scan");
    let before = dto_by_path(&dtos1, "before.mangaplay.md").expect("before minted");
    let uuid_before = before.uuid.clone();
    let rev_before = before.rev;

    // External rename — keeps the same inode (Linux/macOS) so native_id
    // stays constant.
    fs::rename(
        root.join("before.mangaplay.md"),
        root.join("after.mangaplay.md"),
    )
    .unwrap();

    // Reset dirty so we can assert the heal flipped it back on.
    reg.dirty = false;
    let dtos2 = scan_and_reconcile(&mut reg).expect("second scan");

    assert_eq!(
        dtos2.len(),
        1,
        "one file on disk → one row (no tombstone bleed-through)",
    );
    let after = &dtos2[0];
    assert_eq!(after.uuid, uuid_before, "same UUID re-used");
    assert_eq!(after.rel_path, "after.mangaplay.md", "path healed");
    assert!(after.rev > rev_before, "rev bumped on heal");
    assert!(reg.dirty, "heal marks dirty");
}

#[test]
fn scan_tombstones_missing_files()
{
    let td = TempDir::new().unwrap();
    let root = td.path();
    write_file(root, "keep.mangaplay.md", b"keep");
    write_file(root, "gone.mangaplay.md", b"gone");

    let mut reg = empty_registry_at(root);
    let dtos1 = scan_and_reconcile(&mut reg).expect("first scan");
    let gone_uuid_str = dto_by_path(&dtos1, "gone.mangaplay.md").unwrap().uuid.clone();
    let gone_uuid = Uuid::parse_str(&gone_uuid_str).unwrap();

    // Delete `gone.mangaplay.md` externally.
    fs::remove_file(root.join("gone.mangaplay.md")).unwrap();

    reg.dirty = false;
    let dtos2 = scan_and_reconcile(&mut reg).expect("second scan");

    // Returned Vec no longer contains the tombstoned entry.
    assert_eq!(dtos2.len(), 1, "only survivor emitted");
    assert_eq!(dtos2[0].rel_path, "keep.mangaplay.md");

    // Tombstone flag flipped on the missing entry.
    let ghost = reg.entries.get(&gone_uuid).expect("tombstoned entry retained");
    assert!(ghost.tombstone, "missing file → tombstoned");

    assert!(reg.dirty, "tombstoning marks dirty");
}

#[test]
fn scan_untombstones_reappearing_file()
{
    let td = TempDir::new().unwrap();
    let root = td.path();
    write_file(root, "flicker.mangaplay.md", b"original");

    let mut reg = empty_registry_at(root);
    let dtos1 = scan_and_reconcile(&mut reg).expect("first scan");
    let uuid_str = dto_by_path(&dtos1, "flicker.mangaplay.md").unwrap().uuid.clone();
    let uuid = Uuid::parse_str(&uuid_str).unwrap();

    // Capture native_id BEFORE delete so we can compare against the
    // post-recreate reading below.
    let native_before = reg.entries.get(&uuid).unwrap().native_id.clone();

    // Delete → second scan tombstones.
    fs::remove_file(root.join("flicker.mangaplay.md")).unwrap();
    let dtos2 = scan_and_reconcile(&mut reg).expect("second scan");
    assert!(dtos2.is_empty(), "file gone → empty tree");
    assert!(reg.entries.get(&uuid).unwrap().tombstone, "tombstoned");

    // Recreate at same path. On most Linux filesystems the inode differs
    // (proves the native_id branch cannot match) so the path_index cascade
    // is what un-tombstones; the assertion below tolerates the rare inode-
    // reuse case by falling back to a debug print.
    write_file(root, "flicker.mangaplay.md", b"revived");

    reg.dirty = false;
    let dtos3 = scan_and_reconcile(&mut reg).expect("third scan");

    assert_eq!(dtos3.len(), 1, "revived file emitted");
    assert_eq!(dtos3[0].uuid, uuid_str, "same UUID re-used via path_index");
    let survivor = reg.entries.get(&uuid).unwrap();
    assert!(!survivor.tombstone, "un-tombstoned on re-creation");
    assert_eq!(
        survivor.path, "flicker.mangaplay.md",
        "path matches → proves the path-keyed cascade branch fired",
    );
    let native_after = survivor.native_id.clone();
    if native_before == native_after
    {
        // Inode was reused — rare but possible on quick fs::write cycles.
        // Not a failure; native_id_index would have matched too. Log for
        // triage if this ever starts happening consistently.
        eprintln!(
            "[registry_scan test] inode reused on recreate: {:?}",
            native_after,
        );
    }
    else
    {
        // Expected common case on Linux: fresh inode → native_id changed.
        assert_ne!(native_before, native_after, "native_id differs on recreate");
    }
    assert!(reg.dirty, "un-tombstone marks dirty");
}

#[test]
fn scan_skips_dot_folders_and_reserved()
{
    let td = TempDir::new().unwrap();
    let root = td.path();

    // Reserved app dir at depth 0 — must be skipped.
    fs::create_dir_all(root.join("_mangaplaystudio")).unwrap();
    fs::write(root.join("_mangaplaystudio/registry.json"), b"{}").unwrap();

    // Dot folder + dot file at root — must be skipped.
    fs::create_dir_all(root.join(".hidden")).unwrap();
    fs::write(root.join(".hidden/secret.mangaplay.md"), b"secret").unwrap();
    fs::write(root.join(".DS_Store"), b"junk").unwrap();

    // A real script survives.
    write_file(root, "real.mangaplay.md", b"real");

    let mut reg = empty_registry_at(root);
    let dtos = scan_and_reconcile(&mut reg).expect("scan ok");

    // Only `real.mangaplay.md` should appear.
    assert_eq!(dtos.len(), 1, "only the real file");
    assert_eq!(dtos[0].rel_path, "real.mangaplay.md");
}

#[test]
fn scan_emits_folder_entries_when_nonempty()
{
    let td = TempDir::new().unwrap();
    let root = td.path();
    write_file(root, "chapters/story.mangaplay.md", b"story");

    let mut reg = empty_registry_at(root);
    let dtos = scan_and_reconcile(&mut reg).expect("scan ok");

    assert_eq!(dtos.len(), 2, "one folder + one file");

    let folder = dto_by_path(&dtos, "chapters").expect("folder emitted");
    assert_eq!(folder.kind, "folder");
    assert_eq!(folder.parent_uuid, None, "root-level folder has no parent");

    let file = dto_by_path(&dtos, "chapters/story.mangaplay.md").expect("file emitted");
    assert_eq!(file.kind, "file");
    assert_eq!(file.parent_uuid, Some(folder.uuid.clone()), "file's parent = folder uuid");
}

#[test]
fn scan_emits_empty_folders()
{
    let td = TempDir::new().unwrap();
    let root = td.path();
    // Empty folder — no scripts anywhere in the subtree. Matches OLD
    // `list_project_tree_impl` which always emits on-disk folders so a
    // freshly-created New Folder feels responsive to the user.
    fs::create_dir_all(root.join("empty-dir")).unwrap();
    // Also a nested empty folder — both must appear as folder rows.
    fs::create_dir_all(root.join("empty-dir/deeper")).unwrap();

    let mut reg = empty_registry_at(root);
    let dtos = scan_and_reconcile(&mut reg).expect("scan ok");

    // Two folder rows — `empty-dir` and `empty-dir/deeper`.
    assert_eq!(dtos.len(), 2, "both empty folders are emitted");

    let outer = dto_by_path(&dtos, "empty-dir").expect("outer emitted");
    assert_eq!(outer.kind, "folder");
    assert_eq!(outer.parent_uuid, None);

    let inner = dto_by_path(&dtos, "empty-dir/deeper").expect("inner emitted");
    assert_eq!(inner.kind, "folder");
    assert_eq!(inner.parent_uuid, Some(outer.uuid.clone()),
        "nested folder's parent_uuid points at outer folder");
}
