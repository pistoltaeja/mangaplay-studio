//! Integration tests for the new filesystem command helpers.
//!
//! The `#[tauri::command]` wrappers themselves require an `AppHandle` so we
//! drive the pure `*_impl` helpers — same pattern used for `atomic_write_impl`
//! and `list_project_scripts_impl`.

use app_lib::{
    art_map_get,
    art_map_set,
    copy_file_impl,
    create_file_impl,
    delete_file_force_impl,
    force_delete_impl,
    read_project_json,
    rename_file_impl,
    write_project_json,
};
use std::fs;
use tempfile::TempDir;

/// Seed a minimal `project.json` so the artMap helpers have somewhere to
/// write. The shape matches what `mangaart_scaffold_impl` writes after the
/// first scaffold call.
fn seed_project_json(root: &std::path::Path)
{
    let pj = serde_json::json!({
        "id": "test-project-id",
        "displayName": serde_json::Value::Null,
        "createdAt": "2026-01-01T00:00:00Z",
    });
    write_project_json(root, &pj).expect("seed project.json");
}

/// Seed `project.json` and pre-register `script_rel → uuid` in the artMap
/// AND drop a placeholder art file at the resolved storyboard path so tests
/// can assert the file does NOT move.
fn seed_project_with_art(
    root: &std::path::Path,
    script_rel: &str,
    uuid: &str,
) -> std::path::PathBuf
{
    seed_project_json(root);
    let mut pj = read_project_json(root).expect("read seeded project.json");
    art_map_set(&mut pj, script_rel, uuid);
    write_project_json(root, &pj).expect("write art-mapped project.json");

    let art_path = app_lib::resolve_art_path(root, script_rel, uuid);
    if let Some(parent) = art_path.parent()
    {
        fs::create_dir_all(parent).expect("create storyboard parents");
    }
    fs::write(&art_path, format!("art-marker:{}", uuid)).expect("write art placeholder");
    art_path
}

// ── copy ─────────────────────────────────────────────────────────────────

#[test]
fn copy_creates_numbered_sibling()
{
    let tmp = TempDir::new().expect("tempdir");
    let src = tmp.path().join("hero.mangaplay.md");
    fs::write(&src, "# Page 1\nhi\n").unwrap();
    let dst = copy_file_impl(&src).expect("copy ok");
    assert_eq!(dst.file_name().unwrap().to_string_lossy(), "hero 2.mangaplay.md");
    assert_eq!(fs::read_to_string(&dst).unwrap(), "# Page 1\nhi\n");
    // Original still there.
    assert!(src.exists());
}

#[test]
fn copy_of_copy_numbers_correctly()
{
    let tmp = TempDir::new().expect("tempdir");
    let src = tmp.path().join("hero.mangaplay.md");
    fs::write(&src, "x").unwrap();
    let first = copy_file_impl(&src).expect("copy ok");
    let second = copy_file_impl(&first).expect("copy 2 ok");
    let nm = second.file_name().unwrap().to_string_lossy().to_string();
    // "hero 2.mangaplay.md" copied → "hero 3.mangaplay.md".
    assert_eq!(nm, "hero 3.mangaplay.md");
}

#[test]
fn copy_folder_returns_not_supported()
{
    let tmp = TempDir::new().expect("tempdir");
    let sub = tmp.path().join("folder");
    fs::create_dir(&sub).unwrap();
    let err = copy_file_impl(&sub).expect_err("must reject folder");
    assert_eq!(err, "not-supported");
}

#[test]
fn copy_missing_returns_not_found()
{
    let tmp = TempDir::new().expect("tempdir");
    let err = copy_file_impl(&tmp.path().join("nope.mangaplay.md")).expect_err("must err");
    assert_eq!(err, "not-found");
}

// ── create ───────────────────────────────────────────────────────────────

#[test]
fn create_mangaplay_seeds_first_page()
{
    let tmp = TempDir::new().expect("tempdir");
    let dst = create_file_impl(tmp.path(), "mangaplay").expect("create ok");
    assert_eq!(dst.file_name().unwrap().to_string_lossy(), "Untitled.mangaplay.md");
    assert_eq!(fs::read_to_string(&dst).unwrap(), "# Page 1\nPanel 1\nAction line.\n");
}

#[test]
fn create_fountain_is_empty()
{
    let tmp = TempDir::new().expect("tempdir");
    let dst = create_file_impl(tmp.path(), "fountain").expect("create ok");
    assert_eq!(dst.file_name().unwrap().to_string_lossy(), "Untitled.fountain.md");
    assert_eq!(fs::read_to_string(&dst).unwrap(), "");
}

