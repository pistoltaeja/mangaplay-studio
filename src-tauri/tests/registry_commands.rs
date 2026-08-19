//! Integration tests for the UUID-boundary Tauri command impls.
//!
//! Focus: the PURE `*_impl` helpers behind each Tauri command. The Tauri
//! wrappers themselves are thin lock+flush plumbing; the interesting
//! behaviour lives in the impl.
//!
//! Fixtures build small realistic `LoadedRegistry` instances by writing to a
//! `TempDir` then running the shared `scan_and_reconcile` helper. This means
//! the tests exercise the same mint path production uses — no hand-rolled
//! registry entries diverge from what the scanner would produce.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;
use std::time::Instant;

use app_lib::{
    FsErr, LoadedRegistry, NativeId, RegistryDeleteMode, TreeEntryDto,
    read_project_json, registry_atomic_write_impl_fn, registry_copy_impl,
    registry_create_file_impl, registry_delete_impl, registry_list_art_impl,
    registry_list_scripts_impl, registry_move_impl, registry_read_file_impl,
    registry_rename_impl, registry_write_bytes_impl, scan_and_reconcile,
    write_project_json,
};
use tempfile::TempDir;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

fn write_file(root: &Path, rel: &str, contents: &[u8])
{
    let abs = root.join(rel);
    if let Some(p) = abs.parent()
    {
        fs::create_dir_all(p).unwrap();
    }
    fs::write(&abs, contents).unwrap();
}

/// Build a registry pre-populated by scanning the given tempdir.
fn scanned_registry(root: &Path) -> LoadedRegistry
{
    let mut reg = empty_registry_at(root);
    scan_and_reconcile(&mut reg).expect("scan ok");
    // Reset dirty so tests can assert their own mutation flipped it.
    reg.dirty = false;
    reg
}

fn find_uuid(reg: &LoadedRegistry, rel: &str) -> Uuid
{
    reg.entries
        .iter()
        .find(|(_, e)| !e.tombstone && e.path == rel)
        .map(|(u, _)| *u)
        .unwrap_or_else(|| panic!("no entry for {}", rel))
}

// ---------------------------------------------------------------------------
// registry_read_file
// ---------------------------------------------------------------------------

#[test]
fn read_file_happy_returns_contents_and_rev()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "top.mangaplay.md", b"hello world");
    let mut reg = scanned_registry(td.path());
    let uuid = find_uuid(&reg, "top.mangaplay.md");
    let rev_before = reg.entries[&uuid].rev;

    let out = registry_read_file_impl(&mut reg, uuid).expect("read ok");
    assert_eq!(out.contents, "hello world");
    assert_eq!(out.rev, rev_before);
}

#[test]
fn read_file_folder_uuid_returns_io_error()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "sub/inside.mangaplay.md", b"x");
    let mut reg = scanned_registry(td.path());
    let folder_uuid = find_uuid(&reg, "sub");

    let err = registry_read_file_impl(&mut reg, folder_uuid).expect_err("folder errors");
    match err
    {
        FsErr::Io { message } => assert_eq!(message, "is-a-folder"),
        other => panic!("expected Io(is-a-folder), got {:?}", other),
    }
}

