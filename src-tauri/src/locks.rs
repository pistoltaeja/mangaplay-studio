// ---------------------------------------------------------------------------
// Per-project mutex for project.json read-modify-write cycles.
//
// scriptMap mint is a read-modify-write — read project.json, mutate
// scriptMap, atomic-write back. Two callers (JS publish + Rust mangaart
// scaffold) racing here would silently clobber each other's other-field
// mutations because the artMap / scriptMap helpers only touch their own
// subtree but the write rewrites the whole file.
//
// `ProjectJsonLocks` hands out a per-project `Arc<Mutex<()>>` keyed by
// canonical project path. All RMW cycles MUST acquire it for the entire
// read → mutate → write.
//
// The lock map is a process-wide singleton — `ProjectJsonLocks` is a
// zero-sized handle that all instances share. We keep it as a struct
// (rather than naked free functions) so Tauri's `State<ProjectJsonLocks>`
// injection works for commands, AND pure `*_impl` helpers can call
// `ProjectJsonLocks::global()` without taking a parameter.
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

static LOCK_MAP: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

fn lock_map() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>
{
    LOCK_MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Default)]
pub struct ProjectJsonLocks;

impl ProjectJsonLocks
{
    pub fn new() -> Self
    {
        Self
    }

    /// Process-wide handle. Equivalent to `ProjectJsonLocks::new()` — both
    /// route to the same `LOCK_MAP` singleton. Use this from pure helpers
    /// that don't receive a Tauri `State`.
    pub fn global() -> Self
    {
        Self
    }

    /// Canonical path key. Uses `canonicalize` when the path exists, falls
    /// back to the raw path otherwise (test fixtures may not exist yet on
    /// first lock acquisition).
    fn canonical(path: &Path) -> PathBuf
    {
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
    }

    /// Get (or create) the lock for `project_path`. Lock is per-project;
    /// concurrent callers for different projects don't block each other.
    pub fn lock_for(&self, project_path: &Path) -> Arc<Mutex<()>>
    {
        let key = Self::canonical(project_path);
        let mut map = lock_map().lock().expect("ProjectJsonLocks inner mutex poisoned");
        map.entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}
