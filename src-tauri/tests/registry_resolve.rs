//! Integration tests for the UUID resolver primitives.
//!
//! Covers: native-ID reader on Linux, happy-path resolve, unknown/deleted
//! errors, external-rename healing, low-level `locate_by_native_id`, and
//! `FsErr` serde shape.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::Read;
use std::path::PathBuf;
use std::time::Instant;

use app_lib::{
    FsErr, LoadedRegistry, NativeId, RegistryEntry, locate_by_native_id, read_native_id,
    resolve_and_open,
};
use tempfile::TempDir;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// Build an in-memory `LoadedRegistry` with the given entries.
fn make_registry(root: PathBuf, entries: BTreeMap<Uuid, RegistryEntry>) -> LoadedRegistry
{
    let mut reg = LoadedRegistry
    {
        project_uuid: Uuid::new_v4(),
        root_path: root,
        entries,
        native_id_index: HashMap::new(),
        path_index: HashMap::new(),
        dirty: false,
        last_save: Instant::now(),
    };
    reg.rebuild_indices();
    reg
}

/// Create a file on disk at `<root>/<rel>`, then read its native ID via the
/// same `read_native_id` the resolver uses. Returns the identity for
/// registry seeding.
fn seed_file(root: &std::path::Path, rel: &str, contents: &[u8]) -> NativeId
{
    let abs = root.join(rel);
    if let Some(parent) = abs.parent()
    {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(&abs, contents).unwrap();
    let f = File::open(&abs).unwrap();
    read_native_id(&f).unwrap()
}

fn entry(native_id: NativeId, path: &str) -> RegistryEntry
{
    RegistryEntry
    {
        native_id,
        path: path.to_string(),
        kind: "file".to_string(),
        parent_uuid: None,
        rev: 1,
        tombstone: false,
        content_hash_head: None,
    }
}

// ---------------------------------------------------------------------------
// native_id_read
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
#[test]
fn read_native_id_returns_posix_on_linux()
{
    let td = TempDir::new().unwrap();
    let path = td.path().join("scratch.txt");
    fs::write(&path, b"hello").unwrap();
    let f = File::open(&path).unwrap();

    let id = read_native_id(&f).expect("native id read succeeds");
    match id
    {
        NativeId::Posix { dev, ino } =>
        {
            assert!(dev != 0, "st_dev should be non-zero");
            assert!(ino != 0, "st_ino should be non-zero");
        }
        other => panic!("expected NativeId::Posix on Linux, got {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// resolve_and_open
// ---------------------------------------------------------------------------

#[test]
fn resolve_and_open_unknown_uuid_returns_fserr()
{
    let td = TempDir::new().unwrap();
    let mut reg = make_registry(td.path().to_path_buf(), BTreeMap::new());

    let missing = Uuid::new_v4();
    let err = resolve_and_open(&mut reg, missing, false).expect_err("unknown uuid errors");

    match err
    {
        FsErr::UnknownUuid { uuid } => assert_eq!(uuid, missing.to_string()),
        other => panic!("expected UnknownUuid, got {:?}", other),
    }
}

#[test]
fn resolve_and_open_tombstoned_returns_deleted()
{
    let td = TempDir::new().unwrap();
    let uuid = Uuid::new_v4();

    let mut entries = BTreeMap::new();
    let mut e = entry(NativeId::Unknown, "gone.md");
    e.tombstone = true;
    entries.insert(uuid, e);
    let mut reg = make_registry(td.path().to_path_buf(), entries);

    let err = resolve_and_open(&mut reg, uuid, false).expect_err("tombstoned errors");
    match err
    {
        FsErr::Deleted { uuid: u } => assert_eq!(u, uuid.to_string()),
        other => panic!("expected Deleted, got {:?}", other),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn resolve_and_open_happy_path()
{
    let td = TempDir::new().unwrap();
    let native = seed_file(td.path(), "chapter-1/intro.md", b"content");

    let uuid = Uuid::new_v4();
    let mut entries = BTreeMap::new();
    entries.insert(uuid, entry(native.clone(), "chapter-1/intro.md"));
    let mut reg = make_registry(td.path().to_path_buf(), entries);
    let rev_before = reg.entries[&uuid].rev;
    let dirty_before = reg.dirty;

    let (_file, resolved) = resolve_and_open(&mut reg, uuid, false).expect("happy path");
    assert_eq!(resolved.path, "chapter-1/intro.md");
    assert_eq!(resolved.native_id, native);
    assert_eq!(reg.entries[&uuid].rev, rev_before, "no rev bump on happy path");
    assert_eq!(reg.dirty, dirty_before, "no dirty flip on happy path");
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn resolve_and_open_heals_external_rename()
{
    let td = TempDir::new().unwrap();
    let native = seed_file(td.path(), "chapter-1/intro.md", b"content");

    let uuid = Uuid::new_v4();
    let mut entries = BTreeMap::new();
    entries.insert(uuid, entry(native.clone(), "chapter-1/intro.md"));
    let mut reg = make_registry(td.path().to_path_buf(), entries);
    let rev_before = reg.entries[&uuid].rev;

    // External rename: intro.md → renamed.md (same parent).
    fs::rename(
        td.path().join("chapter-1/intro.md"),
        td.path().join("chapter-1/renamed.md"),
    )
    .unwrap();

    let (mut file, resolved) =
        resolve_and_open(&mut reg, uuid, false).expect("heal succeeds");

    assert_eq!(resolved.path, "chapter-1/renamed.md", "returned entry reflects heal");
    assert_eq!(
        reg.entries[&uuid].path,
        "chapter-1/renamed.md",
        "registry path healed",
    );
    assert_eq!(
        reg.entries[&uuid].rev,
        rev_before + 1,
        "rev bumped exactly once on heal",
    );
    assert!(reg.dirty, "heal flips dirty");
    assert_eq!(resolved.native_id, native, "native id unchanged");

    // TOCTOU-safety: the returned handle is the file we located by native
    // ID, so reading from it yields the original contents even though the
    // path on disk has changed.
    let mut buf = String::new();
    file.read_to_string(&mut buf).expect("read healed file");
    assert_eq!(buf, "content");

    // Reverse-lookup indices must also point at the healed path.
    assert_eq!(
        reg.path_index.get("chapter-1/renamed.md").copied(),
        Some(uuid),
        "path_index refreshed to new path",
    );
    assert!(
        !reg.path_index.contains_key("chapter-1/intro.md"),
        "path_index no longer holds old path",
    );
    assert_eq!(
        reg.native_id_index.get(&native).copied(),
        Some(uuid),
        "native_id_index still points at the healed uuid",
    );
}

// ---------------------------------------------------------------------------
// locate_by_native_id
// ---------------------------------------------------------------------------

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn locate_by_native_id_finds_renamed_sibling()
{
    let td = TempDir::new().unwrap();
    let native = seed_file(td.path(), "chapter-1/intro.md", b"content");

    // Rename externally.
    fs::rename(
        td.path().join("chapter-1/intro.md"),
        td.path().join("chapter-1/renamed.md"),
    )
    .unwrap();

    let found = locate_by_native_id(td.path(), &native, "chapter-1/intro.md")
        .expect("scan ok");
    assert_eq!(found.as_deref(), Some("chapter-1/renamed.md"));
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn locate_by_native_id_missing_returns_none()
{
    let td = TempDir::new().unwrap();
    let native = seed_file(td.path(), "chapter-1/intro.md", b"content");

    // Delete the file entirely.
    fs::remove_file(td.path().join("chapter-1/intro.md")).unwrap();

    let found = locate_by_native_id(td.path(), &native, "chapter-1/intro.md")
        .expect("scan ok even when empty");
    assert!(found.is_none(), "no candidate → Ok(None)");
}

// ---------------------------------------------------------------------------
// FsErr serde
// ---------------------------------------------------------------------------

/// Lock the exact JSON payload shape of every `FsErr` variant. The JS side
/// matches on these key names — a silent serde-attribute regression
/// (e.g. dropping the per-field `#[serde(rename = "…")]` attrs on
/// `Stale`/`StaleRev`) would land here and NOT at a runtime type error, so
/// the test asserts each key explicitly.
#[test]
fn fs_err_serde_kebab_case()
{
    // (variant, expected JSON as a serde_json::Value)
    let cases: Vec<(FsErr, serde_json::Value)> = vec![
        (
            FsErr::UnknownUuid { uuid: "x".into() },
            serde_json::json!({ "kind": "unknown-uuid", "uuid": "x" }),
        ),
        (
            FsErr::Deleted { uuid: "x".into() },
            serde_json::json!({ "kind": "deleted", "uuid": "x" }),
        ),
        (
            FsErr::Stale
            {
                uuid: "u".into(),
                last_known_path: "p".into(),
            },
            serde_json::json!({
                "kind": "stale",
                "uuid": "u",
                "last-known-path": "p",
            }),
        ),
        (
            FsErr::StaleRev
            {
                uuid: "u".into(),
                current_rev: 3,
                expected_rev: 2,
            },
            serde_json::json!({
                "kind": "stale-rev",
                "uuid": "u",
                "current-rev": 3,
                "expected-rev": 2,
            }),
        ),
        (
            FsErr::PermissionDenied { message: "m".into() },
            serde_json::json!({ "kind": "permission-denied", "message": "m" }),
        ),
        (
            FsErr::NoProjectOpen,
            serde_json::json!({ "kind": "no-project-open" }),
        ),
        (
            FsErr::Io { message: "m".into() },
            serde_json::json!({ "kind": "io", "message": "m" }),
        ),
        (
            FsErr::Internal { message: "m".into() },
            serde_json::json!({ "kind": "internal", "message": "m" }),
        ),
    ];

    for (err, expected) in cases
    {
        let actual = serde_json::to_value(&err).expect("serialize FsErr");
        assert_eq!(actual, expected, "shape mismatch for {:?}", err);
    }

    // Extra-paranoid: explicitly probe the hyphenated field names on the two
    // variants that carry underscore-named fields. If serde ever regresses
    // (e.g. `rename_all` on tagged enums starts touching inner fields, or the
    // per-field renames are dropped), these look-ups start returning `None`.
    let stale = serde_json::to_value(&FsErr::Stale
    {
        uuid: "u".into(),
        last_known_path: "p".into(),
    })
    .unwrap();
    assert_eq!(
        stale.get("last-known-path").and_then(|v| v.as_str()),
        Some("p"),
        "Stale.last_known_path MUST serialise as `last-known-path`",
    );
    assert!(
        stale.get("last_known_path").is_none(),
        "underscore key must not appear",
    );

    let stale_rev = serde_json::to_value(&FsErr::StaleRev
    {
        uuid: "u".into(),
        current_rev: 3,
        expected_rev: 2,
    })
    .unwrap();
    assert_eq!(
        stale_rev.get("current-rev").and_then(|v| v.as_u64()),
        Some(3),
        "StaleRev.current_rev MUST serialise as `current-rev`",
    );
    assert_eq!(
        stale_rev.get("expected-rev").and_then(|v| v.as_u64()),
        Some(2),
        "StaleRev.expected_rev MUST serialise as `expected-rev`",
    );
    assert!(
        stale_rev.get("current_rev").is_none() && stale_rev.get("expected_rev").is_none(),
        "underscore keys must not appear",
    );
}