#[test]
fn read_file_unknown_uuid_returns_unknown_uuid()
{
    let td = TempDir::new().unwrap();
    let mut reg = empty_registry_at(td.path());
    let missing = Uuid::new_v4();
    let err = registry_read_file_impl(&mut reg, missing).expect_err("unknown errors");
    match err
    {
        FsErr::UnknownUuid { uuid } => assert_eq!(uuid, missing.to_string()),
        other => panic!("expected UnknownUuid, got {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// registry_write_bytes
// ---------------------------------------------------------------------------

#[test]
fn write_bytes_happy_bumps_rev()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "a.mangaplay.md", b"old");
    let mut reg = scanned_registry(td.path());
    let uuid = find_uuid(&reg, "a.mangaplay.md");
    let rev_before = reg.entries[&uuid].rev;

    let result =
        registry_write_bytes_impl(&mut reg, uuid, b"new content", rev_before)
            .expect("write ok");
    assert_eq!(result.rev, rev_before + 1);
    assert_eq!(reg.entries[&uuid].rev, rev_before + 1);
    assert!(reg.dirty, "write marks dirty");

    // Disk reflects new contents.
    let on_disk = fs::read_to_string(td.path().join("a.mangaplay.md")).unwrap();
    assert_eq!(on_disk, "new content");
}

#[test]
fn write_bytes_stale_rev_rejected()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "a.mangaplay.md", b"old");
    let mut reg = scanned_registry(td.path());
    let uuid = find_uuid(&reg, "a.mangaplay.md");
    let rev_before = reg.entries[&uuid].rev;

    let bad_expected = rev_before + 5;
    let err = registry_write_bytes_impl(&mut reg, uuid, b"x", bad_expected)
        .expect_err("stale rev errors");
    match err
    {
        FsErr::StaleRev { current_rev, expected_rev, .. } =>
        {
            assert_eq!(current_rev, rev_before);
            assert_eq!(expected_rev, bad_expected);
        }
        other => panic!("expected StaleRev, got {:?}", other),
    }
    // Rev untouched.
    assert_eq!(reg.entries[&uuid].rev, rev_before);
}

// ---------------------------------------------------------------------------
// registry_atomic_write
// ---------------------------------------------------------------------------

#[test]
fn atomic_write_happy_persists_and_bumps_rev()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "b.mangaplay.md", b"old");
    let mut reg = scanned_registry(td.path());
    let uuid = find_uuid(&reg, "b.mangaplay.md");
    let rev_before = reg.entries[&uuid].rev;

    let result = registry_atomic_write_impl_fn(
        &mut reg,
        uuid,
        "atomic new",
        rev_before,
    )
    .expect("atomic write ok");
    assert_eq!(result.rev, rev_before + 1);
    let on_disk = fs::read_to_string(td.path().join("b.mangaplay.md")).unwrap();
    assert_eq!(on_disk, "atomic new");
    assert!(reg.dirty, "atomic write marks dirty");
}

#[test]
fn atomic_write_stale_rev_rejected()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "b.mangaplay.md", b"old");
    let mut reg = scanned_registry(td.path());
    let uuid = find_uuid(&reg, "b.mangaplay.md");
    let rev_before = reg.entries[&uuid].rev;

    let err =
        registry_atomic_write_impl_fn(&mut reg, uuid, "x", rev_before + 99)
            .expect_err("stale rev errors");
    assert!(matches!(err, FsErr::StaleRev { .. }));
    // Disk untouched.
    let on_disk = fs::read_to_string(td.path().join("b.mangaplay.md")).unwrap();
    assert_eq!(on_disk, "old");
}

// ---------------------------------------------------------------------------
// registry_create_file
// ---------------------------------------------------------------------------

#[test]
fn create_file_creates_with_fresh_uuid()
{
    let td = TempDir::new().unwrap();
    let mut reg = empty_registry_at(td.path());

    let dto = registry_create_file_impl(
        &mut reg,
        None,
        "Untitled.mangaplay.md",
        "mangaplay",
    )
    .expect("create ok");
    assert_eq!(dto.kind, "file");
    assert_eq!(dto.rel_path, "Untitled.mangaplay.md");
    assert_eq!(dto.rev, 1);
    assert!(td.path().join("Untitled.mangaplay.md").is_file());
    // Registry updated.
    let uuid = Uuid::parse_str(&dto.uuid).unwrap();
    assert!(reg.entries.contains_key(&uuid));
    assert!(reg.dirty);
}

#[test]
fn create_file_folder_creates_with_fresh_uuid()
{
    let td = TempDir::new().unwrap();
    let mut reg = empty_registry_at(td.path());

    let dto = registry_create_file_impl(&mut reg, None, "chapters", "folder")
        .expect("create folder ok");
    assert_eq!(dto.kind, "folder");
    assert_eq!(dto.rel_path, "chapters");
    assert!(td.path().join("chapters").is_dir());
}

