//! Integration tests for the project fs-watcher.
//!
//! Layer A — pure unit tests over `map_notify_event` + filter helpers with
//! synthesised `notify::Event` values (no fs I/O, deterministic).
//!
//! Layer B — end-to-end tests that spin up a real `notify-debouncer-full`
//! debouncer against a tempdir, perform fs ops, and assert the collected
//! events match the documented rules.
//!
//! Layer C — macOS-gated smoke test confirming the watcher boots and emits
//! events on FSEvents.

use app_lib::{FsChange, fs_watcher_is_watched_ext, fs_watcher_should_ignore, map_notify_event};

use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
use notify::{Event, EventKind, RecursiveMode};
use notify_debouncer_full::new_debouncer;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

// ───────────────────────────────────────────────────────────────────────────
// Layer A — pure mapping / filter tests
// ───────────────────────────────────────────────────────────────────────────

fn ev(kind: EventKind, paths: Vec<&str>) -> Event
{
    Event
    {
        kind,
        paths: paths.into_iter().map(PathBuf::from).collect(),
        attrs: Default::default(),
    }
}

#[test]
fn map_notify_event_create_file_emits_created()
{
    let e = ev(EventKind::Create(CreateKind::File), vec!["/proj/foo.mangaplay"]);
    let out = map_notify_event(&e);
    assert_eq!(out.len(), 1);
    let (path, change) = &out[0];
    assert_eq!(path, "/proj/foo.mangaplay");
    match change
    {
        FsChange::Created { path: p } => assert_eq!(p, "/proj/foo.mangaplay"),
        other => panic!("expected Created, got {:?}", std::mem::discriminant(other)),
    }
}

#[test]
fn map_notify_event_create_folder_emits_created_dir()
{
    let e = ev(EventKind::Create(CreateKind::Folder), vec!["/proj/chapter-2"]);
    let out = map_notify_event(&e);
    assert_eq!(out.len(), 1);
    match &out[0].1
    {
        FsChange::CreatedDir { path } => assert_eq!(path, "/proj/chapter-2"),
        _ => panic!("expected CreatedDir"),
    }
}

#[test]
fn map_notify_event_modify_data_emits_modified()
{
    let e = ev(
        EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
        vec!["/proj/foo.mangaplay"],
    );
    let out = map_notify_event(&e);
    assert_eq!(out.len(), 1);
    match &out[0].1
    {
        FsChange::Modified { path } => assert_eq!(path, "/proj/foo.mangaplay"),
        _ => panic!("expected Modified"),
    }
}

#[test]
fn map_notify_event_modify_any_emits_modified()
{
    // The widened Modify(_) arm — confirms Modify(Any) flows to Modified
    // rather than being dropped.
    let e = ev(EventKind::Modify(ModifyKind::Any), vec!["/proj/foo.mangaplay"]);
    let out = map_notify_event(&e);
    assert_eq!(out.len(), 1);
    match &out[0].1
    {
        FsChange::Modified { path } => assert_eq!(path, "/proj/foo.mangaplay"),
        _ => panic!("expected Modified"),
    }
}

#[test]
fn map_notify_event_remove_emits_deleted()
{
    let e = ev(EventKind::Remove(RemoveKind::File), vec!["/proj/foo.mangaplay"]);
    let out = map_notify_event(&e);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].0, "/proj/foo.mangaplay");
    match &out[0].1
    {
        FsChange::Deleted => {}
        _ => panic!("expected Deleted"),
    }
}

#[test]
fn map_notify_event_rename_both_atomic_collapses_to_modified()
{
    let e = ev(
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
        vec!["/proj/foo.mangaplay.tmp", "/proj/foo.mangaplay"],
    );
    let out = map_notify_event(&e);
    assert_eq!(out.len(), 1);
    match &out[0].1
    {
        FsChange::Modified { path } => assert_eq!(path, "/proj/foo.mangaplay"),
        _ => panic!("expected Modified (tmp-collapse)"),
    }
}

