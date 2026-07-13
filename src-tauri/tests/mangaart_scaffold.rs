//! Integration tests for `mangaart_scaffold_impl` under the storyboard-
//! relocation layout (Phase 2 of mangaart-storyboard-relocation).
//!
//! Each test sits on a `tempfile::TempDir`, seeds a minimal `project.json`,
//! and exercises the pure helper directly — no Tauri runtime needed.

use app_lib::{
    art_map_get,
    art_map_set,
    mangaart_resolve_path_impl,
    mangaart_scaffold_impl,
    mint_script_uuid,
    read_project_json,
    resolve_art_path,
    write_project_json,
};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn seed_project_json(root: &Path)
{
    let pj = serde_json::json!({
        "id": "test-project-id",
        "displayName": serde_json::Value::Null,
        "createdAt": "2026-01-01T00:00:00Z",
    });
    write_project_json(root, &pj).expect("seed project.json");
}

fn assert_uuid_v4(s: &str)
{
    assert_eq!(s.len(), 36, "uuid string must be 36 chars: {}", s);
    let hyphens = s.chars().filter(|c| *c == '-').count();
    assert_eq!(hyphens, 4, "uuid must have 4 hyphens: {}", s);
    // Version nibble is the first char of the 3rd group (index 14).
    let version = s.chars().nth(14).expect("uuid version nibble");
    assert_eq!(version, '4', "uuid must be v4 (char 14 == '4'): {}", s);
}

#[test]
fn fresh_scaffold_for_root_level_script()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let result = mangaart_scaffold_impl(
        root.to_str().unwrap(),
        "Untitled.mangaplay.md",
    )
    .expect("scaffold ok");

    // (c) returned scaffold has the same UUID that ends up in the artMap.
    let uuid = result["uuid"].as_str().expect("uuid string").to_string();
    assert_uuid_v4(&uuid);
    assert_eq!(result["format"], "mangaart:v1");
    assert_eq!(result["name"], "Untitled.mangaplay");
    assert_eq!(result["scriptFile"], "Untitled.mangaplay.md");
    assert_eq!(result["pages"].as_array().expect("pages").len(), 0);

    // (a) art file lives under storyboard/<uuid>.mangaart at root.
    let expected_art = root.join("_mangaplaystudio").join("storyboard").join(format!("{}.mangaart", uuid));
    assert!(expected_art.exists(), "art file at {:?}", expected_art);

    // (b) project.json carries the mapping under the original script_file key.
    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(
        art_map_get(&pj, "Untitled.mangaplay.md"),
        Some(uuid.clone()),
        "artMap.scripts entry"
    );

    // Sanity: the legacy sibling location is NOT created.
    assert!(
        !root.join("Untitled.mangaplay.mangaart").exists(),
        "legacy sibling art file must not be written"
    );
}

#[test]
fn fresh_scaffold_for_nested_script()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let script = "foo/bar/baz.mangaplay.md";
    let result = mangaart_scaffold_impl(root.to_str().unwrap(), script)
        .expect("scaffold ok");

    let uuid = result["uuid"].as_str().expect("uuid").to_string();
    assert_uuid_v4(&uuid);

    let expected_art = root
        .join("_mangaplaystudio")
        .join("storyboard")
        .join("foo")
        .join("bar")
        .join(format!("{}.mangaart", uuid));
    assert!(expected_art.exists(), "nested art at {:?}", expected_art);

    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(art_map_get(&pj, script), Some(uuid));
}

#[test]
fn two_scripts_same_basename_distinct_folders_get_distinct_uuids()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let a = mangaart_scaffold_impl(
        root.to_str().unwrap(),
        "foo/baz.mangaplay.md",
    )
    .expect("scaffold a");
    let b = mangaart_scaffold_impl(
        root.to_str().unwrap(),
        "qux/baz.mangaplay.md",
    )
    .expect("scaffold b");

    let uuid_a = a["uuid"].as_str().unwrap().to_string();
    let uuid_b = b["uuid"].as_str().unwrap().to_string();
    assert_ne!(uuid_a, uuid_b, "shared-basename scripts must mint distinct UUIDs");

    let art_a = root.join("_mangaplaystudio").join("storyboard").join("foo").join(format!("{}.mangaart", uuid_a));
    let art_b = root.join("_mangaplaystudio").join("storyboard").join("qux").join(format!("{}.mangaart", uuid_b));
    assert!(art_a.exists(), "art a at {:?}", art_a);
    assert!(art_b.exists(), "art b at {:?}", art_b);

    let pj = read_project_json(root).expect("read project.json");
    assert_eq!(art_map_get(&pj, "foo/baz.mangaplay.md"), Some(uuid_a));
    assert_eq!(art_map_get(&pj, "qux/baz.mangaplay.md"), Some(uuid_b));
}

