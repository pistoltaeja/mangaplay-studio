//! Integration tests for `script_map` helpers + `scriptmap_get_or_mint_impl`
//! (TODO/script-uuid-registry.md).
//!
//! Covers: pure-function shape, legacy artMap pull-forward, concurrent
//! mint under the per-project lock.

use app_lib::{
    art_map_set, locks::ProjectJsonLocks, read_project_json, script_map_drop,
    script_map_drop_prefix, script_map_get, script_map_get_or_mint,
    script_map_get_with_legacy_pullforward, script_map_rewrite_key,
    script_map_rewrite_prefix, script_map_set, scriptmap_get_or_mint_impl,
    write_project_json,
};
use std::path::Path;
use std::sync::{Arc, Barrier};
use std::thread;
use tempfile::TempDir;

fn seed_project_json(root: &Path)
{
    let pj = serde_json::json!({
        "id": "test-project-id",
        "createdAt": "2026-01-01T00:00:00Z",
    });
    write_project_json(root, &pj).expect("seed project.json");
}

fn is_uuid_v4(s: &str) -> bool
{
    s.len() == 36
        && s.chars().filter(|c| *c == '-').count() == 4
        && s.chars().nth(14) == Some('4')
}

// ── pure helpers ──────────────────────────────────────────────────────────

#[test]
fn set_then_get_returns_uuid()
{
    let mut pj = serde_json::json!({});
    script_map_set(&mut pj, "Foo.txt", "abc-uuid");
    assert_eq!(script_map_get(&pj, "Foo.txt"), Some("abc-uuid".into()));
}

#[test]
fn get_returns_none_when_section_missing()
{
    let pj = serde_json::json!({});
    assert_eq!(script_map_get(&pj, "Foo.txt"), None);
}

#[test]
fn drop_removes_key()
{
    let mut pj = serde_json::json!({});
    script_map_set(&mut pj, "Foo.txt", "abc");
    script_map_drop(&mut pj, "Foo.txt");
    assert_eq!(script_map_get(&pj, "Foo.txt"), None);
}

#[test]
fn rewrite_key_moves_entry()
{
    let mut pj = serde_json::json!({});
    script_map_set(&mut pj, "Old/Foo.txt", "abc");
    script_map_rewrite_key(&mut pj, "Old/Foo.txt", "New/Foo.txt");
    assert_eq!(script_map_get(&pj, "Old/Foo.txt"), None);
    assert_eq!(script_map_get(&pj, "New/Foo.txt"), Some("abc".into()));
}

#[test]
fn rewrite_prefix_moves_subtree_only()
{
    let mut pj = serde_json::json!({});
    script_map_set(&mut pj, "Chapter_1/a.txt", "u1");
    script_map_set(&mut pj, "Chapter_1/b.txt", "u2");
    script_map_set(&mut pj, "Chapter_10/c.txt", "u3"); // prefix-collision sentinel

    script_map_rewrite_prefix(&mut pj, "Chapter_1", "Renamed");

    assert_eq!(script_map_get(&pj, "Renamed/a.txt"), Some("u1".into()));
    assert_eq!(script_map_get(&pj, "Renamed/b.txt"), Some("u2".into()));
    // Chapter_10 must NOT have been touched (partial-name collision guard).
    assert_eq!(script_map_get(&pj, "Chapter_10/c.txt"), Some("u3".into()));
}

#[test]
fn drop_prefix_removes_subtree_only()
{
    let mut pj = serde_json::json!({});
    script_map_set(&mut pj, "Chapter_1/a.txt", "u1");
    script_map_set(&mut pj, "Chapter_10/b.txt", "u2");

    script_map_drop_prefix(&mut pj, "Chapter_1");

    assert_eq!(script_map_get(&pj, "Chapter_1/a.txt"), None);
    assert_eq!(script_map_get(&pj, "Chapter_10/b.txt"), Some("u2".into()));
}

// ── legacy fallback ───────────────────────────────────────────────────────

#[test]
fn pullforward_copies_legacy_artmap_entry()
{
    let mut pj = serde_json::json!({});
    art_map_set(&mut pj, "Foo.txt", "legacy-uuid");

    let uuid = script_map_get_with_legacy_pullforward(&mut pj, "Foo.txt");
    assert_eq!(uuid, Some("legacy-uuid".into()));

    // After pull-forward, the entry sits in scriptMap.
    assert_eq!(script_map_get(&pj, "Foo.txt"), Some("legacy-uuid".into()));
}

