//! Mangaart commands: scaffold the per-script `.mangaart` file and resolve
//! its on-disk path. Storyboard-relocation helpers (`resolve_art_path`,
//! `art_map_*`, `script_map_*`) stay at the crate root because non-mangaart
//! commands also depend on them.
//!
//! Pure `*_impl` helpers exposed `pub` so `tests/mangaart_scaffold.rs` can
//! exercise them without a Tauri runtime.

use crate::{
    art_map_drop, art_map_find_script_by_uuid, art_map_set, atomic_write_impl,
    commands::project::storyboard_dir, fs_helpers, locks::ProjectJsonLocks,
    read_project_json, resolve_art_path, script_map_get_or_mint,
    script_map_get_with_legacy_pullforward, write_project_json,
};

/// Return the on-disk path for `<storyboard_root>/<uuid>.mangaart`. The
/// UUID-first layout stores every art file flat under the storyboard root,
/// so a rename or move of the script never has to touch the art file. This
/// path is authoritative — no scriptMap/artMap lookup, no fallbacks needed.
fn flat_uuid_art_path(project_dir: &std::path::Path, uuid: &str) -> std::path::PathBuf
{
    let mut p = storyboard_dir(project_dir);
    p.push(format!("{}.mangaart", uuid));
    p
}

/// Return the folder-scoped storyboard directory:
/// `<storyboard_root>/folders/`. Folder-scoped `.mangaart` files live one
/// level deeper than file-scoped ones so the two namespaces never collide
/// (folder-uuid and file-uuid are drawn from the same registry space).
fn storyboard_folders_dir(project_dir: &std::path::Path) -> std::path::PathBuf
{
    let mut p = storyboard_dir(project_dir);
    p.push("folders");
    p
}

/// Return the on-disk path for
/// `<storyboard_root>/folders/<folder_uuid>.mangaart`.
fn folder_uuid_art_path(
    project_dir: &std::path::Path,
    folder_uuid: &str,
) -> std::path::PathBuf
{
    let mut p = storyboard_folders_dir(project_dir);
    p.push(format!("{}.mangaart", folder_uuid));
    p
}

#[tauri::command]
pub fn mangaart_resolve_path(
    project_path: String,
    script_file: String,
) -> Result<Option<String>, String>
{
    mangaart_resolve_path_impl(&project_path, &script_file)
}