#[test]
fn create_file_invalid_basename_rejected()
{
    let td = TempDir::new().unwrap();
    let mut reg = empty_registry_at(td.path());

    // A separator in the name is a validate_basename failure.
    let err =
        registry_create_file_impl(&mut reg, None, "bad/name.txt", "text")
            .expect_err("invalid basename errors");
    match err
    {
        FsErr::Io { message } => assert_eq!(message, "separator"),
        other => panic!("expected Io(separator), got {:?}", other),
    }
}

#[test]
fn create_file_inside_parent_uses_parent_path()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "chapters/existing.mangaplay.md", b"x");
    let mut reg = scanned_registry(td.path());
    let parent_uuid = find_uuid(&reg, "chapters");

    let dto = registry_create_file_impl(
        &mut reg,
        Some(parent_uuid),
        "new.mangaplay.md",
        "mangaplay",
    )
    .expect("nested create ok");
    assert_eq!(dto.rel_path, "chapters/new.mangaplay.md");
    assert_eq!(dto.parent_uuid, Some(parent_uuid.to_string()));
    assert!(td.path().join("chapters/new.mangaplay.md").is_file());
}

// ---------------------------------------------------------------------------
// registry_rename
// ---------------------------------------------------------------------------

#[test]
fn rename_file_renames_and_bumps_rev()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "a.mangaplay.md", b"x");
    let mut reg = scanned_registry(td.path());
    let uuid = find_uuid(&reg, "a.mangaplay.md");
    let rev_before = reg.entries[&uuid].rev;

    let dto = registry_rename_impl(&mut reg, uuid, "b.mangaplay.md", rev_before)
        .expect("rename ok");
    assert_eq!(dto.rel_path, "b.mangaplay.md");
    assert_eq!(dto.rev, rev_before + 1);
    assert!(td.path().join("b.mangaplay.md").exists());
    assert!(!td.path().join("a.mangaplay.md").exists());
}

#[test]
fn rename_folder_cascades_descendants()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "chapters/one.mangaplay.md", b"one");
    write_file(td.path(), "chapters/two.mangaplay.md", b"two");
    let mut reg = scanned_registry(td.path());
    let folder_uuid = find_uuid(&reg, "chapters");
    let child1_uuid = find_uuid(&reg, "chapters/one.mangaplay.md");
    let child2_uuid = find_uuid(&reg, "chapters/two.mangaplay.md");
    let child1_rev = reg.entries[&child1_uuid].rev;
    let child2_rev = reg.entries[&child2_uuid].rev;

    let dto = registry_rename_impl(&mut reg, folder_uuid, "acts", 0)
        .expect("folder rename ok");
    assert_eq!(dto.rel_path, "acts");
    // Descendants moved + rev bumped.
    assert_eq!(reg.entries[&child1_uuid].path, "acts/one.mangaplay.md");
    assert_eq!(reg.entries[&child2_uuid].path, "acts/two.mangaplay.md");
    assert_eq!(reg.entries[&child1_uuid].rev, child1_rev + 1);
    assert_eq!(reg.entries[&child2_uuid].rev, child2_rev + 1);
    // Disk reflects the move.
    assert!(td.path().join("acts/one.mangaplay.md").exists());
    assert!(!td.path().join("chapters").exists());
}

#[test]
fn rename_target_exists_rejected()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "a.mangaplay.md", b"a");
    write_file(td.path(), "b.mangaplay.md", b"b");
    let mut reg = scanned_registry(td.path());
    let a_uuid = find_uuid(&reg, "a.mangaplay.md");

    let err = registry_rename_impl(&mut reg, a_uuid, "b.mangaplay.md", 0)
        .expect_err("collision errors");
    match err
    {
        FsErr::Io { message } => assert_eq!(message, "target-exists"),
        other => panic!("expected Io(target-exists), got {:?}", other),
    }
    // Both files still exist.
    assert!(td.path().join("a.mangaplay.md").exists());
    assert!(td.path().join("b.mangaplay.md").exists());
}

// ---------------------------------------------------------------------------
// registry_move
// ---------------------------------------------------------------------------

