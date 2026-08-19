//! Tauri commands for the per-script Google Slides link registry.
//!
//! Commands: `slides_link_get`, `slides_link_save`, `slides_link_drop`,
//! `slides_link_drop_scoped`.
//! JS callers pass `script_rel_path` — the UUID lookup + persistence happens
//! Rust-side so the JS layer never sees the internal UUID.
//!
//! All read-modify-write of `project.json` happens under the per-project
//! mutex from [`ProjectJsonLocks`] so a JS-side save can't race a
//! script-rename or a delete-cleanup.

use serde::Serialize;
use std::path::Path;

use crate::commands::slides_validation::{validate_slug, validate_opaque};
use crate::fs_helpers::chrono_iso_now;
use crate::locks::ProjectJsonLocks;
use crate::script_map::{script_map_get, script_map_get_or_mint, script_map_get_with_legacy_pullforward};
use crate::slides_links::{
    slides_link_drop as pure_slides_link_drop,
    slides_link_get as pure_slides_link_get,
    slides_link_has,
    slides_link_set,
    SlidesLink,
};
use crate::{read_project_json, write_project_json};

// ── Validation ──────────────────────────────────────────────────────────

fn validate_presentation_id(id: &str) -> Result<(), String>
{
    validate_slug(id, "bad-presentation-id", 200)
}

fn validate_prepare_status(status: &str) -> Result<(), String>
{
    match status
    {
        "clean" | "with-warnings" | "aborted" => Ok(()),
        _ => Err("bad-status".into()),
    }
}

// ── Commands ────────────────────────────────────────────────────────────

fn validate_folder_uuid(uuid: &str) -> Result<(), String>
{
    validate_slug(uuid, "bad-folder-uuid", 200)
}

/// Validate a folder UUID and format its discriminated `slidesLinks` key.
/// Folder-scoped links live under `folder:<uuid>`; file-scoped links use a
/// bare script UUID.
fn folder_key(f: &str) -> Result<String, String>
{
    validate_folder_uuid(f)?;
    Ok(format!("folder:{f}"))
}

/// Return the `SlidesLink` for `script_rel_path`, or `None` if the script
/// has no UUID yet or has no link entry.
///
/// Resolves the UUID via the legacy-pullforward helper so any legacy
/// artMap-only entry gets folded into `scriptMap` as a side effect (and
/// persisted, since we already hold the lock for the read).
///
/// When `folder_uuid` is `Some`, the folder-scoped link is preferred:
/// `slidesLinks["folder:<folder_uuid>"]` is checked first, and only
/// falls back to the per-file entry when the folder key is absent.
#[tauri::command]
pub async fn slides_link_get(
    locks: tauri::State<'_, ProjectJsonLocks>,
    project_path: String,
    script_rel_path: String,
    folder_uuid: Option<String>,
) -> Result<Option<SlidesLink>, String>
{
    slides_link_get_impl(&locks, &project_path, &script_rel_path, folder_uuid.as_deref())
}

pub fn slides_link_get_impl(
    locks: &ProjectJsonLocks,
    project_path: &str,
    script_rel_path: &str,
    folder_uuid: Option<&str>,
) -> Result<Option<SlidesLink>, String>
{
    let project_dir = Path::new(project_path);
    let lock = locks.lock_for(project_dir);
    let _guard = lock.lock().expect("project-json mutex poisoned");

    let mut pj = read_project_json(project_dir)?;

    // Folder scope — try `folder:<uuid>` key first.
    if let Some(f) = folder_uuid
    {
        let key = folder_key(f)?;
        if let Some(mut link) = pure_slides_link_get(&pj, &key)
        {
            link.scope = Some("folder".into());
            return Ok(Some(link));
        }
    }

    let before = pj.clone();
    let uuid = match script_map_get_with_legacy_pullforward(&mut pj, script_rel_path)
    {
        Some(u) => u,
        None => return Ok(None),
    };

    // Pull-forward may have mutated project_json — persist so subsequent
    // reads don't re-run the fallback path.
    if pj != before
    {
        write_project_json(project_dir, &pj)?;
    }

    Ok(pure_slides_link_get(&pj, &uuid).map(|mut link|
    {
        link.scope = Some("file".into());
        link
    }))
}

