//! Project mutation commands: rename / move folder + path. Extracted from
//! lib.rs verbatim — no behaviour changes.
//!
//! Pure helpers (`move_path_impl`, `move_path_with_art`, `read_project_json`,
//! `write_project_json`) are exposed `pub` so the integration tests under
//! `tests/` can exercise them without a Tauri runtime. The crate root in
//! lib.rs re-exports them so `app_lib::<name>` paths keep working.

use std::path::{Path, PathBuf};

use crate::art_map::{art_map_drop, art_map_get, art_map_set};
use crate::commands::project::{app_dir, is_script_filename, project_json_path, read_project_json_locked};
use crate::fs_helpers::{atomic_write_impl, chrono_iso_now};
use crate::locks::ProjectJsonLocks;
use crate::script_map::script_map_rewrite_key;
use crate::commands::file_ops::crud::{apply_folder_art_relocation, project_rel_path};

// ── Project rename / move / close commands ────────────────────────────────

/// Rename the project's visual name (NOT the folder).
/// `scope = "local"` writes per-machine to recent.json.displayNameOverride.
/// `scope = "shared"` writes to <project>/project.json.displayName (shared).
#[tauri::command]
pub fn app_rename_project(
    app: tauri::AppHandle,
    project_path: String,
    display_name: Option<String>,
    scope: String,
) -> Result<(), String> {
    let project_dir = std::path::Path::new(&project_path);
    if read_project_json_locked(project_dir) {
        return Err("project-locked".into());
    }

    let scope = scope.as_str();
    if scope != "local" && scope != "shared" {
        return Err("scope must be 'local' or 'shared'".into());
    }

    if scope == "shared" {
        let project_dir = std::path::Path::new(&project_path);
        // Ensure the app dir exists so the atomic write's `.tmp` sibling
        // resolves. No-op when already scaffolded.
        let _ = std::fs::create_dir_all(app_dir(project_dir));
        let pj_path = project_json_path(project_dir);
        let mut body: serde_json::Value = if pj_path.exists() {
            let raw = std::fs::read_to_string(&pj_path).map_err(|e| e.to_string())?;
            serde_json::from_str(&raw).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "createdAt": chrono_iso_now(),
            })
        };
        body["displayName"] = match display_name {
            Some(s) => serde_json::Value::String(s),
            None => serde_json::Value::Null,
        };
        atomic_write_impl(
            &pj_path.to_string_lossy(),
            &serde_json::to_string_pretty(&body).unwrap(),
        )?;
        // When shared name changes, clear any local override so the new
        // shared name actually takes effect on this machine. UI prompts
        // first if it wants to keep the override.
        let _ = crate::commands::recent::update_recent_field(&app, &project_path, "displayNameOverride", serde_json::Value::Null);
    } else {
        // local scope: write recent.json[].displayNameOverride only.
        let v = match display_name {
            Some(s) => serde_json::Value::String(s),
            None => serde_json::Value::Null,
        };
        crate::commands::recent::update_recent_field(&app, &project_path, "displayNameOverride", v)?;
    }

    Ok(())
}