#[test]
fn map_notify_event_rename_both_non_atomic_emits_renamed()
{
    // Contract (post-3c.ii-fix): outer tuple path = OLD absolute path;
    // `FsChange::Renamed { to }` = NEW absolute path. Registry resolver
    // looks up OLD in `path_index`; JS `project-fs-changed` handler
    // compares `payload.path` (OLD) against the broker's tracked path.
    let e = ev(
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
        vec!["/proj/old.mangaplay", "/proj/new.mangaplay"],
    );
    let out = map_notify_event(&e);
    assert_eq!(out.len(), 1);
    let (outer_path, change) = &out[0];
    assert_eq!(outer_path, "/proj/old.mangaplay",
        "outer path must be OLD (where the file WAS)");
    match change
    {
        FsChange::Renamed { to } => assert_eq!(to, "/proj/new.mangaplay",
            "FsChange::Renamed.to must be NEW (where the file went)"),
        _ => panic!("expected Renamed"),
    }
}

#[test]
fn ignore_filter_drops_dot_prefix()
{
    assert!(fs_watcher_should_ignore(Path::new("/proj/.DS_Store")));
    assert!(fs_watcher_should_ignore(Path::new("/proj/.git")));
}

#[test]
fn ignore_filter_drops_tmp_suffix()
{
    assert!(fs_watcher_should_ignore(Path::new("/proj/foo.mangaplay.tmp")));
    assert!(fs_watcher_should_ignore(Path::new("/proj/floating.tmp")));
}

#[test]
fn ignore_filter_drops_node_modules()
{
    assert!(fs_watcher_should_ignore(Path::new("/proj/node_modules/pkg/file.js")));
}

#[test]
fn ignore_filter_drops_target_dir()
{
    assert!(fs_watcher_should_ignore(Path::new("/proj/target/debug/x")));
    assert!(fs_watcher_should_ignore(Path::new("/proj/build/out.bin")));
    assert!(fs_watcher_should_ignore(Path::new("/proj/dist/bundle.js")));
    assert!(fs_watcher_should_ignore(Path::new("/proj/_generated/translations.js")));
}

#[test]
fn ignore_filter_passes_normal_file()
{
    assert!(!fs_watcher_should_ignore(Path::new("/proj/foo.mangaplay")));
    assert!(!fs_watcher_should_ignore(Path::new("/proj/chapter-1/p01.mangaart")));
}

#[test]
fn watched_ext_recognises_supported_formats()
{
    assert!(fs_watcher_is_watched_ext(Path::new("/proj/foo.mangaplay")));
    assert!(fs_watcher_is_watched_ext(Path::new("/proj/foo.mangaplay.md")));
    assert!(fs_watcher_is_watched_ext(Path::new("/proj/foo.fountain")));
    assert!(fs_watcher_is_watched_ext(Path::new("/proj/foo.md")));
    assert!(fs_watcher_is_watched_ext(Path::new("/proj/foo.mangaart")));
    assert!(!fs_watcher_is_watched_ext(Path::new("/proj/foo.txt")));
    assert!(!fs_watcher_is_watched_ext(Path::new("/proj/foo.png")));
}

// ───────────────────────────────────────────────────────────────────────────
// Layer B — end-to-end with real notify-debouncer-full
// ───────────────────────────────────────────────────────────────────────────