/// Persist a `SlidesLink` for `script_rel_path`. Mints a script UUID if
/// none exists. Preserves the previous `linkedAt` when overwriting an
/// existing entry (the link's birth date is sticky; only
/// `lastPreparedAt` and status update on re-prep).
#[tauri::command]
pub async fn slides_link_save(
    locks: tauri::State<'_, ProjectJsonLocks>,
    project_path: String,
    script_rel_path: String,
    presentation_id: String,
    prepare_status: String,
    folder_uuid: Option<String>,
    revision_id: Option<String>,
) -> Result<SlidesLink, String>
{
    slides_link_save_impl(
        &locks,
        &project_path,
        &script_rel_path,
        &presentation_id,
        &prepare_status,
        folder_uuid.as_deref(),
        revision_id.as_deref(),
    )
}

pub fn slides_link_save_impl(
    locks: &ProjectJsonLocks,
    project_path: &str,
    script_rel_path: &str,
    presentation_id: &str,
    prepare_status: &str,
    folder_uuid: Option<&str>,
    revision_id: Option<&str>,
) -> Result<SlidesLink, String>
{
    validate_presentation_id(presentation_id)?;
    validate_prepare_status(prepare_status)?;
    if let Some(r) = revision_id
    {
        validate_opaque(r, "bad-revision-id", 200)?;
    }

    let project_dir = Path::new(project_path);
    let lock = locks.lock_for(project_dir);
    let _guard = lock.lock().expect("project-json mutex poisoned");

    let mut pj = read_project_json(project_dir)?;

    // Discriminated key: folder scope writes `folder:<folder_uuid>`, file
    // scope mints a script UUID via `scriptMap`. Folder scope skips the
    // mint entirely — folders are their own registry entities.
    let key = match folder_uuid
    {
        Some(f) => folder_key(f)?,
        None =>
        {
            let (uuid, _minted) = script_map_get_or_mint(&mut pj, script_rel_path);
            uuid
        }
    };

    let now = chrono_iso_now();
    let existing = pure_slides_link_get(&pj, &key);
    let linked_at = match &existing
    {
        // Overwrite: preserve the original linkedAt.
        Some(e) => e.linked_at.clone(),
        None => now.clone(),
    };

    let entry = SlidesLink
    {
        presentation_id: presentation_id.to_string(),
        linked_at,
        last_prepared_at: now,
        last_prepare_status: prepare_status.to_string(),
        last_known_revision_id: match revision_id
        {
            Some(r) => Some(r.to_string()),
            None => existing.as_ref().and_then(|e| e.last_known_revision_id.clone()),
        },
        scope: None,
    };

    slides_link_set(&mut pj, &key, &entry);
    write_project_json(project_dir, &pj)?;

    Ok(entry)
}

/// Remove any slidesLinks entry for `script_rel_path`. Returns `true` when
/// an entry was actually removed, `false` when the script had no UUID or
/// no link entry to begin with.
///
/// Read-only UUID lookup (no legacy pullforward) — if the script has no
/// UUID at all, there can't be a link entry either.
///
/// Registered but currently unused from bundled JS — reserved for a future
/// "Unlink Slides deck" UI action. Wired now so the JS side can adopt
/// without a Rust release. Revisit and remove if left unused indefinitely.
#[tauri::command]
pub async fn slides_link_drop(
    locks: tauri::State<'_, ProjectJsonLocks>,
    project_path: String,
    script_rel_path: String,
    folder_uuid: Option<String>,
) -> Result<bool, String>
{
    slides_link_drop_impl(&locks, &project_path, &script_rel_path, folder_uuid.as_deref())
}

