//! Integration tests for `fold_artmap_into_registry`
//! (artMap → registry UUID re-alignment on first project open).
//!
//! Covers the four documented behaviours of the artMap fold:
//!  1. realign — registry entry's UUID differs from artMap → re-key it.
//!  2. missing — artMap references a rel_path with no live entry → skip.
//!  3. aligned — artMap UUID already matches → no-op, no rev bump.
//!  4. invalid — artMap value isn't a UUID string → skip.

use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

use app_lib::{
    LoadedRegistry, NativeId, RegistryEntry, fold_artmap_into_registry,
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn fixed_uuid(seed: &str) -> Uuid
{
    let mut bytes = [0u8; 16];
    for (i, b) in seed.as_bytes().iter().enumerate()
    {
        bytes[i % 16] ^= *b;
    }
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    Uuid::from_bytes(bytes)
}

/// Build a registry pre-seeded with one file entry at `rel_path`, keyed
/// by `uuid`. `native_id` is stored on the entry and (when not
/// `NativeId::Unknown`) mirrored in the reverse index.
fn seed_registry_with_one_file(
    uuid: Uuid,
    rel_path: &str,
    native_id: NativeId,
) -> LoadedRegistry
{
    let mut entries = BTreeMap::new();
    entries.insert(
        uuid,
        RegistryEntry
        {
            native_id: native_id.clone(),
            path: rel_path.to_string(),
            kind: "file".to_string(),
            parent_uuid: None,
            rev: 3,
            tombstone: false,
            content_hash_head: None,
        },
    );
    let mut path_index = HashMap::new();
    path_index.insert(rel_path.to_string(), uuid);
    let mut native_id_index = HashMap::new();
    if !matches!(native_id, NativeId::Unknown)
    {
        native_id_index.insert(native_id.clone(), uuid);
    }
    LoadedRegistry
    {
        project_uuid: Uuid::new_v4(),
        root_path: std::path::PathBuf::from("/tmp/fold-test"),
        entries,
        native_id_index,
        path_index,
        dirty: false,
        last_save: Instant::now(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn fold_artmap_realigns_registry_uuid()
{
    let uuid_a = fixed_uuid("aaa-current");
    let uuid_b = fixed_uuid("bbb-artmap");
    let native = NativeId::Posix { dev: 1, ino: 42 };

    let mut reg = seed_registry_with_one_file(
        uuid_a,
        "foo.mangaplay.md",
        native.clone(),
    );

    let mut art_map = Map::new();
    art_map.insert(
        "foo.mangaplay.md".to_string(),
        Value::String(uuid_b.to_string()),
    );

    let n = fold_artmap_into_registry(&mut reg, &art_map).unwrap();
    assert_eq!(n, 1, "one entry migrated");

    assert!(
        reg.entries.contains_key(&uuid_b),
        "entry re-keyed under artmap uuid",
    );
    assert!(
        !reg.entries.contains_key(&uuid_a),
        "old uuid removed from entries",
    );

    let entry = &reg.entries[&uuid_b];
    assert_eq!(entry.path, "foo.mangaplay.md", "path preserved");
    assert_eq!(entry.native_id, native, "native_id preserved");
    assert_eq!(entry.kind, "file", "kind preserved");
    assert_eq!(entry.parent_uuid, None, "parent_uuid preserved");
    assert_eq!(entry.rev, 4, "rev bumped from 3 → 4");
    assert!(!entry.tombstone, "tombstone preserved (false)");

    assert!(reg.dirty, "fold marks the registry dirty");
    assert_eq!(
        reg.path_index.get("foo.mangaplay.md"),
        Some(&uuid_b),
        "path_index re-pointed at new uuid",
    );
}

#[test]
fn fold_artmap_skips_missing_files()
{
    let uuid_a = fixed_uuid("aaa-present");
    let uuid_b = fixed_uuid("bbb-artmap");

    let mut reg = seed_registry_with_one_file(
        uuid_a,
        "present.mangaplay.md",
        NativeId::Unknown,
    );

    let mut art_map = Map::new();
    // rel_path that is NOT in the registry — the file was deleted between
    // the artMap being written and this project open.
    art_map.insert(
        "gone.mangaplay.md".to_string(),
        Value::String(uuid_b.to_string()),
    );

    let n = fold_artmap_into_registry(&mut reg, &art_map).unwrap();
    assert_eq!(n, 0, "no migration for missing file");
    assert!(!reg.dirty, "no change → not dirty");
    assert!(
        reg.entries.contains_key(&uuid_a),
        "existing entry left untouched",
    );
}

#[test]
fn fold_artmap_skips_aligned_entries()
{
    let uuid_a = fixed_uuid("aligned");
    let mut reg = seed_registry_with_one_file(
        uuid_a,
        "foo.mangaplay.md",
        NativeId::Unknown,
    );
    let starting_rev = reg.entries[&uuid_a].rev;

    let mut art_map = Map::new();
    art_map.insert(
        "foo.mangaplay.md".to_string(),
        Value::String(uuid_a.to_string()),
    );

    let n = fold_artmap_into_registry(&mut reg, &art_map).unwrap();
    assert_eq!(n, 0, "aligned entries are no-ops");
    assert!(!reg.dirty, "aligned → not dirty");
    assert_eq!(
        reg.entries[&uuid_a].rev, starting_rev,
        "aligned → rev not bumped",
    );
}

#[test]
fn fold_artmap_skips_collision_with_existing_uuid()
{
    // Seed: entry X at pathA, entry Y at pathB. artMap says pathA → Y.
    // Folding must NOT clobber the entry already keyed under Y.
    let uuid_x = fixed_uuid("xxx-at-path-a");
    let uuid_y = fixed_uuid("yyy-at-path-b");
    let native_a = NativeId::Posix { dev: 1, ino: 10 };
    let native_b = NativeId::Posix { dev: 1, ino: 20 };

    let mut reg = seed_registry_with_one_file(
        uuid_x,
        "a.mangaplay.md",
        native_a.clone(),
    );
    // Splice a second entry directly so both live in the same registry.
    reg.entries.insert(
        uuid_y,
        RegistryEntry
        {
            native_id: native_b.clone(),
            path: "b.mangaplay.md".to_string(),
            kind: "file".to_string(),
            parent_uuid: None,
            rev: 5,
            tombstone: false,
            content_hash_head: None,
        },
    );
    reg.path_index.insert("b.mangaplay.md".to_string(), uuid_y);
    reg.native_id_index.insert(native_b.clone(), uuid_y);

    let starting_rev_x = reg.entries[&uuid_x].rev;
    let starting_rev_y = reg.entries[&uuid_y].rev;

    let mut art_map = Map::new();
    art_map.insert(
        "a.mangaplay.md".to_string(),
        Value::String(uuid_y.to_string()),
    );

    let n = fold_artmap_into_registry(&mut reg, &art_map).unwrap();
    assert_eq!(n, 0, "collision → no migration");
    assert!(!reg.dirty, "collision skip does not dirty the registry");

    assert!(
        reg.entries.contains_key(&uuid_x),
        "original entry X preserved",
    );
    assert!(
        reg.entries.contains_key(&uuid_y),
        "colliding entry Y preserved (NOT clobbered)",
    );
    assert_eq!(
        reg.entries[&uuid_x].rev, starting_rev_x,
        "X rev not bumped",
    );
    assert_eq!(
        reg.entries[&uuid_y].rev, starting_rev_y,
        "Y rev not bumped",
    );
    assert_eq!(
        reg.entries[&uuid_x].path, "a.mangaplay.md",
        "X path preserved",
    );
    assert_eq!(
        reg.entries[&uuid_y].path, "b.mangaplay.md",
        "Y path preserved",
    );
}

#[test]
fn fold_artmap_skips_invalid_uuid_strings()
{
    let uuid_a = fixed_uuid("aaa");
    let mut reg = seed_registry_with_one_file(
        uuid_a,
        "foo.mangaplay.md",
        NativeId::Unknown,
    );
    let starting_rev = reg.entries[&uuid_a].rev;

    let mut art_map = Map::new();
    // Non-UUID string.
    art_map.insert(
        "foo.mangaplay.md".to_string(),
        Value::String("not-a-uuid".to_string()),
    );
    // Non-string JSON value.
    art_map.insert(
        "other.mangaplay.md".to_string(),
        json!(42),
    );

    let n = fold_artmap_into_registry(&mut reg, &art_map).unwrap();
    assert_eq!(n, 0, "invalid values skipped");
    assert!(!reg.dirty);
    assert_eq!(reg.entries[&uuid_a].rev, starting_rev);
}
