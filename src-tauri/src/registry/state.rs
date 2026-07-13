//! Managed-state wrapper for the currently-open project's UUID registry.
//!
//! See [`TODO/uuid-file-registry.md`](../../../../TODO/uuid-file-registry.md)
//! Part 2 — Managed State & Locking — for the full design.
//!
//! # Overview
//!
//! [`ProjectRegistryState`] is a Tauri `.manage(...)` state holding the
//! in-memory [`LoadedRegistry`] for whichever project is currently open,
//! or `None` when no project is open.
//!
//! # Locking model
//!
//! `ProjectRegistryState` owns a plain `Mutex<Option<LoadedRegistry>>` for
//! safe access to the in-memory struct. This is the *inner* lock.
//!
//! The *outer* RMW lock — held by commands that want to serialise a full
//! read-modify-write cycle including the on-disk flush — is the existing
//! [`crate::ProjectJsonLocks`] keyed on the project root path. Part 3
//! layers that on top when commands begin mutating. Part 2 does not touch
//! it.
//!
//! # Lifecycle
//!
//! - `project_open(path)` → [`ProjectRegistryState::load_for`] loads the
//!   registry (or synthesises an empty one on `NotFound`, or logs +
//!   accepts the `.bak` payload on recovery).
//! - `project_close` → [`ProjectRegistryState::flush_if_dirty`] then
//!   [`ProjectRegistryState::clear`]. (Wiring lands with the close command
//!   in a later part.)
//! - Mutating commands go through [`ProjectRegistryState::with_loaded`]
//!   to acquire `&mut LoadedRegistry`, mutate, set `dirty`, and either
//!   flush immediately or debounce (see plan Part 2 debounce policy).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use uuid::Uuid;

use crate::registry::native_id::NativeId;
use crate::registry::store::{
    LoadErr, RegistryEntry, RegistryFile, load_from_disk, save_atomic,
};

/// Structured error returned by [`ProjectRegistryState::with_loaded`] and
/// [`ProjectRegistryState::flush_if_dirty`].
///
/// Modelled so `registry_cmds.rs` can differentiate a genuine "no project
/// loaded" case from a poisoned inner mutex or a failed on-disk save. The
/// `Display` impl reproduces the legacy string shape (`no-project-open`,
/// `mutex-poisoned:...`, `registry-flush-error:...`) so existing string
/// call sites (e.g. `load_for` in `project_open`) keep working via the
/// `From<RegistryStateErr> for String` impl below.
#[derive(Debug)]
pub enum RegistryStateErr
{
    /// No project is currently loaded into the state.
    NoProjectOpen,
    /// The inner `Mutex` was poisoned by a panic in a previous borrower.
    MutexPoisoned(String),
    /// The on-disk save failed (only reachable via `flush_if_dirty`).
    SaveFailed(String),
}

impl std::fmt::Display for RegistryStateErr
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
    {
        match self
        {
            Self::NoProjectOpen => write!(f, "no-project-open"),
            Self::MutexPoisoned(m) => write!(f, "mutex-poisoned:{}", m),
            Self::SaveFailed(m) => write!(f, "registry-flush-error:{}", m),
        }
    }
}

impl From<RegistryStateErr> for String
{
    fn from(e: RegistryStateErr) -> Self
    {
        e.to_string()
    }
}

/// In-memory registry for a single open project.
///
/// Fields mirror the plan's Part 2 code block. `entries` is keyed by the
/// in-memory `Uuid` type (converted to/from the on-disk `String` keys via
/// [`to_registry_file`](LoadedRegistry::to_registry_file)).
///
/// `native_id_index` and `path_index` are reverse lookups populated from
/// `entries`; callers that mutate `entries` MUST call
/// [`rebuild_indices`](LoadedRegistry::rebuild_indices) afterwards (or use
/// helpers that do so — those land in Part 3).
pub struct LoadedRegistry
{
    /// Stable UUID for the project itself. Duplicated from
    /// `_mangaplaystudio/project.json::id`; the registry is self-describing.
    pub project_uuid: Uuid,

    /// Absolute path to the project root. Set from the runtime
    /// `project_root` parameter on every open. Never read from disk.
    pub root_path: PathBuf,

    /// Per-file / per-folder entries, keyed by UUID.
    pub entries: HashMap<Uuid, RegistryEntry>,

    /// Reverse index: [`NativeId`] → owning UUID. Used by dedup + the
    /// external-rename healing path (Part 3).
    pub native_id_index: HashMap<NativeId, Uuid>,

    /// Reverse index: project-relative path (forward slashes) → owning
    /// UUID. Rebuilt on any mutation that touches paths.
    pub path_index: HashMap<String, Uuid>,

