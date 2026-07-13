//! Create / rename file commands, project-relative path helpers, and folder
//! art-relocation helper. Also hosts the Save-As dialog + raw-write export
//! commands. Extracted from lib.rs verbatim — no behaviour changes.

use std::path::{Path, PathBuf};

use crate::art_map::{art_map_drop, art_map_get, art_map_rewrite_prefix, art_map_set};
use crate::commands::project::{is_script_filename, storyboard_dir};
use crate::commands::project_mutations::{read_project_json, write_project_json};
use crate::fs_helpers::next_free_name;
use crate::locks::ProjectJsonLocks;
use crate::project_root::{ProjectRoot, assert_within_project_root};
use crate::script_map::{script_map_rewrite_key, script_map_rewrite_prefix};
use crate::validate_basename::validate_basename;

use super::fs_events::{FsChange, emit_fs_changed, path_eq_caseless};

// ── app_create_file ──────────────────────────────────────────────────────

/// Pure helper backing `app_create_file`. `kind` ∈ "folder" | "mangaplay" |
/// "fountain" | "superscript" | "text". Returns the path of the new entry.
pub fn create_file_impl(parent: &Path, kind: &str) -> Result<PathBuf, String>
{
    if !parent.is_dir()
    {
        return Err("parent-not-dir".into());
    }
    let (ext_chain, seed): (&str, Option<&str>) = match kind
    {
        "folder" => ("", None),
        "mangaplay" => (".mangaplay.md", Some("# Page 1\nPanel 1\nAction line.\n")),
        "fountain" => (".fountain.md", Some("")),
        "superscript" => (".sup.md", Some("")),
        "text" => (".txt", Some("")),
        _ => return Err("invalid-kind".into()),
    };
    let new_name = next_free_name(parent, "Untitled", ext_chain, 1);
    let dst = parent.join(&new_name);
    if kind == "folder"
    {
        std::fs::create_dir(&dst).map_err(|e| format!("create-error:{}", e))?;
    }
    else
    {
        std::fs::write(&dst, seed.unwrap_or(""))
            .map_err(|e| format!("create-error:{}", e))?;
    }
    Ok(dst)
}

#[tauri::command]
pub fn app_create_file(
    app: tauri::AppHandle,
    state: tauri::State<ProjectRoot>,
    parent: String,
    kind: String,
) -> Result<String, String>
{
    let p = assert_within_project_root(Path::new(&parent), &state)?;
    let dst = create_file_impl(&p, &kind)?;
    let dst_str = dst.to_string_lossy().to_string();
    emit_fs_changed(&app, &dst_str, FsChange::Created { path: dst_str.clone() });
    Ok(dst_str)
}

// ── app_rename_file ──────────────────────────────────────────────────────

