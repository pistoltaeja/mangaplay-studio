/// App-state guard for the currently-open project's canonical root path.
///
/// Populated by `project_open`, `project_pick_folder`, and `project_create_new`
/// after they validate the on-disk folder. FS commands that take a caller-
/// supplied `path` use [`assert_within_project_root`] to canonicalize and
/// containment-check the path against this value before any IO.
///
/// `None` means "no project open" — FS commands reject in that case rather
/// than fall through to an unscoped filesystem operation.
///
/// Wave 2b capability-scope-tighten. Pairs with the scoped `fs:*`
/// permissions in `capabilities/default.json` so even a JS supply-chain
/// attacker can't reach paths outside the user's chosen project.
pub struct ProjectRoot(pub std::sync::Mutex<Option<std::path::PathBuf>>);

impl ProjectRoot {
    pub fn new() -> Self { Self(std::sync::Mutex::new(None)) }
    /// Record `path` as the active project root. Best-effort canonicalize;
    /// falls back to the raw path on canonicalize failure (e.g. UNC quirks).
    pub fn set(&self, path: &std::path::Path) {
        let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if let Ok(mut g) = self.0.lock() {
            *g = Some(canon);
        }
    }
    pub fn get(&self) -> Option<std::path::PathBuf> {
        self.0.lock().ok().and_then(|g| g.clone())
    }
}

/// Canonicalize `path` and assert it lives under the currently-open project
/// root recorded in [`ProjectRoot`]. Returns the canonical path on success or
/// a stable string error on rejection:
///
///   * `"no-project-open"` — `ProjectRoot` is `None`.
///   * `"invalid-path:<reason>"` — canonicalize failed (typically ENOENT).
///   * `"path-escapes-project-root"` — canonical path is outside the root.
///
/// JS-side callers should map these to the existing error-toast UX rather
/// than surface the raw string.
pub fn assert_within_project_root(
    path: &std::path::Path,
    state: &ProjectRoot,
) -> Result<std::path::PathBuf, String> {
    let root = state.get().ok_or_else(|| "no-project-open".to_string())?;
    let canon = std::fs::canonicalize(path)
        .map_err(|e| format!("invalid-path:{}", e))?;
    if canon.starts_with(&root) {
        Ok(canon)
    } else {
        Err("path-escapes-project-root".to_string())
    }
}
