//! Integration test for list_project_scripts_impl — exercises directory walk
//! and metadata extraction that backs the `list_project_scripts` Tauri command.

use app_lib::list_project_scripts_impl;
use std::fs;
use tempfile::TempDir;

#[test]
fn empty_dir_returns_empty_vec()
{
    let tmp = TempDir::new().expect("tempdir");

    let result = list_project_scripts_impl(tmp.path()).expect("ok");

    assert_eq!(result.len(), 0, "empty dir must return empty vec");
}

#[test]
fn missing_dir_returns_empty_vec()
{
    let tmp = TempDir::new().expect("tempdir");
    let missing = tmp.path().join("does-not-exist");

    let result = list_project_scripts_impl(&missing).expect("ok");

    assert_eq!(result.len(), 0, "missing dir must return empty vec");
}

#[test]
fn single_mangaplay_file_has_timestamps()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(
        tmp.path().join("Untitled.mangaplay.md"),
        "# Page 1\n",
    )
    .expect("write");

    let result = list_project_scripts_impl(tmp.path()).expect("ok");

    assert_eq!(result.len(), 1, "expected 1 entry");
    assert_eq!(result[0]["name"], "Untitled.mangaplay.md");

    let modified_at = result[0]["modifiedAt"].as_u64().expect("modifiedAt u64");
    let created_at = result[0]["createdAt"].as_u64().expect("createdAt u64");
    assert!(modified_at > 0, "modifiedAt must be > 0");
    assert!(created_at > 0, "createdAt must be > 0 (falls back to mtime)");
}

#[test]
fn multiple_files_sorted_by_name()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("b.mangaplay.md"), "b").expect("write b");
    fs::write(tmp.path().join("a.mangaplay.md"), "a").expect("write a");

    let result = list_project_scripts_impl(tmp.path()).expect("ok");

    assert_eq!(result.len(), 2, "expected 2 entries");
    assert_eq!(result[0]["name"], "a.mangaplay.md", "a sorts before b");
    assert_eq!(result[1]["name"], "b.mangaplay.md");
}

#[test]
fn filters_non_mangaplay_files()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("script.mangaplay.md"), "ok").expect("write md");
    fs::write(tmp.path().join("notes.txt"), "skip").expect("write txt");
    fs::write(tmp.path().join("data.json"), "{}").expect("write json");
    fs::create_dir(tmp.path().join("subfolder")).expect("mkdir");

    let result = list_project_scripts_impl(tmp.path()).expect("ok");

    // `is_script_filename` includes `.txt` (text files are a first-class
    // script kind in the UI — see app_create_file "text" branch).
    assert_eq!(result.len(), 2, "scripts + text files listed; .json + folders skipped");
    let names: Vec<&str> = result.iter().map(|v| v["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"script.mangaplay.md"));
    assert!(names.contains(&"notes.txt"));
}