    /// `true` when the in-memory state is ahead of disk. Cleared by
    /// [`ProjectRegistryState::flush_if_dirty`].
    pub dirty: bool,

    /// Instant of the last successful flush. Used by the debounce policy
    /// in Part 3.
    pub last_save: Instant,
}

impl LoadedRegistry
{
    /// Build the on-disk shape from the in-memory struct.
    ///
    /// The only structural difference is the `entries` key type: on-disk
    /// uses `HashMap<String, RegistryEntry>` (so `serde_json` emits it as
    /// a plain JSON object), in-memory uses `HashMap<Uuid, RegistryEntry>`.
    fn to_registry_file(&self) -> RegistryFile
    {
        let entries: HashMap<String, RegistryEntry> = self
            .entries
            .iter()
            .map(|(uuid, entry)| (uuid.to_string(), entry.clone()))
            .collect();

        RegistryFile
        {
            version: crate::registry::store::REGISTRY_VERSION,
            project_uuid: self.project_uuid,
            entries,
        }
    }

    /// Clear + repopulate `native_id_index` and `path_index` from
    /// `entries`. Cheap enough to run after every mutation batch; Part 3
    /// helpers will call this at the tail of each RMW.
    pub fn rebuild_indices(&mut self)
    {
        self.native_id_index.clear();
        self.path_index.clear();
        for (uuid, entry) in &self.entries
        {
            // Skip tombstoned rows in the reverse indices — they still
            // occupy a UUID slot in `entries` but must not shadow a live
            // entry sharing the same native ID or path.
            if entry.tombstone
            {
                continue;
            }
            self.native_id_index.insert(entry.native_id.clone(), *uuid);
            self.path_index.insert(entry.path.clone(), *uuid);
        }
    }

    /// Flip the dirty flag. Small helper so call sites read as intent
    /// rather than a raw field poke.
    pub fn mark_dirty(&mut self)
    {
        self.dirty = true;
    }
}

// ---------------------------------------------------------------------------
// LoadedRegistry constructors
// ---------------------------------------------------------------------------

impl LoadedRegistry
{
    /// Fresh empty registry for a project that has no `registry.json` yet.
    /// `dirty: true` so the first mutation-driven flush persists it.
    fn empty(root_path: PathBuf) -> Self
    {
        Self
        {
            project_uuid: Uuid::new_v4(),
            root_path,
            entries: HashMap::new(),
            native_id_index: HashMap::new(),
            path_index: HashMap::new(),
            dirty: true,
            last_save: Instant::now(),
        }
    }

    /// Adopt a `RegistryFile` loaded from disk into the in-memory shape.
    /// `project_root` is the runtime-supplied path (never from disk).
    fn from_file(file: RegistryFile, project_root: PathBuf, dirty: bool) -> Self
    {
        let mut entries: HashMap<Uuid, RegistryEntry> = HashMap::new();
        for (k, v) in file.entries
        {
            match Uuid::parse_str(&k)
            {
                Ok(u) => { entries.insert(u, v); }
                Err(e) =>
                {
                    eprintln!(
                        "[registry] dropping unparseable UUID key '{}': {}",
                        k, e,
                    );
                }
            }
        }

        let mut reg = Self
        {
            project_uuid: file.project_uuid,
            root_path: project_root,
            entries,
            native_id_index: HashMap::new(),
            path_index: HashMap::new(),
            dirty,
            last_save: Instant::now(),
        };
        reg.rebuild_indices();
        reg
    }
}

// ---------------------------------------------------------------------------
// ProjectRegistryState
// ---------------------------------------------------------------------------

/// Tauri managed-state wrapper around `Option<LoadedRegistry>`.
///
/// See the module docs for the locking model. Public shape mirrors
/// [`crate::ProjectRoot`].
pub struct ProjectRegistryState(pub Mutex<Option<LoadedRegistry>>);

impl ProjectRegistryState
{
    /// Empty state — no project loaded. Constructed once at app boot and
    /// registered via `.manage(ProjectRegistryState::new())` in
    /// [`crate::run`].
    pub fn new() -> Self
    {
        Self(Mutex::new(None))
    }