/// Pure helper backing `app_rename_file`. See
/// TODO/mangaart-storyboard-relocation.md Phase 3 (file case) and Phase 5
/// (folder case — when `path.is_dir()` the artMap prefix is rewritten and
/// the `<root>/storyboard/<old_rel>/` subtree is physically moved to mirror
/// the new script-folder location).
///
/// When `project_root` is provided AND the source is a script file (per
/// `is_script_filename`) AND `project.json` has an `artMap.scripts` entry
/// for the script's project-root-relative path, the entry's key is rewritten
/// from the old relative path to the new one. The mapped UUID is preserved,
/// and the `.mangaart` file on disk is NOT moved — its identity is the UUID,
/// and the mirrored storyboard folder is derived from the script path for
/// human browsability, not authority. After a rename the mirror may no longer
/// literally match the new script location; that is intentional.
///
/// `project_root` is `None` for callers that don't track a project root
/// (the fakefs JS tests, or any flow outside the open-project lifecycle).
/// In that case no artMap bookkeeping is attempted and the rename is a pure
/// filesystem operation.
///
/// Order of operations:
///   1. validate + collision check (pre-existing behaviour)
///   2. project.json artMap rewrite (if applicable). On any failure here,
///      the rename is aborted — the on-disk script is untouched.
///   3. `std::fs::rename` the script file.
///
/// If step 3 fails after step 2 succeeded, the artMap now points at a key
/// that has no on-disk script. On the next scaffold call for the new key the
/// existing UUID is found, the existing art file is found, and the system is
/// consistent again. The old key is gone (correct — the old script is too).
pub fn rename_file_impl(
    path: &Path,
    new_name: &str,
    currently_open: bool,
    project_root: Option<&Path>,
) -> Result<PathBuf, String>
{
    if currently_open
    {
        return Err("project-is-open".into());
    }
    validate_basename(new_name).map_err(|e| e.to_string())?;

    let parent = path.parent().ok_or("no-parent")?;
    let dst = parent.join(new_name);

    let is_case_only = path_eq_caseless(path, &dst) && path != dst;
    if !is_case_only && dst.exists()
    {
        return Err("target-exists".into());
    }

    // ── FOLDER rename branch (Phase 5) ────────────────────────────────────
    // For folders the script-side rename happens FIRST (visible op, fail
    // fast); then the artMap prefix rewrite and storyboard subtree move are
    // best-effort. Failure modes:
    //   * step 1 fails  → return the error; nothing else ran.
    //   * step 1 OK, art-side fails → warn-only; the next loadMangaart for
    //     any script in the renamed folder re-scaffolds a fresh UUID and the
    //     old art bytes become orphans (acceptable per plan atomicity rule).
    if path.is_dir()
    {
        // Capture rel paths BEFORE the rename so `project_rel_path` resolves
        // against the still-existing source path.
        let old_rel_opt = project_root.and_then(|root| project_rel_path(root, path));
        let new_rel_opt = project_root.and_then(|root| project_rel_path(root, &dst));

        match std::fs::rename(path, &dst)
        {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied =>
            {
                return Err("access-denied".into());
            }
            Err(e) => return Err(format!("rename-error:{}", e)),
        }

        if let (Some(root), Some(old_rel), Some(new_rel))
            = (project_root, old_rel_opt, new_rel_opt)
        {
            if old_rel != new_rel
            {
                apply_folder_art_relocation(root, &old_rel, &new_rel);
            }
        }

        return Ok(dst);
    }

    // ── artMap + scriptMap rewrite (before the on-disk rename, per docstring) ──
    // Gates:
    //   * a project root was supplied (else: not a project-managed rename)
    //   * old filename is a script (`.mangaplay.md` / `.fountain.md` / `.sup.md`)
    //   * project.json exists and parses
    // RMW held under the per-project lock so a concurrent scriptmap mint
    // can't race.
    if let Some(root) = project_root
    {
        let old_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if is_script_filename(old_name)
        {
            if let (Some(old_rel), Some(new_rel)) = (
                project_rel_path(root, path),
                project_rel_path(root, &dst),
            )
            {
                // Skip when nothing would change. case-only renames still
                // proceed: the canonical key in the map should follow the
                // user's chosen case so JS lookups (case-sensitive on map
                // keys) keep matching.
                if old_rel != new_rel
                {
                    let locks = ProjectJsonLocks::global();
                    let lock = locks.lock_for(root);
                    let _guard = lock.lock().expect("project-json mutex poisoned");

                    if let Ok(mut pj) = read_project_json(root)
                    {
                        let pre = pj.clone();
                        if let Some(uuid) = art_map_get(&pj, &old_rel)
                        {
                            art_map_drop(&mut pj, &old_rel);
                            art_map_set(&mut pj, &new_rel, &uuid);
                        }
                        // scriptMap is the new authority; rewrite the key
                        // regardless of legacy artMap presence.
                        script_map_rewrite_key(&mut pj, &old_rel, &new_rel);
                        if pj != pre
                        {
                            write_project_json(root, &pj)?;
                        }
                    }
                }
            }
        }
    }

    match std::fs::rename(path, &dst)
    {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied =>
        {
            return Err("access-denied".into());
        }
        Err(e) => return Err(format!("rename-error:{}", e)),
    }

    Ok(dst)
}