#[test]
fn create_folder_creates_dir()
{
    let tmp = TempDir::new().expect("tempdir");
    let dst = create_file_impl(tmp.path(), "folder").expect("create ok");
    assert_eq!(dst.file_name().unwrap().to_string_lossy(), "Untitled");
    assert!(dst.is_dir());
}

#[test]
fn create_invalid_kind_errors()
{
    let tmp = TempDir::new().expect("tempdir");
    let err = create_file_impl(tmp.path(), "ham").expect_err("must err");
    assert_eq!(err, "invalid-kind");
}

#[test]
fn create_in_missing_parent_errors()
{
    let tmp = TempDir::new().expect("tempdir");
    let nope = tmp.path().join("ghost");
    let err = create_file_impl(&nope, "mangaplay").expect_err("must err");
    assert_eq!(err, "parent-not-dir");
}

#[test]
fn create_numbers_when_untitled_taken()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("Untitled.mangaplay.md"), "x").unwrap();
    let dst = create_file_impl(tmp.path(), "mangaplay").expect("create ok");
    assert_eq!(dst.file_name().unwrap().to_string_lossy(), "Untitled 2.mangaplay.md");
}

// ── rename ───────────────────────────────────────────────────────────────

#[test]
fn rename_happy_path()
{
    let tmp = TempDir::new().expect("tempdir");
    let src = tmp.path().join("hero.mangaplay.md");
    fs::write(&src, "x").unwrap();
    let dst = rename_file_impl(&src, "villain.mangaplay.md", false, None)
        .expect("rename ok");
    assert!(!src.exists());
    assert!(dst.exists());
}

#[test]
fn rename_blocks_when_currently_open()
{
    let tmp = TempDir::new().expect("tempdir");
    let src = tmp.path().join("hero.mangaplay.md");
    fs::write(&src, "x").unwrap();
    let err = rename_file_impl(&src, "villain.mangaplay.md", true, None)
        .expect_err("must err");
    assert_eq!(err, "project-is-open");
}

#[test]
fn rename_rejects_invalid_basename()
{
    let tmp = TempDir::new().expect("tempdir");
    let src = tmp.path().join("hero.mangaplay.md");
    fs::write(&src, "x").unwrap();
    let err = rename_file_impl(&src, "bad/name.md", false, None)
        .expect_err("must err");
    assert_eq!(err, "separator");
}

#[test]
fn rename_blocks_on_existing_target()
{
    let tmp = TempDir::new().expect("tempdir");
    let src = tmp.path().join("a.mangaplay.md");
    let dst = tmp.path().join("b.mangaplay.md");
    fs::write(&src, "x").unwrap();
    fs::write(&dst, "y").unwrap();
    let err = rename_file_impl(&src, "b.mangaplay.md", false, None)
        .expect_err("must err");
    assert_eq!(err, "target-exists");
}

// ── art-map rewrite on rename ─────────────────────────────────────────────

#[test]
fn rename_script_with_art_rewrites_map_key_and_does_not_move_file()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    let uuid = "aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000";
    let script_src = root.join("foo.mangaplay.md");
    fs::write(&script_src, "x").unwrap();

    let art_path = seed_project_with_art(root, "foo.mangaplay.md", uuid);
    let art_bytes_before = fs::read(&art_path).expect("read art before");

    let dst = rename_file_impl(&script_src, "bar.mangaplay.md", false, Some(root))
        .expect("rename ok");

    // (a) script file renamed
    assert!(!script_src.exists(), "old script gone");
    assert!(dst.exists(), "new script present");

    // (b) old key dropped, (c) new key carries the SAME UUID
    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(art_map_get(&pj, "foo.mangaplay.md"), None, "old key dropped");
    assert_eq!(
        art_map_get(&pj, "bar.mangaplay.md").as_deref(),
        Some(uuid),
        "new key preserved UUID",
    );

    // (d) art file is unchanged — same path, same bytes
    assert!(art_path.exists(), "art file still at original storyboard path");
    let art_bytes_after = fs::read(&art_path).expect("read art after");
    assert_eq!(art_bytes_before, art_bytes_after, "art bytes unchanged");
}

#[test]
fn rename_nested_script_with_art_keeps_art_in_old_mirrored_folder()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    let uuid = "12345678-90ab-4cde-8f01-234567890abc";

    // foo/bar/baz.mangaplay.md
    let nested_dir = root.join("foo").join("bar");
    fs::create_dir_all(&nested_dir).unwrap();
    let script_src = nested_dir.join("baz.mangaplay.md");
    fs::write(&script_src, "x").unwrap();

    let art_path = seed_project_with_art(root, "foo/bar/baz.mangaplay.md", uuid);
    // Sanity: art lives at _mangaplaystudio/storyboard/foo/bar/<uuid>.mangaart
    assert_eq!(
        art_path,
        root.join("_mangaplaystudio").join("storyboard").join("foo").join("bar")
            .join(format!("{}.mangaart", uuid)),
    );

    rename_file_impl(&script_src, "qux.mangaplay.md", false, Some(root))
        .expect("rename ok");

    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(art_map_get(&pj, "foo/bar/baz.mangaplay.md"), None);
    assert_eq!(
        art_map_get(&pj, "foo/bar/qux.mangaplay.md").as_deref(),
        Some(uuid),
    );

    // Art file stayed put.
    assert!(art_path.exists(), "art file still at storyboard/foo/bar/<uuid>");
}

