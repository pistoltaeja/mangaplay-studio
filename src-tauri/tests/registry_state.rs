//! Integration tests for `ProjectRegistryState`.
//!
//! Covers: fresh-project synthesis on `NotFound`, index population on load,
//! flush semantics (dirty vs clean), replace-on-second-load, and the
//! `no-project-open` error path.

use std::collections::BTreeMap;
use std::fs;

use app_lib::{
    LoadedRegistry, NativeId, ProjectRegistryState, RegistryEntry, RegistryFile,
    registry_save_atomic,
};
use tempfile::TempDir;
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

fn sample_ntfs(file_id: &str) -> NativeId
{
    NativeId::Ntfs
    {
        volume_serial: 0xDEADBEEF,
        file_id: file_id.to_string(),
    }
}

/// Snapshot of what a fixture wrote. Lets tests probe the exact
/// native-IDs / paths / project_uuid a given seed produced without
/// hard-coding constants.
struct SeedFixture
{
    uuid_a: Uuid,
    uuid_b: Uuid,
    project_uuid: Uuid,
    native_id_a: NativeId,
    native_id_b: NativeId,
    path_a: String,
    path_b: String,
}

/// Build a two-entry registry and persist it to `<root>/_mangaplaystudio/registry.json`
/// via the `save_atomic` API. Returns a [`SeedFixture`] describing
/// exactly what was written.
/// `seed_prefix` disambiguates entries between fixtures used in the same test
/// so we can assert a second load truly replaced the first.
fn seed_registry_on_disk_with_prefix(
    root: &std::path::Path,
    seed_prefix: &str,
) -> SeedFixture
{
    let a = fixed_uuid(&format!("{}-a", seed_prefix));
    let b = fixed_uuid(&format!("{}-b", seed_prefix));
    let project_uuid = fixed_uuid(&format!("{}-proj", seed_prefix));

    // Per-prefix native IDs + paths so two fixtures in one test don't collide.
    let native_id_a = sample_ntfs(&format!("0x{}-A", seed_prefix));
    let native_id_b = NativeId::Posix
    {
        dev: 7,
        ino: (seed_prefix.len() as u64).wrapping_mul(100) + 42,
    };
    let path_a = format!("{}/chapter-1/intro.mangaplay.md", seed_prefix);
    let path_b = format!("{}/chapter-2", seed_prefix);

    let mut entries: BTreeMap<String, RegistryEntry> = BTreeMap::new();
    entries.insert(
        a.to_string(),
        RegistryEntry
        {
            native_id: native_id_a.clone(),
            path: path_a.clone(),
            kind: "file".to_string(),
            parent_uuid: None,
            rev: 3,
            tombstone: false,
            content_hash_head: None,
        },
    );
    entries.insert(
        b.to_string(),
        RegistryEntry
        {
            native_id: native_id_b.clone(),
            path: path_b.clone(),
            kind: "folder".to_string(),
            parent_uuid: None,
            rev: 1,
            tombstone: false,
            content_hash_head: None,
        },
    );

    let file = RegistryFile
    {
        version: 2,
        project_uuid,
        entries,
    };
    registry_save_atomic(root, &file).expect("save_atomic seeded fixture");

    SeedFixture
    {
        uuid_a: a,
        uuid_b: b,
        project_uuid,
        native_id_a,
        native_id_b,
        path_a,
        path_b,
    }
}

