//! Integration tests for the four recent.json writers.
//!
//! Background: all four writers use `path_eq_caseless` so a case-only rename on Windows / macOS finds the
//! existing entry instead of leaving a duplicate. The fix had ZERO automated
//! coverage — a future refactor that reverted one of the sites to an
//! exact-string compare would not be caught by any test.
//!
//! These tests exercise the pure `_impl` helpers so cargo test stays
//! hermetic (no Tauri handle, no app_data_dir).

use app_lib::{
    app_remove_recent_impl,
    app_update_recent_impl,
    path_eq_caseless,
    update_recent_field_impl,
    update_recent_path_impl,
};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

/// Seed `<dir>/recent.json` with `entries` and return its path.
fn seed_recent(dir: &Path, entries: &[serde_json::Value]) -> std::path::PathBuf
{
    let path = dir.join("recent.json");
    fs::write(&path, serde_json::to_string_pretty(entries).unwrap()).expect("seed recent.json");
    path
}

fn read_recent(dir: &Path) -> Vec<serde_json::Value>
{
    let path = dir.join("recent.json");
    let s = fs::read_to_string(&path).expect("read recent.json");
    serde_json::from_str(&s).expect("parse recent.json")
}

// ── path_eq_caseless ─────────────────────────────────────────────────────

#[test]
fn path_eq_caseless_matches_case_variant()
{
    assert!(path_eq_caseless(
        Path::new("C:\\Users\\Test\\Projects\\MyProject"),
        Path::new("C:\\users\\test\\projects\\myproject"),
    ));
}

#[test]
fn path_eq_caseless_rejects_genuinely_different_paths()
{
    assert!(!path_eq_caseless(
        Path::new("C:\\Users\\Test\\Projects\\MyProject"),
        Path::new("C:\\Users\\Test\\Projects\\OtherProject"),
    ));
}

// ── app_remove_recent_impl ───────────────────────────────────────────────

#[test]
fn remove_recent_finds_case_variant()
{
    let tmp = TempDir::new().expect("tempdir");
    seed_recent(tmp.path(), &[
        serde_json::json!({ "path": "C:\\Users\\Test\\Projects\\MyProject", "name": "MyProject" }),
        serde_json::json!({ "path": "C:\\Users\\Test\\Projects\\OtherProject", "name": "OtherProject" }),
    ]);

    // Remove via the lowercase variant — must still find and drop the
    // mixed-case entry.
    app_remove_recent_impl(tmp.path(), "C:\\users\\test\\projects\\myproject")
        .expect("remove succeeds");

    let recent = read_recent(tmp.path());
    assert_eq!(recent.len(), 1, "case-variant must drop the seeded entry");
    assert_eq!(
        recent[0].get("name").and_then(|v| v.as_str()),
        Some("OtherProject"),
        "the OTHER entry must survive",
    );
}

#[test]
fn remove_recent_leaves_unrelated_entries_alone()
{
    let tmp = TempDir::new().expect("tempdir");
    seed_recent(tmp.path(), &[
        serde_json::json!({ "path": "C:\\Users\\Test\\Projects\\MyProject", "name": "MyProject" }),
    ]);

    app_remove_recent_impl(tmp.path(), "C:\\Users\\Test\\Projects\\Different")
        .expect("remove succeeds");

    let recent = read_recent(tmp.path());
    assert_eq!(recent.len(), 1, "genuinely-different path must not match");
}

#[test]
fn remove_recent_is_idempotent_on_missing_file()
{
    let tmp = TempDir::new().expect("tempdir");
    // No recent.json at all — must not error.
    app_remove_recent_impl(tmp.path(), "C:\\anywhere").expect("missing file → ok");
}

// ── app_update_recent_impl ───────────────────────────────────────────────

