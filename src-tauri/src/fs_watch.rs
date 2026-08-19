// ── Filesystem watcher (project tree change notifications) ───────────────
//
// Wraps notify-debouncer-full with a per-window state managed by Tauri.
// JS calls fs_watch_start(root) once the project is open. The watcher
// uses RecursiveMode::Recursive so every subdirectory is covered from
// the start — externally-created files in any subfolder trigger events
// without waiting for the user to expand that folder in the explorer.
// Events emit on the existing `project-fs-changed` Tauri event so the
// sync contract stays single-channel.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use notify::{RecursiveMode, RecommendedWatcher};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use notify_debouncer_full::{Debouncer, DebouncedEvent, RecommendedCache, new_debouncer};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::time::Duration;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::{Path, PathBuf};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::sync::Mutex;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::commands::file_ops::fs_events::{FsChange, emit_fs_changed, emit_registry_fs_changed};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::registry::ProjectRegistryState;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::Manager;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const FS_WATCHER_DEBOUNCE_MS: u64 = 500;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub struct FsWatcher
{
    inner: Mutex<Option<FsWatcherInner>>,
}

/// Android/iOS stub — no native path-watch API available, so the FsWatcher is
/// a no-op shell. Same managed-state surface so the call sites compile.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub struct FsWatcher;

#[cfg(any(target_os = "android", target_os = "ios"))]
impl FsWatcher {
    pub fn new() -> Self { Self }
}