/// Compute `child`'s path relative to `root`, normalised to forward slashes
/// so the result is comparable against `artMap.scripts` keys (which are
/// always stored with `/` regardless of host OS). Returns `None` when
/// `child` does not live under `root`.
pub(crate) fn project_rel_path(root: &Path, child: &Path) -> Option<String>
{
    let rel = child.strip_prefix(root).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() { None } else { Some(s) }
}

/// Best-effort artMap prefix rewrite + storyboard subtree move for a folder
/// rename / move (Phase 5). Called AFTER the script-side rename has
/// succeeded; either step failing here logs a warning but never unwinds.
/// Used by both [`rename_file_impl`] (folder branch) and
/// [`move_path_with_art`].
///
/// Steps:
///   1. Read `project.json`, apply [`art_map_rewrite_prefix`], write
///      `project.json`. The helper's trailing-slash gate prevents partial
///      prefix matches (e.g. renaming `foo` does NOT touch `foobar/...`).
///   2. If `<root>/storyboard/<old_rel>/` exists on disk, move it to
///      `<root>/storyboard/<new_rel>/`, creating the new parent dir first.
///      No mirrored subtree exists when no script in the folder ever had art
///      scaffolded — that's a no-op, not an error.
///
/// Caller is responsible for ensuring `old_rel != new_rel`.
pub(crate) fn apply_folder_art_relocation(root: &Path, old_rel: &str, new_rel: &str)
{
    // Step 1: artMap + scriptMap prefix rewrite under the per-project lock.
    let locks = ProjectJsonLocks::global();
    let lock = locks.lock_for(root);
    let _guard = lock.lock().expect("project-json mutex poisoned");

    match read_project_json(root)
    {
        Ok(mut pj) =>
        {
            art_map_rewrite_prefix(&mut pj, old_rel, new_rel);
            script_map_rewrite_prefix(&mut pj, old_rel, new_rel);
            if let Err(e) = write_project_json(root, &pj)
            {
                log::warn!(
                    "[folder-relocate] failed to write project.json for {} -> {}: {}",
                    old_rel, new_rel, e,
                );
                // Fall through to step 2 anyway — keeping the on-disk
                // storyboard subtree aligned with the script folder is the
                // higher-priority invariant.
            }
        }
        Err(e) =>
        {
            log::warn!(
                "[folder-relocate] project.json unreadable ({}); skipping artMap rewrite",
                e,
            );
        }
    }

    // Step 2: physical storyboard subtree move.
    let storyboard_root = storyboard_dir(root);
    let old_subtree = rel_join(&storyboard_root, old_rel);
    let new_subtree = rel_join(&storyboard_root, new_rel);

    if !old_subtree.exists()
    {
        // No mirrored subtree existed — nothing to move. Common case for
        // folders that never had any scripts with art scaffolded.
        return;
    }
    if let Some(parent) = new_subtree.parent()
    {
        if let Err(e) = std::fs::create_dir_all(parent)
        {
            log::warn!(
                "[folder-relocate] failed to create new storyboard parent {}: {}",
                parent.display(), e,
            );
            return;
        }
    }
    if let Err(e) = std::fs::rename(&old_subtree, &new_subtree)
    {
        log::warn!(
            "[folder-relocate] failed to move storyboard {} -> {}: {}",
            old_subtree.display(), new_subtree.display(), e,
        );
    }
}

/// Join a forward-slash relative path (the `artMap.scripts` key form) onto a
/// native base `Path`. Empty segments are skipped so a leading or trailing
/// `/` cannot escape `base`.
pub(super) fn rel_join(base: &Path, rel: &str) -> PathBuf
{
    let mut out = base.to_path_buf();
    for part in rel.trim_matches('/').split('/')
    {
        if part.is_empty() { continue; }
        out.push(part);
    }
    out
}

#[tauri::command]
pub fn app_rename_file(
    app: tauri::AppHandle,
    state: tauri::State<ProjectRoot>,
    path: String,
    new_name: String,
    currently_open: bool,
    project_root: Option<String>,
) -> Result<String, String>
{
    let safe = assert_within_project_root(Path::new(&path), &state)?;
    let root_buf = project_root.as_deref().map(Path::new);
    let dst = rename_file_impl(&safe, &new_name, currently_open, root_buf)?;
    let dst_str = dst.to_string_lossy().to_string();
    emit_fs_changed(&app, &path, FsChange::Renamed { to: dst_str.clone() });
    Ok(dst_str)
}