#[test]
fn update_recent_replaces_case_variant_not_duplicates_it()
{
    let tmp = TempDir::new().expect("tempdir");
    seed_recent(tmp.path(), &[
        serde_json::json!({
            "path": "C:\\Users\\Test\\Projects\\MyProject",
            "name": "MyProject",
            "displayNameOverride": "My Custom Name",
        }),
    ]);

    // Re-open via the lowercase variant. Must NOT duplicate; must preserve
    // the displayNameOverride.
    app_update_recent_impl(tmp.path(), "C:\\users\\test\\projects\\myproject")
        .expect("update succeeds");

    let recent = read_recent(tmp.path());
    assert_eq!(recent.len(), 1, "case-only rename must not duplicate");
    assert_eq!(
        recent[0].get("path").and_then(|v| v.as_str()),
        Some("C:\\users\\test\\projects\\myproject"),
        "path must update to the new case variant",
    );
    assert_eq!(
        recent[0].get("displayNameOverride").and_then(|v| v.as_str()),
        Some("My Custom Name"),
        "displayNameOverride must survive case-rename",
    );
}

#[test]
fn update_recent_dedupes_separator_variant()
{
    let tmp = TempDir::new().expect("tempdir");
    // Same project recorded once with backslashes (picker) and once with
    // forward slashes (auto-resume) — a raw-string caseless compare left both.
    seed_recent(tmp.path(), &[
        serde_json::json!({ "path": "D:\\proj\\Dorothy", "name": "Dorothy" }),
        serde_json::json!({ "path": "D:/proj/Dorothy",   "name": "Dorothy" }),
    ]);

    app_update_recent_impl(tmp.path(), "D:/proj/Dorothy").expect("update succeeds");

    let recent = read_recent(tmp.path());
    assert_eq!(recent.len(), 1, "separator variants must collapse to one entry");
    assert_eq!(
        recent[0].get("path").and_then(|v| v.as_str()),
        Some("D:/proj/Dorothy"),
        "new entry uses the passed path",
    );
}

#[test]
fn update_recent_creates_file_when_missing()
{
    let tmp = TempDir::new().expect("tempdir");
    app_update_recent_impl(tmp.path(), "C:\\new\\project").expect("update succeeds");
    let recent = read_recent(tmp.path());
    assert_eq!(recent.len(), 1);
    assert_eq!(
        recent[0].get("path").and_then(|v| v.as_str()),
        Some("C:\\new\\project"),
    );
}

#[test]
fn update_recent_truncates_to_ten()
{
    let tmp = TempDir::new().expect("tempdir");
    // Seed 10 distinct entries so the new one pushes the oldest out.
    let seed: Vec<serde_json::Value> = (0..10)
        .map(|i| serde_json::json!({
            "path": format!("C:\\proj\\p{}", i),
            "name": format!("p{}", i),
        }))
        .collect();
    seed_recent(tmp.path(), &seed);

    app_update_recent_impl(tmp.path(), "C:\\proj\\new").expect("update succeeds");
    let recent = read_recent(tmp.path());
    assert_eq!(recent.len(), 10, "must stay capped at 10");
    assert_eq!(
        recent[0].get("path").and_then(|v| v.as_str()),
        Some("C:\\proj\\new"),
        "new entry prepended at index 0",
    );
}

// ── update_recent_path_impl ──────────────────────────────────────────────

#[test]
fn update_recent_path_finds_case_variant()
{
    let tmp = TempDir::new().expect("tempdir");
    // Use forward slashes so `Path::file_name()` works on Linux test runs
    // too. Production callers pass platform-native paths; on Windows
    // backslashes work, on Unix forward slashes do — both go through the
    // same code path inside the writer.
    seed_recent(tmp.path(), &[
        serde_json::json!({ "path": "/users/test/projects/MyProject", "name": "MyProject" }),
    ]);

    // Call with the case-variant `old_path`. Must still find + rewrite.
    update_recent_path_impl(
        tmp.path(),
        "/USERS/test/projects/myproject",
        "/users/test/projects/Renamed",
    ).expect("rewrite succeeds");

    let recent = read_recent(tmp.path());
    assert_eq!(recent.len(), 1);
    assert_eq!(
        recent[0].get("path").and_then(|v| v.as_str()),
        Some("/users/test/projects/Renamed"),
    );
    assert_eq!(
        recent[0].get("name").and_then(|v| v.as_str()),
        Some("Renamed"),
        "name must be refreshed from the new basename",
    );
}

