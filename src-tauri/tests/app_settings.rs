//! Integration test for app_settings_get_impl / app_settings_set_impl —
//! exercises the on-disk settings.json contract that backs the Tauri
//! `app_settings_get` / `app_settings_set` commands.

use app_lib::{app_settings_get_impl, app_settings_set_impl};
use std::fs;
use std::sync::Arc;
use std::thread;
use tempfile::TempDir;

#[test]
fn fresh_dir_returns_defaults()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    let value = app_settings_get_impl(&dir, "standalone").expect("get ok");

    assert_eq!(value["format"], "settings:v1");
    assert_eq!(value["skin"], "default");
    assert_eq!(value["hardwareAcceleration"], true);
    assert_eq!(value["automaticUpdates"], true);
    assert!(value.get("updatedAt").is_some(), "updatedAt must stamp");

    // Get must NOT auto-scaffold a file.
    assert!(
        !tmp.path().join("settings.json").exists(),
        "get must not create settings.json"
    );
}

#[test]
fn set_then_get_round_trip()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    app_settings_set_impl(&dir, serde_json::json!({ "skin": "night" }), "standalone")
        .expect("set ok");

    let value = app_settings_get_impl(&dir, "standalone").expect("get ok");
    assert_eq!(value["skin"], "night");
    assert_eq!(value["hardwareAcceleration"], true);
    assert_eq!(value["automaticUpdates"], true);
    assert!(
        tmp.path().join("settings.json").exists(),
        "set must create settings.json"
    );
}

#[test]
fn partial_set_preserves_other_fields()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    app_settings_set_impl(&dir, serde_json::json!({ "skin": "night" }), "standalone")
        .expect("set 1");
    app_settings_set_impl(
        &dir,
        serde_json::json!({ "hardwareAcceleration": false }),
        "standalone",
    )
    .expect("set 2");

    let value = app_settings_get_impl(&dir, "standalone").expect("get ok");
    assert_eq!(value["skin"], "night", "first write preserved");
    assert_eq!(value["hardwareAcceleration"], false, "second write applied");
    assert_eq!(value["automaticUpdates"], true, "default preserved");
}

#[test]
fn corrupt_file_recovers_and_renames()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();
    fs::create_dir_all(&dir).expect("mkdir");
    fs::write(dir.join("settings.json"), "{{{garbage}}}").expect("write garbage");

    let value = app_settings_get_impl(&dir, "standalone").expect("get ok despite corrupt");
    assert_eq!(value["skin"], "default", "defaults returned");
    assert!(
        value.get("__recovered").is_some(),
        "__recovered marker must be set"
    );

    // settings.json itself is gone (renamed away).
    assert!(!dir.join("settings.json").exists(), "corrupt file moved");

    // A settings.json.corrupt-* file must exist.
    let entries: Vec<_> = fs::read_dir(&dir)
        .expect("read tmp dir")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let has_corrupt = entries
        .iter()
        .any(|n| n.starts_with("settings.json.corrupt-"));
    assert!(has_corrupt, "expected settings.json.corrupt-* file, got {entries:?}");
}

#[test]
fn missing_parent_dir_create_on_set()
{
    let tmp = TempDir::new().expect("tempdir");
    let nested = tmp.path().join("missing").join("nested");
    // Do NOT create `nested` ahead of time — set must mkdir for us.
    assert!(!nested.exists(), "precondition: nested dir absent");

    app_settings_set_impl(&nested, serde_json::json!({ "skin": "night" }), "standalone")
        .expect("set creates parent");

    assert!(nested.exists(), "set must create parent dir");
    assert!(
        nested.join("settings.json").exists(),
        "set must create settings.json under nested dir"
    );
}

#[test]
fn concurrent_writes_serialize()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = Arc::new(tmp.path().to_path_buf());

    let dir_a = Arc::clone(&dir);
    let h_a = thread::spawn(move || {
        for _ in 0..20
        {
            app_settings_set_impl(
                &dir_a,
                serde_json::json!({ "skin": "night" }),
                "standalone",
            )
            .expect("a set ok");
        }
    });

    let dir_b = Arc::clone(&dir);
    let h_b = thread::spawn(move || {
        for _ in 0..20
        {
            app_settings_set_impl(
                &dir_b,
                serde_json::json!({ "hardwareAcceleration": false }),
                "standalone",
            )
            .expect("b set ok");
        }
    });

    h_a.join().expect("a joined");
    h_b.join().expect("b joined");

    // Final state must contain BOTH last writes (both keys persisted across
    // interleaved merges). Specifically: the *last* writer of each key wins,
    // but both keys should be present and parseable, with no torn JSON.
    let value = app_settings_get_impl(&dir, "standalone").expect("get ok after threads");
    assert_eq!(value["skin"], "night");
    assert_eq!(value["hardwareAcceleration"], false);
}

