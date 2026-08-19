//! Integration tests for the `registry-fs-changed` event payload.
//!
//! Focus: the pure `resolve_path_to_registry_change` helper. It does the
//! interesting mapping work — the `emit_registry_fs_changed` wrapper is
//! thin `AppHandle::emit` plumbing that isn't callable without a live
//! Tauri runtime, so we validate the payload shape via the helper here
//! and rely on the smoke test to cover the emit-through-Tauri path.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::time::Instant;

use app_lib::{
    FsChange, LoadedRegistry, NativeId, RegistryEntry, RegistryFsChange,
    resolve_path_to_registry_change,
};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn empty_registry_at(root: PathBuf) -> LoadedRegistry
{
    LoadedRegistry
    {
        project_uuid: Uuid::new_v4(),
        root_path: root,
        entries: BTreeMap::new(),
        native_id_index: HashMap::new(),
        path_index: HashMap::new(),
        dirty: false,
        last_save: Instant::now(),
    }
}

/// Insert a file entry into the registry at `rel_path` with the given rev
/// and return the minted UUID. Rebuilds indices at the tail so the caller
/// can immediately look up by path.
fn seed_entry(reg: &mut LoadedRegistry, rel_path: &str, rev: u64) -> Uuid
{
    let uuid = Uuid::new_v4();
    let native_id = NativeId::Posix
    {
        dev: 1,
        ino: (rel_path.len() as u64).wrapping_mul(31) + rev,
    };
    reg.entries.insert(
        uuid,
        RegistryEntry
        {
            native_id,
            path: rel_path.to_string(),
            kind: "file".to_string(),
            parent_uuid: None,
            rev,
            tombstone: false,
            content_hash_head: None,
        },
    );
    reg.rebuild_indices();
    uuid
}

