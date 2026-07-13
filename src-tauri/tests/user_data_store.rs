//! Integration tests for the user-data store MVP:
//!   - `resolve_user_data_dir_for_exe` portable-mode branch logic.
//!   - `user_settings_load_impl` / `user_settings_save_impl` round-trip,
//!     merge semantics, defaults, recovery on bad input.
//!
//! Tauri-handle-dependent paths (`resolve_user_data_dir` proper) are
//! covered end-to-end by the Windows verify run — these tests exercise
//! the pure helpers so cargo test stays hermetic.

use app_lib::{
    resolve_user_data_dir_for_exe,
    user_settings_load_impl,
    user_settings_save_impl,
};
use std::fs;
use tempfile::TempDir;

// ── resolve_user_data_dir_for_exe ────────────────────────────────────────

#[test]
fn portable_resolver_returns_none_when_marker_missing()
{
    let tmp = TempDir::new().expect("tempdir");
    // No `portable` marker → resolver short-circuits, caller falls through
    // to app_config_dir.
    assert!(resolve_user_data_dir_for_exe(tmp.path()).is_none());
}

#[test]
#[cfg(not(target_os = "macos"))]
fn portable_resolver_returns_userdata_when_marker_present()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("portable"), b"").expect("write marker");

    let resolved = resolve_user_data_dir_for_exe(tmp.path());
    assert!(resolved.is_some(), "marker present must resolve to userdata/");
    let p = resolved.unwrap();
    assert_eq!(p, tmp.path().join("userdata"));
    assert!(p.exists(), "userdata/ must be created by the resolver");

    // Resolver must clean up its own write-probe artefact.
    assert!(
        !p.join(".write-probe").exists(),
        "write-probe must be deleted after a successful probe"
    );
}

#[test]
#[cfg(target_os = "macos")]
fn portable_resolver_short_circuits_on_macos()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("portable"), b"").expect("write marker");

    // Even with the marker present, macOS resolver always returns None —
    // bundle signature sealing + Gatekeeper App Translocation make portable
    // mode user-hostile there.
    assert!(resolve_user_data_dir_for_exe(tmp.path()).is_none());
}

#[test]
#[cfg(not(target_os = "macos"))]
fn portable_resolver_idempotent_on_repeat_call()
{
    let tmp = TempDir::new().expect("tempdir");
    fs::write(tmp.path().join("portable"), b"").expect("write marker");

    let p1 = resolve_user_data_dir_for_exe(tmp.path()).expect("resolved");
    let p2 = resolve_user_data_dir_for_exe(tmp.path()).expect("re-resolved");
    assert_eq!(p1, p2);
    assert!(p1.exists());
}

// ── user_settings_load_impl ──────────────────────────────────────────────

#[test]
fn user_settings_load_returns_defaults_for_missing_file()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    let v = user_settings_load_impl(&dir).expect("load ok");

    assert_eq!(v["format"], "user-settings:v1");
    assert_eq!(v["defaultLanguage"], "en");
    assert!(v["createdVersion"].is_null(),
        "createdVersion is stamped by user_data_ensure_version, not load");
    assert!(v["currentVersion"].is_null(),
        "currentVersion is stamped by user_data_ensure_version, not load");
    assert!(v["lastProjectPath"].is_null());
    assert_eq!(v["lastSettingsTab"], "general");

    // load must NOT scaffold a file on disk.
    assert!(
        !tmp.path().join("user-settings.json").exists(),
        "load must not create user-settings.json"
    );
}

#[test]
fn user_settings_load_silently_recovers_from_corrupt_file()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    fs::write(tmp.path().join("user-settings.json"), b"{{{ not json")
        .expect("seed corrupt");

    let v = user_settings_load_impl(&dir).expect("load ok");

    // Falls back to defaults; corrupt file left alone (MVP — caller can
    // overwrite via save).
    assert_eq!(v["defaultLanguage"], "en");
    assert!(tmp.path().join("user-settings.json").exists(),
        "MVP keeps the corrupt file; quarantine deferred");
}

// ── user_settings_save_impl ──────────────────────────────────────────────

#[test]
fn user_settings_save_then_load_round_trip()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    user_settings_save_impl(
        &dir,
        serde_json::json!({ "lastProjectPath": "/tmp/projA" }),
    ).expect("save ok");

    let v = user_settings_load_impl(&dir).expect("load ok");
    assert_eq!(v["lastProjectPath"], "/tmp/projA");
    assert_eq!(v["defaultLanguage"], "en", "default preserved");
    assert!(
        tmp.path().join("user-settings.json").exists(),
        "save must create the file"
    );
}

