//! Integration tests for the UUID file registry store.
//!
//! Covers: round-trip save/load, missing-file NotFound, tmp-file cleanup,
//! .bak rotation, corrupt-primary recovery, both-corrupt failure, and
//! per-variant serde tag stability for `NativeId`.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use app_lib::{
    NativeId, RegistryEntry, RegistryFile, RegistryLoadErr, registry_load_from_disk,
    registry_save_atomic,
};
use tempfile::TempDir;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// Deterministic UUID derived from a seed string so test payloads
/// compare cleanly without depending on the `v5` cargo feature.
fn fixed_uuid(seed: &str) -> Uuid
{
    // Simple fold — no crypto claim. Only property we need is determinism
    // per (seed) across runs.
    let mut bytes = [0u8; 16];
    for (i, b) in seed.as_bytes().iter().enumerate()
    {
        bytes[i % 16] ^= *b;
    }
    // Force the version nibble to 4 and the variant bits to RFC-4122 so
    // the resulting bytes are a valid UUID string (36 chars).
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    Uuid::from_bytes(bytes)
}

fn sample_ntfs_id() -> NativeId
{
    NativeId::Ntfs
    {
        volume_serial: 0xDEADBEEF,
        file_id: "0x0002000000012345".to_string(),
    }
}

fn sample_registry() -> RegistryFile
{
    let mut entries: BTreeMap<String, RegistryEntry> = BTreeMap::new();

    let a = fixed_uuid("entry-a");
    entries.insert(
        a.to_string(),
        RegistryEntry
        {
            native_id: sample_ntfs_id(),
            path: "chapter-1/intro.mangaplay.md".to_string(),
            kind: "file".to_string(),
            parent_uuid: None,
            rev: 7,
            tombstone: false,
            content_hash_head: Some("sha256:e3b0c4:4096".to_string()),
        },
    );

    let b = fixed_uuid("entry-b");
    entries.insert(
        b.to_string(),
        RegistryEntry
        {
            native_id: NativeId::Posix { dev: 42, ino: 9001 },
            path: "chapter-2/art".to_string(),
            kind: "folder".to_string(),
            parent_uuid: Some(a),
            rev: 1,
            tombstone: false,
            content_hash_head: None,
        },
    );

    RegistryFile
    {
        version: 2,
        project_uuid: fixed_uuid("project"),
        entries,
    }
}

fn app_dir(root: &Path) -> std::path::PathBuf
{
    root.join("_mangaplaystudio")
}

fn primary_path(root: &Path) -> std::path::PathBuf
{
    app_dir(root).join("registry.json")
}

fn bak_path(root: &Path) -> std::path::PathBuf
{
    app_dir(root).join("registry.json.bak")
}

fn tmp_path(root: &Path) -> std::path::PathBuf
{
    app_dir(root).join("registry.json.tmp")
}

fn bak_tmp_path(root: &Path) -> std::path::PathBuf
{
    app_dir(root).join("registry.json.bak.tmp")
}

// ---------------------------------------------------------------------------
// Round-trip + missing
// ---------------------------------------------------------------------------

#[test]
fn save_then_load_roundtrip()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();

    let reg = sample_registry();
    registry_save_atomic(root, &reg).expect("save ok");

    let read_back = registry_load_from_disk(root).expect("load ok");
    assert_eq!(reg, read_back, "round-trip must preserve full registry");
}

#[test]
fn load_from_disk_missing_returns_notfound()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();

    match registry_load_from_disk(root)
    {
        Err(RegistryLoadErr::NotFound) => {}
        other => panic!("expected NotFound, got {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// Atomic write side-effects
// ---------------------------------------------------------------------------

#[test]
fn atomic_write_leaves_no_tmp()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();

    let reg = sample_registry();
    registry_save_atomic(root, &reg).expect("save ok");

    assert!(
        !tmp_path(root).exists(),
        "registry.json.tmp must be gone after a successful save",
    );
    assert!(primary_path(root).exists(), "primary must exist");
}

#[test]
fn overwrite_preserves_bak()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();

    // Save #1: writes primary, no bak yet.
    let mut reg = sample_registry();
    registry_save_atomic(root, &reg).expect("save#1 ok");
    assert!(!bak_path(root).exists(), "no bak after first save");

    // Capture the first payload for later comparison.
    let first_bytes = fs::read(primary_path(root)).expect("read primary #1");

    // Save #2: mutate + save again. Primary now holds the new payload;
    // .bak must hold the OLD payload (i.e. `first_bytes`).
    reg.entries
        .get_mut(&fixed_uuid("entry-a").to_string())
        .expect("entry-a present")
        .rev = 999;
    registry_save_atomic(root, &reg).expect("save#2 ok");

    let bak_bytes = fs::read(bak_path(root)).expect("read bak");
    assert_eq!(
        bak_bytes, first_bytes,
        ".bak must contain the FIRST payload after an overwrite, not the current one",
    );

    // Sanity: primary reflects the new payload.
    let primary_now = fs::read(primary_path(root)).expect("read primary #2");
    assert_ne!(primary_now, first_bytes, "primary should have moved on");
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

#[test]
fn corrupt_primary_recovers_from_bak()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();

    // Two good saves so both primary and .bak exist.
    let reg = sample_registry();
    registry_save_atomic(root, &reg).expect("save#1 ok");
    // Second save with same payload — leaves an identical .bak.
    registry_save_atomic(root, &reg).expect("save#2 ok");

    // Truncate primary to zero bytes → unparseable.
    fs::write(primary_path(root), b"").expect("truncate primary");

    match registry_load_from_disk(root)
    {
        Err(RegistryLoadErr::BakRecovered { registry, warning }) =>
        {
            assert_eq!(
                registry, reg,
                "recovered payload must equal the last good save",
            );
            assert!(
                !warning.is_empty(),
                "warning string must be populated for logging",
            );
        }
        other => panic!("expected BakRecovered, got {:?}", other),
    }
}