#[test]
fn move_file_updates_parent_uuid_and_path()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "top.mangaplay.md", b"x");
    write_file(td.path(), "chapters/seed.mangaplay.md", b"seed"); // makes chapters/
    let mut reg = scanned_registry(td.path());
    let file_uuid = find_uuid(&reg, "top.mangaplay.md");
    let dest_uuid = find_uuid(&reg, "chapters");

    let dto = registry_move_impl(&mut reg, file_uuid, Some(dest_uuid), 0)
        .expect("move ok");
    assert_eq!(dto.rel_path, "chapters/top.mangaplay.md");
    assert_eq!(dto.parent_uuid, Some(dest_uuid.to_string()));
    assert!(td.path().join("chapters/top.mangaplay.md").exists());
    assert!(!td.path().join("top.mangaplay.md").exists());
}

#[test]
fn move_folder_into_own_descendant_rejected()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "outer/inner/seed.mangaplay.md", b"seed");
    let mut reg = scanned_registry(td.path());
    let outer_uuid = find_uuid(&reg, "outer");
    let inner_uuid = find_uuid(&reg, "outer/inner");

    let err = registry_move_impl(&mut reg, outer_uuid, Some(inner_uuid), 0)
        .expect_err("self-descendant move errors");
    match err
    {
        FsErr::Io { message } => assert_eq!(message, "move-into-own-descendant"),
        other => panic!("expected Io(move-into-own-descendant), got {:?}", other),
    }
    // Untouched on disk.
    assert!(td.path().join("outer/inner/seed.mangaplay.md").exists());
}

// ---------------------------------------------------------------------------
// registry_delete
// ---------------------------------------------------------------------------

#[test]
fn delete_force_file_tombstones_and_bumps_rev()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "doomed.mangaplay.md", b"x");
    let mut reg = scanned_registry(td.path());
    let uuid = find_uuid(&reg, "doomed.mangaplay.md");
    let rev_before = reg.entries[&uuid].rev;

    registry_delete_impl(&mut reg, uuid, rev_before, RegistryDeleteMode::Force)
        .expect("delete ok");
    let ghost = &reg.entries[&uuid];
    assert!(ghost.tombstone, "tombstoned");
    assert_eq!(ghost.rev, rev_before + 1);
    assert!(!td.path().join("doomed.mangaplay.md").exists());
    assert!(reg.dirty);
}

#[test]
fn delete_force_folder_cascades_tombstones()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "chapters/one.mangaplay.md", b"1");
    write_file(td.path(), "chapters/two.mangaplay.md", b"2");
    let mut reg = scanned_registry(td.path());
    let folder_uuid = find_uuid(&reg, "chapters");
    let child1_uuid = find_uuid(&reg, "chapters/one.mangaplay.md");
    let child2_uuid = find_uuid(&reg, "chapters/two.mangaplay.md");

    registry_delete_impl(&mut reg, folder_uuid, 0, RegistryDeleteMode::Force)
        .expect("folder delete ok");
    assert!(reg.entries[&folder_uuid].tombstone);
    assert!(reg.entries[&child1_uuid].tombstone);
    assert!(reg.entries[&child2_uuid].tombstone);
    assert!(!td.path().join("chapters").exists());
}

// ---------------------------------------------------------------------------
// registry_copy
// ---------------------------------------------------------------------------

#[test]
fn copy_creates_new_uuid_with_same_content()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "src.mangaplay.md", b"copy me");
    let mut reg = scanned_registry(td.path());
    let src_uuid = find_uuid(&reg, "src.mangaplay.md");

    let dto = registry_copy_impl(&mut reg, src_uuid).expect("copy ok");
    // Fresh UUID, fresh rev.
    assert_ne!(dto.uuid, src_uuid.to_string());
    assert_eq!(dto.rev, 1);
    assert_ne!(dto.rel_path, "src.mangaplay.md", "different path");
    let copy_abs = td.path().join(&dto.rel_path);
    let contents = fs::read_to_string(&copy_abs).unwrap();
    assert_eq!(contents, "copy me");
}

