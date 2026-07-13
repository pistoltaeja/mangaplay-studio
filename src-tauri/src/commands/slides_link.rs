//! Tauri commands for the per-script Google Slides link registry.
//!
//! Three commands: `slides_link_get`, `slides_link_save`, `slides_link_drop`.
//! JS callers pass `script_rel_path` — the UUID lookup + persistence happens
//! Rust-side so the JS layer never sees the internal UUID.
//!
//! All read-modify-write of `project.json` happens under the per-project
//! mutex from [`ProjectJsonLocks`] so a JS-side save can't race a
//! script-rename or a delete-cleanup.

use std::path::Path;

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

/// Reject presentation IDs that are empty, over-long, or contain path or
/// null characters. Defence in depth — the ID originates from a
/// user-pasted URL parsed on the JS side.
fn validate_presentation_id(id: &str) -> Result<(), String>
{
    if id.is_empty()
        || id.len() > 200
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.contains('\0')
    {
        return Err("bad-presentation-id".into());
    }
    Ok(())
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

/// Reject folder UUIDs that are empty, over-long, or contain path or null
/// characters. Same defence pattern as `validate_presentation_id`.
fn validate_folder_uuid(uuid: &str) -> Result<(), String>
{
    if uuid.is_empty()
        || uuid.len() > 200
        || uuid.contains('/')
        || uuid.contains('\\')
        || uuid.contains("..")
        || uuid.contains('\0')
    {
        return Err("bad-folder-uuid".into());
    }
    Ok(())
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
        validate_folder_uuid(f)?;
        let key = format!("folder:{f}");
        if let Some(link) = pure_slides_link_get(&pj, &key)
        {
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

    Ok(pure_slides_link_get(&pj, &uuid))
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
) -> Result<SlidesLink, String>
{
    slides_link_save_impl(
        &locks,
        &project_path,
        &script_rel_path,
        &presentation_id,
        &prepare_status,
        folder_uuid.as_deref(),
    )
}

pub fn slides_link_save_impl(
    locks: &ProjectJsonLocks,
    project_path: &str,
    script_rel_path: &str,
    presentation_id: &str,
    prepare_status: &str,
    folder_uuid: Option<&str>,
) -> Result<SlidesLink, String>
{
    validate_presentation_id(presentation_id)?;
    validate_prepare_status(prepare_status)?;

    let project_dir = Path::new(project_path);
    let lock = locks.lock_for(project_dir);
    let _guard = lock.lock().expect("project-json mutex poisoned");

    let mut pj = read_project_json(project_dir)?;

    // Discriminated key: folder scope writes `folder:<folder_uuid>`, file
    // scope mints a script UUID via `scriptMap`. Folder scope skips the
    // mint entirely — folders are their own registry entities.
    let key = match folder_uuid
    {
        Some(f) =>
        {
            validate_folder_uuid(f)?;
            format!("folder:{f}")
        }
        None =>
        {
            let (uuid, _minted) = script_map_get_or_mint(&mut pj, script_rel_path);
            uuid
        }
    };

    let now = chrono_iso_now();
    let linked_at = match pure_slides_link_get(&pj, &key)
    {
        // Overwrite: preserve the original linkedAt.
        Some(existing) => existing.linked_at,
        None => now.clone(),
    };

    let entry = SlidesLink
    {
        presentation_id: presentation_id.to_string(),
        linked_at,
        last_prepared_at: now,
        last_prepare_status: prepare_status.to_string(),
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
        Some(f) =>
        {
            validate_folder_uuid(f)?;
            format!("folder:{f}")
        }
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

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests
{
    use super::*;
    use tempfile::TempDir;

    use crate::commands::project::app_dir;

    fn make_project() -> TempDir
    {
        let td = TempDir::new().unwrap();
        // Scaffold _mangaplaystudio/ + a minimal project.json.
        std::fs::create_dir_all(app_dir(td.path())).unwrap();
        let pj = serde_json::json!({
            "id": "test-project",
        });
        let path = crate::commands::project_mutations::read_project_json(td.path())
            .err(); // sanity: ensure not present yet
        let _ = path;
        crate::commands::project_mutations::write_project_json(td.path(), &pj).unwrap();
        td
    }

    fn locks() -> ProjectJsonLocks
    {
        ProjectJsonLocks::new()
    }

    #[test]
    fn get_when_no_scriptmap_entry_returns_none()
    {
        let td = make_project();
        let l = locks();
        let got = slides_link_get_impl(
            &l,
            td.path().to_str().unwrap(),
            "foo.mangaplay",
            None,
        )
        .unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn save_mints_uuid_and_get_returns_entry()
    {
        let td = make_project();
        let l = locks();
        let pp = td.path().to_str().unwrap();
        let rel = "foo.mangaplay";

        let saved = slides_link_save_impl(&l, pp, rel, "1PqR", "clean", None).unwrap();
        assert_eq!(saved.presentation_id, "1PqR");
        assert_eq!(saved.last_prepare_status, "clean");
        assert!(!saved.linked_at.is_empty());
        assert_eq!(saved.linked_at, saved.last_prepared_at);

        let got = slides_link_get_impl(&l, pp, rel, None).unwrap().expect("entry");
        assert_eq!(got.presentation_id, "1PqR");
        assert_eq!(got.linked_at, saved.linked_at);
    }

    #[test]
    fn save_twice_preserves_linked_at_updates_prepared_at()
    {
        let td = make_project();
        let l = locks();
        let pp = td.path().to_str().unwrap();
        let rel = "foo.mangaplay";

        let first = slides_link_save_impl(&l, pp, rel, "1PqR", "clean", None).unwrap();
        // chrono_iso_now() has sub-second resolution — ensure the second
        // call resolves to a distinct timestamp.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let second = slides_link_save_impl(
            &l,
            pp,
            rel,
            "1PqR",
            "with-warnings",
            None,
        )
        .unwrap();

        assert_eq!(second.linked_at, first.linked_at, "linkedAt is sticky");
        assert_ne!(second.last_prepared_at, first.last_prepared_at);
        assert_eq!(second.last_prepare_status, "with-warnings");
    }

    #[test]
    fn bad_presentation_id_rejected()
    {
        let td = make_project();
        let l = locks();
        let pp = td.path().to_str().unwrap();

        let e = slides_link_save_impl(&l, pp, "foo.mangaplay", "", "clean", None).unwrap_err();
        assert_eq!(e, "bad-presentation-id");

        let e = slides_link_save_impl(&l, pp, "foo.mangaplay", "../evil", "clean", None).unwrap_err();
        assert_eq!(e, "bad-presentation-id");

        let e = slides_link_save_impl(&l, pp, "foo.mangaplay", "a/b", "clean", None).unwrap_err();
        assert_eq!(e, "bad-presentation-id");
    }

    #[test]
    fn bad_prepare_status_rejected()
    {
        let td = make_project();
        let l = locks();
        let pp = td.path().to_str().unwrap();

        let e = slides_link_save_impl(&l, pp, "foo.mangaplay", "1PqR", "nonsense", None).unwrap_err();
        assert_eq!(e, "bad-status");
    }

    #[test]
    fn drop_after_save_returns_true_then_false()
    {
        let td = make_project();
        let l = locks();
        let pp = td.path().to_str().unwrap();
        let rel = "foo.mangaplay";

        slides_link_save_impl(&l, pp, rel, "1PqR", "clean", None).unwrap();
        let first = slides_link_drop_impl(&l, pp, rel, None).unwrap();
        assert!(first);
        let second = slides_link_drop_impl(&l, pp, rel, None).unwrap();
        assert!(!second);

        // Confirm get returns None post-drop.
        let got = slides_link_get_impl(&l, pp, rel, None).unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn folder_scope_save_get_drop_uses_folder_key()
    {
        let td = make_project();
        let l = locks();
        let pp = td.path().to_str().unwrap();
        let rel = "Chapter_1/Act_V.mangaplay";
        let folder = "folder-uuid-123";

        let saved = slides_link_save_impl(
            &l, pp, rel, "PRES-XYZ", "clean", Some(folder),
        ).unwrap();
        assert_eq!(saved.presentation_id, "PRES-XYZ");

        // Reading with the same folder_uuid returns the folder-scoped entry.
        let got = slides_link_get_impl(&l, pp, rel, Some(folder))
            .unwrap()
            .expect("folder entry");
        assert_eq!(got.presentation_id, "PRES-XYZ");

        // Reading without a folder scope falls back to the file lookup —
        // there's no file entry, so None.
        let no_file = slides_link_get_impl(&l, pp, rel, None).unwrap();
        assert!(no_file.is_none(), "file scope shouldn't see folder-scoped entry");

        // Drop with folder scope clears the folder-scoped entry.
        let dropped = slides_link_drop_impl(&l, pp, rel, Some(folder)).unwrap();
        assert!(dropped);
        let after = slides_link_get_impl(&l, pp, rel, Some(folder)).unwrap();
        assert!(after.is_none());
    }

    #[test]
    fn folder_scope_and_file_scope_coexist()
    {
        let td = make_project();
        let l = locks();
        let pp = td.path().to_str().unwrap();
        let rel = "Chapter_1/Act_V.mangaplay";
        let folder = "folder-uuid-abc";

        // Save a file-scoped entry first, then a folder-scoped one against
        // the same relPath. Both must be independently retrievable.
        slides_link_save_impl(&l, pp, rel, "FILE-DECK", "clean", None).unwrap();
        slides_link_save_impl(&l, pp, rel, "FOLDER-DECK", "clean", Some(folder)).unwrap();

        let folder_link = slides_link_get_impl(&l, pp, rel, Some(folder)).unwrap().unwrap();
        assert_eq!(folder_link.presentation_id, "FOLDER-DECK");

        let file_link = slides_link_get_impl(&l, pp, rel, None).unwrap().unwrap();
        assert_eq!(file_link.presentation_id, "FILE-DECK");
    }

    #[test]
    fn bad_folder_uuid_rejected()
    {
        let td = make_project();
        let l = locks();
        let pp = td.path().to_str().unwrap();

        let e = slides_link_save_impl(
            &l, pp, "foo.mangaplay", "1PqR", "clean", Some(""),
        ).unwrap_err();
        assert_eq!(e, "bad-folder-uuid");

        let e = slides_link_save_impl(
            &l, pp, "foo.mangaplay", "1PqR", "clean", Some("../evil"),
        ).unwrap_err();
        assert_eq!(e, "bad-folder-uuid");
    }
}
