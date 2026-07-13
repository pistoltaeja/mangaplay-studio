//! Coverage for the v2 layout pieces that the migrator + open paths consume:
//!   * `project_create_new_impl` scaffolds the new shape.
//!   * `list_project_scripts_impl` walks recursively, accepts both extensions,
//!     skips dotfiles, returns slash-joined relative paths.

use app_lib::{list_project_scripts_impl, project_create_new_impl};
use std::fs;
use tempfile::TempDir;

// ── project_create_new_impl ──────────────────────────────────────────────

#[test]
fn create_new_scaffolds_v2_layout()
{
    let tmp = TempDir::new().expect("tempdir");
    let path = project_create_new_impl(
        &tmp.path().to_string_lossy(),
        "My Comic",
    )
    .expect("create ok");
    let root = std::path::Path::new(&path);
    let app = root.join("_mangaplaystudio");

    assert!(app.is_dir(), "app dir must exist");
    assert!(app.join("settings").is_dir());
    assert!(!root.join("project").exists(), "flat layout: no project/ subdir");
    assert!(app.join("storyboard").is_dir());
    assert!(app.join("meta.json").is_file());
    assert!(app.join("project.json").is_file());

    // None of the old reserved siblings live at the project root anymore.
    assert!(!root.join("mangaplay_settings").exists());
    assert!(!root.join("storyboard").exists());
    assert!(!root.join("meta.json").exists());
    assert!(!root.join("project.json").exists());

    let seed = root.join("Untitled.mangaplay.md");
    assert!(seed.is_file(), "must seed Untitled.mangaplay.md at root");
    let body = fs::read_to_string(&seed).unwrap();
    assert_eq!(body, "# Page 1\nPanel 1\nAction line.\n");

    // project.json carries a UUID id + null displayName.
    let pj: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(app.join("project.json")).unwrap())
            .unwrap();
    assert!(pj.get("id").and_then(|v| v.as_str()).is_some());
    assert!(pj.get("displayName").map(|v| v.is_null()).unwrap_or(false));
}

#[test]
fn create_new_rejects_missing_parent()
{
    let tmp = TempDir::new().expect("tempdir");
    let ghost = tmp.path().join("ghost");
    let err = project_create_new_impl(&ghost.to_string_lossy(), "x")
        .expect_err("must err");
    assert!(err.contains("not a directory"), "got: {}", err);
}

// ── list_project_scripts_impl recursive walk ──────────────────────────────

#[test]
fn walk_finds_nested_scripts_with_slash_joined_names()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    fs::write(root.join("root.mangaplay.md"), "a").unwrap();
    fs::create_dir(root.join("chapter-1")).unwrap();
    fs::write(root.join("chapter-1").join("intro.mangaplay.md"), "b").unwrap();
    fs::write(root.join("chapter-1").join("outro.fountain.md"), "c").unwrap();
    fs::create_dir(root.join("chapter-1").join("scenes")).unwrap();
    fs::write(
        root.join("chapter-1").join("scenes").join("a.mangaplay.md"),
        "d",
    )
    .unwrap();

    let names: Vec<String> = list_project_scripts_impl(root)
        .expect("ok")
        .iter()
        .map(|v| v["name"].as_str().unwrap_or("").to_string())
        .collect();

    // Sorted alphabetically (the impl sorts before returning).
    assert!(names.contains(&"root.mangaplay.md".to_string()));
    assert!(names.contains(&"chapter-1/intro.mangaplay.md".to_string()));
    assert!(names.contains(&"chapter-1/outro.fountain.md".to_string()));
    assert!(names.contains(&"chapter-1/scenes/a.mangaplay.md".to_string()));
    assert_eq!(names.len(), 4);
}

#[test]
fn walk_skips_dotfiles_and_non_script_files()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    fs::write(root.join("ok.mangaplay.md"), "x").unwrap();
    fs::write(root.join(".hidden.mangaplay.md"), "skip me").unwrap();
    fs::write(root.join("notes.txt"), "skip").unwrap();
    fs::write(root.join("data.json"), "{}").unwrap();
    fs::create_dir(root.join(".git")).unwrap();
    fs::write(root.join(".git").join("HEAD"), "skip").unwrap();

    let names: Vec<String> = list_project_scripts_impl(root)
        .expect("ok")
        .iter()
        .map(|v| v["name"].as_str().unwrap_or("").to_string())
        .collect();

    assert_eq!(names, vec!["notes.txt".to_string(), "ok.mangaplay.md".to_string()]);
}

#[test]
fn walk_returns_empty_when_dir_missing()
{
    let tmp = TempDir::new().expect("tempdir");
    let ghost = tmp.path().join("does-not-exist");
    let result = list_project_scripts_impl(&ghost).expect("ok");
    assert!(result.is_empty());
}

#[test]
fn walk_accepts_fountain_extension()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("scene.fountain.md"), "INT. KITCHEN\n").unwrap();

    let names: Vec<String> = list_project_scripts_impl(tmp.path())
        .expect("ok")
        .iter()
        .map(|v| v["name"].as_str().unwrap_or("").to_string())
        .collect();

    assert_eq!(names, vec!["scene.fountain.md".to_string()]);
}