#[test]
fn tmp_sweep_on_get()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();
    fs::create_dir_all(&dir).expect("mkdir");

    // Plant a valid settings.json and a stray .tmp leftover.
    let valid = serde_json::json!({
        "format": "settings:v1",
        "updatedAt": "2026-01-01T00:00:00Z",
        "skin": "night",
        "hardwareAcceleration": true,
        "automaticUpdates": true
    });
    fs::write(
        dir.join("settings.json"),
        serde_json::to_string_pretty(&valid).unwrap(),
    )
    .expect("write settings");
    fs::write(dir.join("settings.json.tmp"), "leftover-from-crash")
        .expect("write tmp");

    let value = app_settings_get_impl(&dir, "standalone").expect("get ok");
    assert_eq!(value["skin"], "night", "valid settings honoured");

    // .tmp swept.
    assert!(
        !dir.join("settings.json.tmp").exists(),
        "stray .tmp must be deleted"
    );
    // settings.json untouched.
    assert!(
        dir.join("settings.json").exists(),
        "valid settings.json preserved"
    );
}

#[test]
fn unknown_fields_dropped_on_merge()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();
    fs::create_dir_all(&dir).expect("mkdir");

    let blob = serde_json::json!({
        "format": "settings:v1",
        "skin": "night",
        "pancakes": 42
    });
    fs::write(
        dir.join("settings.json"),
        serde_json::to_string_pretty(&blob).unwrap(),
    )
    .expect("write blob");

    let value = app_settings_get_impl(&dir, "standalone").expect("get ok");
    assert_eq!(value["skin"], "night");
    assert!(
        value.get("pancakes").is_none(),
        "unknown keys must drop, got {value}"
    );
}

#[test]
fn colorscheme_dark_migrates_to_skin_night_and_drops_key()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();
    fs::create_dir_all(&dir).expect("mkdir");

    // Seed a legacy settings.json — pre-skins refactor shape.
    let legacy = serde_json::json!({
        "format": "settings:v1",
        "colorScheme": "dark",
        "hardwareAcceleration": true,
    });
    fs::write(
        dir.join("settings.json"),
        serde_json::to_string_pretty(&legacy).unwrap(),
    )
    .expect("write legacy");

    // First read: sanitiser drops the unknown `colorScheme` key. JS
    // shell-restore.js handles the value → `skin` mapping and persists it,
    // but the Rust-level contract on its own just guarantees the unknown
    // key is stripped on merge — `skin` returns to its default here.
    let value = app_settings_get_impl(&dir, "standalone").expect("get ok despite legacy shape");
    assert!(
        value.get("colorScheme").is_none(),
        "sanitiser must drop legacy colorScheme, got {value}"
    );
    assert_eq!(value["skin"], "default", "default skin returned when unset");

    // After the JS migration persists `skin: night`, the value round-trips.
    app_settings_set_impl(&dir, serde_json::json!({ "skin": "night" }), "standalone")
        .expect("set skin");
    let value = app_settings_get_impl(&dir, "standalone").expect("get ok");
    assert_eq!(value["skin"], "night");
    assert!(
        value.get("colorScheme").is_none(),
        "colorScheme stays absent after migration"
    );
}

#[test]
fn mobile_defaults_start_panels_collapsed()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    // Fresh install on mobile — collapse-toggle buttons are hidden by CSS
    // in mobile/tablet UX modes, so leaving the panels open would strand
    // the user with no way to close them. Defaults must start collapsed.
    let value = app_settings_get_impl(&dir, "mobile").expect("get ok");
    assert_eq!(value["leftPaneCollapsed"], true, "mobile default = collapsed");
    assert_eq!(value["storyboardCollapsed"], true, "mobile default = collapsed");

    let value = app_settings_get_impl(&dir, "tablet").expect("get ok");
    assert_eq!(value["leftPaneCollapsed"], true, "tablet default = collapsed");
    assert_eq!(value["storyboardCollapsed"], true, "tablet default = collapsed");

    // Standalone keeps the historical open-by-default.
    let value = app_settings_get_impl(&dir, "standalone").expect("get ok");
    assert_eq!(value["leftPaneCollapsed"], false, "standalone default = open");
    assert_eq!(value["storyboardCollapsed"], false, "standalone default = open");
}