pub fn slides_link_drop_impl(
    locks: &ProjectJsonLocks,
    project_path: &str,
    script_rel_path: &str,
    folder_uuid: Option<&str>,
) -> Result<bool, String>
{
    let project_dir = Path::new(project_path);
    let lock = locks.lock_for(project_dir);
    let _guard = lock.lock().expect("project-json mutex poisoned");

    let mut pj = read_project_json(project_dir)?;
    let key = match folder_uuid
    {
        Some(f) => folder_key(f)?,
        None =>
        {
            match script_map_get(&pj, script_rel_path)
            {
                Some(u) => u,
                None => return Ok(false),
            }
        }
    };
    if !slides_link_has(&pj, &key)
    {
        return Ok(false);
    }
    pure_slides_link_drop(&mut pj, &key);
    write_project_json(project_dir, &pj)?;
    Ok(true)
}

// ── Scoped drop ─────────────────────────────────────────────────────────

/// Result of a scope-aware drop. `scope` reports which registry entry
/// (or entries) were removed (or `"none"` if there was nothing to remove).
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct SlidesLinkDropScopedResult
{
    /// `"both"`, `"folder"`, `"file"`, or `"none"`.
    pub scope: &'static str,
    /// `true` when at least one entry was actually removed.
    pub cleared: bool,
}

/// Scope-aware unlink.
///
/// Drops BOTH scopes when both exist so a coexisting file-scope entry
/// can't silently resurface after a folder-scope unlink. Behaviour:
/// 1. If `folder_uuid` is Some, drop the folder-scoped entry if present.
/// 2. Also drop the file-scoped entry for `script_rel_path` if present.
/// 3. Report `scope`:
///    - `"both"`  — folder AND file entries were both present and dropped.
///    - `"folder"` — only folder was present.
///    - `"file"`  — only file was present (also the sole outcome when
///                 `folder_uuid` is None and a file entry exists).
///    - `"none"`  — neither was present. `cleared: false`.
///
/// The single-entry `slides_link_drop` command remains for callers that
/// know exactly which scope they mean; this variant is for the JS "Unlink"
/// action where the UI wants "remove whichever link(s) are in effect".
#[tauri::command]
pub async fn slides_link_drop_scoped(
    locks: tauri::State<'_, ProjectJsonLocks>,
    project_path: String,
    script_rel_path: String,
    folder_uuid: Option<String>,
) -> Result<SlidesLinkDropScopedResult, String>
{
    slides_link_drop_scoped_impl(
        &locks,
        &project_path,
        &script_rel_path,
        folder_uuid.as_deref(),
    )
}

pub fn slides_link_drop_scoped_impl(
    locks: &ProjectJsonLocks,
    project_path: &str,
    script_rel_path: &str,
    folder_uuid: Option<&str>,
) -> Result<SlidesLinkDropScopedResult, String>
{
    let project_dir = Path::new(project_path);
    let lock = locks.lock_for(project_dir);
    let _guard = lock.lock().expect("project-json mutex poisoned");

    let mut pj = read_project_json(project_dir)?;

    let mut folder_dropped = false;
    let mut file_dropped = false;

    // Folder scope — drop if present.
    if let Some(f) = folder_uuid
    {
        let key = folder_key(f)?;
        if slides_link_has(&pj, &key)
        {
            pure_slides_link_drop(&mut pj, &key);
            folder_dropped = true;
        }
    }

    // File scope — drop if present, regardless of whether folder dropped.
    if let Some(uuid) = script_map_get(&pj, script_rel_path)
    {
        if slides_link_has(&pj, &uuid)
        {
            pure_slides_link_drop(&mut pj, &uuid);
            file_dropped = true;
        }
    }

    let scope = match (folder_dropped, file_dropped)
    {
        (true, true)   => "both",
        (true, false)  => "folder",
        (false, true)  => "file",
        (false, false) => "none",
    };
    let cleared = folder_dropped || file_dropped;

    if cleared
    {
        write_project_json(project_dir, &pj)?;
    }

    Ok(SlidesLinkDropScopedResult { scope, cleared })
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "slides_link_tests.rs"]
mod tests;