#[test]
fn update_recent_path_leaves_other_entries_untouched()
{
    let tmp = TempDir::new().expect("tempdir");
    seed_recent(tmp.path(), &[
        serde_json::json!({ "path": "C:\\Users\\Test\\Projects\\MyProject", "name": "MyProject" }),
        serde_json::json!({ "path": "C:\\Users\\Test\\Projects\\Other", "name": "Other" }),
    ]);

    update_recent_path_impl(
        tmp.path(),
        "C:\\users\\test\\projects\\myproject",
        "C:\\Users\\Test\\Projects\\Renamed",
    ).expect("rewrite succeeds");

    let recent = read_recent(tmp.path());
    assert_eq!(recent.len(), 2);
    // Find the entry that should remain unchanged.
    let other = recent.iter()
        .find(|v| v.get("name").and_then(|n| n.as_str()) == Some("Other"))
        .expect("Other entry survives");
    assert_eq!(
        other.get("path").and_then(|v| v.as_str()),
        Some("C:\\Users\\Test\\Projects\\Other"),
        "unrelated entry untouched",
    );
}

// ── update_recent_field_impl ─────────────────────────────────────────────

#[test]
fn update_recent_field_sets_via_case_variant()
{
    let tmp = TempDir::new().expect("tempdir");
    seed_recent(tmp.path(), &[
        serde_json::json!({ "path": "C:\\Users\\Test\\Projects\\MyProject", "name": "MyProject" }),
    ]);

    update_recent_field_impl(
        tmp.path(),
        "C:\\users\\test\\projects\\myproject",
        "displayNameOverride",
        serde_json::Value::String("Renamed".into()),
    ).expect("field set succeeds");

    let recent = read_recent(tmp.path());
    assert_eq!(
        recent[0].get("displayNameOverride").and_then(|v| v.as_str()),
        Some("Renamed"),
        "case-variant lookup must find the entry",
    );
}

#[test]
fn update_recent_field_clears_with_null()
{
    let tmp = TempDir::new().expect("tempdir");
    seed_recent(tmp.path(), &[
        serde_json::json!({
            "path": "C:\\Users\\Test\\Projects\\MyProject",
            "name": "MyProject",
            "displayNameOverride": "Old Name",
        }),
    ]);

    update_recent_field_impl(
        tmp.path(),
        "C:\\users\\test\\projects\\myproject",
        "displayNameOverride",
        serde_json::Value::Null,
    ).expect("field clear succeeds");

    let recent = read_recent(tmp.path());
    assert!(
        recent[0].get("displayNameOverride").is_none(),
        "null value must REMOVE the key, not write null into it",
    );
}

#[test]
fn update_recent_field_does_not_touch_other_entries()
{
    let tmp = TempDir::new().expect("tempdir");
    seed_recent(tmp.path(), &[
        serde_json::json!({
            "path": "C:\\Users\\Test\\Projects\\MyProject",
            "name": "MyProject",
            "displayNameOverride": "Keep Me",
        }),
        serde_json::json!({ "path": "C:\\Users\\Test\\Projects\\Other", "name": "Other" }),
    ]);

    // Update field on a path that matches NEITHER entry — no entry should
    // change.
    update_recent_field_impl(
        tmp.path(),
        "C:\\Users\\Test\\Projects\\Missing",
        "displayNameOverride",
        serde_json::Value::String("Should Not Appear".into()),
    ).expect("ok on miss");

    let recent = read_recent(tmp.path());
    assert_eq!(recent.len(), 2);
    let mine = recent.iter()
        .find(|v| v.get("name").and_then(|n| n.as_str()) == Some("MyProject"))
        .unwrap();
    assert_eq!(
        mine.get("displayNameOverride").and_then(|v| v.as_str()),
        Some("Keep Me"),
        "non-matching update must not change existing entries",
    );
}