#[test]
fn both_files_corrupt_returns_corrupt()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();

    // Two saves → both files present.
    let reg = sample_registry();
    registry_save_atomic(root, &reg).expect("save#1 ok");
    registry_save_atomic(root, &reg).expect("save#2 ok");

    // Truncate both.
    fs::write(primary_path(root), b"").expect("truncate primary");
    fs::write(bak_path(root), b"").expect("truncate bak");

    match registry_load_from_disk(root)
    {
        Err(RegistryLoadErr::Corrupt { primary_err, bak_err }) =>
        {
            assert!(!primary_err.is_empty(), "primary_err populated");
            assert!(!bak_err.is_empty(), "bak_err populated");
        }
        other => panic!("expected Corrupt, got {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// NativeId serde tag stability
// ---------------------------------------------------------------------------

#[test]
fn native_id_serde_roundtrip()
{
    let variants: Vec<(NativeId, &'static str)> = vec![
        (
            NativeId::Ntfs
            {
                volume_serial: 0xDEADBEEF,
                file_id: "0x0002000000012345".to_string(),
            },
            "ntfs",
        ),
        (
            NativeId::Apfs
            {
                volume_uuid: "01234567-89ab-cdef-0123-456789abcdef".to_string(),
                ino: 42,
                gen: 3,
            },
            "apfs",
        ),
        (
            NativeId::Posix { dev: 100, ino: 200 },
            "posix",
        ),
        (
            NativeId::IosBookmark
            {
                blob_base64: "AAAA".to_string(),
            },
            "ios-bookmark",
        ),
        (
            NativeId::AndroidSaf
            {
                tree_uri: "content://com.android.externalstorage.documents/tree/primary".to_string(),
                document_id: "primary:Documents/Foo".to_string(),
                persisted: true,
            },
            "android-saf",
        ),
        (NativeId::Unknown, "unknown"),
    ];

    for (nid, expected_kind) in variants
    {
        let json = serde_json::to_value(&nid).expect("serialize");
        assert_eq!(
            json.get("kind").and_then(|v| v.as_str()),
            Some(expected_kind),
            "serde tag for variant must be {expected_kind}, got {json:?}",
        );

        let round_tripped: NativeId =
            serde_json::from_value(json.clone()).expect("deserialize");
        assert_eq!(round_tripped, nid, "round-trip must preserve variant");
    }
}

// ---------------------------------------------------------------------------
// Atomic-write ordering guarantees (Fix 1 / Fix 2)
// ---------------------------------------------------------------------------

/// After two consecutive saves, `registry.json` must exist and parse as
/// the v2 payload, and `registry.json.bak` must exist and parse as the
/// v1 payload. The atomic sequence never leaves primary absent — a
/// crash between operations would still leave the OLD primary in place.
#[test]
fn save_never_leaves_primary_missing()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();

    // Save v1.
    let mut reg = sample_registry();
    let v1 = reg.clone();
    registry_save_atomic(root, &reg).expect("save v1 ok");
    assert!(primary_path(root).exists(), "primary exists after v1 save");

    // Save v2 (mutate one field).
    reg.entries
        .get_mut(&fixed_uuid("entry-a").to_string())
        .expect("entry-a present")
        .rev = 42;
    registry_save_atomic(root, &reg).expect("save v2 ok");

    // Primary present + parseable + v2.
    assert!(primary_path(root).exists(), "primary exists after v2 save");
    let primary_loaded = registry_load_from_disk(root).expect("primary parses");
    assert_eq!(
        primary_loaded, reg,
        "primary must hold the v2 payload after the second save",
    );

    // .bak present + parseable + v1.
    assert!(bak_path(root).exists(), ".bak exists after v2 save");
    let bak_bytes = fs::read(bak_path(root)).expect("read bak");
    let bak_parsed: RegistryFile =
        serde_json::from_slice(&bak_bytes).expect(".bak parses as RegistryFile");
    assert_eq!(
        bak_parsed, v1,
        ".bak must hold the v1 payload after the second save",
    );
}

/// The `.bak.tmp` staging file must be cleaned up on the happy path.
#[test]
fn save_leaves_no_bak_tmp()
{
    let tmp = TempDir::new().expect("tempdir");
    let root = tmp.path();

    let reg = sample_registry();
    registry_save_atomic(root, &reg).expect("save#1 ok");
    assert!(
        !bak_tmp_path(root).exists(),
        "registry.json.bak.tmp must not exist after first save",
    );

    registry_save_atomic(root, &reg).expect("save#2 ok");
    assert!(
        !bak_tmp_path(root).exists(),
        "registry.json.bak.tmp must not exist after second save",
    );
}

#[test]
fn native_id_ntfs_json_shape()
{
    // Sanity check on the exact JSON shape from the plan spec:
    //   {"kind":"ntfs","volume_serial":...,"file_id":"0x..."}
    let nid = NativeId::Ntfs
    {
        volume_serial: 3735928559,
        file_id: "0x0002000000067890".to_string(),
    };
    let json = serde_json::to_value(&nid).expect("serialize");

    assert_eq!(json["kind"], "ntfs");
    assert_eq!(json["volume_serial"], 3735928559u64);
    assert_eq!(json["file_id"], "0x0002000000067890");
}