// ---------------------------------------------------------------------------
// registry_list_scripts / registry_list_art
// ---------------------------------------------------------------------------

#[test]
fn list_scripts_filters_to_script_extensions_only()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "one.mangaplay.md", b"1");
    write_file(td.path(), "two.fountain.md", b"2");
    // Non-script — a plain README should NOT appear.
    write_file(td.path(), "readme.notes", b"n");
    let mut reg = scanned_registry(td.path());

    let scripts = registry_list_scripts_impl(&reg);
    // The scanner already filters by `is_script_filename` so `.notes` is not
    // in the registry to begin with; the assertion is that everything we DO
    // see IS a script.
    assert!(!scripts.is_empty());
    for s in &scripts
    {
        let name = s.rel_path.rsplit('/').next().unwrap_or("");
        let is_script = name.ends_with(".mangaplay.md")
            || name.ends_with(".fountain.md")
            || name.ends_with(".sup.md")
            || name.ends_with(".mangaplay")
            || name.ends_with(".fountain")
            || name.ends_with(".sup")
            || name.ends_with(".txt");
        assert!(is_script, "non-script surfaced: {}", s.rel_path);
    }
    // Folders excluded even if present.
    assert!(scripts.iter().all(|s| s.kind == "file"));
    // `readme.notes` NOT in the list.
    assert!(!scripts.iter().any(|s| s.rel_path == "readme.notes"));

    // Silence unused-var warning; scanned registry object isn't otherwise
    // consumed after impl calls.
    let _ = &mut reg;
}

#[test]
fn list_art_filters_to_storyboard_subdir_only()
{
    let td = TempDir::new().unwrap();
    // The scanner skips `_mangaplaystudio/` at depth 0, so seed the entries
    // by hand into the registry.
    let mut reg = empty_registry_at(td.path());
    // A .mangaart entry under storyboard/ — should appear.
    let art_uuid = Uuid::new_v4();
    reg.entries.insert(art_uuid, app_lib::RegistryEntry
    {
        native_id: NativeId::Unknown,
        path: "_mangaplaystudio/storyboard/abc.mangaart".to_string(),
        kind: "file".to_string(),
        parent_uuid: None,
        rev: 1,
        tombstone: false,
        content_hash_head: None,
    });
    // A non-art file (script) — should NOT appear.
    let script_uuid = Uuid::new_v4();
    reg.entries.insert(script_uuid, app_lib::RegistryEntry
    {
        native_id: NativeId::Unknown,
        path: "top.mangaplay.md".to_string(),
        kind: "file".to_string(),
        parent_uuid: None,
        rev: 1,
        tombstone: false,
        content_hash_head: None,
    });
    // A tombstoned art entry — should NOT appear.
    let ghost_uuid = Uuid::new_v4();
    reg.entries.insert(ghost_uuid, app_lib::RegistryEntry
    {
        native_id: NativeId::Unknown,
        path: "_mangaplaystudio/storyboard/ghost.mangaart".to_string(),
        kind: "file".to_string(),
        parent_uuid: None,
        rev: 1,
        tombstone: true,
        content_hash_head: None,
    });
    reg.rebuild_indices();

    let art = registry_list_art_impl(&reg);
    assert_eq!(art.len(), 1);
    assert_eq!(art[0].uuid, art_uuid.to_string());
    assert_eq!(art[0].rel_path, "_mangaplaystudio/storyboard/abc.mangaart");
}

// ---------------------------------------------------------------------------
// Folder cascade + prefix-collision coverage (reviewer follow-ups)
// ---------------------------------------------------------------------------