/// Spin up a debouncer against `dir`, run `ops`, wait long enough for the
/// 500ms debounce window to flush (3x = 1500ms), then drop and drain.
fn collect_events<F>(dir: &Path, ops: F) -> Vec<(String, FsChange)>
where
    F: FnOnce(&Path),
{
    let (tx, rx) = mpsc::channel();
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        None,
        move |result: notify_debouncer_full::DebounceEventResult|
        {
            match result
            {
                Ok(events) =>
                {
                    for ev in events
                    {
                        for pair in map_notify_event(&ev.event)
                        {
                            let _ = tx.send(pair);
                        }
                    }
                }
                Err(_) => {}
            }
        },
    )
    .expect("debouncer construct");

    debouncer
        .watch(dir, RecursiveMode::NonRecursive)
        .expect("watch root");

    // Give the watcher a brief moment to settle before performing ops.
    std::thread::sleep(Duration::from_millis(100));

    ops(dir);

    // Flush: 3x the debounce window so the debouncer has time to emit.
    std::thread::sleep(Duration::from_millis(1500));

    drop(debouncer);

    let mut out = Vec::new();
    while let Ok(pair) = rx.try_recv()
    {
        out.push(pair);
    }
    out
}

fn tempdir() -> tempfile::TempDir
{
    tempfile::Builder::new()
        .prefix("mps-fs-watcher-")
        .tempdir()
        .expect("tempdir")
}

fn has_change_for<F>(events: &[(String, FsChange)], path_suffix: &str, matcher: F) -> bool
where
    F: Fn(&FsChange) -> bool,
{
    events
        .iter()
        .any(|(p, c)| p.ends_with(path_suffix) && matcher(c))
}

#[test]
fn e2e_creates_file_emits_created()
{
    let td = tempdir();
    let events = collect_events(td.path(), |dir|
    {
        let p = dir.join("foo.mangaplay");
        std::fs::write(&p, "Title: hi\n").expect("write");
    });

    assert!(
        has_change_for(&events, "foo.mangaplay", |c| matches!(c, FsChange::Created { .. })),
        "expected Created event for foo.mangaplay, got: {:?}",
        events.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>()
    );
}

#[test]
fn e2e_atomic_write_collapses_to_modified()
{
    let td = tempdir();
    // Seed file so the atomic write is replacing an existing target.
    let final_path = td.path().join("foo.mangaplay");
    std::fs::write(&final_path, "old\n").expect("seed");

    let events = collect_events(td.path(), |dir|
    {
        let tmp = dir.join("foo.mangaplay.tmp");
        let dst = dir.join("foo.mangaplay");
        std::fs::write(&tmp, "new contents\n").expect("write tmp");
        // Brief pause inside the debounce window — both events should still
        // coalesce, and the tmp create should be dropped by the ignore filter.
        std::thread::sleep(Duration::from_millis(50));
        std::fs::rename(&tmp, &dst).expect("rename");
    });

    // The tmp file should NEVER appear in the event stream (ignore filter).
    for (p, _) in &events
    {
        assert!(
            !p.ends_with(".tmp"),
            "no .tmp path should leak through: {}",
            p
        );
    }

    // Exactly one Modified event for the final path. The renamer may also
    // emit the create-of-final as Created on some backends — accept either
    // Modified or Created, but require at least one event for the final
    // path. The atomic-collapse rule guarantees that when the backend
    // produces a Rename(Both) it becomes Modified; not all backends do.
    let final_events: Vec<&FsChange> = events
        .iter()
        .filter(|(p, _)| p.ends_with("foo.mangaplay") && !p.ends_with(".tmp"))
        .map(|(_, c)| c)
        .collect();

    assert!(
        !final_events.is_empty(),
        "expected at least one event for foo.mangaplay, got none"
    );
    // Backend variance: on Linux inotify, an atomic write surfaces as
    // Remove(.tmp) + Create(final) — the .tmp is dropped by the ignore
    // filter, leaving a Create for the final path. On Windows/macOS, the
    // notify-debouncer-full FileIdMap reports Rename(Both) which our
    // mapping collapses to Modified. Both shapes are correct end-to-end:
    // the JS handler treats Created and Modified the same way (refresh
    // explorer + re-read if active). What MUST hold is: at least one event
    // on the final path, of either kind, with NO .tmp leak (already
    // asserted above).
    assert!(
        final_events.iter().any(|c| matches!(c, FsChange::Modified { .. } | FsChange::Created { .. })),
        "expected Modified (Windows/macOS) or Created (Linux) for foo.mangaplay, got: {:?}",
        final_events
    );
}