#[test]
fn rename_script_without_art_mapping_succeeds()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let src = root.join("hero.mangaplay.md");
    fs::write(&src, "x").unwrap();

    rename_file_impl(&src, "villain.mangaplay.md", false, Some(root))
        .expect("rename ok");

    assert!(!src.exists());
    assert!(root.join("villain.mangaplay.md").exists());

    let pj = read_project_json(root).expect("read project.json");
    // artMap may be absent OR an empty `scripts` object — either is fine.
    let scripts_empty = pj
        .get("artMap")
        .and_then(|m| m.get("scripts"))
        .and_then(|s| s.as_object())
        .map(|o| o.is_empty())
        .unwrap_or(true);
    assert!(scripts_empty, "artMap.scripts must remain empty");
}

#[test]
fn rename_non_script_file_does_not_touch_art_map()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    let uuid = "deadbeef-0000-4000-8000-feedfacecafe";

    // Pre-seed an unrelated art mapping for a script that exists on disk.
    fs::write(root.join("hero.mangaplay.md"), "x").unwrap();
    seed_project_with_art(root, "hero.mangaplay.md", uuid);

    // Now rename a NON-script file.
    let notes = root.join("notes.txt");
    fs::write(&notes, "hello").unwrap();
    rename_file_impl(&notes, "more-notes.txt", false, Some(root))
        .expect("rename ok");

    assert!(!notes.exists());
    assert!(root.join("more-notes.txt").exists());

    // The unrelated mapping is intact.
    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(
        art_map_get(&pj, "hero.mangaplay.md").as_deref(),
        Some(uuid),
        "unrelated artMap entry untouched",
    );
}

#[test]
fn rename_target_exists_aborts_before_map_write()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    let uuid = "11111111-2222-4333-8444-555555555555";

    let src = root.join("foo.mangaplay.md");
    let blocker = root.join("bar.mangaplay.md");
    fs::write(&src, "x").unwrap();
    fs::write(&blocker, "y").unwrap();

    seed_project_with_art(root, "foo.mangaplay.md", uuid);

    let err = rename_file_impl(&src, "bar.mangaplay.md", false, Some(root))
        .expect_err("must err");
    assert_eq!(err, "target-exists");

    // Pre-existing dst check runs FIRST → no JSON I/O happened. Key intact.
    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(
        art_map_get(&pj, "foo.mangaplay.md").as_deref(),
        Some(uuid),
        "old key must still be present after target-exists abort",
    );
    assert_eq!(
        art_map_get(&pj, "bar.mangaplay.md"),
        None,
        "new key must NOT have been written",
    );

    assert!(src.exists(), "script untouched on collision");
}

#[test]
fn case_only_rename_updates_map_key()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    let uuid = "abcdef01-2345-4678-89ab-cdef01234567";

    let src = root.join("Foo.mangaplay.md");
    fs::write(&src, "x").unwrap();
    seed_project_with_art(root, "Foo.mangaplay.md", uuid);

    rename_file_impl(&src, "foo.mangaplay.md", false, Some(root))
        .expect("case-only rename ok");

    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(
        art_map_get(&pj, "Foo.mangaplay.md"),
        None,
        "original-case key dropped",
    );
    assert_eq!(
        art_map_get(&pj, "foo.mangaplay.md").as_deref(),
        Some(uuid),
        "new-case key carries the same UUID",
    );
}

// ── delete (force path — trash crate hard to exercise in CI tempdir) ─────

#[test]
fn force_delete_removes_file()
{
    let tmp = TempDir::new().expect("tempdir");
    let p = tmp.path().join("doomed.mangaplay.md");
    fs::write(&p, "x").unwrap();
    force_delete_impl(&p).expect("delete ok");
    assert!(!p.exists());
}

#[test]
fn force_delete_removes_dir_recursively()
{
    let tmp = TempDir::new().expect("tempdir");
    let d = tmp.path().join("dir");
    fs::create_dir(&d).unwrap();
    fs::write(d.join("inner.md"), "x").unwrap();
    force_delete_impl(&d).expect("delete ok");
    assert!(!d.exists());
}

#[test]
fn force_delete_missing_errors()
{
    let tmp = TempDir::new().expect("tempdir");
    let err = force_delete_impl(&tmp.path().join("nope")).expect_err("must err");
    assert_eq!(err, "not-found");
}