#[test]
fn move_folder_cascades_descendant_paths()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "outer/inner-file.mangaplay.md", b"inner");
    write_file(td.path(), "outer/deeper/leaf.mangaplay.md", b"leaf");
    write_file(td.path(), "dest/seed.mangaplay.md", b"seed"); // makes dest/
    let mut reg = scanned_registry(td.path());

    let outer_uuid = find_uuid(&reg, "outer");
    let inner_uuid = find_uuid(&reg, "outer/inner-file.mangaplay.md");
    let deeper_uuid = find_uuid(&reg, "outer/deeper");
    let leaf_uuid = find_uuid(&reg, "outer/deeper/leaf.mangaplay.md");
    let dest_uuid = find_uuid(&reg, "dest");

    let outer_rev = reg.entries[&outer_uuid].rev;
    let inner_rev = reg.entries[&inner_uuid].rev;
    let deeper_rev = reg.entries[&deeper_uuid].rev;
    let leaf_rev = reg.entries[&leaf_uuid].rev;

    let dto = registry_move_impl(&mut reg, outer_uuid, Some(dest_uuid), outer_rev)
        .expect("folder move ok");

    // Moved folder itself.
    assert_eq!(dto.rel_path, "dest/outer");
    assert_eq!(reg.entries[&outer_uuid].path, "dest/outer");
    assert_eq!(reg.entries[&outer_uuid].parent_uuid, Some(dest_uuid));
    assert_eq!(reg.entries[&outer_uuid].rev, outer_rev + 1);

    // Descendants cascaded.
    assert_eq!(
        reg.entries[&inner_uuid].path,
        "dest/outer/inner-file.mangaplay.md"
    );
    assert_eq!(reg.entries[&deeper_uuid].path, "dest/outer/deeper");
    assert_eq!(
        reg.entries[&leaf_uuid].path,
        "dest/outer/deeper/leaf.mangaplay.md"
    );
    assert_eq!(reg.entries[&inner_uuid].rev, inner_rev + 1);
    assert_eq!(reg.entries[&deeper_uuid].rev, deeper_rev + 1);
    assert_eq!(reg.entries[&leaf_uuid].rev, leaf_rev + 1);

    // Disk reflects the whole-tree move.
    assert!(td.path().join("dest/outer/inner-file.mangaplay.md").exists());
    assert!(td.path().join("dest/outer/deeper/leaf.mangaplay.md").exists());
    assert!(!td.path().join("outer/inner-file.mangaplay.md").exists());
    assert!(!td.path().join("outer").exists());
}

#[test]
fn rename_folder_does_not_touch_prefix_collision_siblings()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "chapters/one.mangaplay.md", b"1");
    write_file(td.path(), "chapters-old/legacy.mangaplay.md", b"legacy");
    let mut reg = scanned_registry(td.path());

    let chapters_uuid = find_uuid(&reg, "chapters");
    let chapters_child_uuid = find_uuid(&reg, "chapters/one.mangaplay.md");
    let old_folder_uuid = find_uuid(&reg, "chapters-old");
    let old_child_uuid = find_uuid(&reg, "chapters-old/legacy.mangaplay.md");

    let old_folder_rev = reg.entries[&old_folder_uuid].rev;
    let old_child_rev = reg.entries[&old_child_uuid].rev;
    let old_folder_path = reg.entries[&old_folder_uuid].path.clone();
    let old_child_path = reg.entries[&old_child_uuid].path.clone();

    let dto = registry_rename_impl(&mut reg, chapters_uuid, "acts", 0)
        .expect("rename ok");

    // Renamed folder + its child migrated.
    assert_eq!(dto.rel_path, "acts");
    assert_eq!(reg.entries[&chapters_uuid].path, "acts");
    assert_eq!(reg.entries[&chapters_child_uuid].path, "acts/one.mangaplay.md");

    // Sibling prefix-collision folder + its child UNTOUCHED.
    assert_eq!(reg.entries[&old_folder_uuid].path, old_folder_path);
    assert_eq!(reg.entries[&old_folder_uuid].rev, old_folder_rev);
    assert_eq!(reg.entries[&old_child_uuid].path, old_child_path);
    assert_eq!(reg.entries[&old_child_uuid].rev, old_child_rev);

    // Disk mirrors the same story.
    assert!(td.path().join("acts/one.mangaplay.md").exists());
    assert!(td.path().join("chapters-old/legacy.mangaplay.md").exists());
    assert!(!td.path().join("chapters").exists());
}