#[test]
fn e2e_delete_emits_deleted()
{
    let td = tempdir();
    let p = td.path().join("doomed.mangaplay");
    std::fs::write(&p, "bye\n").expect("seed");
    // Let the seed-create settle outside the measurement window.
    std::thread::sleep(Duration::from_millis(200));

    let events = collect_events(td.path(), |_dir|
    {
        std::fs::remove_file(&p).expect("delete");
    });

    assert!(
        has_change_for(&events, "doomed.mangaplay", |c| matches!(c, FsChange::Deleted)),
        "expected Deleted event for doomed.mangaplay, got: {:?}",
        events.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>()
    );
}

#[test]
fn e2e_rename_emits_renamed()
{
    let td = tempdir();
    let a = td.path().join("a.mangaplay");
    let b = td.path().join("b.mangaplay");
    std::fs::write(&a, "x\n").expect("seed");
    std::thread::sleep(Duration::from_millis(200));

    let events = collect_events(td.path(), |_dir|
    {
        std::fs::rename(&a, &b).expect("rename");
    });

    // Some backends report Rename(Both) → Renamed. Others split it into
    // Remove(a) + Create(b). Accept either: a Renamed event whose outer
    // path is OLD (post-3c.ii contract), OR a Deleted/Created pair
    // covering both paths.
    let saw_renamed = has_change_for(&events, "a.mangaplay", |c|
    {
        matches!(c, FsChange::Renamed { to } if to.ends_with("b.mangaplay"))
    });
    let saw_split = has_change_for(&events, "a.mangaplay", |c| matches!(c, FsChange::Deleted))
        && has_change_for(&events, "b.mangaplay", |c| matches!(c, FsChange::Created { .. }));

    assert!(
        saw_renamed || saw_split,
        "expected Renamed (or Deleted+Created split) for a→b, got: {:?}",
        events
    );
}

#[test]
fn e2e_subdir_create_emits_created_dir()
{
    let td = tempdir();
    let events = collect_events(td.path(), |dir|
    {
        std::fs::create_dir(dir.join("chapter-2")).expect("mkdir");
    });

    assert!(
        has_change_for(&events, "chapter-2", |c| matches!(c, FsChange::CreatedDir { .. })),
        "expected CreatedDir event for chapter-2, got: {:?}",
        events.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>()
    );
}

#[test]
fn e2e_tmp_file_ignored()
{
    let td = tempdir();
    let events = collect_events(td.path(), |dir|
    {
        // A .tmp file that's never renamed to a watched ext — the
        // ignore filter must drop every event for it.
        let tmp = dir.join("floating.tmp");
        std::fs::write(&tmp, "garbage\n").expect("write tmp");
        std::thread::sleep(Duration::from_millis(50));
        // Touch it again to trigger a Modify.
        std::fs::write(&tmp, "more garbage\n").expect("touch tmp");
    });

    for (p, c) in &events
    {
        assert!(
            !p.ends_with(".tmp"),
            "no .tmp path should leak through: {} → {:?}",
            p,
            std::mem::discriminant(c)
        );
    }
}

// e2e_node_modules_ignored is covered at the unit level (Layer A). The
// watcher uses NonRecursive watches and only the root is watched here, so
// constructing a recursive scenario in an integration test would require
// re-implementing the recursive add-subdir logic. The pure filter test in
// `ignore_filter_drops_node_modules` exhaustively proves the contract.

// ───────────────────────────────────────────────────────────────────────────
// Layer C — macOS smoke
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
#[test]
fn macos_smoke()
{
    // FSEvents has known coalescing quirks; this single smoke test confirms
    // the watcher boots and emits events on macOS hardware. Mirrors
    // e2e_creates_file_emits_created. Run via
    //     cargo test --test fs_watcher macos_smoke
    // on a Mac.
    e2e_creates_file_emits_created();
}