/// Convenience wrapper — default seed prefix `state` for the tests that
/// don't need to disambiguate. Returns just the two entry UUIDs to match
/// the original two-tuple call sites.
fn seed_registry_on_disk(root: &std::path::Path) -> (Uuid, Uuid)
{
    let f = seed_registry_on_disk_with_prefix(root, "state");
    (f.uuid_a, f.uuid_b)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn load_for_missing_creates_fresh()
{
    let td = TempDir::new().unwrap();
    let state = ProjectRegistryState::new();

    state.load_for(td.path()).expect("load_for on empty dir");

    state
        .with_loaded(|reg: &mut LoadedRegistry|
        {
            assert!(reg.entries.is_empty(), "fresh registry has no entries");
            assert!(reg.dirty, "fresh registry is dirty so first flush persists");
            assert_eq!(reg.root_path, td.path());
            // `project_uuid` is minted fresh — just verify it isn't nil.
            assert!(!reg.project_uuid.is_nil());
        })
        .expect("with_loaded after load_for");
}

#[test]
fn load_for_existing_populates_indices()
{
    let td = TempDir::new().unwrap();
    let seed = seed_registry_on_disk_with_prefix(td.path(), "state");

    let state = ProjectRegistryState::new();
    state.load_for(td.path()).expect("load_for on seeded dir");

    state
        .with_loaded(|reg|
        {
            assert_eq!(reg.entries.len(), 2);
            assert!(!reg.dirty, "clean load starts non-dirty");

            // native_id_index reverse-maps to the correct UUIDs.
            let via_ntfs = reg
                .native_id_index
                .get(&seed.native_id_a)
                .copied();
            assert_eq!(via_ntfs, Some(seed.uuid_a), "ntfs id → uuid_a");

            let via_posix = reg
                .native_id_index
                .get(&seed.native_id_b)
                .copied();
            assert_eq!(via_posix, Some(seed.uuid_b), "posix id → uuid_b");

            // path_index reverse-maps to the correct UUIDs.
            assert_eq!(
                reg.path_index.get(&seed.path_a).copied(),
                Some(seed.uuid_a),
            );
            assert_eq!(
                reg.path_index.get(&seed.path_b).copied(),
                Some(seed.uuid_b),
            );
        })
        .unwrap();
}

#[test]
fn flush_if_dirty_when_clean_returns_false()
{
    let td = TempDir::new().unwrap();
    seed_registry_on_disk(td.path());

    let state = ProjectRegistryState::new();
    state.load_for(td.path()).unwrap();

    // Force-clear dirty (a fresh load is already clean, but be explicit).
    state
        .with_loaded(|reg| { reg.dirty = false; })
        .unwrap();

    let bak = td.path().join("_mangaplaystudio").join("registry.json.bak");
    let bak_existed_before = bak.exists();

    let flushed = state.flush_if_dirty().expect("flush_if_dirty");
    assert!(!flushed, "clean state must not flush");

    // The primary was never overwritten so no fresh `.bak` was minted.
    // (If a `.bak` existed before this test's flush, it stays exactly the
    // same. The invariant we assert is: no NEW .bak appeared.)
    assert_eq!(
        bak.exists(),
        bak_existed_before,
        ".bak state must not change on no-op flush",
    );
}

#[test]
fn flush_if_dirty_when_dirty_writes()
{
    let td = TempDir::new().unwrap();
    let (uuid_a, _uuid_b) = seed_registry_on_disk(td.path());

    let state = ProjectRegistryState::new();
    state.load_for(td.path()).unwrap();

    // Mutate an entry: bump rev on uuid_a.
    state
        .with_loaded(|reg|
        {
            let entry = reg.entries.get_mut(&uuid_a).expect("uuid_a present");
            entry.rev = 999;
            reg.mark_dirty();
        })
        .unwrap();

    let flushed = state.flush_if_dirty().expect("flush_if_dirty");
    assert!(flushed, "dirty state must flush");

    // Verify on-disk primary reflects the mutation.
    let primary = td.path().join("_mangaplaystudio").join("registry.json");
    let bytes = fs::read(&primary).expect("registry.json exists");
    let parsed: RegistryFile =
        serde_json::from_slice(&bytes).expect("registry.json parses");
    let round_tripped = parsed
        .entries
        .get(&uuid_a.to_string())
        .expect("uuid_a present on disk");
    assert_eq!(round_tripped.rev, 999, "mutation persisted");

    // Second flush is now a no-op.
    let flushed_again = state.flush_if_dirty().unwrap();
    assert!(!flushed_again, "already-flushed state is clean");
}

#[test]
fn load_for_replaces_previous()
{
    let td_a = TempDir::new().unwrap();
    let seed_a = seed_registry_on_disk_with_prefix(td_a.path(), "alpha");

    let td_b = TempDir::new().unwrap();
    let seed_b = seed_registry_on_disk_with_prefix(td_b.path(), "beta");

    let state = ProjectRegistryState::new();
    state.load_for(td_a.path()).unwrap();
    state.load_for(td_b.path()).unwrap();

    state
        .with_loaded(|reg|
        {
            assert_eq!(reg.root_path, td_b.path(),
                "root_path reflects the second load");

            // Entries count is dir_b's exactly — no partial merge.
            assert_eq!(
                reg.entries.len(), 2,
                "entries count matches dir_b's fixture, not dir_a + dir_b",
            );

            // project_uuid switched over to dir_b's.
            assert_eq!(
                reg.project_uuid, seed_b.project_uuid,
                "project_uuid reflects the second load",
            );

            // dir_b's entries are present.
            assert!(
                reg.entries.contains_key(&seed_b.uuid_a),
                "dir_b's entries are present",
            );

            // dir_a's UUIDs are gone.
            assert!(
                !reg.entries.contains_key(&seed_a.uuid_a),
                "dir_a's uuid_a entry is gone",
            );
            assert!(
                !reg.entries.contains_key(&seed_a.uuid_b),
                "dir_a's uuid_b entry is gone",
            );

            // native_id_index carries none of dir_a's native IDs.
            for stale in [&seed_a.native_id_a, &seed_a.native_id_b]
            {
                assert!(
                    !reg.native_id_index.contains_key(stale),
                    "native_id_index leaked dir_a's native id: {:?}",
                    stale,
                );
            }

            // path_index carries none of dir_a's paths.
            for stale in [&seed_a.path_a, &seed_a.path_b]
            {
                assert!(
                    !reg.path_index.contains_key(stale),
                    "path_index leaked dir_a's path: {}",
                    stale,
                );
            }
        })
        .unwrap();
}

#[test]
fn load_for_corrupt_returns_error_and_clears_state()
{
    // 1. Seed dir_a with a valid registry.
    let td_a = TempDir::new().unwrap();
    let seed_a = seed_registry_on_disk_with_prefix(td_a.path(), "alpha");

    let state = ProjectRegistryState::new();

    // 2. Load dir_a — succeeds.
    state.load_for(td_a.path()).expect("load_for dir_a");

    // 3. Confirm dir_a's entries are in memory.
    let count_a = state
        .with_loaded(|reg| reg.entries.len())
        .expect("with_loaded after dir_a load");
    assert_eq!(count_a, 2, "dir_a's two entries loaded");

    // Sanity: seed_a's UUIDs really did land.
    state
        .with_loaded(|reg|
        {
            assert!(reg.entries.contains_key(&seed_a.uuid_a));
        })
        .unwrap();

    // 4. Create dir_b with both primary and .bak corrupt so BakRecovered
    //    doesn't fire and Corrupt is the outcome.
    let td_b = TempDir::new().unwrap();
    let app_dir = td_b.path().join("_mangaplaystudio");
    fs::create_dir_all(&app_dir).expect("create _mangaplaystudio in dir_b");
    fs::write(app_dir.join("registry.json"), b"not json")
        .expect("write corrupt primary");
    fs::write(app_dir.join("registry.json.bak"), b"also not json")
        .expect("write corrupt .bak");

    // 5. Load dir_b — must fail with a registry-corrupt error.
    let err = state
        .load_for(td_b.path())
        .expect_err("corrupt load returns Err");
    assert!(
        err.starts_with("registry-corrupt:"),
        "expected registry-corrupt: prefix, got: {}",
        err,
    );

    // 6. Critical: stale dir_a state must be wiped.
    let post_err = state
        .with_loaded(|_| ())
        .expect_err("with_loaded after corrupt load");
    assert!(
        matches!(post_err, app_lib::RegistryStateErr::NoProjectOpen),
        "corrupt load must clear the inner mutex to None, got: {:?}",
        post_err,
    );
    assert_eq!(
        post_err.to_string(),
        "no-project-open",
        "Display shape stays stable for legacy string-consumers",
    );
}

#[test]
fn with_loaded_no_project_open_errors()
{
    let state = ProjectRegistryState::new();
    let err = state.with_loaded(|_| ()).expect_err("no project loaded");
    assert!(
        matches!(err, app_lib::RegistryStateErr::NoProjectOpen),
        "expected NoProjectOpen, got: {:?}",
        err,
    );
    assert_eq!(err.to_string(), "no-project-open");
}
