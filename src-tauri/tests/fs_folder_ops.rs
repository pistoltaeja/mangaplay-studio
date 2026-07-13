//! Integration tests for Phase 5 of the .mangaart storyboard relocation:
//! in-project folder rename (via `rename_file_impl` against a directory) and
//! in-project move (via `move_path_with_art`).
//!
//! Both surfaces have to keep three pieces of state in sync after the
//! visible filesystem operation:
//!   * the script-side folder is at the new path
//!   * every `artMap.scripts` key under the old prefix now uses the new
//!   * the `<root>/storyboard/<old>/` subtree has been moved to
//!     `<root>/storyboard/<new>/`
//!
//! The art-side steps are best-effort; tests assert success here because
//! the tempdir scenario never trips the warn-only paths.

use app_lib::{
    art_map_get,
    art_map_set,
    delete_file_force_impl,
    move_path_with_art,
    read_project_json,
    rename_file_impl,
    resolve_art_path,
    write_project_json,
};
use std::fs;
use tempfile::TempDir;

/// Seed `<root>/project.json` with the shape `mangaart_scaffold_impl` writes
/// on first scaffold.
fn seed_project_json(root: &std::path::Path)
{
    let pj = serde_json::json!({
        "id": "test-project-id",
        "displayName": serde_json::Value::Null,
        "createdAt": "2026-01-01T00:00:00Z",
    });
    write_project_json(root, &pj).expect("seed project.json");
}

/// Seed an artMap entry for `script_rel → uuid` AND drop a placeholder art
/// file at the resolved storyboard path. Returns the storyboard path so the
/// test can assert against it.
fn seed_art(
    root: &std::path::Path,
    script_rel: &str,
    uuid: &str,
) -> std::path::PathBuf
{
    let mut pj = read_project_json(root).expect("read project.json (must be pre-seeded)");
    art_map_set(&mut pj, script_rel, uuid);
    write_project_json(root, &pj).expect("write art-mapped project.json");

    let art_path = resolve_art_path(root, script_rel, uuid);
    if let Some(parent) = art_path.parent()
    {
        fs::create_dir_all(parent).expect("create storyboard parents");
    }
    fs::write(&art_path, format!("art-marker:{}", uuid)).expect("write art placeholder");
    art_path
}

// ── folder rename (rename_file_impl directory branch) ────────────────────

#[test]
fn rename_folder_with_scripts_moves_storyboard_subtree_and_rewrites_keys()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let foo = root.join("foo");
    fs::create_dir(&foo).unwrap();
    fs::write(foo.join("a.mangaplay.md"), "a").unwrap();
    fs::write(foo.join("b.mangaplay.md"), "b").unwrap();

    let uuid_a = "aaaa1111-1111-4111-8111-111111111111";
    let uuid_b = "bbbb2222-2222-4222-8222-222222222222";
    let art_a = seed_art(root, "foo/a.mangaplay.md", uuid_a);
    let art_b = seed_art(root, "foo/b.mangaplay.md", uuid_b);
    assert!(art_a.exists(), "seed art a");
    assert!(art_b.exists(), "seed art b");

    let dst = rename_file_impl(&foo, "qux", false, Some(root))
        .expect("folder rename ok");

    // (a) script folder renamed
    assert!(!foo.exists(), "old script folder gone");
    assert_eq!(dst, root.join("qux"));
    assert!(dst.join("a.mangaplay.md").exists(), "scripts carried in rename");
    assert!(dst.join("b.mangaplay.md").exists());

    // (b) artMap keys rewritten, same UUIDs
    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(art_map_get(&pj, "foo/a.mangaplay.md"), None, "old key a dropped");
    assert_eq!(art_map_get(&pj, "foo/b.mangaplay.md"), None, "old key b dropped");
    assert_eq!(
        art_map_get(&pj, "qux/a.mangaplay.md").as_deref(),
        Some(uuid_a),
        "new key a preserves UUID",
    );
    assert_eq!(
        art_map_get(&pj, "qux/b.mangaplay.md").as_deref(),
        Some(uuid_b),
        "new key b preserves UUID",
    );

    // (c) art files now under storyboard/qux/
    let new_art_a = root.join("_mangaplaystudio").join("storyboard").join("qux")
        .join(format!("{}.mangaart", uuid_a));
    let new_art_b = root.join("_mangaplaystudio").join("storyboard").join("qux")
        .join(format!("{}.mangaart", uuid_b));
    assert!(new_art_a.exists(), "art a moved to qux subtree");
    assert!(new_art_b.exists(), "art b moved to qux subtree");

    // (d) old storyboard/foo/ is gone
    assert!(!root.join("_mangaplaystudio").join("storyboard").join("foo").exists(), "old subtree gone");
}

