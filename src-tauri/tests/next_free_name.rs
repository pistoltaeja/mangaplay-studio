//! Integration test for the `next_free_name` helper.

use app_lib::fs_helpers::next_free_name;
use std::fs;
use tempfile::TempDir;

#[test]
fn empty_dir_returns_bare_name()
{
    let tmp = TempDir::new().expect("tempdir");
    let got = next_free_name(tmp.path(), "Untitled", ".mangaplay.md", 1);
    assert_eq!(got, "Untitled.mangaplay.md");
}

#[test]
fn collision_returns_numbered_name()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("Untitled.mangaplay.md"), "x").unwrap();
    let got = next_free_name(tmp.path(), "Untitled", ".mangaplay.md", 1);
    assert_eq!(got, "Untitled 2.mangaplay.md");
}

#[test]
fn double_collision_returns_next_number()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("Untitled.mangaplay.md"), "x").unwrap();
    fs::write(tmp.path().join("Untitled 2.mangaplay.md"), "x").unwrap();
    let got = next_free_name(tmp.path(), "Untitled", ".mangaplay.md", 1);
    assert_eq!(got, "Untitled 3.mangaplay.md");
}

#[test]
fn double_suffix_preserved()
{
    // Whole ext_chain is one unit — never split per-dot.
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("Untitled.fountain.md"), "x").unwrap();
    let got = next_free_name(tmp.path(), "Untitled", ".fountain.md", 1);
    assert_eq!(got, "Untitled 2.fountain.md");
}

#[test]
fn start_greater_than_one_skips_bare_name()
{
    let tmp = TempDir::new().expect("tempdir");
    // Bare name is FREE, but caller asked to start numbering — bare must be skipped.
    let got = next_free_name(tmp.path(), "Untitled", ".mangaplay.md", 2);
    assert_eq!(got, "Untitled 2.mangaplay.md");
}