// ── art-map cleanup on delete ─────────────────────────────────────────────
//
// Force-variant tests so the cleanup is deterministic without depending on a
// freedesktop / Win32 trash backend that might not exist on the CI host.

#[test]
fn delete_script_with_art_clears_map_and_removes_art()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    let uuid = "aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000";

    let script = root.join("foo.mangaplay.md");
    fs::write(&script, "x").unwrap();
    let art_path = seed_project_with_art(root, "foo.mangaplay.md", uuid);
    assert!(art_path.exists(), "precondition: art file written");

    delete_file_force_impl(&script, Some(root)).expect("delete ok");

    // (a) script gone
    assert!(!script.exists(), "script removed");
    // (b) art file gone
    assert!(!art_path.exists(), "mapped art file removed");
    // (c) artMap entry dropped
    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(art_map_get(&pj, "foo.mangaplay.md"), None, "map key gone");
}

#[test]
fn delete_script_without_art_mapping_succeeds()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let script = root.join("hero.mangaplay.md");
    fs::write(&script, "x").unwrap();

    delete_file_force_impl(&script, Some(root)).expect("delete ok");

    assert!(!script.exists(), "script removed");

    let pj = read_project_json(root).expect("read project.json");
    let scripts_empty = pj
        .get("artMap")
        .and_then(|m| m.get("scripts"))
        .and_then(|s| s.as_object())
        .map(|o| o.is_empty())
        .unwrap_or(true);
    assert!(scripts_empty, "artMap.scripts must remain empty");
}

#[test]
fn delete_non_script_file_does_not_touch_art_map()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    let uuid = "deadbeef-0000-4000-8000-feedfacecafe";

    // Pre-seed an unrelated art mapping for a script that exists on disk.
    fs::write(root.join("hero.mangaplay.md"), "x").unwrap();
    let unrelated_art = seed_project_with_art(root, "hero.mangaplay.md", uuid);

    // Delete a NON-script file (`.txt` is a script per is_script_filename
    // today, so pick a clearly-non-script extension for this test).
    let notes = root.join("notes.json");
    fs::write(&notes, "{}").unwrap();
    delete_file_force_impl(&notes, Some(root)).expect("delete ok");

    assert!(!notes.exists(), "notes removed");
    assert!(unrelated_art.exists(), "unrelated art file untouched");

    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(
        art_map_get(&pj, "hero.mangaplay.md").as_deref(),
        Some(uuid),
        "unrelated artMap entry untouched",
    );
}

#[test]
fn delete_file_without_project_root_works_as_before()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    let uuid = "11112222-3333-4444-8555-666677778888";

    // Even with a populated project.json + art file, passing `None` must
    // leave both untouched.
    let script = root.join("hero.mangaplay.md");
    fs::write(&script, "x").unwrap();
    let art_path = seed_project_with_art(root, "hero.mangaplay.md", uuid);

    delete_file_force_impl(&script, None).expect("delete ok");

    assert!(!script.exists(), "script removed");
    assert!(art_path.exists(), "art file untouched (no project_root)");

    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(
        art_map_get(&pj, "hero.mangaplay.md").as_deref(),
        Some(uuid),
        "artMap untouched when project_root is None",
    );
}

#[test]
fn delete_script_when_project_json_missing_still_deletes_script()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    // Intentionally NOT seeding project.json.

    let script = root.join("hero.mangaplay.md");
    fs::write(&script, "x").unwrap();

    delete_file_force_impl(&script, Some(root)).expect("delete ok");

    assert!(!script.exists(), "script removed despite missing project.json");
    assert!(
        !root.join("_mangaplaystudio").join("project.json").exists(),
        "project.json still absent",
    );
}

#[test]
fn delete_folder_does_not_touch_art_map()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    let uuid = "99998888-7777-4666-8555-444433332222";

    // Seed an art mapping for a real script — independent of the folder we
    // delete below. The folder-delete must NOT drop this entry — folder-scoped
    // art cleanup is the folder branch's job.
    fs::write(root.join("hero.mangaplay.md"), "x").unwrap();
    let art_path = seed_project_with_art(root, "hero.mangaplay.md", uuid);

    let doomed = root.join("subdir");
    fs::create_dir(&doomed).unwrap();
    fs::write(doomed.join("inner.txt"), "y").unwrap();

    delete_file_force_impl(&doomed, Some(root)).expect("delete folder ok");

    assert!(!doomed.exists(), "folder removed");
    assert!(art_path.exists(), "unrelated art untouched");

    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(
        art_map_get(&pj, "hero.mangaplay.md").as_deref(),
        Some(uuid),
        "artMap untouched when target is a folder",
    );
}
