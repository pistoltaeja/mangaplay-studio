//! Unit tests for the storyboard-relocation helpers in `lib.rs`:
//! `resolve_art_path`, `mint_script_uuid`, `art_map_get`, `art_map_set`,
//! `art_map_drop`, `art_map_rewrite_prefix`, `art_map_drop_prefix`.
//!
//! Previously an inline `#[cfg(test)] mod art_relocation_tests` in
//! `src/lib.rs`. Moved here so the public-surface helpers are exercised
//! the same way every other helper in the crate is — via the test crate
//! that links `app_lib` as an external dependency.

use app_lib::{
    art_map_drop, art_map_drop_prefix, art_map_get, art_map_rewrite_prefix,
    art_map_set, mint_script_uuid, resolve_art_path,
};
use std::path::Path;

// -- resolve_art_path -----------------------------------------------------

#[test]
fn resolve_art_path_root_level_script()
{
    let root = Path::new("/proj");
    let got = resolve_art_path(root, "baz.mangaplay.md", "abc-uuid");
    assert_eq!(got, Path::new("/proj/_mangaplaystudio/storyboard/abc-uuid.mangaart"));
}

#[test]
fn resolve_art_path_nested_script()
{
    let root = Path::new("/proj");
    let got = resolve_art_path(root, "foo/baz.mangaplay.md", "abc-uuid");
    assert_eq!(got, Path::new("/proj/_mangaplaystudio/storyboard/foo/abc-uuid.mangaart"));
}

#[test]
fn resolve_art_path_deeply_nested_script()
{
    let root = Path::new("/proj");
    let got = resolve_art_path(
        root,
        "ch1/scene2/page3/baz.mangaplay.md",
        "deadbeef",
    );
    assert_eq!(
        got,
        Path::new("/proj/_mangaplaystudio/storyboard/ch1/scene2/page3/deadbeef.mangaart"),
    );
}

// -- art_map_get ----------------------------------------------------------

#[test]
fn art_map_get_returns_none_when_artmap_absent()
{
    let pj = serde_json::json!({ "id": "x", "displayName": "y" });
    assert_eq!(art_map_get(&pj, "foo/a.md"), None);
}

#[test]
fn art_map_get_returns_none_when_key_absent()
{
    let pj = serde_json::json!({
        "artMap": { "scripts": { "foo/a.md": "u1" } }
    });
    assert_eq!(art_map_get(&pj, "missing/b.md"), None);
}

#[test]
fn art_map_get_returns_uuid_when_present()
{
    let pj = serde_json::json!({
        "artMap": { "scripts": { "foo/a.md": "u1" } }
    });
    assert_eq!(art_map_get(&pj, "foo/a.md").as_deref(), Some("u1"));
}

// -- art_map_set ----------------------------------------------------------

#[test]
fn art_map_set_creates_section_when_missing()
{
    let mut pj = serde_json::json!({ "id": "x" });
    art_map_set(&mut pj, "foo/a.md", "u1");
    assert_eq!(
        pj["artMap"]["scripts"]["foo/a.md"].as_str(),
        Some("u1"),
    );
    // Existing keys untouched.
    assert_eq!(pj["id"].as_str(), Some("x"));
}

#[test]
fn art_map_set_overwrites_existing()
{
    let mut pj = serde_json::json!({
        "artMap": { "scripts": { "foo/a.md": "u1" } }
    });
    art_map_set(&mut pj, "foo/a.md", "u2");
    assert_eq!(
        pj["artMap"]["scripts"]["foo/a.md"].as_str(),
        Some("u2"),
    );
}

// -- art_map_drop ---------------------------------------------------------

#[test]
fn art_map_drop_removes_existing_key()
{
    let mut pj = serde_json::json!({
        "artMap": { "scripts": { "foo/a.md": "u1", "foo/b.md": "u2" } }
    });
    art_map_drop(&mut pj, "foo/a.md");
    assert!(pj["artMap"]["scripts"].get("foo/a.md").is_none());
    assert_eq!(
        pj["artMap"]["scripts"]["foo/b.md"].as_str(),
        Some("u2"),
    );
}

