//! Integration tests for `list_project_tree_impl` — the walker that backs
//! the `app_list_project_tree` Tauri command. Emits both folder and file
//! entries. Folders are emitted whenever they exist on disk, including
//! empty ones — the tree UI relies on this so freshly-created folders
//! appear immediately without waiting for a script to be added.

use app_lib::list_project_tree_impl;
use std::fs;
use tempfile::TempDir;

#[test]
fn flat_dir_with_two_scripts_returns_two_files()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("a.mangaplay.md"), "a").unwrap();
    fs::write(tmp.path().join("b.mangaplay.md"), "b").unwrap();

    let result = list_project_tree_impl(tmp.path()).expect("ok");
    assert_eq!(result.len(), 2);
    assert_eq!(result[0]["name"], "a.mangaplay.md");
    assert_eq!(result[0]["kind"], "file");
    assert_eq!(result[1]["name"], "b.mangaplay.md");
    assert_eq!(result[1]["kind"], "file");
}

#[test]
fn nested_scripts_emit_folder_row()
{
    let tmp = TempDir::new().expect("tempdir");
    let chapter = tmp.path().join("chapter-1");
    fs::create_dir(&chapter).unwrap();
    fs::write(tmp.path().join("top.mangaplay.md"), "x").unwrap();
    fs::write(chapter.join("intro.mangaplay.md"), "y").unwrap();
    fs::write(chapter.join("scene.mangaplay.md"), "z").unwrap();

    let result = list_project_tree_impl(tmp.path()).expect("ok");
    // 1 folder + 3 files = 4 entries.
    assert_eq!(result.len(), 4);

    let kinds_by_name: std::collections::HashMap<_, _> = result
        .iter()
        .map(|e| (
            e["name"].as_str().unwrap().to_string(),
            e["kind"].as_str().unwrap().to_string(),
        ))
        .collect();

    assert_eq!(kinds_by_name.get("chapter-1"), Some(&"folder".to_string()));
    assert_eq!(kinds_by_name.get("chapter-1/intro.mangaplay.md"), Some(&"file".to_string()));
    assert_eq!(kinds_by_name.get("chapter-1/scene.mangaplay.md"), Some(&"file".to_string()));
    assert_eq!(kinds_by_name.get("top.mangaplay.md"), Some(&"file".to_string()));
}

#[test]
fn empty_folders_are_emitted()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::create_dir(tmp.path().join("empty")).unwrap();
    fs::create_dir(tmp.path().join("also-empty")).unwrap();
    fs::write(tmp.path().join("kept.mangaplay.md"), "x").unwrap();

    let result = list_project_tree_impl(tmp.path()).expect("ok");
    // Two empty folders + one script = three entries.
    assert_eq!(result.len(), 3);

    let by_name: std::collections::HashMap<_, _> = result
        .iter()
        .map(|e| (
            e["name"].as_str().unwrap().to_string(),
            e["kind"].as_str().unwrap().to_string(),
        ))
        .collect();
    assert_eq!(by_name.get("empty"), Some(&"folder".to_string()));
    assert_eq!(by_name.get("also-empty"), Some(&"folder".to_string()));
    assert_eq!(by_name.get("kept.mangaplay.md"), Some(&"file".to_string()));
}

#[test]
fn folder_with_only_non_script_files_still_emitted()
{
    let tmp = TempDir::new().expect("tempdir");
    let junk = tmp.path().join("junk");
    fs::create_dir(&junk).unwrap();
    fs::write(junk.join("notes.txt"), "ignored").unwrap();
    fs::write(tmp.path().join("kept.mangaplay.md"), "x").unwrap();

    let result = list_project_tree_impl(tmp.path()).expect("ok");
    // 1 folder + 1 script + 1 nested .txt (treated as a script by
    // `is_script_filename` — see app_create_file "text" branch). The folder
    // is always emitted even when empty of scripts.
    assert_eq!(result.len(), 3);

    let by_name: std::collections::HashMap<_, _> = result
        .iter()
        .map(|e| (
            e["name"].as_str().unwrap().to_string(),
            e["kind"].as_str().unwrap().to_string(),
        ))
        .collect();
    assert_eq!(by_name.get("junk"), Some(&"folder".to_string()));
    assert_eq!(by_name.get("junk/notes.txt"), Some(&"file".to_string()));
    assert_eq!(by_name.get("kept.mangaplay.md"), Some(&"file".to_string()));
}

#[test]
fn missing_dir_returns_empty_vec()
{
    let tmp = TempDir::new().expect("tempdir");
    let missing = tmp.path().join("nope");
    let result = list_project_tree_impl(&missing).expect("ok");
    assert_eq!(result.len(), 0);
}

#[test]
fn entries_include_absolute_path()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("a.mangaplay.md"), "x").unwrap();

    let result = list_project_tree_impl(tmp.path()).expect("ok");
    assert_eq!(result.len(), 1);
    let path = result[0]["path"].as_str().expect("path string");
    assert!(path.ends_with("a.mangaplay.md"));
    assert!(std::path::Path::new(path).is_absolute(), "path is absolute");
}
