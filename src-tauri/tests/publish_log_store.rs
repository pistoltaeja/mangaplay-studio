//! Integration tests for the publish-log store:
//!   - `publish_log_load_impl` empty / missing / malformed behaviour.
//!   - `publish_log_append_impl` prepend order, rotation at 200, double rotation.
//!
//! Tauri-handle paths are covered by the manual smoke pass — these tests
//! exercise the pure helpers so cargo test stays hermetic.

use app_lib::{
    publish_log_append_impl,
    publish_log_load_impl,
    next_free_publish_log_number,
};
use serde_json::json;
use std::fs;
use tempfile::TempDir;

fn make_entry(idx: usize) -> serde_json::Value
{
    json!({
        "fileName": format!("file-{}", idx),
        "docId": format!("doc-{}", idx),
        "docUrl": format!("https://docs.google.com/document/d/doc-{}", idx),
        "format": "mangaplay",
        "intent": "publish",
        "createdAtUtc": "2026-06-30T12:00:00Z",
        "googleSub": null,
        "googleEmail": null,
        "googleName": null,
        "googlePicture": null
    })
}

// ── load ────────────────────────────────────────────────────────────────

#[test]
fn load_returns_empty_when_file_missing()
{
    let tmp = TempDir::new().expect("tempdir");
    let v = publish_log_load_impl(tmp.path()).expect("load");
    let entries = v.get("entries").and_then(|e| e.as_array()).expect("entries array");
    assert!(entries.is_empty());
}

#[test]
fn load_returns_empty_when_file_malformed()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("publish-log.json"), b"this is not json").expect("write garbage");
    let v = publish_log_load_impl(tmp.path()).expect("load");
    let entries = v.get("entries").and_then(|e| e.as_array()).expect("entries array");
    assert!(entries.is_empty());
}

#[test]
fn load_returns_empty_when_entries_key_missing()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("publish-log.json"), br#"{"foo": "bar"}"#).expect("write");
    let v = publish_log_load_impl(tmp.path()).expect("load");
    let entries = v.get("entries").and_then(|e| e.as_array()).expect("entries array");
    assert!(entries.is_empty());
}

// ── append ──────────────────────────────────────────────────────────────

#[test]
fn append_once_creates_file_with_one_entry()
{
    let tmp = TempDir::new().expect("tempdir");
    publish_log_append_impl(tmp.path(), make_entry(0)).expect("append");

    let v = publish_log_load_impl(tmp.path()).expect("load");
    let entries = v.get("entries").and_then(|e| e.as_array()).expect("entries");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].get("fileName").and_then(|s| s.as_str()), Some("file-0"));
}

#[test]
fn append_prepends_newest_first()
{
    let tmp = TempDir::new().expect("tempdir");
    publish_log_append_impl(tmp.path(), make_entry(0)).expect("a");
    publish_log_append_impl(tmp.path(), make_entry(1)).expect("b");

    let v = publish_log_load_impl(tmp.path()).expect("load");
    let entries = v.get("entries").and_then(|e| e.as_array()).expect("entries");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].get("fileName").and_then(|s| s.as_str()), Some("file-1"));
    assert_eq!(entries[1].get("fileName").and_then(|s| s.as_str()), Some("file-0"));
}

#[test]
fn append_recovers_from_malformed_active_file()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("publish-log.json"), b"garbage").expect("write garbage");

    publish_log_append_impl(tmp.path(), make_entry(42)).expect("append");

    let v = publish_log_load_impl(tmp.path()).expect("load");
    let entries = v.get("entries").and_then(|e| e.as_array()).expect("entries");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].get("fileName").and_then(|s| s.as_str()), Some("file-42"));
}

// ── rotation ────────────────────────────────────────────────────────────

#[test]
fn rotation_kicks_in_at_201st_append()
{
    let tmp = TempDir::new().expect("tempdir");
    for i in 0..200 {
        publish_log_append_impl(tmp.path(), make_entry(i)).expect("append");
    }

    // Active should now hold 200 entries.
    let pre = publish_log_load_impl(tmp.path()).expect("load pre");
    assert_eq!(pre.get("entries").and_then(|e| e.as_array()).map(|a| a.len()), Some(200));

    // The 201st triggers rotation.
    publish_log_append_impl(tmp.path(), make_entry(1000)).expect("append 201");

    // Active file holds only the new entry.
    let active = publish_log_load_impl(tmp.path()).expect("load active");
    let active_entries = active.get("entries").and_then(|e| e.as_array()).expect("entries");
    assert_eq!(active_entries.len(), 1);
    assert_eq!(active_entries[0].get("fileName").and_then(|s| s.as_str()), Some("file-1000"));

    // Archived file holds the original 200.
    let archived_path = tmp.path().join("publish-log-1.json");
    assert!(archived_path.exists(), "archive must exist");
    let archived_str = fs::read_to_string(&archived_path).expect("read archive");
    let archived: serde_json::Value = serde_json::from_str(&archived_str).expect("parse archive");
    let archived_entries = archived.get("entries").and_then(|e| e.as_array()).expect("entries");
    assert_eq!(archived_entries.len(), 200);
}

#[test]
fn double_rotation_uses_next_free_suffix()
{
    let tmp = TempDir::new().expect("tempdir");

    // First rotation: fill 200, append once more.
    for i in 0..200 {
        publish_log_append_impl(tmp.path(), make_entry(i)).expect("append");
    }
    publish_log_append_impl(tmp.path(), make_entry(1000)).expect("rot 1");
    assert!(tmp.path().join("publish-log-1.json").exists());

    // Second rotation: fill 199 more (one entry already there) → 200 active, then trigger.
    for i in 0..199 {
        publish_log_append_impl(tmp.path(), make_entry(2000 + i)).expect("fill");
    }
    publish_log_append_impl(tmp.path(), make_entry(3000)).expect("rot 2");

    assert!(tmp.path().join("publish-log-1.json").exists());
    assert!(tmp.path().join("publish-log-2.json").exists(), "second archive must exist");

    let active = publish_log_load_impl(tmp.path()).expect("load active");
    let active_entries = active.get("entries").and_then(|e| e.as_array()).expect("entries");
    assert_eq!(active_entries.len(), 1);
    assert_eq!(active_entries[0].get("fileName").and_then(|s| s.as_str()), Some("file-3000"));
}

// ── next_free_publish_log_number ────────────────────────────────────────

#[test]
fn next_free_defaults_to_one()
{
    let tmp = TempDir::new().expect("tempdir");
    assert_eq!(next_free_publish_log_number(tmp.path()), 1);
}

#[test]
fn next_free_picks_max_plus_one()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("publish-log-1.json"), b"{}").expect("write");
    fs::write(tmp.path().join("publish-log-3.json"), b"{}").expect("write");
    fs::write(tmp.path().join("publish-log-7.json"), b"{}").expect("write");
    fs::write(tmp.path().join("publish-log-other.json"), b"{}").expect("non-matching");
    assert_eq!(next_free_publish_log_number(tmp.path()), 8);
}