#[test]
fn rename_tombstoned_returns_deleted()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "gone.mangaplay.md", b"x");
    let mut reg = scanned_registry(td.path());
    let uuid = find_uuid(&reg, "gone.mangaplay.md");

    // Tombstone the entry directly (bypass disk delete).
    reg.entries.get_mut(&uuid).unwrap().tombstone = true;

    let err = registry_rename_impl(&mut reg, uuid, "renamed.mangaplay.md", 0)
        .expect_err("tombstoned rename errors");
    match err
    {
        FsErr::Deleted { uuid: u } => assert_eq!(u, uuid.to_string()),
        other => panic!("expected Deleted, got {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// scriptMap / artMap bookkeeping across rename + move
// ---------------------------------------------------------------------------

/// Seed `<root>/_mangaplaystudio/project.json` with the given scriptMap.
/// `entries` is a list of `(rel_path, uuid)` pairs.
fn seed_script_map(root: &Path, entries: &[(&str, &str)])
{
    let mut map = serde_json::Map::new();
    for (rel, uuid) in entries
    {
        map.insert(
            (*rel).to_string(),
            serde_json::json!({ "uuid": *uuid }),
        );
    }
    let pj = serde_json::json!({ "scriptMap": serde_json::Value::Object(map) });
    write_project_json(root, &pj).expect("seed project.json");
}

/// Read scriptMap[key].uuid as a String, or None if absent.
fn script_map_uuid(pj: &serde_json::Value, key: &str) -> Option<String>
{
    pj.get("scriptMap")?
        .get(key)?
        .get("uuid")?
        .as_str()
        .map(|s| s.to_string())
}

#[test]
fn rename_file_rewrites_script_map()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "Untitled.mangaplay.md", b"x");
    let known_uuid = "11111111-1111-1111-1111-111111111111";
    seed_script_map(td.path(), &[("Untitled.mangaplay.md", known_uuid)]);

    let mut reg = scanned_registry(td.path());
    let uuid = find_uuid(&reg, "Untitled.mangaplay.md");
    let rev_before = reg.entries[&uuid].rev;

    registry_rename_impl(&mut reg, uuid, "NewFile.mangaplay.md", rev_before)
        .expect("rename ok");

    // Disk moved.
    assert!(td.path().join("NewFile.mangaplay.md").exists());
    assert!(!td.path().join("Untitled.mangaplay.md").exists());

    // scriptMap rewritten.
    let pj = read_project_json(td.path()).expect("read pj");
    assert_eq!(
        script_map_uuid(&pj, "NewFile.mangaplay.md").as_deref(),
        Some(known_uuid),
    );
    assert!(script_map_uuid(&pj, "Untitled.mangaplay.md").is_none());
}

#[test]
fn move_file_rewrites_script_map()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "top.mangaplay.md", b"top");
    write_file(td.path(), "chapters/seed.mangaplay.md", b"seed");
    let top_uuid_str = "22222222-2222-2222-2222-222222222222";
    let seed_uuid_str = "33333333-3333-3333-3333-333333333333";
    seed_script_map(
        td.path(),
        &[
            ("top.mangaplay.md", top_uuid_str),
            ("chapters/seed.mangaplay.md", seed_uuid_str),
        ],
    );

    let mut reg = scanned_registry(td.path());
    let file_uuid = find_uuid(&reg, "top.mangaplay.md");
    let folder_uuid = find_uuid(&reg, "chapters");

    registry_move_impl(&mut reg, file_uuid, Some(folder_uuid), 0)
        .expect("move ok");

    // Disk moved.
    assert!(td.path().join("chapters/top.mangaplay.md").exists());
    assert!(!td.path().join("top.mangaplay.md").exists());

    // scriptMap: new key present, old key gone, sibling untouched.
    let pj = read_project_json(td.path()).expect("read pj");
    assert_eq!(
        script_map_uuid(&pj, "chapters/top.mangaplay.md").as_deref(),
        Some(top_uuid_str),
    );
    assert!(script_map_uuid(&pj, "top.mangaplay.md").is_none());
    assert_eq!(
        script_map_uuid(&pj, "chapters/seed.mangaplay.md").as_deref(),
        Some(seed_uuid_str),
    );
}