#[test]
fn idempotent_scaffold_returns_same_uuid_and_does_not_overwrite()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let first = mangaart_scaffold_impl(
        root.to_str().unwrap(),
        "Doc.mangaplay.md",
    )
    .expect("first scaffold");
    let first_uuid = first["uuid"].as_str().unwrap().to_string();
    let first_created = first["createdAt"].as_str().unwrap().to_string();

    let art_path = root.join("_mangaplaystudio").join("storyboard").join(format!("{}.mangaart", first_uuid));
    let raw_before = fs::read_to_string(&art_path).expect("read art file");

    let second = mangaart_scaffold_impl(
        root.to_str().unwrap(),
        "Doc.mangaplay.md",
    )
    .expect("second scaffold");
    let second_uuid = second["uuid"].as_str().unwrap().to_string();
    let second_created = second["createdAt"].as_str().unwrap().to_string();

    assert_eq!(first_uuid, second_uuid, "UUID must be reused on second call");
    assert_eq!(first_created, second_created, "createdAt must come from disk");

    let raw_after = fs::read_to_string(&art_path).expect("read art file again");
    assert_eq!(raw_before, raw_after, "art file must not be rewritten");
}

#[test]
fn recovers_when_map_entry_exists_but_file_missing()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    // Pre-seed: mapping points at a UUID, no art file on disk.
    let preset_uuid = mint_script_uuid();
    let mut pj = read_project_json(root).expect("read");
    art_map_set(&mut pj, "Recover.mangaplay.md", &preset_uuid);
    write_project_json(root, &pj).expect("write");

    let result = mangaart_scaffold_impl(
        root.to_str().unwrap(),
        "Recover.mangaplay.md",
    )
    .expect("scaffold ok");

    assert_eq!(
        result["uuid"].as_str().unwrap(),
        preset_uuid.as_str(),
        "must re-use the mapped UUID, not mint a fresh one"
    );

    let art_path = resolve_art_path(root, "Recover.mangaplay.md", &preset_uuid);
    assert!(art_path.exists(), "art file (re)created at {:?}", art_path);

    // The mapping must still point at the same UUID (not get rewritten).
    let pj_after = read_project_json(root).expect("read after");
    assert_eq!(art_map_get(&pj_after, "Recover.mangaplay.md"), Some(preset_uuid));
}

#[test]
fn errs_when_project_json_missing()
{
    let tmp = TempDir::new().expect("tempdir");
    // Note: no project.json seeded.

    let err = mangaart_scaffold_impl(
        tmp.path().to_str().unwrap(),
        "anything.mangaplay.md",
    )
    .expect_err("scaffold must err");

    assert_eq!(err, "project-json-missing");
    // And nothing got created.
    let app = tmp.path().join("_mangaplaystudio");
    assert!(!app.join("storyboard").exists(), "no storyboard/ on err");
    assert!(!app.join("project.json").exists(), "no project.json minted");
}

// ── mangaart_resolve_path_impl ───────────────────────────────────────────

#[test]
fn resolve_path_returns_mapped_path_when_present()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let uuid = mint_script_uuid();
    let mut pj = read_project_json(root).expect("read");
    art_map_set(&mut pj, "Untitled.mangaplay.md", &uuid);
    write_project_json(root, &pj).expect("write");

    let resolved = mangaart_resolve_path_impl(
        root.to_str().unwrap(),
        "Untitled.mangaplay.md",
    )
    .expect("resolve ok")
    .expect("path present");

    let expected = root.join("_mangaplaystudio").join("storyboard").join(format!("{}.mangaart", uuid));
    assert_eq!(resolved, expected.to_string_lossy().to_string());
}

#[test]
fn resolve_path_returns_none_when_no_map_entry()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let resolved = mangaart_resolve_path_impl(
        root.to_str().unwrap(),
        "no-such-script.mangaplay.md",
    )
    .expect("resolve ok");

    assert!(resolved.is_none(), "unmapped script must resolve to None");
}

#[test]
fn resolve_path_errs_when_project_json_missing()
{
    let tmp = TempDir::new().expect("tempdir");
    // Note: no project.json seeded.

    let err = mangaart_resolve_path_impl(
        tmp.path().to_str().unwrap(),
        "anything.mangaplay.md",
    )
    .expect_err("resolve must err");

    assert_eq!(err, "project-json-missing");
}

#[test]
fn resolve_path_handles_nested_script()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let uuid = mint_script_uuid();
    let script = "foo/bar/baz.mangaplay.md";
    let mut pj = read_project_json(root).expect("read");
    art_map_set(&mut pj, script, &uuid);
    write_project_json(root, &pj).expect("write");

    let resolved = mangaart_resolve_path_impl(root.to_str().unwrap(), script)
        .expect("resolve ok")
        .expect("path present");

    let expected = root
        .join("_mangaplaystudio")
        .join("storyboard")
        .join("foo")
        .join("bar")
        .join(format!("{}.mangaart", uuid));
    assert_eq!(resolved, expected.to_string_lossy().to_string());
}