#[test]
fn rename_folder_with_no_scripts_or_art_is_noop_for_artmap()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let foo = root.join("foo");
    fs::create_dir(&foo).unwrap();
    fs::write(foo.join("notes.txt"), "hello").unwrap();
    fs::write(foo.join("more.txt"), "world").unwrap();

    let dst = rename_file_impl(&foo, "qux", false, Some(root))
        .expect("folder rename ok");

    assert!(!foo.exists(), "old folder gone");
    assert!(dst.join("notes.txt").exists(), "txt file carried");

    // artMap.scripts must be absent OR empty.
    let pj = read_project_json(root).expect("read project.json");
    let empty = pj
        .get("artMap")
        .and_then(|m| m.get("scripts"))
        .and_then(|s| s.as_object())
        .map(|o| o.is_empty())
        .unwrap_or(true);
    assert!(empty, "artMap.scripts must remain empty");

    // No storyboard tree should have been created.
    assert!(!root.join("_mangaplaystudio").join("storyboard").join("qux").exists());
    assert!(!root.join("_mangaplaystudio").join("storyboard").join("foo").exists());
}

#[test]
fn rename_folder_partial_prefix_does_not_touch_unrelated_keys()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let foo = root.join("foo");
    let foobar = root.join("foobar");
    fs::create_dir(&foo).unwrap();
    fs::create_dir(&foobar).unwrap();
    fs::write(foo.join("a.mangaplay.md"), "a").unwrap();
    fs::write(foobar.join("b.mangaplay.md"), "b").unwrap();

    let uuid_a = "aaaa1111-1111-4111-8111-111111111111";
    let uuid_b = "bbbb2222-2222-4222-8222-222222222222";
    seed_art(root, "foo/a.mangaplay.md", uuid_a);
    let foobar_art = seed_art(root, "foobar/b.mangaplay.md", uuid_b);

    rename_file_impl(&foo, "qux", false, Some(root))
        .expect("folder rename ok");

    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(
        art_map_get(&pj, "qux/a.mangaplay.md").as_deref(),
        Some(uuid_a),
        "foo key migrated to qux",
    );
    assert_eq!(
        art_map_get(&pj, "foobar/b.mangaplay.md").as_deref(),
        Some(uuid_b),
        "foobar key MUST NOT be rewritten (trailing-slash gate)",
    );

    // foobar's storyboard subtree untouched on disk.
    assert!(foobar_art.exists(), "foobar art file still at original path");
    assert!(root.join("_mangaplaystudio").join("storyboard").join("foobar").exists());
}

#[test]
fn rename_folder_when_project_json_missing_still_renames_folder()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    // Intentionally NO project.json.

    let foo = root.join("foo");
    fs::create_dir(&foo).unwrap();
    fs::write(foo.join("a.mangaplay.md"), "a").unwrap();

    let dst = rename_file_impl(&foo, "qux", false, Some(root))
        .expect("folder rename ok even without project.json");

    assert!(!foo.exists());
    assert!(dst.is_dir());
    assert!(dst.join("a.mangaplay.md").exists());
}