/// Rename ONLY the folder on disk (and update recent.json path). Refuses if
/// `currently_open` is true — UI must return to the picker (which closes the
/// active project) before invoking this command.
#[tauri::command]
pub fn app_rename_folder(
    app: tauri::AppHandle,
    project_path: String,
    new_basename: String,
    currently_open: bool,
) -> Result<String, String> {
    if currently_open {
        return Err("project-is-open".into());
    }
    if new_basename.is_empty() || new_basename.contains('/') || new_basename.contains('\\') {
        return Err("invalid-name".into());
    }
    let src = std::path::Path::new(&project_path);
    if read_project_json_locked(src) {
        return Err("project-locked".into());
    }
    let parent = src.parent().ok_or("no parent")?.to_path_buf();
    let dst = parent.join(&new_basename);
    if dst.exists() {
        return Err("target-exists".into());
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    let dst_str = dst.to_string_lossy().to_string();
    // Update recent.json: rewrite the path.
    crate::commands::recent::update_recent_path(&app, &project_path, &dst_str)?;
    Ok(dst_str)
}

/// Move a project folder to a different parent dir. Cross-device (EXDEV)
/// safe — delegates to `move_path_impl` for the rename + symlink/descendant
/// guard. This command additionally refuses when the project is open and
/// updates `recent.json` after a successful move.
#[tauri::command]
pub fn app_move_folder(
    app: tauri::AppHandle,
    project_path: String,
    new_parent: String,
    currently_open: bool,
) -> Result<String, String> {
    if currently_open {
        return Err("project-is-open".into());
    }
    let src = std::path::Path::new(&project_path);
    if read_project_json_locked(src) {
        return Err("project-locked".into());
    }
    let parent = std::path::Path::new(&new_parent);
    let dst = move_path_impl(src, parent)?;
    let dst_str = dst.to_string_lossy().to_string();
    crate::commands::recent::update_recent_path(&app, &project_path, &dst_str)?;
    Ok(dst_str)
}

fn is_cross_device(e: &std::io::Error) -> bool {
    // EXDEV on Unix, ERROR_NOT_SAME_DEVICE (17) on Windows.
    e.raw_os_error() == Some(18) || e.raw_os_error() == Some(17)
}

/// Read `<project_dir>/_mangaplaystudio/project.json` as a full JSON value.
///
/// Returns `Err("project-json-missing")` when the file is absent so callers
/// can distinguish that condition from a parse failure. Used by the read-
/// modify-write paths in the art-relocation flow (scaffold, rename, delete).
/// Exposed `pub` for integration tests.
pub fn read_project_json(project_dir: &std::path::Path) -> Result<serde_json::Value, String>
{
    let pj = project_json_path(project_dir);
    if !pj.exists()
    {
        return Err("project-json-missing".into());
    }
    let raw = std::fs::read_to_string(&pj).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Atomically write `value` (pretty-printed) to
/// `<project_dir>/_mangaplaystudio/project.json`.
///
/// Pairs with [`read_project_json`] for the read-modify-write pattern used by
/// the art-relocation flow. Creates the parent app dir if missing so the
/// atomic helper's `.tmp` sibling resolves on a freshly-minted project.
/// Exposed `pub` for integration tests.
pub fn write_project_json(
    project_dir: &std::path::Path,
    value: &serde_json::Value,
) -> Result<(), String>
{
    std::fs::create_dir_all(app_dir(project_dir)).map_err(|e| e.to_string())?;
    let pj = project_json_path(project_dir);
    let pretty = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    atomic_write_impl(&pj.to_string_lossy(), &pretty)
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Move a file or folder INSIDE an open project to a different parent dir.
///
/// Unlike `app_move_folder` (project-level, refuses when the project is open),
/// this is the in-project version used by the file explorer's drag-and-drop.
///
/// Rules:
///   * `src` must exist.
///   * `new_parent` must be an existing directory.
///   * If `src` is a directory: reject when `new_parent` is `src` or a
///     descendant of `src` (move-into-self / move-into-descendant).
///   * Destination basename is preserved from `src`. If the destination
///     already exists, returns `"target-exists"`.
///   * Cross-device (EXDEV) → copy + delete with rollback.
pub fn move_path_impl(
    src: &std::path::Path,
    new_parent: &std::path::Path,
) -> Result<std::path::PathBuf, String>
{
    if !src.exists()
    {
        return Err("source-not-found".into());
    }
    if !new_parent.is_dir()
    {
        return Err("parent-not-dir".into());
    }

    let src_is_dir = src.is_dir();
    if src_is_dir
    {
        // Defeat symlink tricks: canonicalize both before the prefix check.
        // Fall back to the raw paths when canonicalize fails (non-existent
        // sub-segments, permissions) so the test surface still catches the
        // obvious cases.
        let src_canon = std::fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
        let parent_canon = std::fs::canonicalize(new_parent)
            .unwrap_or_else(|_| new_parent.to_path_buf());
        if parent_canon == src_canon || parent_canon.starts_with(&src_canon)
        {
            return Err("move-into-descendant".into());
        }
    }

    let basename = src.file_name().ok_or("no basename")?;
    let dst = new_parent.join(basename);
    if dst.exists()
    {
        return Err("target-exists".into());
    }

    match std::fs::rename(src, &dst)
    {
        Ok(()) => Ok(dst),
        Err(e) if is_cross_device(&e) =>
        {
            if src_is_dir
            {
                if let Err(copy_err) = copy_dir_recursive(src, &dst)
                {
                    let _ = std::fs::remove_dir_all(&dst);
                    return Err(format!("copy failed: {}", copy_err));
                }
                if let Err(del_err) = std::fs::remove_dir_all(src)
                {
                    return Err(format!(
                        "moved to {} but source remains (delete failed: {})",
                        dst.display(), del_err
                    ));
                }
            }
            else
            {
                if let Err(copy_err) = std::fs::copy(src, &dst)
                {
                    let _ = std::fs::remove_file(&dst);
                    return Err(format!("copy failed: {}", copy_err));
                }
                if let Err(del_err) = std::fs::remove_file(src)
                {
                    return Err(format!(
                        "moved to {} but source remains (delete failed: {})",
                        dst.display(), del_err
                    ));
                }
            }
            Ok(dst)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Move a file or folder INSIDE an open project, then keep the artMap and
/// the `<root>/storyboard/` mirror in sync.
///
/// Always calls [`move_path_impl`] first — that's the visible filesystem
/// operation. Only after it succeeds does the artMap bookkeeping run, and
/// every art-side step is best-effort (warn-only) so a stale map never
/// blocks the move that the user actually asked for.
///
/// Two shapes of art bookkeeping, mirroring the rename code path:
///
/// * **Source is a folder.** Treat like a folder rename: prefix-rewrite every
///   `artMap.scripts` key under the old folder path to use the new path, and
///   physically rename `<root>/storyboard/<old_rel>/` to
///   `<root>/storyboard/<new_rel>/`. Same best-effort discipline as
///   [`apply_folder_art_relocation`].
///
/// * **Source is a single script file.** Rewrite the single artMap key from
///   old rel → new rel; the `.mangaart` file is NOT moved. The art's identity
///   is its UUID, the mirrored folder is
///   a human-browsable convenience derived from the script's *creation*
///   address, not its current one. (Folder-level ops still move the subtree
///   because the user's intent is wholesale relocation; single-file moves
///   shouldn't drag the bytes around.)
///
/// * **Source is a non-script file.** No art bookkeeping.
///
/// When `project_root` is `None` this degrades to a plain `move_path_impl`.
pub fn move_path_with_art(
    src: &Path,
    new_parent: &Path,
    project_root: Option<&Path>,
) -> Result<PathBuf, String>
{
    // Snapshot relevant inputs BEFORE the move while `src` still exists.
    let src_is_dir = src.is_dir();
    let src_basename = src.file_name().and_then(|n| n.to_str()).map(str::to_string);
    let old_rel = project_root.and_then(|root| project_rel_path(root, src));

    let dst = move_path_impl(src, new_parent)?;

    if let (Some(root), Some(old_rel_str)) = (project_root, old_rel)
    {
        let new_rel_opt = project_rel_path(root, &dst);
        let Some(new_rel_str) = new_rel_opt else { return Ok(dst); };
        if old_rel_str == new_rel_str
        {
            return Ok(dst);
        }

        if src_is_dir
        {
            apply_folder_art_relocation(root, &old_rel_str, &new_rel_str);
        }
        else if let Some(name) = src_basename
        {
            if is_script_filename(&name)
            {
                let locks = ProjectJsonLocks::global();
                let lock = locks.lock_for(root);
                let _guard = lock.lock().expect("project-json mutex poisoned");

                if let Ok(mut pj) = read_project_json(root)
                {
                    let pre = pj.clone();
                    if let Some(uuid) = art_map_get(&pj, &old_rel_str)
                    {
                        art_map_drop(&mut pj, &old_rel_str);
                        art_map_set(&mut pj, &new_rel_str, &uuid);
                    }
                    // scriptMap is the new authority; rewrite regardless of
                    // legacy artMap presence.
                    script_map_rewrite_key(&mut pj, &old_rel_str, &new_rel_str);
                    if pj != pre
                    {
                        if let Err(e) = write_project_json(root, &pj)
                        {
                            log::warn!(
                                "[move] failed to write project.json for {} -> {}: {}",
                                old_rel_str, new_rel_str, e,
                            );
                        }
                    }
                }
            }
        }
    }

    Ok(dst)
}