#[test]
fn rename_folder_rewrites_script_map_prefix_and_moves_storyboard()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "chapters/one.mangaplay.md", b"one");
    write_file(td.path(), "chapters/two.mangaplay.md", b"two");
    let one_uuid_str = "44444444-4444-4444-4444-444444444444";
    let two_uuid_str = "55555555-5555-5555-5555-555555555555";
    seed_script_map(
        td.path(),
        &[
            ("chapters/one.mangaplay.md", one_uuid_str),
            ("chapters/two.mangaplay.md", two_uuid_str),
        ],
    );

    // Physical storyboard subtree to relocate.
    let sb_old = td.path().join("_mangaplaystudio/storyboard/chapters");
    fs::create_dir_all(&sb_old).unwrap();
    fs::write(sb_old.join("dummy.mangaart"), b"").unwrap();

    let mut reg = scanned_registry(td.path());
    let folder_uuid = find_uuid(&reg, "chapters");

    registry_rename_impl(&mut reg, folder_uuid, "acts", 0).expect("rename ok");

    // scriptMap prefix rewritten.
    let pj = read_project_json(td.path()).expect("read pj");
    assert_eq!(
        script_map_uuid(&pj, "acts/one.mangaplay.md").as_deref(),
        Some(one_uuid_str),
    );
    assert_eq!(
        script_map_uuid(&pj, "acts/two.mangaplay.md").as_deref(),
        Some(two_uuid_str),
    );
    assert!(script_map_uuid(&pj, "chapters/one.mangaplay.md").is_none());
    assert!(script_map_uuid(&pj, "chapters/two.mangaplay.md").is_none());

    // Storyboard subtree physically relocated.
    assert!(td.path().join("_mangaplaystudio/storyboard/acts/dummy.mangaart").exists());
    assert!(!td.path().join("_mangaplaystudio/storyboard/chapters").exists());
}

#[test]
fn move_folder_rewrites_script_map_prefix_and_moves_storyboard()
{
    let td = TempDir::new().unwrap();
    write_file(td.path(), "chapters/one.mangaplay.md", b"one");
    write_file(td.path(), "dest/anchor.mangaplay.md", b"anchor");
    let one_uuid_str = "66666666-6666-6666-6666-666666666666";
    let anchor_uuid_str = "77777777-7777-7777-7777-777777777777";
    seed_script_map(
        td.path(),
        &[
            ("chapters/one.mangaplay.md", one_uuid_str),
            ("dest/anchor.mangaplay.md", anchor_uuid_str),
        ],
    );

    // Physical storyboard subtree to relocate.
    let sb_old = td.path().join("_mangaplaystudio/storyboard/chapters");
    fs::create_dir_all(&sb_old).unwrap();
    fs::write(sb_old.join("dummy.mangaart"), b"").unwrap();

    let mut reg = scanned_registry(td.path());
    let chapters_uuid = find_uuid(&reg, "chapters");
    let dest_uuid = find_uuid(&reg, "dest");

    registry_move_impl(&mut reg, chapters_uuid, Some(dest_uuid), 0)
        .expect("move ok");

    // scriptMap prefix rewritten under new parent.
    let pj = read_project_json(td.path()).expect("read pj");
    assert_eq!(
        script_map_uuid(&pj, "dest/chapters/one.mangaplay.md").as_deref(),
        Some(one_uuid_str),
    );
    assert!(script_map_uuid(&pj, "chapters/one.mangaplay.md").is_none());
    assert_eq!(
        script_map_uuid(&pj, "dest/anchor.mangaplay.md").as_deref(),
        Some(anchor_uuid_str),
    );

    // Storyboard subtree physically relocated.
    assert!(
        td.path()
            .join("_mangaplaystudio/storyboard/dest/chapters/dummy.mangaart")
            .exists(),
    );
    assert!(!td.path().join("_mangaplaystudio/storyboard/chapters").exists());
}