#[test]
fn get_or_mint_reuses_legacy_artmap_uuid()
{
    let mut pj = serde_json::json!({});
    art_map_set(&mut pj, "Foo.txt", "legacy-uuid");

    let (uuid, minted) = script_map_get_or_mint(&mut pj, "Foo.txt");
    assert_eq!(uuid, "legacy-uuid");
    assert!(minted, "pull-forward is a mutation; caller must persist");
    assert_eq!(script_map_get(&pj, "Foo.txt"), Some("legacy-uuid".into()));
}

#[test]
fn get_or_mint_mints_fresh_when_no_entry()
{
    let mut pj = serde_json::json!({});

    let (uuid, minted) = script_map_get_or_mint(&mut pj, "New.txt");
    assert!(minted);
    assert!(is_uuid_v4(&uuid), "expected uuid v4, got {uuid}");
}

#[test]
fn get_or_mint_idempotent_after_mint()
{
    let mut pj = serde_json::json!({});

    let (uuid_a, _) = script_map_get_or_mint(&mut pj, "Foo.txt");
    let (uuid_b, minted_b) = script_map_get_or_mint(&mut pj, "Foo.txt");

    assert_eq!(uuid_a, uuid_b);
    assert!(!minted_b, "second call must NOT mint");
}

// ── scriptmap_get_or_mint_impl through the lock ───────────────────────────

#[test]
fn impl_mints_and_persists_under_lock()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let locks = ProjectJsonLocks::global();
    let res = scriptmap_get_or_mint_impl(
        &locks,
        root.to_str().unwrap(),
        "Foo.txt",
    )
    .expect("mint ok");

    assert!(res.minted);
    assert!(is_uuid_v4(&res.uuid));
    // Returned project_json reflects the in-memory state.
    assert_eq!(
        script_map_get(&res.project_json, "Foo.txt"),
        Some(res.uuid.clone()),
    );
    // On-disk state matches.
    let pj_disk = read_project_json(root).expect("re-read");
    assert_eq!(script_map_get(&pj_disk, "Foo.txt"), Some(res.uuid.clone()));
}

#[test]
fn impl_idempotent_no_second_write()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();
    seed_project_json(root);

    let locks = ProjectJsonLocks::global();
    let first = scriptmap_get_or_mint_impl(
        &locks,
        root.to_str().unwrap(),
        "Foo.txt",
    )
    .expect("first ok");

    let second = scriptmap_get_or_mint_impl(
        &locks,
        root.to_str().unwrap(),
        "Foo.txt",
    )
    .expect("second ok");

    assert_eq!(first.uuid, second.uuid);
    assert!(!second.minted, "second call must not mint");
}

// ── concurrent mint under the lock ────────────────────────────────────────

#[test]
fn concurrent_get_or_mint_single_uuid()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path().to_path_buf();
    seed_project_json(&root);

    let thread_count = 10;
    let barrier = Arc::new(Barrier::new(thread_count));
    let mut handles = Vec::with_capacity(thread_count);

    for _ in 0..thread_count
    {
        let root = root.clone();
        let barrier = barrier.clone();
        handles.push(thread::spawn(move || {
            barrier.wait();
            let locks = ProjectJsonLocks::global();
            scriptmap_get_or_mint_impl(
                &locks,
                root.to_str().unwrap(),
                "Shared.txt",
            )
            .expect("mint ok")
            .uuid
        }));
    }

    let uuids: Vec<String> = handles
        .into_iter()
        .map(|h| h.join().expect("thread join"))
        .collect();

    let first = &uuids[0];
    assert!(is_uuid_v4(first), "first uuid must be valid v4: {first}");
    assert!(
        uuids.iter().all(|u| u == first),
        "all 10 concurrent mints must return same UUID, got {:?}",
        uuids,
    );

    // And on disk we have exactly one entry.
    let pj = read_project_json(&root).expect("re-read");
    assert_eq!(script_map_get(&pj, "Shared.txt"), Some(first.clone()));
}