#[test]
fn rename_folder_target_exists_aborts_before_map_or_storyboard_move()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let foo = root.join("foo");
    let qux = root.join("qux");
    fs::create_dir(&foo).unwrap();
    fs::create_dir(&qux).unwrap();
    fs::write(foo.join("a.mangaplay.md"), "a").unwrap();

    let uuid_a = "aaaa1111-1111-4111-8111-111111111111";
    let art_a = seed_art(root, "foo/a.mangaplay.md", uuid_a);

    let err = rename_file_impl(&foo, "qux", false, Some(root))
        .expect_err("must reject — target exists");
    assert_eq!(err, "target-exists");

    // Script folder unchanged.
    assert!(foo.exists(), "source folder untouched");
    assert!(foo.join("a.mangaplay.md").exists());

    // artMap unchanged.
    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(
        art_map_get(&pj, "foo/a.mangaplay.md").as_deref(),
        Some(uuid_a),
        "old key still present",
    );
    assert_eq!(art_map_get(&pj, "qux/a.mangaplay.md"), None, "new key NOT written");

    // Storyboard subtree unchanged.
    assert!(art_a.exists(), "art file still at original path");
    assert!(!root.join("_mangaplaystudio").join("storyboard").join("qux").exists());
}

// ── folder + file move (move_path_with_art) ──────────────────────────────

#[test]
fn move_folder_with_scripts_moves_storyboard_subtree()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let foo = root.join("foo");
    let parent = root.join("parent");
    fs::create_dir(&foo).unwrap();
    fs::create_dir(&parent).unwrap();
    fs::write(foo.join("a.mangaplay.md"), "a").unwrap();

    let uuid_a = "aaaa1111-1111-4111-8111-111111111111";
    seed_art(root, "foo/a.mangaplay.md", uuid_a);

    let dst = move_path_with_art(&foo, &parent, Some(root))
        .expect("folder move ok");

    assert!(!foo.exists(), "old folder gone");
    assert_eq!(dst, parent.join("foo"));
    assert!(dst.join("a.mangaplay.md").exists());

    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(art_map_get(&pj, "foo/a.mangaplay.md"), None);
    assert_eq!(
        art_map_get(&pj, "parent/foo/a.mangaplay.md").as_deref(),
        Some(uuid_a),
        "key rewritten to new nested path",
    );

    let new_art = root.join("_mangaplaystudio").join("storyboard").join("parent").join("foo")
        .join(format!("{}.mangaart", uuid_a));
    assert!(new_art.exists(), "art file moved under storyboard/parent/foo/");
    assert!(!root.join("_mangaplaystudio").join("storyboard").join("foo").exists(), "old subtree gone");
}

#[test]
fn move_single_script_file_rewrites_key_only_art_stays_put()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let foo = root.join("foo");
    let bar = root.join("bar");
    fs::create_dir(&foo).unwrap();
    fs::create_dir(&bar).unwrap();
    let script = foo.join("a.mangaplay.md");
    fs::write(&script, "a").unwrap();

    let uuid_a = "aaaa1111-1111-4111-8111-111111111111";
    let art_path = seed_art(root, "foo/a.mangaplay.md", uuid_a);
    let art_bytes_before = fs::read(&art_path).expect("read art before");

    let dst = move_path_with_art(&script, &bar, Some(root))
        .expect("file move ok");

    assert!(!script.exists(), "old script gone");
    assert_eq!(dst, bar.join("a.mangaplay.md"));
    assert!(dst.exists());

    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(art_map_get(&pj, "foo/a.mangaplay.md"), None);
    assert_eq!(
        art_map_get(&pj, "bar/a.mangaplay.md").as_deref(),
        Some(uuid_a),
        "single-file move rewrites the one key",
    );

    // Per Phase 3's per-file rule, the .mangaart file stays put.
    assert!(art_path.exists(), "art file unchanged on disk");
    let art_bytes_after = fs::read(&art_path).expect("read art after");
    assert_eq!(art_bytes_before, art_bytes_after, "art bytes unchanged");

    // And no storyboard/bar/ tree was created.
    assert!(!root.join("_mangaplaystudio").join("storyboard").join("bar").exists());
}