#[test]
fn art_map_drop_noop_when_key_missing()
{
    let mut pj = serde_json::json!({
        "artMap": { "scripts": { "foo/a.md": "u1" } }
    });
    art_map_drop(&mut pj, "nope/x.md");
    assert_eq!(
        pj["artMap"]["scripts"]["foo/a.md"].as_str(),
        Some("u1"),
    );
}

#[test]
fn art_map_drop_noop_when_section_absent()
{
    let mut pj = serde_json::json!({ "id": "x" });
    art_map_drop(&mut pj, "foo/a.md");
    assert!(pj.get("artMap").is_none());
}

// -- art_map_rewrite_prefix -----------------------------------------------

#[test]
fn art_map_rewrite_prefix_renames_subtree()
{
    let mut pj = serde_json::json!({
        "artMap": { "scripts": {
            "foo/a.md": "u1",
            "foo/bar/b.md": "u2",
            "foobar/c.md": "u3",
            "other/d.md": "u4",
        }}
    });
    art_map_rewrite_prefix(&mut pj, "foo", "qux");

    let scripts = pj["artMap"]["scripts"].as_object().unwrap();
    assert_eq!(scripts.get("qux/a.md").and_then(|v| v.as_str()), Some("u1"));
    assert_eq!(
        scripts.get("qux/bar/b.md").and_then(|v| v.as_str()),
        Some("u2"),
    );
    // Partial-name collision NOT rewritten.
    assert_eq!(
        scripts.get("foobar/c.md").and_then(|v| v.as_str()),
        Some("u3"),
    );
    // Unrelated entry untouched.
    assert_eq!(
        scripts.get("other/d.md").and_then(|v| v.as_str()),
        Some("u4"),
    );
    // Old keys gone.
    assert!(scripts.get("foo/a.md").is_none());
    assert!(scripts.get("foo/bar/b.md").is_none());
}

#[test]
fn art_map_rewrite_prefix_noop_when_unchanged()
{
    let mut pj = serde_json::json!({
        "artMap": { "scripts": { "foo/a.md": "u1" } }
    });
    art_map_rewrite_prefix(&mut pj, "foo", "foo");
    assert_eq!(
        pj["artMap"]["scripts"]["foo/a.md"].as_str(),
        Some("u1"),
    );
}

#[test]
fn art_map_rewrite_prefix_noop_when_section_absent()
{
    let mut pj = serde_json::json!({ "id": "x" });
    art_map_rewrite_prefix(&mut pj, "foo", "qux");
    assert!(pj.get("artMap").is_none());
}

// -- art_map_drop_prefix --------------------------------------------------

#[test]
fn art_map_drop_prefix_removes_subtree_only()
{
    let mut pj = serde_json::json!({
        "artMap": { "scripts": {
            "foo/a.md": "u1",
            "foo/bar/b.md": "u2",
            "foobar/c.md": "u3",
            "other/d.md": "u4",
        }}
    });
    art_map_drop_prefix(&mut pj, "foo");

    let scripts = pj["artMap"]["scripts"].as_object().unwrap();
    assert!(scripts.get("foo/a.md").is_none());
    assert!(scripts.get("foo/bar/b.md").is_none());
    // Partial-name collision survives.
    assert_eq!(
        scripts.get("foobar/c.md").and_then(|v| v.as_str()),
        Some("u3"),
    );
    assert_eq!(
        scripts.get("other/d.md").and_then(|v| v.as_str()),
        Some("u4"),
    );
}

// -- mint_script_uuid -----------------------------------------------------

#[test]
fn mint_script_uuid_returns_v4_format()
{
    let s = mint_script_uuid();
    assert_eq!(s.len(), 36, "uuid must be 36 chars: {}", s);
    assert_eq!(
        s.chars().filter(|c| *c == '-').count(),
        4,
        "uuid must have 4 hyphens: {}",
        s,
    );
    let version = s.chars().nth(14).expect("uuid version nibble");
    assert_eq!(version, '4', "uuid must be v4: {}", s);
    // Lowercase only.
    assert_eq!(s, s.to_lowercase(), "uuid must be lowercase: {}", s);
}