/// Open a native Save-As dialog and return the chosen path (or None on cancel).
/// Honours MPS_TEST_SAVE_DIR for CDP tests — when set, the dialog is bypassed
/// and the file lands at `<MPS_TEST_SAVE_DIR>/<default_name>`. Mirrors the
/// MPS_TEST_DIR pattern used by project_pick_folder.
///
/// `filters` is `[(label, [ext, ...]), ...]` — passed straight to
/// FileDialogBuilder::add_filter.
#[tauri::command]
pub async fn app_save_file_dialog(
    app: tauri::AppHandle,
    default_name: String,
    filters: Vec<(String, Vec<String>)>,
) -> Result<Option<String>, String>
{
    // Test shortcut.
    if let Ok(test_dir) = std::env::var("MPS_TEST_SAVE_DIR") {
        if !test_dir.is_empty() {
            std::fs::create_dir_all(&test_dir).map_err(|e| e.to_string())?;
            let p = std::path::Path::new(&test_dir).join(&default_name);
            return Ok(Some(p.to_string_lossy().into_owned()));
        }
    }
    // Run the dialog on a blocking worker thread so the async runtime
    // and the WebView2 message pump stay alive while the modal is open.
    // tauri-plugin-dialog explicitly warns against the non-blocking
    // callback API from inside async commands (see desktop.rs:9) —
    // the blocking variant is the recommended path here.
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut builder = app.dialog().file().set_file_name(&default_name);
        for (name, exts) in &filters {
            let exts_ref: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
            builder = builder.add_filter(name, &exts_ref);
        }
        Ok::<Option<String>, String>(builder.blocking_save_file().map(|p| p.to_string()))
    })
    .await
    .map_err(|e| format!("save-dialog-join-error:{}", e))?
}

/// Write a byte array to `path`. Used by the Export Screenplay flow for
/// binary formats (PDF, FadeIn ZIP) and text formats (Fountain, FDX XML, TXT)
/// alike. Creates parent directories as needed so callers don't have to
/// guard.
#[tauri::command]
pub fn app_write_bytes(path: String, bytes: Vec<u8>) -> Result<(), String>
{
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir-error:{}", e))?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("write-error:{}", e))
}

/// Open a native Open-File dialog and return the chosen path (or None on
/// cancel). Mirrors app_save_file_dialog but for reads; used by the Import
/// Screenplay flow. Honours MPS_TEST_OPEN_FILE for CDP tests.
///
/// `filters` is `[(label, [ext, ...]), ...]` — passed straight to
/// FileDialogBuilder::add_filter.
#[tauri::command]
pub async fn app_open_file_dialog(
    app: tauri::AppHandle,
    filters: Vec<(String, Vec<String>)>,
) -> Result<Option<String>, String>
{
    if let Ok(test_path) = std::env::var("MPS_TEST_OPEN_FILE") {
        if !test_path.is_empty() {
            return Ok(Some(test_path));
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut builder = app.dialog().file();
        for (name, exts) in &filters {
            let exts_ref: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
            builder = builder.add_filter(name, &exts_ref);
        }
        Ok::<Option<String>, String>(builder.blocking_pick_file().map(|p| p.to_string()))
    })
    .await
    .map_err(|e| format!("open-dialog-join-error:{}", e))?
}

/// Read an arbitrary file's contents as bytes. Used by the Import Screenplay
/// flow — the file lives OUTSIDE the current project, so `read_project_file`
/// (which is project-scoped) doesn't apply. Returned to JS as a Vec<u8>
/// which Tauri serialises as a byte array.
#[tauri::command]
pub fn app_read_file_bytes(path: String) -> Result<Vec<u8>, String>
{
    std::fs::read(&path).map_err(|e| format!("read-error:{}", e))
}