// ── folder delete (delete_file_force_impl directory branch, Phase 6) ─────
// Force variant used here because trash:: behaviour against tempdirs is hard
// to verify deterministically — matches the Phase 4 file-delete test choice.

#[test]
fn delete_folder_with_scripts_drops_keys_and_removes_storyboard_subtree()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let foo = root.join("foo");
    fs::create_dir(&foo).unwrap();
    fs::write(foo.join("a.mangaplay.md"), "a").unwrap();
    fs::write(foo.join("b.mangaplay.md"), "b").unwrap();

    let uuid_a = "aaaa1111-1111-4111-8111-111111111111";
    let uuid_b = "bbbb2222-2222-4222-8222-222222222222";
    let art_a = seed_art(root, "foo/a.mangaplay.md", uuid_a);
    let art_b = seed_art(root, "foo/b.mangaplay.md", uuid_b);
    assert!(art_a.exists(), "seed art a");
    assert!(art_b.exists(), "seed art b");

    delete_file_force_impl(&foo, Some(root)).expect("folder delete ok");

    // (a) script folder gone
    assert!(!foo.exists(), "script folder removed");

    // (b) storyboard/foo/ subtree gone
    assert!(
        !root.join("_mangaplaystudio").join("storyboard").join("foo").exists(),
        "mirrored storyboard subtree removed",
    );

    // (c) storyboard/ root still exists (no over-deletion)
    assert!(root.join("_mangaplaystudio").join("storyboard").exists(), "storyboard root preserved");

    // (d) both keys dropped from artMap
    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(art_map_get(&pj, "foo/a.mangaplay.md"), None, "key a dropped");
    assert_eq!(art_map_get(&pj, "foo/b.mangaplay.md"), None, "key b dropped");
}

#[test]
fn delete_folder_with_partial_prefix_does_not_touch_unrelated_keys()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let foo = root.join("foo");
    let foobar = root.join("foobar");
    fs::create_dir(&foo).unwrap();
    fs::create_dir(&foobar).unwrap();
    fs::write(foo.join("x.mangaplay.md"), "x").unwrap();
    fs::write(foobar.join("y.mangaplay.md"), "y").unwrap();

    let uuid_x = "aaaa1111-1111-4111-8111-111111111111";
    let uuid_y = "bbbb2222-2222-4222-8222-222222222222";
    seed_art(root, "foo/x.mangaplay.md", uuid_x);
    let foobar_art = seed_art(root, "foobar/y.mangaplay.md", uuid_y);

    delete_file_force_impl(&foo, Some(root)).expect("folder delete ok");

    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(art_map_get(&pj, "foo/x.mangaplay.md"), None, "foo/x key dropped");
    assert_eq!(
        art_map_get(&pj, "foobar/y.mangaplay.md").as_deref(),
        Some(uuid_y),
        "foobar/y key UNCHANGED (trailing-slash gate)",
    );

    // foobar's storyboard subtree untouched on disk.
    assert!(foobar_art.exists(), "foobar art file untouched");
    assert!(root.join("_mangaplaystudio").join("storyboard").join("foobar").exists());
}

#[test]
fn delete_empty_folder_no_artmap_entries_succeeds()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let foo = root.join("foo");
    fs::create_dir(&foo).unwrap();

    delete_file_force_impl(&foo, Some(root))
        .expect("empty folder delete ok");

    assert!(!foo.exists(), "folder gone");

    // artMap.scripts must be absent OR empty.
    let pj = read_project_json(root).expect("read project.json");
    let empty = pj
        .get("artMap")
        .and_then(|m| m.get("scripts"))
        .and_then(|s| s.as_object())
        .map(|o| o.is_empty())
        .unwrap_or(true);
    assert!(empty, "artMap.scripts remains empty");
}