/// Absolute path joining `root` with `rel` using the host separator.
fn abs_of(root: &std::path::Path, rel: &str) -> String
{
    root.join(rel).to_string_lossy().to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn resolve_created_returns_unknown()
{
    // Watcher fires Created BEFORE JS calls `registry_list_tree`; the
    // registry has no UUID for the new file yet. The helper must emit
    // `Unknown` so JS knows to refresh.
    let root = PathBuf::from("/tmp/project-a");
    let reg = empty_registry_at(root.clone());

    let change = FsChange::Created { path: abs_of(&root, "foo.md") };
    let out = resolve_path_to_registry_change(&reg, &abs_of(&root, "foo.md"), &change);

    match out
    {
        Some(RegistryFsChange::Unknown { rel_path }) =>
        {
            assert_eq!(rel_path, "foo.md");
        }
        other => panic!("expected Unknown, got {:?}", other),
    }
}

#[test]
fn resolve_created_dir_returns_unknown()
{
    // CreatedDir travels the same "no UUID yet" cascade as Created.
    let root = PathBuf::from("/tmp/project-cd");
    let reg = empty_registry_at(root.clone());

    let change = FsChange::CreatedDir { path: abs_of(&root, "chapter-1") };
    let out = resolve_path_to_registry_change(&reg, &abs_of(&root, "chapter-1"), &change);

    match out
    {
        Some(RegistryFsChange::Unknown { rel_path }) =>
        {
            assert_eq!(rel_path, "chapter-1");
        }
        other => panic!("expected Unknown, got {:?}", other),
    }
}

#[test]
fn resolve_modified_known_path_returns_modified_with_uuid()
{
    let root = PathBuf::from("/tmp/project-b");
    let mut reg = empty_registry_at(root.clone());
    let uuid = seed_entry(&mut reg, "known.md", 7);

    let abs = abs_of(&root, "known.md");
    let change = FsChange::Modified { path: abs.clone() };
    let out = resolve_path_to_registry_change(&reg, &abs, &change);

    match out
    {
        Some(RegistryFsChange::Modified { uuid: u, rel_path, rev }) =>
        {
            assert_eq!(u, uuid.to_string());
            assert_eq!(rel_path, "known.md");
            assert_eq!(rev, 7);
        }
        other => panic!("expected Modified, got {:?}", other),
    }
}

#[test]
fn resolve_modified_unknown_path_returns_unknown()
{
    let root = PathBuf::from("/tmp/project-c");
    let reg = empty_registry_at(root.clone());

    let abs = abs_of(&root, "never-seen.md");
    let change = FsChange::Modified { path: abs.clone() };
    let out = resolve_path_to_registry_change(&reg, &abs, &change);

    match out
    {
        Some(RegistryFsChange::Unknown { rel_path }) =>
        {
            assert_eq!(rel_path, "never-seen.md");
        }
        other => panic!("expected Unknown, got {:?}", other),
    }
}

#[test]
fn resolve_deleted_known_path_returns_deleted()
{
    let root = PathBuf::from("/tmp/project-d");
    let mut reg = empty_registry_at(root.clone());
    let uuid = seed_entry(&mut reg, "gone.md", 3);

    let abs = abs_of(&root, "gone.md");
    let out = resolve_path_to_registry_change(&reg, &abs, &FsChange::Deleted);

    match out
    {
        Some(RegistryFsChange::Deleted { uuid: u, rel_path }) =>
        {
            assert_eq!(u, uuid.to_string());
            assert_eq!(rel_path, "gone.md");
        }
        other => panic!("expected Deleted, got {:?}", other),
    }
}

#[test]
fn resolve_deleted_unknown_path_returns_unknown()
{
    let root = PathBuf::from("/tmp/project-du");
    let reg = empty_registry_at(root.clone());

    let abs = abs_of(&root, "never-existed.md");
    let out = resolve_path_to_registry_change(&reg, &abs, &FsChange::Deleted);

    match out
    {
        Some(RegistryFsChange::Unknown { rel_path }) =>
        {
            assert_eq!(rel_path, "never-existed.md");
        }
        other => panic!("expected Unknown, got {:?}", other),
    }
}

#[test]
fn resolve_renamed_known_old_path_returns_renamed()
{
    // Post-3c.ii-fix: this matches the ACTUAL watcher-emitted shape —
    // `path` is the OLD absolute path (registry `path_index` key), and
    // `FsChange::Renamed { to }` carries the NEW absolute path.
    // Before the fix, `map_notify_event` was emitting NEW in both slots,
    // so this test was passing on a scenario the watcher never actually
    // produced. See `renamed_from_watcher_input_shape_resolves_uuid`
    // below for the same expectation named to emphasise that.
    let root = PathBuf::from("/tmp/project-e");
    let mut reg = empty_registry_at(root.clone());
    let uuid = seed_entry(&mut reg, "old.md", 4);

    let abs_old = abs_of(&root, "old.md");
    let abs_new = abs_of(&root, "new.md");
    let change = FsChange::Renamed { to: abs_new };
    let out = resolve_path_to_registry_change(&reg, &abs_old, &change);

    match out
    {
        Some(RegistryFsChange::Renamed { uuid: u, rel_path, new_name, rev }) =>
        {
            assert_eq!(u, uuid.to_string());
            assert_eq!(rel_path, "old.md");
            assert_eq!(new_name, "new.md");
            assert_eq!(rev, 4);
        }
        other => panic!("expected Renamed, got {:?}", other),
    }
}

#[test]
fn renamed_from_watcher_input_shape_resolves_uuid()
{
    // KEY test: feeds the resolver EXACTLY what `map_notify_event` produces —
    // `path = OLD_absolute_path`, `change = FsChange::Renamed { to: NEW_absolute_path }`.
    // Before the fix, the watcher emitted NEW in the outer slot, so this call
    // would have gone to the `Unknown` fallback because `path_index` is keyed
    // by OLD paths and had no entry at NEW.
    let root = PathBuf::from("/tmp/project-watcher-shape");
    let mut reg = empty_registry_at(root.clone());
    let uuid = seed_entry(&mut reg, "chapter-1/scene-a.md", 9);

    let abs_old = abs_of(&root, "chapter-1/scene-a.md");
    let abs_new = abs_of(&root, "chapter-1/scene-b.md");

    // This is the exact tuple shape emitted by `map_notify_event`.
    let change = FsChange::Renamed { to: abs_new };
    let out = resolve_path_to_registry_change(&reg, &abs_old, &change);

    match out
    {
        Some(RegistryFsChange::Renamed { uuid: u, rel_path, new_name, rev }) =>
        {
            assert_eq!(u, uuid.to_string(),
                "watcher-shape rename must resolve to the OLD path's UUID");
            assert_eq!(rel_path, "chapter-1/scene-a.md");
            assert_eq!(new_name, "scene-b.md");
            assert_eq!(rev, 9);
        }
        other => panic!(
            "expected Renamed (watcher-shape must resolve UUID via OLD path lookup), got {:?}",
            other
        ),
    }
}

#[test]
fn resolve_handles_no_project_loaded_via_empty_registry()
{
    // `emit_registry_fs_changed`'s fallback path when no project is
    // loaded emits `Unknown { rel_path }` without panicking. The pure
    // resolver already handles the reg-not-loaded case at the call site
    // (the emitter constructs the fallback envelope directly). We assert
    // here that an empty `LoadedRegistry` (zero entries, empty
    // `path_index`) still resolves cleanly to `Unknown` for every
    // watcher-emitted change kind — no panic on any variant.
    let root = PathBuf::from("/tmp/project-empty");
    let reg = empty_registry_at(root.clone());

    let abs = abs_of(&root, "some/path.md");

    // Modified — must fall back to Unknown.
    match resolve_path_to_registry_change(
        &reg,
        &abs,
        &FsChange::Modified { path: abs.clone() },
    )
    {
        Some(RegistryFsChange::Unknown { rel_path }) =>
        {
            assert_eq!(rel_path, "some/path.md");
        }
        other => panic!("expected Unknown for empty registry Modified, got {:?}", other),
    }

    // Deleted — must fall back to Unknown.
    match resolve_path_to_registry_change(&reg, &abs, &FsChange::Deleted)
    {
        Some(RegistryFsChange::Unknown { rel_path }) =>
        {
            assert_eq!(rel_path, "some/path.md");
        }
        other => panic!("expected Unknown for empty registry Deleted, got {:?}", other),
    }

    // Renamed — must fall back to Unknown.
    let abs_new = abs_of(&root, "some/new.md");
    match resolve_path_to_registry_change(
        &reg,
        &abs,
        &FsChange::Renamed { to: abs_new },
    )
    {
        Some(RegistryFsChange::Unknown { rel_path }) =>
        {
            assert_eq!(rel_path, "some/path.md");
        }
        other => panic!("expected Unknown for empty registry Renamed, got {:?}", other),
    }
}

#[test]
fn resolve_renamed_unknown_old_path_returns_unknown()
{
    let root = PathBuf::from("/tmp/project-eu");
    let reg = empty_registry_at(root.clone());

    let abs_old = abs_of(&root, "old-unknown.md");
    let abs_new = abs_of(&root, "new-unknown.md");
    let change = FsChange::Renamed { to: abs_new };
    let out = resolve_path_to_registry_change(&reg, &abs_old, &change);

    match out
    {
        Some(RegistryFsChange::Unknown { rel_path }) =>
        {
            assert_eq!(rel_path, "old-unknown.md");
        }
        other => panic!("expected Unknown, got {:?}", other),
    }
}

#[test]
fn resolve_copied_returns_unknown_with_new_path()
{
    let root = PathBuf::from("/tmp/project-cp");
    let mut reg = empty_registry_at(root.clone());
    // Even with the source registered, Copied points at a brand-new
    // destination — no UUID yet.
    let _ = seed_entry(&mut reg, "src.md", 1);

    let abs_src = abs_of(&root, "src.md");
    let abs_dst = abs_of(&root, "dst.md");
    let change = FsChange::Copied { to: abs_dst };
    let out = resolve_path_to_registry_change(&reg, &abs_src, &change);

    match out
    {
        Some(RegistryFsChange::Unknown { rel_path }) =>
        {
            assert_eq!(rel_path, "dst.md",
                "Copied must carry the DESTINATION path so JS refreshes at the right spot");
        }
        other => panic!("expected Unknown, got {:?}", other),
    }
}

#[test]
fn serde_uses_kebab_case_field_names()
{
    // Renamed carries `new_name` (a multi-word field) — assert the
    // emitted JSON key is `new-name`, not `new_name` or `newName`.
    let variant = RegistryFsChange::Renamed
    {
        uuid: "018f4c2e-a1b2-4000-8000-000000000001".to_string(),
        rel_path: "chapter-1/intro.md".to_string(),
        new_name: "outro.md".to_string(),
        rev: 12,
    };
    let json = serde_json::to_value(&variant).expect("serialize Renamed");

    assert_eq!(json.get("change").and_then(|v| v.as_str()), Some("renamed"),
        "enum tag serialises as kebab-case variant name");
    assert!(json.get("new-name").is_some(),
        "new_name field emits with kebab-case key, got: {}", json);
    assert!(json.get("new_name").is_none(),
        "underscore key must NOT appear, got: {}", json);
    assert_eq!(json.get("new-name").and_then(|v| v.as_str()), Some("outro.md"));
    assert!(json.get("rel-path").is_some(), "rel_path emits kebab, got: {}", json);
    assert_eq!(json.get("rev").and_then(|v| v.as_u64()), Some(12));
}

#[test]
fn serde_created_variant_has_all_kebab_keys()
{
    let variant = RegistryFsChange::Created
    {
        uuid: "018f4c2e-a1b2-4000-8000-000000000002".to_string(),
        parent_uuid: Some("018f4c2e-a1b2-4000-8000-000000000003".to_string()),
        name: "hero.md".to_string(),
        rel_path: "chapter-1/hero.md".to_string(),
        rev: 1,
        kind: "file".to_string(),
    };
    let json = serde_json::to_value(&variant).expect("serialize Created");

    assert_eq!(json.get("change").and_then(|v| v.as_str()), Some("created"));
    assert!(json.get("parent-uuid").is_some(),
        "parent_uuid emits as parent-uuid, got: {}", json);
    assert!(json.get("parent_uuid").is_none());
    assert!(json.get("rel-path").is_some());
    assert!(json.get("uuid").is_some(), "single-word field stays as `uuid`");
    assert!(json.get("name").is_some(), "single-word field stays as `name`");
    assert!(json.get("kind").is_some(), "single-word field stays as `kind`");
    assert!(json.get("rev").is_some(), "single-word field stays as `rev`");
}

#[test]
fn serde_moved_variant_has_kebab_keys()
{
    let variant = RegistryFsChange::Moved
    {
        uuid: "018f4c2e-a1b2-4000-8000-000000000004".to_string(),
        rel_path: "chapter-2/moved.md".to_string(),
        new_parent_uuid: Some("018f4c2e-a1b2-4000-8000-000000000005".to_string()),
        rev: 8,
    };
    let json = serde_json::to_value(&variant).expect("serialize Moved");

    assert_eq!(json.get("change").and_then(|v| v.as_str()), Some("moved"));
    assert!(json.get("new-parent-uuid").is_some(),
        "new_parent_uuid emits as new-parent-uuid, got: {}", json);
    assert!(json.get("new_parent_uuid").is_none());
}

#[test]
fn serde_unknown_variant_shape()
{
    let variant = RegistryFsChange::Unknown { rel_path: "foo/bar.md".to_string() };
    let json = serde_json::to_value(&variant).expect("serialize Unknown");

    assert_eq!(json.get("change").and_then(|v| v.as_str()), Some("unknown"));
    assert_eq!(json.get("rel-path").and_then(|v| v.as_str()), Some("foo/bar.md"));
    // Sanity: no stray fields.
    let obj = json.as_object().unwrap();
    assert_eq!(obj.len(), 2, "Unknown has exactly change + rel-path, got: {}", json);
}

#[test]
#[cfg(windows)]
fn windows_backslash_path_normalizes_to_forward_slash()
{
    // Native separators — real watcher payload shape on Windows.
    let root = PathBuf::from("C:\\project");
    let mut reg = empty_registry_at(root.clone());
    let uuid = seed_entry(&mut reg, "chapter-1/intro.md", 2);

    let abs = "C:\\project\\chapter-1\\intro.md".to_string();
    let out = resolve_path_to_registry_change(&reg, &abs, &FsChange::Modified { path: abs.clone() });

    match out
    {
        Some(RegistryFsChange::Modified { uuid: u, rel_path, rev }) =>
        {
            assert_eq!(u, uuid.to_string());
            assert_eq!(rel_path, "chapter-1/intro.md",
                "backslash paths must normalise to forward-slash rel paths");
            assert_eq!(rev, 2);
        }
        other => panic!("expected Modified, got {:?}", other),
    }
}

#[test]
#[cfg(not(windows))]
fn linux_forward_slash_path_normalizes_cleanly()
{
    // On non-Windows, the watcher already hands us forward-slash paths.
    // Still verify the strip + join is a no-op transform.
    let root = PathBuf::from("/tmp/project-lin");
    let mut reg = empty_registry_at(root.clone());
    let uuid = seed_entry(&mut reg, "chapter-1/intro.md", 5);

    let abs = "/tmp/project-lin/chapter-1/intro.md".to_string();
    let out = resolve_path_to_registry_change(&reg, &abs, &FsChange::Modified { path: abs.clone() });

    match out
    {
        Some(RegistryFsChange::Modified { uuid: u, rel_path, rev }) =>
        {
            assert_eq!(u, uuid.to_string());
            assert_eq!(rel_path, "chapter-1/intro.md");
            assert_eq!(rev, 5);
        }
        other => panic!("expected Modified, got {:?}", other),
    }
}

#[test]
fn resolve_rename_with_backslash_in_new_path_gets_clean_basename()
{
    // The `to` field on Windows would contain backslashes; basename_of
    // must strip them and yield a clean file name.
    let root = PathBuf::from("/tmp/project-rb");
    let mut reg = empty_registry_at(root.clone());
    let uuid = seed_entry(&mut reg, "old.md", 1);

    let abs_old = abs_of(&root, "old.md");
    // Simulate a Windows-style destination.
    let win_style_to = "C:\\project-rb\\subdir\\new.md".to_string();
    let change = FsChange::Renamed { to: win_style_to };
    let out = resolve_path_to_registry_change(&reg, &abs_old, &change);

    match out
    {
        Some(RegistryFsChange::Renamed { new_name, uuid: u, .. }) =>
        {
            assert_eq!(new_name, "new.md",
                "basename must strip backslash-separated path components");
            assert_eq!(u, uuid.to_string());
        }
        other => panic!("expected Renamed, got {:?}", other),
    }
}
