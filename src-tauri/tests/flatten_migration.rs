//! Integration tests for the auto-flatten migration + ignore-list semantics.
//!
//! Covers:
//!   * Happy path: <root>/project/<files> → <root>/<files>, project/ removed.
//!   * Collision: any pre-existing target name aborts without moving anything.
//!   * Ignore list at depth 0 hides app-managed names from the explorer.
//!   * Ignore list does NOT filter at deeper depths.

use app_lib::{flatten_project_layout_impl, list_project_tree_impl};
use std::fs;
use tempfile::TempDir;

// ── flatten_project_layout_impl ──────────────────────────────────────────

#[test]
fn flatten_moves_children_up_and_removes_project_dir()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    fs::create_dir(root.join("project")).unwrap();
    fs::write(root.join("project").join("hero.mangaplay.md"), "h").unwrap();
    fs::write(root.join("project").join("intro.fountain.md"), "i").unwrap();
    fs::create_dir(root.join("project").join("chapter-2")).unwrap();
    fs::write(root.join("project").join("chapter-2").join("scene.mangaplay"), "s").unwrap();

    let moved = flatten_project_layout_impl(root).expect("ok");
    assert!(moved, "expected flatten to happen");

    assert!(root.join("hero.mangaplay.md").exists());
    assert!(root.join("intro.fountain.md").exists());
    assert!(root.join("chapter-2").join("scene.mangaplay").exists());
    assert!(!root.join("project").exists(), "project/ must be removed");
}

#[test]
fn flatten_collision_aborts_without_moving()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    fs::create_dir(root.join("project")).unwrap();
    fs::write(root.join("project").join("hero.mangaplay.md"), "new").unwrap();
    fs::write(root.join("project").join("solo.mangaplay.md"), "x").unwrap();
    // Existing collision target at root.
    fs::write(root.join("hero.mangaplay.md"), "existing").unwrap();

    let err = flatten_project_layout_impl(root).expect_err("must error");
    assert!(err.starts_with("flatten-collision:"), "got: {}", err);
    assert!(err.contains("hero.mangaplay.md"));

    // Pre-existing root file untouched.
    assert_eq!(fs::read_to_string(root.join("hero.mangaplay.md")).unwrap(), "existing");
    // The non-colliding script stayed under project/ — operation is all-or-nothing.
    assert!(root.join("project").join("solo.mangaplay.md").exists(), "no moves on collision");
    assert!(root.join("project").join("hero.mangaplay.md").exists());
}

#[test]
fn flatten_noop_when_no_project_dir()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    fs::write(root.join("hero.mangaplay.md"), "x").unwrap();

    let moved = flatten_project_layout_impl(root).expect("ok");
    assert!(!moved, "no project/ → no move");
    assert!(root.join("hero.mangaplay.md").exists());
}

#[test]
fn flatten_removes_empty_project_dir()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    fs::create_dir(root.join("project")).unwrap();

    let moved = flatten_project_layout_impl(root).expect("ok");
    assert!(!moved, "empty project/ → no move, but dir cleaned up");
    assert!(!root.join("project").exists());
}

// ── ignore list at depth 0 ───────────────────────────────────────────────

#[test]
fn ignore_list_hides_app_managed_names_at_root()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    // App-managed scaffolding that must NOT appear in the explorer.
    let app = root.join("_mangaplaystudio");
    fs::create_dir(&app).unwrap();
    fs::write(app.join("project.json"), "{}").unwrap();
    fs::write(app.join("meta.json"), "{}").unwrap();
    fs::create_dir(app.join("storyboard")).unwrap();
    fs::write(app.join("storyboard").join("page-001.json"), "{}").unwrap();
    fs::create_dir(app.join("settings")).unwrap();
    fs::write(app.join("settings").join("session.json"), "{}").unwrap();
    // Real content.
    fs::write(root.join("hero.mangaplay.md"), "h").unwrap();
    fs::create_dir(root.join("Chapter_1")).unwrap();
    fs::write(root.join("Chapter_1").join("intro.mangaplay"), "i").unwrap();

    let names: Vec<String> = list_project_tree_impl(root)
        .expect("ok")
        .iter()
        .map(|v| v["name"].as_str().unwrap_or("").to_string())
        .collect();

    assert!(names.contains(&"hero.mangaplay.md".to_string()));
    assert!(names.contains(&"Chapter_1".to_string()));
    assert!(names.contains(&"Chapter_1/intro.mangaplay".to_string()));

    // The single reserved app directory must not surface.
    for ignored in &["_mangaplaystudio"]
    {
        assert!(
            !names.iter().any(|n| n == ignored || n.starts_with(&format!("{}/", ignored))),
            "ignored name leaked: {} (got names: {:?})",
            ignored, names
        );
    }
}

#[test]
fn ignore_list_does_not_filter_at_deeper_depths()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    // A subfolder named "storyboard" deep in the tree is plain user
    // content under the new layout — only `_mangaplaystudio` is reserved
    // (and only at depth 0 for the explorer). Confirm walker still
    // surfaces a deeply-nested storyboard folder.
    fs::create_dir(root.join("Chapter_1")).unwrap();
    fs::create_dir(root.join("Chapter_1").join("storyboard")).unwrap();
    fs::write(
        root.join("Chapter_1").join("storyboard").join("scene.mangaplay"),
        "s",
    )
    .unwrap();

    let names: Vec<String> = list_project_tree_impl(root)
        .expect("ok")
        .iter()
        .map(|v| v["name"].as_str().unwrap_or("").to_string())
        .collect();

    assert!(names.contains(&"Chapter_1".to_string()));
    assert!(names.contains(&"Chapter_1/storyboard".to_string()),
            "user-content storyboard/ at depth 1 must NOT be filtered (got: {:?})", names);
    assert!(names.contains(&"Chapter_1/storyboard/scene.mangaplay".to_string()));
}
