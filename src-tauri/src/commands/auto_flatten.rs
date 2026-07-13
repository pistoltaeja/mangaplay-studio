//! One-shot migration: collapse a legacy `<root>/project/` subdirectory up
//! into the project root.
//!
//! Older project layouts wrapped scripts and assets inside a `project/`
//! subfolder. `project_open` calls [`flatten_project_layout_impl`] on
//! every open as a best-effort migration — successful flattens are
//! silent, collisions return `flatten-collision:<name>` and leave the
//! filesystem untouched (the project still opens against whatever shape
//! is on disk).
//!
//! Re-exported at the crate root so `tests/flatten_migration.rs` can
//! exercise it without a Tauri runtime.

use std::path::{Path, PathBuf};

/// One-shot auto-flatten: if `<root>/project/` exists and contains entries,
/// move every direct child up to `<root>/` and remove the now-empty
/// `project/` dir. Returns Ok(true) when a flatten happened, Ok(false) when
/// nothing to do. Returns Err with `flatten-collision:<name>` when any move
/// target already exists at root — in that case NO files are moved.
pub fn flatten_project_layout_impl(root: &Path) -> Result<bool, String>
{
    let project_dir = root.join("project");
    if !project_dir.is_dir() { return Ok(false); }

    let entries: Vec<std::fs::DirEntry> = match std::fs::read_dir(&project_dir)
    {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(e) => return Err(format!("flatten-read:{}", e)),
    };
    if entries.is_empty()
    {
        let _ = std::fs::remove_dir(&project_dir);
        return Ok(false);
    }

    // Pre-flight collision check: bail before any move if ANY target name
    // already exists at root. Keeps the operation all-or-nothing.
    for entry in &entries
    {
        let name = entry.file_name();
        let target = root.join(&name);
        if target.exists()
        {
            return Err(format!("flatten-collision:{}", name.to_string_lossy()));
        }
    }

    let mut completed: Vec<(PathBuf, PathBuf)> = Vec::new();
    for entry in &entries
    {
        let name = entry.file_name();
        let src = entry.path();
        let dst = root.join(&name);
        if let Err(e) = std::fs::rename(&src, &dst)
        {
            // Roll back any moves already performed.
            for (s, d) in completed.iter().rev()
            {
                let _ = std::fs::rename(d, s);
            }
            return Err(format!("flatten-move:{}", e));
        }
        completed.push((src, dst));
    }
    let _ = std::fs::remove_dir(&project_dir);
    Ok(true)
}