// `RecommendedCache` resolves to `FileIdMap` on Windows/macOS (where
// inode/file-id tracking is required for reliable rename detection) and to
// `NoCache` on Linux/Android (where inotify already provides rename cookies).
// Using the alias makes this field compile on every target — hardcoding
// `FileIdMap` here breaks the Linux build (and would break native tests).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct FsWatcherInner
{
    debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
    /// Kept for log context / future diagnostics; the debouncer owns the
    /// recursive watch and unregisters it when dropped.
    #[allow(dead_code)]
    root: PathBuf,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl FsWatcher
{
    pub fn new() -> Self
    {
        Self { inner: Mutex::new(None) }
    }
}

/// Returns true if the path should be ignored — dot-prefixed basename,
/// `.tmp` suffix (atomic-write artefacts AND foreign tempfiles), or a path
/// segment matching a build / dependency / generated directory.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn fs_watcher_should_ignore(path: &Path) -> bool
{
    if let Some(name) = path.file_name().and_then(|n| n.to_str())
    {
        if name.starts_with('.') { return true; }
        if name.ends_with(".tmp") { return true; }
    }
    for component in path.components()
    {
        if let std::path::Component::Normal(seg) = component
        {
            if let Some(s) = seg.to_str()
            {
                match s
                {
                    "node_modules" | "target" | "build" | "dist" | "_generated" | "_mangaplaystudio" => return true,
                    _ => {}
                }
            }
        }
    }
    false
}

/// Watched extensions for the atomic-write tmp-collapse rule.
///
/// Must cover every extension the app itself atomic-writes via
/// [`atomic_write_impl`] — otherwise the tmp→real rename fires as
/// `Renamed{to}` (external rename) instead of `Modified{to}`, and JS
/// FS-changed handlers treat the self-save as an external rename. Keep in
/// sync with `formatForFilename` in `src/js/editor/lang-registry.js`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn fs_watcher_is_watched_ext(path: &Path) -> bool
{
    let s = path.to_string_lossy();
    s.ends_with(".mangaplay")
        || s.ends_with(".mangaplay.md")
        || s.ends_with(".fountain")
        || s.ends_with(".fountain.md")
        || s.ends_with(".sup")
        || s.ends_with(".sup.md")
        || s.ends_with(".md")
        || s.ends_with(".txt")
        || s.ends_with(".mangaart")
}

/// Map a single notify event to zero or more (path, FsChange) pairs.
/// Implements the rules from the plan:
///   - Create(File)             → Created{path}
///   - Create(Folder)           → CreatedDir{path}
///   - Modify(_)                → Modified{path}   (Data/Metadata/Name/Any/Other)
///   - Remove(_)                → Deleted          (path goes in payload.path)
///   - Rename(Both): if from.ends_with(".tmp") AND to has a watched ext
///                              → Modified{path: to}  (atomic-write collapse)
///   - Rename(Both): otherwise  → Renamed{to}
///   - anything else            → drop
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn map_notify_event(event: &notify::Event) -> Vec<(String, FsChange)>
{
    use notify::EventKind::*;
    use notify::event::{CreateKind, ModifyKind, RenameMode};

    let mut out = Vec::new();
    match &event.kind
    {
        Create(kind) =>
        {
            for p in &event.paths
            {
                if fs_watcher_should_ignore(p) { continue; }
                let path = p.to_string_lossy().to_string();
                match kind
                {
                    CreateKind::Folder => out.push((path.clone(), FsChange::CreatedDir { path })),
                    _ => out.push((path.clone(), FsChange::Created { path })),
                }
            }
        }
        Modify(ModifyKind::Name(RenameMode::Both)) =>
        {
            if event.paths.len() >= 2
            {
                let from = &event.paths[0];
                let to = &event.paths[1];
                if fs_watcher_should_ignore(to) { return out; }
                let to_str = to.to_string_lossy().to_string();
                let from_str = from.to_string_lossy();
                let is_tmp_collapse = from_str.ends_with(".tmp") && fs_watcher_is_watched_ext(to);
                if is_tmp_collapse
                {
                    out.push((to_str.clone(), FsChange::Modified { path: to_str }));
                }
                else
                {
                    // Contract: outer path is the OLD absolute path (where the
                    // file WAS); `to` inside FsChange::Renamed is the NEW
                    // absolute path. This matches what `resolve_path_to_registry_change`
                    // expects (looks up OLD path in `path_index`) and what the
                    // JS `project-fs-changed` handler expects
                    // (`broker.isActivePath(payload.path)` compares against the
                    // tracked OLD path).
                    let from_owned = from_str.to_string();
                    out.push((from_owned, FsChange::Renamed { to: to_str }));
                }
            }
        }
        Modify(_) =>
        {
            for p in &event.paths
            {
                if fs_watcher_should_ignore(p) { continue; }
                let path = p.to_string_lossy().to_string();
                out.push((path.clone(), FsChange::Modified { path }));
            }
        }
        Remove(_) =>
        {
            for p in &event.paths
            {
                if fs_watcher_should_ignore(p) { continue; }
                let path = p.to_string_lossy().to_string();
                out.push((path, FsChange::Deleted));
            }
        }
        _ => {}
    }
    out
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn fs_watch_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, FsWatcher>,
    path: String,
) -> Result<(), String>
{
    let root = PathBuf::from(&path);
    if !root.is_dir() { return Err(format!("not a directory: {}", path)); }

    let app_handle = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(FS_WATCHER_DEBOUNCE_MS),
        None,
        move |result: notify_debouncer_full::DebounceEventResult|
        {
            match result
            {
                Ok(events) =>
                {
                    for ev in events
                    {
                        let de: &DebouncedEvent = &ev;
                        for (path, change) in map_notify_event(&de.event)
                        {
                            // NEW `registry-fs-changed` event fires BEFORE the
                            // OLD `project-fs-changed` — we borrow the `change`
                            // snapshot for registry resolution then hand ownership
                            // to the legacy emitter. Both listeners see the same
                            // underlying change while JS listeners migrate over.
                            let registry_state = app_handle.state::<ProjectRegistryState>();
                            emit_registry_fs_changed(&app_handle, &registry_state, &path, &change);
                            emit_fs_changed(&app_handle, &path, change);
                        }
                    }
                }
                Err(errs) =>
                {
                    for e in errs { log::warn!("[fs_watcher] {}", e); }
                }
            }
        },
    ).map_err(|e| e.to_string())?;

    debouncer.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;

    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    *guard = Some(FsWatcherInner { debouncer, root });
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn fs_watch_stop(state: tauri::State<'_, FsWatcher>) -> Result<(), String>
{
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn fs_watch_add_subdir(
    _state: tauri::State<'_, FsWatcher>,
    _path: String,
) -> Result<(), String>
{
    // Recursive mode covers all subdirectories — nothing to add.
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn fs_watch_remove_subdir(
    _state: tauri::State<'_, FsWatcher>,
    _path: String,
) -> Result<(), String>
{
    // Recursive mode covers all subdirectories — nothing to remove.
    Ok(())
}

// ── Android/iOS stubs for fs_watch_* ────────────────────────────────────
// Android/iOS have no kernel-level path-watch API the way Linux does —
// apps watch via Storage Access Framework callbacks at the Java layer.
// The prototype mobile UX uses sandboxed FS only, where mtime-based
// polling or pull-to-refresh is sufficient. Commands stay defined so
// the JS invoke() calls don't error.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn fs_watch_start(_app: tauri::AppHandle, _state: tauri::State<'_, FsWatcher>, _path: String) -> Result<(), String> { Ok(()) }
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn fs_watch_stop(_state: tauri::State<'_, FsWatcher>) -> Result<(), String> { Ok(()) }
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn fs_watch_add_subdir(_state: tauri::State<'_, FsWatcher>, _path: String) -> Result<(), String> { Ok(()) }
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn fs_watch_remove_subdir(_state: tauri::State<'_, FsWatcher>, _path: String) -> Result<(), String> { Ok(()) }
