//! Copy / delete / trash / force-delete commands + art-cleanup helpers.
//! Extracted from lib.rs verbatim — no behaviour changes.

use std::path::{Path, PathBuf};

use crate::art_map::{art_map_drop, art_map_drop_prefix, art_map_get, resolve_art_path};
use crate::commands::project::{is_script_filename, storyboard_dir};
use crate::commands::project_mutations::{read_project_json, write_project_json};
use crate::fs_helpers;
use crate::fs_helpers::next_free_name;
use crate::locks::ProjectJsonLocks;
use crate::project_root::{ProjectRoot, assert_within_project_root};
use crate::script_map::{script_map_drop, script_map_drop_prefix};
use crate::slides_links::slides_link_drop as slides_link_drop_pure;

use super::crud::{project_rel_path, rel_join};
use super::fs_events::{FsChange, emit_fs_changed};
use super::fs_events::{split_base_and_ext, strip_trailing_number};

// ── app_copy_file ────────────────────────────────────────────────────────

/// Copy a file to a sibling with a duplicate-numbered name. Folders are
/// rejected — recursive folder copies are out of scope for this milestone.
pub fn copy_file_impl(path: &Path) -> Result<PathBuf, String>
{
    if !path.exists()
    {
        return Err("not-found".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir()
    {
        return Err("not-supported".into());
    }
    let parent = path.parent().ok_or("no-parent")?;
    let name = path
        .file_name()
        .ok_or("no-basename")?
        .to_string_lossy()
        .to_string();
    let (raw_base, ext_chain) = split_base_and_ext(&name);
    let base = strip_trailing_number(&raw_base);
    let new_name = next_free_name(parent, &base, &ext_chain, 2);
    let dst = parent.join(&new_name);
    std::fs::copy(path, &dst).map_err(|e| format!("copy-error:{}", e))?;
    Ok(dst)
}

#[tauri::command]
pub fn app_copy_file(app: tauri::AppHandle, path: String) -> Result<String, String>
{
    let p = Path::new(&path);
    let dst = copy_file_impl(p)?;
    let dst_str = dst.to_string_lossy().to_string();
    emit_fs_changed(&app, &path, FsChange::Copied { to: dst_str.clone() });
    Ok(dst_str)
}

// ── app_delete_file ──────────────────────────────────────────────────────

/// Map a `trash` crate error to one of our stable error codes.
/// Desktop-only: the trash crate is not part of the Android dep set.
/// Kept for downstream callers that want richer error messages than the
/// generic `trash-error:...` produced by [`fs_helpers::trash_or_remove`].
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[allow(dead_code)]
pub fn classify_trash_error(err: trash::Error) -> String
{
    match err
    {
        trash::Error::Os { code, description } =>
        {
            format!("os-error:{}:{}", code, description)
        }
        trash::Error::Unknown { description } =>
        {
            let d = description.to_lowercase();
            if d.contains("trash") || d.contains("freedesktop")
            {
                "trash-unavailable".into()
            }
            else
            {
                format!("unknown:{}", description)
            }
        }
        other => format!("trash-error:{}", other),
    }
}

/// Pure helper backing `app_delete_file`. See
/// TODO/mangaplay-storyboard-relocation.md Phase 4.
///
/// When `project_root` is provided AND `path` is a script file (per
/// `is_script_filename`) AND `project.json` has an `artMap.scripts` entry
/// for the script's project-root-relative path, the matching `.mangaart`
/// file is trashed and the map entry is dropped. Best-effort: a missing
/// `project.json`, an absent map entry, or a failure to trash the art file
/// never blocks the script delete.
///
/// Order of operations (chosen to keep failure states recoverable):
///   1. trash the script file (the user's intent)
///   2. drop the artMap entry and write `project.json`
///   3. trash the `.mangaart` file
///
/// If (1) fails, nothing else runs — the user can retry. If (1) succeeds but
/// (2) fails, the art file is orphaned with a stale map entry — harmless;
/// the next scaffold call for the same script path recovers. If (1) and (2)
/// succeed but (3) fails, the art file is orphaned without a map entry —
/// dead bytes on disk, never referenced.
///
/// Folder deletes (`path.is_dir()`) route through a separate branch (Phase 6):
/// the script-side folder is trashed first, then every `artMap.scripts` key
/// under `<folderRel>/` is dropped and the mirrored
/// `<root>/storyboard/<folderRel>/` subtree is trashed too. Art-side steps
/// are best-effort and never unwind the script delete.
pub fn delete_file_impl(
    path: &Path,
    project_root: Option<&Path>,
) -> Result<(), String>
{
    if !path.exists()
    {
        return Err("not-found".into());
    }

    // ── FOLDER delete branch (Phase 6) ────────────────────────────────────
    if path.is_dir()
    {
        // Capture rel path BEFORE the trash so `project_rel_path` resolves
        // against the still-existing source path.
        let folder_rel_opt = project_root
            .and_then(|root| project_rel_path(root, path));

        // (1) Trash the script folder first. If this fails, art is untouched.
        fs_helpers::trash_or_remove(path)?;

        // (2) - (5) best-effort, never unwind.
        if let (Some(root), Some(folder_rel)) = (project_root, folder_rel_opt)
        {
            apply_folder_art_cleanup_trash(root, &folder_rel);
        }

        return Ok(());
    }

    // ── FILE delete branch (Phase 4) ──────────────────────────────────────
    // Compute art-side bookkeeping inputs BEFORE trashing the script, while
    // the file still exists (`is_file` would flip to false post-trash, and
    // `project_rel_path` doesn't care either way, but we want the gate
    // decision frozen on the pre-trash state).
    let art_cleanup = compute_art_cleanup(path, project_root);

    // (1) Trash the script first. If this fails, leave map and art untouched.
    fs_helpers::trash_or_remove(path)?;

    // (2) + (3) — best-effort, never unwind the script delete.
    if let Some((root, script_rel, uuid)) = art_cleanup
    {
        apply_art_cleanup_trash(&root, &script_rel, &uuid);
    }

    Ok(())
}

#[tauri::command]
pub fn app_delete_file(
    app: tauri::AppHandle,
    state: tauri::State<ProjectRoot>,
    path: String,
    project_root: Option<String>,
) -> Result<(), String>
{
    let safe = assert_within_project_root(Path::new(&path), &state)?;
    let root_buf = project_root.as_deref().map(Path::new);
    delete_file_impl(&safe, root_buf)?;
    emit_fs_changed(&app, &path, FsChange::Deleted);
    Ok(())
}

// ── app_delete_file_force ────────────────────────────────────────────────

pub fn force_delete_impl(path: &Path) -> Result<(), String>
{
    if !path.exists()
    {
        return Err("not-found".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir()
    {
        std::fs::remove_dir_all(path).map_err(|e| format!("delete-error:{}", e))
    }
    else
    {
        std::fs::remove_file(path).map_err(|e| format!("delete-error:{}", e))
    }
}

/// Force-delete variant of [`delete_file_impl`]. Same ordering and same
/// best-effort semantics — only differences are:
///   * the script is removed via `std::fs::remove_file` (skips trash)
///   * the matching art file is removed via `std::fs::remove_file` (same)
///
/// The shared `force_delete_impl` is intentionally untouched so the folder
/// delete path (Phase 6) can keep using it unchanged.
pub fn delete_file_force_impl(
    path: &Path,
    project_root: Option<&Path>,
) -> Result<(), String>
{
    if !path.exists()
    {
        return Err("not-found".into());
    }

    // ── FOLDER delete branch (Phase 6) ────────────────────────────────────
    if path.is_dir()
    {
        let folder_rel_opt = project_root
            .and_then(|root| project_rel_path(root, path));

        force_delete_impl(path)?;

        if let (Some(root), Some(folder_rel)) = (project_root, folder_rel_opt)
        {
            apply_folder_art_cleanup_remove(root, &folder_rel);
        }

        return Ok(());
    }

    // ── FILE delete branch (Phase 4) ──────────────────────────────────────
    let art_cleanup = compute_art_cleanup(path, project_root);

    force_delete_impl(path)?;

    if let Some((root, script_rel, uuid)) = art_cleanup
    {
        apply_art_cleanup_remove(&root, &script_rel, &uuid);
    }

    Ok(())
}

#[tauri::command]
pub fn app_delete_file_force(
    app: tauri::AppHandle,
    state: tauri::State<ProjectRoot>,
    path: String,
    project_root: Option<String>,
) -> Result<(), String>
{
    let safe = assert_within_project_root(Path::new(&path), &state)?;
    let root_buf = project_root.as_deref().map(Path::new);
    delete_file_force_impl(&safe, root_buf)?;
    emit_fs_changed(&app, &path, FsChange::Deleted);
    Ok(())
}

/// Decide whether a delete call needs to do art bookkeeping. Returns
/// `Some((project_root, script_rel_path, uuid))` when ALL gates pass:
///   * project root supplied (call originated inside an open project)
///   * the path is a regular file (folder delete is Phase 6's job)
///   * basename is a script filename per [`is_script_filename`]
///   * the path lives under `project_root` (else `project_rel_path` returns
///     `None`)
///   * `project.json` parses and has an `artMap.scripts` entry for the path
///
/// Any gate failing → `None`, and the caller skips art handling.
fn compute_art_cleanup(
    path: &Path,
    project_root: Option<&Path>,
) -> Option<(std::path::PathBuf, String, String)>
{
    let root = project_root?;
    if !path.is_file()
    {
        return None;
    }
    let name = path.file_name().and_then(|n| n.to_str())?;
    if !is_script_filename(name)
    {
        return None;
    }
    let script_rel = project_rel_path(root, path)?;
    let pj = read_project_json(root).ok()?;
    let uuid = art_map_get(&pj, &script_rel)?;
    Some((root.to_path_buf(), script_rel, uuid))
}

/// Apply the art cleanup using the trash crate for the `.mangaart` file.
/// Best-effort throughout: errors are logged via `eprintln!` and swallowed
/// so the caller (which has already deleted the script) keeps making
/// progress.
pub fn apply_art_cleanup_trash(root: &Path, script_rel: &str, uuid: &str)
{
    let locks = ProjectJsonLocks::global();
    let lock = locks.lock_for(root);
    let _guard = lock.lock().expect("project-json mutex poisoned");
    apply_art_cleanup_trash_locked(root, script_rel, uuid);
}

/// Lockless variant of [`apply_art_cleanup_trash`]. Skips the
/// `ProjectJsonLocks` acquisition — callers MUST already hold the per-project
/// mutex, otherwise the read-modify-write on `project.json` races. Used by
/// `registry_delete_impl`, which already takes the lock in `delete_dispatch`
/// before entering the impl (double-acquire would deadlock — same mutex,
/// same thread, non-reentrant).
pub fn apply_art_cleanup_trash_locked(root: &Path, script_rel: &str, uuid: &str)
{
    let Ok(mut pj) = read_project_json(root)
    else
    {
        eprintln!(
            "[delete] art cleanup skipped: project.json unreadable at {}",
            root.display(),
        );
        return;
    };
    art_map_drop(&mut pj, script_rel);
    script_map_drop(&mut pj, script_rel);
    slides_link_drop_pure(&mut pj, uuid);
    if let Err(e) = write_project_json(root, &pj)
    {
        eprintln!("[delete] failed to write project.json after drop: {}", e);
        return;
    }
    let art_path = resolve_art_path(root, script_rel, uuid);
    if art_path.exists()
    {
        if let Err(e) = fs_helpers::trash_or_remove(&art_path)
        {
            eprintln!(
                "[delete] failed to trash art file {}: {}",
                art_path.display(),
                e,
            );
        }
    }
}

/// Like [`apply_art_cleanup_trash`] but uses `std::fs::remove_file` for the
/// `.mangaart` file — used by the force-delete path so the call stays
/// trash-free end to end (matches the script-side `force_delete_impl`).
pub fn apply_art_cleanup_remove(root: &Path, script_rel: &str, uuid: &str)
{
    let locks = ProjectJsonLocks::global();
    let lock = locks.lock_for(root);
    let _guard = lock.lock().expect("project-json mutex poisoned");
    apply_art_cleanup_remove_locked(root, script_rel, uuid);
}

/// Lockless variant of [`apply_art_cleanup_remove`]. See
/// [`apply_art_cleanup_trash_locked`] for the invariant callers must uphold.
pub fn apply_art_cleanup_remove_locked(root: &Path, script_rel: &str, uuid: &str)
{
    let Ok(mut pj) = read_project_json(root)
    else
    {
        eprintln!(
            "[delete-force] art cleanup skipped: project.json unreadable at {}",
            root.display(),
        );
        return;
    };
    art_map_drop(&mut pj, script_rel);
    script_map_drop(&mut pj, script_rel);
    slides_link_drop_pure(&mut pj, uuid);
    if let Err(e) = write_project_json(root, &pj)
    {
        eprintln!("[delete-force] failed to write project.json after drop: {}", e);
        return;
    }
    let art_path = resolve_art_path(root, script_rel, uuid);
    if art_path.exists()
    {
        if let Err(e) = std::fs::remove_file(&art_path)
        {
            eprintln!(
                "[delete-force] failed to remove art file {}: {}",
                art_path.display(),
                e,
            );
        }
    }
}

/// Best-effort folder-delete art cleanup using the trash crate (Phase 6).
/// Called AFTER the script folder has already been trashed; any failure here
/// is logged via `eprintln!` and never unwinds the script delete.
///
/// Steps:
///   1. Read `project.json`. If unreadable, skip — the script folder is
///      already gone and the user's intent is satisfied.
///   2. [`art_map_drop_prefix`] — drop every `artMap.scripts` key starting
///      with `<folder_rel>/`. Trailing-slash safe (`foo` does NOT match
///      `foobar/...`).
///   3. Write `project.json`.
///   4. If `<root>/storyboard/<folder_rel>/` exists, trash it. No mirrored
///      subtree exists when no script in the folder ever had art scaffolded —
///      a clean no-op.
fn apply_folder_art_cleanup_trash(root: &Path, folder_rel: &str)
{
    let locks = ProjectJsonLocks::global();
    let lock = locks.lock_for(root);
    let _guard = lock.lock().expect("project-json mutex poisoned");

    let Ok(mut pj) = read_project_json(root)
    else
    {
        eprintln!(
            "[delete-folder] art cleanup skipped: project.json unreadable at {}",
            root.display(),
        );
        return;
    };
    art_map_drop_prefix(&mut pj, folder_rel);
    script_map_drop_prefix(&mut pj, folder_rel);
    if let Err(e) = write_project_json(root, &pj)
    {
        eprintln!(
            "[delete-folder] failed to write project.json after drop_prefix: {}",
            e,
        );
        return;
    }
    let storyboard_subtree = rel_join(&storyboard_dir(root), folder_rel);
    if storyboard_subtree.exists()
    {
        if let Err(e) = fs_helpers::trash_or_remove(&storyboard_subtree)
        {
            eprintln!(
                "[delete-folder] failed to trash storyboard subtree {}: {}",
                storyboard_subtree.display(),
                e,
            );
        }
    }
}

/// Like [`apply_folder_art_cleanup_trash`] but uses `std::fs::remove_dir_all`
/// for the storyboard subtree — used by the force-delete folder path so the
/// call stays trash-free end to end.
fn apply_folder_art_cleanup_remove(root: &Path, folder_rel: &str)
{
    let Ok(mut pj) = read_project_json(root)
    else
    {
        eprintln!(
            "[delete-folder-force] art cleanup skipped: project.json unreadable at {}",
            root.display(),
        );
        return;
    };
    art_map_drop_prefix(&mut pj, folder_rel);
    if let Err(e) = write_project_json(root, &pj)
    {
        eprintln!(
            "[delete-folder-force] failed to write project.json after drop_prefix: {}",
            e,
        );
        return;
    }
    let storyboard_subtree = rel_join(&storyboard_dir(root), folder_rel);
    if storyboard_subtree.exists()
    {
        if let Err(e) = std::fs::remove_dir_all(&storyboard_subtree)
        {
            eprintln!(
                "[delete-folder-force] failed to remove storyboard subtree {}: {}",
                storyboard_subtree.display(),
                e,
            );
        }
    }
}