/// Pure helper backing the `mangaart_resolve_path` Tauri command. Exposed so
/// Rust integration tests can exercise the lookup without a Tauri runtime.
///
/// Returns:
///   * `Ok(Some(path))` — the mirrored storyboard path for the mapped UUID.
///     The file may or may not exist on disk (callers must handle the
///     crash-after-map-write recovery case via scaffold fallback).
///   * `Ok(None)`       — `project.json` exists but has no `scriptMap` or
///     legacy `artMap` entry for `script_file`. Caller should mint via
///     `mangaart_scaffold`.
///   * `Err("project-json-missing")` — no `project.json` at the project root.
///
/// Reads scriptMap first, falls back to legacy `artMap.scripts`, and pulls
/// the legacy entry forward into scriptMap when it fires. The pull-forward
/// is a write, so we acquire the per-project lock for the duration.
pub fn mangaart_resolve_path_impl(
    project_path: &str,
    script_file: &str,
) -> Result<Option<String>, String>
{
    use std::path::Path;

    let project_dir = Path::new(project_path);
    let locks = ProjectJsonLocks::global();
    let lock = locks.lock_for(project_dir);
    let _guard = lock.lock().expect("project-json mutex poisoned");

    let mut pj = read_project_json(project_dir)?;
    let pre = pj.clone();
    match script_map_get_with_legacy_pullforward(&mut pj, script_file)
    {
        Some(uuid) =>
        {
            if pj != pre
            {
                // Pulled forward from artMap — persist the new scriptMap entry.
                write_project_json(project_dir, &pj)?;
            }
            let path = resolve_art_path(project_dir, script_file, &uuid);
            if path.exists()
            {
                return Ok(Some(path.to_string_lossy().to_string()));
            }
            // identity fallback: file may have been left behind by a single-file
            // move — search by UUID under the storyboard root before giving up.
            let storyboard_root = storyboard_dir(project_dir);
            if let Some(found) = find_art_by_uuid(&storyboard_root, &uuid)
            {
                return Ok(Some(found.to_string_lossy().to_string()));
            }
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

// Recursively walk `root` looking for a file named `<uuid>.mangaart`. Returns
// the first depth-first hit, or None if the dir is missing / no match.
fn find_art_by_uuid(root: &std::path::Path, uuid: &str) -> Option<std::path::PathBuf>
{
    let target = format!("{}.mangaart", uuid);
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten()
    {
        let path = entry.path();
        let file_type = match entry.file_type()
        {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_file()
        {
            if entry.file_name() == std::ffi::OsStr::new(&target)
            {
                return Some(path);
            }
        }
        else if file_type.is_dir()
        {
            if let Some(found) = find_art_by_uuid(&path, uuid)
            {
                return Some(found);
            }
        }
    }
    None
}

#[tauri::command]
pub fn mangaart_scaffold(
    project_path: String,
    script_file: String,
) -> Result<serde_json::Value, String>
{
    mangaart_scaffold_impl(&project_path, &script_file)
}

/// Pure helper backing the `mangaart_scaffold` Tauri command. Exposed so
/// Rust integration tests can exercise the scaffold logic without spinning
/// up a Tauri runtime.
///
/// Behaviour (storyboard-relocation layout):
///   1. Read `<project_path>/project.json`. Err `project-json-missing` if absent.
///   2. Resolve the UUID for `script_file` via `script_map_get_or_mint` —
///      reads scriptMap, falls back to legacy artMap (pulled forward), or
///      mints a fresh UUID.
///   3. If the UUID resolved to an existing art file, read and return it
///      (idempotent).
///   4. Otherwise write a fresh empty art file under the resolved path.
///   5. On every write to project.json: held under the per-project lock so
///      a concurrent JS-side mint can't clobber our state.
pub fn mangaart_scaffold_impl(
    project_path: &str,
    script_file: &str,
) -> Result<serde_json::Value, String>
{
    use std::path::Path;

    let basename = script_file
        .strip_suffix(".md")
        .unwrap_or(script_file)
        .to_string();

    let project_dir = Path::new(project_path);
    let locks = ProjectJsonLocks::global();
    let lock = locks.lock_for(project_dir);
    let _guard = lock.lock().expect("project-json mutex poisoned");

    let mut project_json = read_project_json(project_dir)?;
    let (uuid, minted) = script_map_get_or_mint(&mut project_json, script_file);

    // Keep legacy artMap in sync — old code paths may still read from it
    // until the migration completes naturally on every project's next touch.
    art_map_set(&mut project_json, script_file, &uuid);

    if minted
    {
        write_project_json(project_dir, &project_json)?;
    }

    let art_path = resolve_art_path(project_dir, script_file, &uuid);
    if art_path.exists()
    {
        let raw = std::fs::read_to_string(&art_path).map_err(|e| e.to_string())?;
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        return Ok(parsed);
    }

    write_fresh_art_file(&art_path, &uuid, &basename, script_file)
}

/// Write a fresh empty `.mangaart` scaffold to `art_path` and return its
/// parsed body. Creates any missing parent directories. Caller owns UUID
/// minting + project.json bookkeeping.
fn write_fresh_art_file(
    art_path: &std::path::Path,
    uuid: &str,
    basename: &str,
    script_file: &str,
) -> Result<serde_json::Value, String>
{
    if let Some(parent) = art_path.parent()
    {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let now = chrono::Utc::now().to_rfc3339();
    let scaffold = serde_json::json!({
        "format": "mangaart:v1",
        "uuid": uuid,
        "name": basename,
        "scriptFile": script_file,
        "createdAt": now,
        "updatedAt": now,
        "pages": Vec::<serde_json::Value>::new(),
    });

    let pretty = serde_json::to_string_pretty(&scaffold).map_err(|e| e.to_string())?;
    atomic_write_impl(&art_path.to_string_lossy(), &pretty)?;
    Ok(scaffold)
}

// ---------------------------------------------------------------------------
// UUID-first resolve + scaffold. These commands ignore scriptMap/artMap and
// address the art file by the registry UUID alone, so rename and move can't
// desynchronise the mapping. Layout: <storyboard_root>/<uuid>.mangaart flat.
// The `find_art_by_uuid` recursive fallback still covers legacy mirrored-dir
// files that live somewhere deeper in the storyboard tree.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mangaart_resolve_by_uuid(
    project_path: String,
    uuid: String,
) -> Result<Option<String>, String>
{
    mangaart_resolve_by_uuid_impl(&project_path, &uuid)
}

pub fn mangaart_resolve_by_uuid_impl(
    project_path: &str,
    uuid: &str,
) -> Result<Option<String>, String>
{
    let project_dir = std::path::Path::new(project_path);
    let flat = flat_uuid_art_path(project_dir, uuid);
    if flat.exists()
    {
        return Ok(Some(flat.to_string_lossy().to_string()));
    }
    // Legacy layout may have stashed the file under a mirrored dir. Walk the
    // whole storyboard tree looking for `<uuid>.mangaart`.
    let storyboard_root = storyboard_dir(project_dir);
    if let Some(found) = find_art_by_uuid(&storyboard_root, uuid)
    {
        return Ok(Some(found.to_string_lossy().to_string()));
    }
    Ok(None)
}

/// Return the on-disk path for the folder-scoped `.mangaart` at
/// `<storyboard_root>/folders/<folder_uuid>.mangaart`. Ensures the
/// `folders/` subdirectory exists on disk so a subsequent write can succeed
/// without racing on directory creation. Mirrors
/// [`mangaart_resolve_by_uuid`] shape — returns the path even when the
/// file itself has not been scaffolded yet, so callers get an authoritative
/// location to write to. Returns `Ok(None)` only if the storyboard root
/// itself cannot be created (e.g. project dir missing).
#[tauri::command]
pub fn mangaart_resolve_by_folder_uuid(
    project_path: String,
    folder_uuid: String,
) -> Result<Option<String>, String>
{
    mangaart_resolve_by_folder_uuid_impl(&project_path, &folder_uuid)
}

pub fn mangaart_resolve_by_folder_uuid_impl(
    project_path: &str,
    folder_uuid: &str,
) -> Result<Option<String>, String>
{
    let project_dir = std::path::Path::new(project_path);
    let folders_dir = storyboard_folders_dir(project_dir);
    std::fs::create_dir_all(&folders_dir).map_err(|e| e.to_string())?;
    let path = folder_uuid_art_path(project_dir, folder_uuid);
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn mangaart_scaffold_by_uuid(
    project_path: String,
    uuid: String,
    display_name: Option<String>,
) -> Result<serde_json::Value, String>
{
    mangaart_scaffold_by_uuid_impl(&project_path, &uuid, display_name.as_deref())
}

pub fn mangaart_scaffold_by_uuid_impl(
    project_path: &str,
    uuid: &str,
    display_name: Option<&str>,
) -> Result<serde_json::Value, String>
{
    let project_dir = std::path::Path::new(project_path);
    let locks = ProjectJsonLocks::global();
    let lock = locks.lock_for(project_dir);
    let _guard = lock.lock().expect("project-json mutex poisoned");

    // Prefer the flat path; if a legacy mirrored-dir file exists, honour it
    // rather than orphaning the existing strokes.
    let flat = flat_uuid_art_path(project_dir, uuid);
    let existing = if flat.exists()
    {
        Some(flat.clone())
    }
    else
    {
        let storyboard_root = storyboard_dir(project_dir);
        find_art_by_uuid(&storyboard_root, uuid)
    };

    if let Some(path) = existing
    {
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        return Ok(parsed);
    }

    let basename = display_name.unwrap_or(uuid);
    write_fresh_art_file(&flat, uuid, basename, basename)
}

// ---------------------------------------------------------------------------
// mangaart_erase — wipe the entire storyboard for a script/UUID.
// The "start over" action driven by the paint widget's trash button. Drops
// the artMap entry and trashes the `.mangaart` file. Does NOT delete the
// source script — that's `registry_delete`'s job. Idempotent.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mangaart_erase(
    project_path: String,
    uuid: String,
) -> Result<(), String>
{
    mangaart_erase_impl(&project_path, &uuid)
}

/// Pure helper backing [`mangaart_erase`]. Exposed so tests can exercise the
/// erase logic without a Tauri runtime.
///
/// Behaviour:
///   1. Read `project.json`. Missing/unreadable → skip the artMap edit but
///      still try to trash the file (matches the caller's "start over"
///      intent).
///   2. Reverse-lookup script rel-path from the UUID via
///      [`art_map_find_script_by_uuid`].
///   3. If found, [`art_map_drop`] + [`write_project_json`].
///   4. Resolve the on-disk `.mangaart` path. Prefer
///      [`resolve_art_path`] when a script rel is known; otherwise scan the
///      storyboard tree with [`mangaart_resolve_by_uuid_impl`].
///   5. Trash or remove the file if present. Missing file is not an error.
pub fn mangaart_erase_impl(
    project_path: &str,
    uuid: &str,
) -> Result<(), String>
{
    use std::path::Path;

    let project_dir = Path::new(project_path);
    let locks = ProjectJsonLocks::global();
    let lock = locks.lock_for(project_dir);
    let _guard = lock.lock().expect("project-json mutex poisoned");

    // Step 1-3: artMap bookkeeping. Best-effort on the artMap side so a
    // corrupt project.json doesn't block the file trash.
    let script_rel: Option<String> = match read_project_json(project_dir)
    {
        Ok(mut pj) =>
        {
            let found = art_map_find_script_by_uuid(&pj, uuid);
            if let Some(rel) = &found
            {
                art_map_drop(&mut pj, rel);
                write_project_json(project_dir, &pj)?;
            }
            found
        }
        Err(e) =>
        {
            eprintln!(
                "[mangaart_erase] project.json unreadable at {}: {} — continuing to file trash",
                project_dir.display(), e,
            );
            None
        }
    };

    // Step 4: resolve the on-disk path.
    let art_path = match &script_rel
    {
        Some(rel) =>
        {
            let by_map = resolve_art_path(project_dir, rel, uuid);
            if by_map.exists()
            {
                Some(by_map)
            }
            else
            {
                // Fall back to a scan — the map key may point at a stale
                // mirrored dir after a rename that skipped mangaart moves.
                mangaart_resolve_by_uuid_impl(project_path, uuid)?
                    .map(std::path::PathBuf::from)
            }
        }
        None => mangaart_resolve_by_uuid_impl(project_path, uuid)?
            .map(std::path::PathBuf::from),
    };

    // Step 5: trash-or-remove. Missing file = fine.
    if let Some(path) = art_path
    {
        if path.exists()
        {
            if let Err(e) = fs_helpers::trash_or_remove(&path)
            {
                eprintln!(
                    "[mangaart_erase] failed to trash {}: {}",
                    path.display(), e,
                );
            }
        }
    }

    Ok(())
}
