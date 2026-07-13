//! Integration tests for `move_path_impl` — the in-project move backing
//! the file explorer's drag-and-drop. Cross-device fallback is exercised
//! via the same-FS rename success path here; the EXDEV branch is covered
//! by manual repro (impossible to provoke in a tempdir).

use app_lib::move_path_impl;
use std::fs;
use tempfile::TempDir;

#[test]
fn move_file_to_sibling_folder_succeeds()
{
    let tmp = TempDir::new().expect("tempdir");
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    let src = a.join("foo.mangaplay.md");
    fs::write(&src, "# Page 1\n").unwrap();

    let dst = move_path_impl(&src, &b).expect("move ok");
    assert_eq!(dst, b.join("foo.mangaplay.md"));
    assert!(!src.exists(), "source removed after rename");
    assert!(dst.exists(), "destination created");
    assert_eq!(fs::read_to_string(&dst).unwrap(), "# Page 1\n");
}

#[test]
fn target_exists_rejected()
{
    let tmp = TempDir::new().expect("tempdir");
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("foo.mangaplay.md"), "src").unwrap();
    fs::write(b.join("foo.mangaplay.md"), "dst").unwrap();

    let err = move_path_impl(&a.join("foo.mangaplay.md"), &b).expect_err("must reject");
    assert_eq!(err, "target-exists");
    // Source must remain untouched.
    assert_eq!(fs::read_to_string(a.join("foo.mangaplay.md")).unwrap(), "src");
    assert_eq!(fs::read_to_string(b.join("foo.mangaplay.md")).unwrap(), "dst");
}

#[test]
fn move_into_descendant_rejected()
{
    let tmp = TempDir::new().expect("tempdir");
    let a = tmp.path().join("a");
    let sub = a.join("sub");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&sub).unwrap();

    let err = move_path_impl(&a, &sub).expect_err("must reject");
    assert_eq!(err, "move-into-descendant");
    assert!(a.exists(), "source folder must remain");
    assert!(sub.exists(), "destination folder must remain");
}

#[test]
fn move_into_self_rejected()
{
    let tmp = TempDir::new().expect("tempdir");
    let a = tmp.path().join("a");
    fs::create_dir(&a).unwrap();

    let err = move_path_impl(&a, &a).expect_err("must reject");
    assert_eq!(err, "move-into-descendant");
}

#[test]
fn move_folder_to_sibling_succeeds()
{
    let tmp = TempDir::new().expect("tempdir");
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("inside.mangaplay.md"), "x").unwrap();

    let dst = move_path_impl(&a, &b).expect("move ok");
    assert_eq!(dst, b.join("a"));
    assert!(!a.exists(), "source folder removed");
    assert!(dst.exists(), "destination folder created");
    assert!(dst.join("inside.mangaplay.md").exists(), "children carried over");
}

#[test]
fn missing_source_rejected()
{
    let tmp = TempDir::new().expect("tempdir");
    let a = tmp.path().join("a");
    fs::create_dir(&a).unwrap();
    let src = tmp.path().join("ghost.mangaplay.md");

    let err = move_path_impl(&src, &a).expect_err("must reject");
    assert_eq!(err, "source-not-found");
}

#[test]
fn parent_not_dir_rejected()
{
    let tmp = TempDir::new().expect("tempdir");
    let src = tmp.path().join("foo.mangaplay.md");
    fs::write(&src, "x").unwrap();
    let bogus_parent = tmp.path().join("nope");

    let err = move_path_impl(&src, &bogus_parent).expect_err("must reject");
    assert_eq!(err, "parent-not-dir");
}

// ── app_move_folder delegation gates (closes audit-rust.md L5) ──────────
//
// `app_move_folder` (Tauri command) used to duplicate the rename + EXDEV
// dance inline with no symlink/descendant guard. It now delegates to
// `move_path_impl`, so a future refactor that re-inlines the rename
// would re-open L5. These tests exercise the same fixtures through
// `move_path_impl` to gate the contract `app_move_folder` now relies on.

#[test]
fn project_level_move_into_descendant_rejected()
{
    // Simulates: user drags a project folder into one of its own subfolders
    // via the start-screen "Move to…" action. The Tauri command's body is
    // now `move_path_impl(src, parent)`; the descendant guard MUST fire.
    let tmp = TempDir::new().expect("tempdir");
    let project = tmp.path().join("MyProject");
    let subfolder = project.join("chapters");
    fs::create_dir(&project).unwrap();
    fs::create_dir(&subfolder).unwrap();
    let app = project.join("_mangaplaystudio");
    fs::create_dir(&app).unwrap();
    fs::write(app.join("project.json"), "{}").unwrap();

    let err = move_path_impl(&project, &subfolder).expect_err("must reject");
    assert_eq!(err, "move-into-descendant");
    assert!(app.join("project.json").exists(), "project untouched");
}

#[test]
fn project_level_move_to_sibling_parent_succeeds()
{
    // Simulates: user moves a project folder to a sibling directory.
    // Happy path — basename preserved, recent.json caller side updates
    // separately.
    let tmp = TempDir::new().expect("tempdir");
    let old_parent = tmp.path().join("old");
    let new_parent = tmp.path().join("new");
    fs::create_dir(&old_parent).unwrap();
    fs::create_dir(&new_parent).unwrap();
    let project = old_parent.join("MyProject");
    fs::create_dir(&project).unwrap();
    let app = project.join("_mangaplaystudio");
    fs::create_dir(&app).unwrap();
    fs::write(app.join("project.json"), "{}").unwrap();

    let dst = move_path_impl(&project, &new_parent).expect("move ok");
    assert_eq!(dst, new_parent.join("MyProject"));
    assert!(!project.exists(), "project removed from old parent");
    assert!(
        dst.join("_mangaplaystudio").join("project.json").exists(),
        "project.json carried over",
    );
}