#[test]
fn delete_folder_when_project_json_missing_still_deletes_folder()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    // Intentionally NO project.json.

    let foo = root.join("foo");
    fs::create_dir(&foo).unwrap();
    fs::write(foo.join("a.mangaplay.md"), "a").unwrap();

    delete_file_force_impl(&foo, Some(root))
        .expect("folder delete ok even without project.json");

    assert!(!foo.exists(), "folder gone");
}

#[test]
fn delete_folder_when_storyboard_subtree_missing_still_drops_keys()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let foo = root.join("foo");
    fs::create_dir(&foo).unwrap();
    fs::write(foo.join("a.mangaplay.md"), "a").unwrap();

    // Seed map entry but NOT a storyboard file on disk.
    let uuid_a = "aaaa1111-1111-4111-8111-111111111111";
    let mut pj = read_project_json(root).expect("read project.json");
    art_map_set(&mut pj, "foo/a.mangaplay.md", uuid_a);
    write_project_json(root, &pj).expect("write project.json");
    assert!(
        !root.join("_mangaplaystudio").join("storyboard").join("foo").exists(),
        "no storyboard subtree exists pre-delete",
    );

    delete_file_force_impl(&foo, Some(root)).expect("folder delete ok");

    assert!(!foo.exists(), "folder gone");

    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(
        art_map_get(&pj, "foo/a.mangaplay.md"),
        None,
        "key dropped even though no storyboard file existed",
    );
}

#[test]
fn delete_nested_folder_drops_nested_keys_and_subtree()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let parent = root.join("parent");
    let nested = parent.join("foo");
    let sibling = parent.join("bar");
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir_all(&sibling).unwrap();
    fs::write(nested.join("a.mangaplay.md"), "a").unwrap();
    fs::write(sibling.join("s.mangaplay.md"), "s").unwrap();
    fs::write(parent.join("p.mangaplay.md"), "p").unwrap();

    let uuid_nested = "aaaa1111-1111-4111-8111-111111111111";
    let uuid_sibling = "bbbb2222-2222-4222-8222-222222222222";
    let uuid_parent = "cccc3333-3333-4333-8333-333333333333";
    let art_nested = seed_art(root, "parent/foo/a.mangaplay.md", uuid_nested);
    let art_sibling = seed_art(root, "parent/bar/s.mangaplay.md", uuid_sibling);
    let art_parent = seed_art(root, "parent/p.mangaplay.md", uuid_parent);
    assert!(art_nested.exists());
    assert!(art_sibling.exists());
    assert!(art_parent.exists());

    delete_file_force_impl(&nested, Some(root)).expect("nested folder delete ok");

    // (a) only parent/foo/ removed
    assert!(!nested.exists(), "nested folder gone");
    assert!(sibling.exists(), "sibling folder untouched");
    assert!(parent.exists(), "parent folder untouched");

    // (b) only storyboard/parent/foo/ removed
    assert!(
        !root.join("_mangaplaystudio").join("storyboard").join("parent").join("foo").exists(),
        "nested storyboard subtree gone",
    );
    assert!(
        root.join("_mangaplaystudio").join("storyboard").join("parent").join("bar").exists(),
        "sibling storyboard subtree untouched",
    );
    assert!(art_sibling.exists(), "sibling art file untouched");
    assert!(art_parent.exists(), "parent-level art file untouched");

    // (c) only the parent/foo/* key dropped
    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(
        art_map_get(&pj, "parent/foo/a.mangaplay.md"),
        None,
        "nested key dropped",
    );
    assert_eq!(
        art_map_get(&pj, "parent/bar/s.mangaplay.md").as_deref(),
        Some(uuid_sibling),
        "sibling key preserved",
    );
    assert_eq!(
        art_map_get(&pj, "parent/p.mangaplay.md").as_deref(),
        Some(uuid_parent),
        "parent-level key preserved (NOT prefix-matched by 'parent/foo')",
    );
}