    /// Load the registry for `project_root` into memory, replacing any
    /// previously-loaded registry.
    ///
    /// Cases:
    /// - `Ok` from [`load_from_disk`] → adopt the file, `dirty: false`.
    /// - [`LoadErr::NotFound`] → synthesise an empty registry with a fresh
    ///   `project_uuid` and `dirty: true` (so the first mutation flush
    ///   persists it).
    /// - [`LoadErr::BakRecovered`] → log a warning via `eprintln!`, adopt
    ///   the recovered payload with `dirty: true` so the next save
    ///   promotes it back to primary.
    /// - [`LoadErr::Corrupt`] → on corruption the inner state is cleared to
    ///   `None`; subsequent [`with_loaded`](Self::with_loaded) calls will
    ///   surface `no-project-open` until a successful `load_for` runs. A
    ///   later command (Part 3) will trigger the rebuild-from-scan path.
    pub fn load_for(&self, project_root: &Path) -> Result<(), String>
    {
        let loaded = match load_from_disk(project_root)
        {
            Ok(file) =>
            {
                LoadedRegistry::from_file(file, project_root.to_path_buf(), false)
            }

            Err(LoadErr::NotFound) =>
            {
                LoadedRegistry::empty(project_root.to_path_buf())
            }

            Err(LoadErr::BakRecovered { registry, warning }) =>
            {
                eprintln!(
                    "[registry] recovered from .bak for {}: {}",
                    project_root.display(),
                    warning,
                );
                LoadedRegistry::from_file(registry, project_root.to_path_buf(), true)
            }

            Err(LoadErr::Corrupt { primary_err, bak_err }) =>
            {
                if let Ok(mut guard) = self.0.lock()
                {
                    *guard = None;
                }
                return Err(format!(
                    "registry-corrupt:primary={};bak={}",
                    primary_err, bak_err,
                ));
            }
        };

        let mut guard = self.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(loaded);
        Ok(())
    }

    /// Drop the currently-loaded registry without flushing. Callers that
    /// need to persist should call [`flush_if_dirty`] first.
    pub fn clear(&self)
    {
        if let Ok(mut g) = self.0.lock()
        {
            *g = None;
        }
    }

    /// Accessor for the inner registry. Yields `&mut LoadedRegistry` to
    /// the closure. Returns `Err("no-project-open")` when no project is
    /// loaded.
    ///
    /// This is the RMW accessor Part 3 commands use — the caller is
    /// responsible for setting `dirty` on mutation (or using a helper
    /// that does so).
    ///
    /// Indices are rebuilt automatically after `f` returns; callers must
    /// NOT call [`rebuild_indices`](LoadedRegistry::rebuild_indices)
    /// themselves. The rebuild is O(entries.len()) and unconditional —
    /// no attempt is made to detect whether `f` actually mutated anything.
    ///
    /// # Re-entrancy
    ///
    /// `f` MUST NOT call [`flush_if_dirty`](Self::flush_if_dirty),
    /// [`load_for`](Self::load_for), or [`with_loaded`](Self::with_loaded)
    /// on the same `ProjectRegistryState` — the inner `Mutex` is not
    /// reentrant and will deadlock.
    pub fn with_loaded<F, R>(&self, f: F) -> Result<R, RegistryStateErr>
    where
        F: FnOnce(&mut LoadedRegistry) -> R,
    {
        let mut guard = self
            .0
            .lock()
            .map_err(|e| RegistryStateErr::MutexPoisoned(e.to_string()))?;
        match guard.as_mut()
        {
            Some(reg) =>
            {
                let result = f(reg);
                reg.rebuild_indices();
                Ok(result)
            }
            None => Err(RegistryStateErr::NoProjectOpen),
        }
    }

    /// Persist the in-memory registry to disk if dirty.
    ///
    /// Returns:
    /// - `Ok(true)` — flushed. `dirty` cleared, `last_save` refreshed.
    /// - `Ok(false)` — no project loaded, or loaded but not dirty. Nothing
    ///   written.
    /// - `Err(RegistryStateErr::MutexPoisoned(_))` — inner mutex was
    ///   poisoned by a panic in a previous borrower.
    /// - `Err(RegistryStateErr::SaveFailed(_))` — [`save_atomic`] failed.
    ///   The in-memory state is untouched (still dirty, safe to retry).
    pub fn flush_if_dirty(&self) -> Result<bool, RegistryStateErr>
    {
        let mut guard = self
            .0
            .lock()
            .map_err(|e| RegistryStateErr::MutexPoisoned(e.to_string()))?;
        let reg = match guard.as_mut()
        {
            Some(r) => r,
            None => return Ok(false),
        };
        if !reg.dirty
        {
            return Ok(false);
        }
        let file = reg.to_registry_file();
        save_atomic(&reg.root_path, &file)
            .map_err(|e| RegistryStateErr::SaveFailed(e.to_string()))?;
        reg.dirty = false;
        reg.last_save = Instant::now();
        Ok(true)
    }
}

impl Default for ProjectRegistryState
{
    fn default() -> Self
    {
        Self::new()
    }
}