#[test]
fn user_settings_save_partial_preserves_untouched_fields()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "defaultLanguage": "ja",
            "lastProjectPath": "/tmp/old",
        }),
    ).expect("set initial");

    user_settings_save_impl(
        &dir,
        serde_json::json!({ "lastProjectPath": "/tmp/new" }),
    ).expect("set partial");

    let v = user_settings_load_impl(&dir).expect("load ok");
    assert_eq!(v["defaultLanguage"], "ja", "language preserved");
    assert_eq!(v["lastProjectPath"], "/tmp/new", "last path updated");
}

#[test]
fn user_settings_save_drops_unknown_keys()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "lastProjectPath": "/tmp/x",
            "imAFutureField": "ignored",
        }),
    ).expect("save ok");

    let v = user_settings_load_impl(&dir).expect("load ok");
    assert!(
        v.get("imAFutureField").is_none(),
        "unknown keys must drop silently to keep the schema honest"
    );
    assert_eq!(v["lastProjectPath"], "/tmp/x");
}

#[test]
fn user_settings_save_creates_missing_parent_dir()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().join("nested").join("deep");
    assert!(!dir.exists(), "precondition");

    user_settings_save_impl(
        &dir,
        serde_json::json!({ "lastProjectPath": "/tmp/p" }),
    ).expect("save creates parent dir");

    assert!(dir.join("user-settings.json").is_file());
}

#[test]
fn user_settings_save_stamps_format_and_updated_at()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    user_settings_save_impl(
        &dir,
        serde_json::json!({ "defaultLanguage": "ko" }),
    ).expect("save ok");

    let raw = fs::read_to_string(dir.join("user-settings.json"))
        .expect("file exists");
    let v: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
    assert_eq!(v["format"], "user-settings:v1");
    assert!(v["updatedAt"].is_string(), "updatedAt always stamped");
}

// ── projectSessions sub-map ──────────────────────────────────────────────

#[test]
fn user_settings_default_has_empty_project_sessions_map()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    let v = user_settings_load_impl(&dir).expect("load ok");

    let map = v["projectSessions"].as_object().expect("map present");
    assert!(map.is_empty(), "fresh install starts with an empty map");
}

#[test]
fn user_settings_project_sessions_round_trip()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "projectSessions": {
                "uuid-a": {
                    "viewMode": "solo-mangaplay",
                    "expandedFolders": ["Chapter_1"]
                }
            }
        }),
    ).expect("save ok");

    let v = user_settings_load_impl(&dir).expect("load ok");
    let entry = &v["projectSessions"]["uuid-a"];
    assert_eq!(entry["viewMode"], "solo-mangaplay");
    assert_eq!(entry["expandedFolders"][0], "Chapter_1");
}

#[test]
fn user_settings_project_sessions_partial_save_preserves_other_uuids()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "projectSessions": {
                "uuid-a": { "viewMode": "dual" },
                "uuid-b": { "viewMode": "solo-storyboard" }
            }
        }),
    ).expect("initial save ok");

    // Second save updates only uuid-a. uuid-b must survive.
    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "projectSessions": {
                "uuid-a": { "viewMode": "solo-screenplay" }
            }
        }),
    ).expect("partial save ok");

    let v = user_settings_load_impl(&dir).expect("load ok");
    assert_eq!(v["projectSessions"]["uuid-a"]["viewMode"], "solo-screenplay");
    assert_eq!(v["projectSessions"]["uuid-b"]["viewMode"], "solo-storyboard",
        "unrelated uuid must survive partial save");
}

#[test]
fn user_settings_project_sessions_uuid_partial_replaces_entry_fields()
{
    // Inner shape is opaque JS-owned. A per-uuid partial fully replaces the
    // corresponding entry — JS caller is responsible for shallow-merging the
    // inner fields before invoking save.
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "projectSessions": {
                "uuid-a": { "viewMode": "dual", "lastSoloMode": "solo-storyboard" }
            }
        }),
    ).expect("first ok");

    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "projectSessions": {
                "uuid-a": { "viewMode": "solo-screenplay" }
            }
        }),
    ).expect("second ok");

    let v = user_settings_load_impl(&dir).expect("load ok");
    assert_eq!(v["projectSessions"]["uuid-a"]["viewMode"], "solo-screenplay");
    // Inner-field merge is JS's job; Rust replaces the whole entry.
    assert!(
        v["projectSessions"]["uuid-a"].get("lastSoloMode").is_none(),
        "Rust does not deep-merge inside per-uuid entries"
    );
}

#[test]
fn user_settings_project_sessions_absent_in_partial_preserves_all()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "projectSessions": {
                "uuid-a": { "viewMode": "dual" }
            }
        }),
    ).expect("save initial");

    // A save that touches an unrelated top-level key must not lose the map.
    user_settings_save_impl(
        &dir,
        serde_json::json!({ "lastProjectPath": "/tmp/x" }),
    ).expect("save unrelated");

    let v = user_settings_load_impl(&dir).expect("load ok");
    assert_eq!(v["projectSessions"]["uuid-a"]["viewMode"], "dual");
    assert_eq!(v["lastProjectPath"], "/tmp/x");
}
