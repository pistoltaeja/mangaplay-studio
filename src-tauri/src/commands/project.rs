//! Project open / create / read / tree-walk commands.

use crate::project_root::{ProjectRoot, assert_within_project_root};
use crate::registry::state::ProjectRegistryState;
use crate::fs_helpers::{atomic_write_impl, chrono_iso_now};
use crate::commands::auto_flatten::flatten_project_layout_impl;

/// Read or mint `project.json` at the project root. Returns
/// `(id, display_name_or_null)`. Silent — never prompts the user.
/// Mints with a fresh v4 UUID and `displayName: null` if the file is absent
/// or unreadable; never overwrites a valid existing id.
fn project_open_or_mint_id(project_dir: &std::path::Path) -> (String, serde_json::Value) {
    let pj_path = project_json_path(project_dir);
    if pj_path.exists() {
        if let Ok(raw) = std::fs::read_to_string(&pj_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                    let dn = v.get("displayName").cloned().unwrap_or(serde_json::Value::Null);
                    return (id.to_string(), dn);
                }
            }
        }
    }
    // Mint a fresh project.json. Atomic write; ignore failures silently —
    // we still return a runtime-only id so the app proceeds. The atomic
    // helper writes a `.tmp` file next to the target, so the parent dir
    // (the app dir) must exist first — caller paths (`project_open`)
    // already scaffold it, but be defensive in case a future call site
    // mints without scaffolding first.
    let _ = std::fs::create_dir_all(app_dir(project_dir));
    let id = uuid::Uuid::new_v4().to_string();
    let body = serde_json::json!({
        "id": id,
        "displayName": serde_json::Value::Null,
        "createdAt": chrono_iso_now(),
    });
    let _ = atomic_write_impl(
        &pj_path.to_string_lossy(),
        &serde_json::to_string_pretty(&body).unwrap(),
    );
    (id, serde_json::Value::Null)
}

#[tauri::command]
pub fn project_open(
    state: tauri::State<ProjectRoot>,
    registry_state: tauri::State<ProjectRegistryState>,
    path: String,
) -> Result<serde_json::Value, String> {
    use std::path::Path;

    let project_dir = Path::new(&path);
    if !project_dir.is_dir() {
        return Err("Not a directory".into());
    }
    // Record the canonical project root so the FS-command containment helper
    // (assert_within_project_root) can validate every subsequent read/write.
    state.set(project_dir);

    // Best-effort registry load — never blocks project open. On corrupt
    // failure the error is logged and a follow-up Part 3 command triggers
    // rebuild-from-scan. See TODO/uuid-file-registry.md Part 2.
    if let Err(e) = registry_state.load_for(project_dir) {
        eprintln!("[project_open] registry load failed: {}", e);
    }

    // Part 5 migration: fold `project.json.artMap.scripts` UUIDs into the
    // registry so existing projects keep their script → mangaart continuity.
    // Idempotent — subsequent opens re-run scan (cheap) and the fold no-ops
    // on already-aligned entries. See TODO/uuid-file-registry.md Part 5.
    let art_map_scripts = crate::art_map::read_all_scripts(project_dir)
        .unwrap_or_default();
    if !art_map_scripts.is_empty() {
        let _ = registry_state.with_loaded(|reg| {
            if let Err(e) = crate::registry::scan_and_reconcile(reg) {
                eprintln!("[project_open] scan-before-fold failed: {:?}", e);
                return;
            }
            if let Err(e) = crate::registry::migrate::fold_artmap_into_registry(
                reg,
                &art_map_scripts,
            ) {
                eprintln!("[project_open] artmap fold failed: {:?}", e);
            }
        });
    }

    // Orphan cleanup: any artMap.scripts entry pointing at a source file that
    // no longer exists is dead weight. Drop them in-place and persist a single
    // write. Never fails the open — read/write failures fall through silently.
    let orphans: Vec<String> = art_map_scripts
        .iter()
        .filter_map(|(rel, _)| {
            if project_dir.join(rel).exists() { None } else { Some(rel.clone()) }
        })
        .collect();
    if !orphans.is_empty()
    {
        if let Ok(mut pj) = crate::commands::project_mutations::read_project_json(project_dir)
        {
            for rel in &orphans
            {
                crate::art_map::art_map_drop(&mut pj, rel);
            }
            let _ = crate::commands::project_mutations::write_project_json(project_dir, &pj);
            log::debug!(
                "[project_open] pruned {} orphan artMap entries from '{}'",
                orphans.len(),
                project_dir.display()
            );
        }
    }

    // Unconditionally scaffold the app-managed dirs + meta.json so later saves
    // don't ENOENT on a fresh / legacy folder. Idempotent — create_dir_all is
    // a no-op when the target already exists, and meta.json is only written
    // when missing. Both subdir creates are recursive, so the parent
    // `_mangaplaystudio/` directory comes into existence along with them.
    let _ = std::fs::create_dir_all(settings_dir(project_dir));
    let _ = std::fs::create_dir_all(storyboard_dir(project_dir));
    let meta_path = meta_json_path(project_dir);
    if !meta_path.exists() {
        let meta = serde_json::json!({
            "savedAt": chrono_iso_now(),
        });
        let _ = std::fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap());
    }

    // Auto-flatten any leftover `<root>/project/` directory. Best-effort —
    // a collision is logged but the project still opens. The user-facing
    // migration dialog has been removed; whatever the project opens to is
    // what the user sees.
    if let Err(e) = flatten_project_layout_impl(project_dir) {
        eprintln!("[project_open] flatten skipped for {}: {}", path, e);
    }

    // Mint or read project.json.
    let (project_id, shared_display_name) = project_open_or_mint_id(project_dir);

    // Read meta.json from the app dir.
    let mut meta = serde_json::json!({});
    let meta_path = meta_json_path(project_dir);
    if meta_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&meta_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                meta = v;
            }
        }
    }

    // Find first script under the project root (recursive). We pick the
    // alphabetically-first entry from list_project_scripts_impl so the boot
    // payload is deterministic across runs.
    let mut script = String::new();
    let mut script_file = String::new();
    let scripts_root = project_dir.to_path_buf();
    if scripts_root.is_dir() {
        if let Ok(entries) = list_project_scripts_impl(&scripts_root) {
            if let Some(first) = entries.first() {
                if let Some(name) = first.get("name").and_then(|v| v.as_str()) {
                    script_file = name.to_string();
                    let full = scripts_root.join(name);
                    script = std::fs::read_to_string(&full).unwrap_or_default();
                }
            }
        }
    }

    // Read drawings from _mangaplaystudio/storyboard/page-NNN.json.
    let mut drawings = serde_json::json!({});
    let sb_dir = storyboard_dir(project_dir);
    if sb_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&sb_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".json") && name.starts_with("page-") {
                    if let Ok(raw) = std::fs::read_to_string(entry.path()) {
                        if let Ok(art) = serde_json::from_str::<serde_json::Value>(&raw) {
                            let page_num = name
                                .trim_start_matches("page-")
                                .trim_end_matches(".json");
                            drawings[page_num] = art;
                        }
                    }
                }
            }
        }
    }

    Ok(serde_json::json!({
        "status": "ok",
        "project": {
            "script": script,
            "scriptFile": script_file,
            "drawings": drawings,
            "meta": meta,
            "id": project_id,
            "displayName": shared_display_name,
        },
    }))
}

#[tauri::command]
pub fn read_project_file(
    state: tauri::State<ProjectRoot>,
    path: String,
) -> Result<String, String> {
    let safe = assert_within_project_root(std::path::Path::new(&path), &state)?;
    std::fs::read_to_string(&safe).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn atomic_write_project_file(
    state: tauri::State<ProjectRoot>,
    path: String,
    contents: String,
) -> Result<(), String> {
    // First-write paths don't exist yet so we can't canonicalize the target
    // directly — canonicalize the parent dir (which must exist) and assert
    // containment there. The basename is then joined back on for the write.
    let target = std::path::Path::new(&path);
    let parent = target.parent().ok_or_else(|| "invalid-path:no-parent".to_string())?;
    let basename = target.file_name().ok_or_else(|| "invalid-path:no-basename".to_string())?;
    let safe_parent = assert_within_project_root(parent, &state)?;
    let safe = safe_parent.join(basename);
    atomic_write_impl(&safe.to_string_lossy(), &contents)
}

/// Delete a single file within the project root. Silent no-op when the
/// file is absent (idempotent cleanup after migration).
///
/// Not routed through the trash-crate flow (`app_delete_file`) — this is
/// an app-internal cleanup path (session.json migration), not a user
/// intent. Direct `std::fs::remove_file` keeps the migration hermetic and
/// avoids polluting the user's system trash with app bookkeeping files.
#[tauri::command]
pub fn app_internal_remove_project_file(
    state: tauri::State<ProjectRoot>,
    path: String,
) -> Result<(), String>
{
    let target = std::path::Path::new(&path);
    let parent = target.parent().ok_or_else(|| "invalid-path:no-parent".to_string())?;
    let basename = target.file_name().ok_or_else(|| "invalid-path:no-basename".to_string())?;
    let safe_parent = assert_within_project_root(parent, &state)?;
    let safe = safe_parent.join(basename);
    if !safe.exists() { return Ok(()); }
    std::fs::remove_file(&safe).map_err(|e| e.to_string())
}

/// Remove an EMPTY directory within the project root. Non-empty dirs are
/// left in place (session-migration companion command — the `settings/`
/// dir may still hold `fold-state.json`).
#[tauri::command]
pub fn app_internal_remove_empty_project_dir(
    state: tauri::State<ProjectRoot>,
    path: String,
) -> Result<(), String>
{
    let target = std::path::Path::new(&path);
    let parent = target.parent().ok_or_else(|| "invalid-path:no-parent".to_string())?;
    let basename = target.file_name().ok_or_else(|| "invalid-path:no-basename".to_string())?;
    let safe_parent = assert_within_project_root(parent, &state)?;
    let safe = safe_parent.join(basename);
    if !safe.exists() { return Ok(()); }
    if !safe.is_dir() { return Err("not-a-directory".into()); }
    // remove_dir only succeeds on empty dirs — the OS-level "directory not
    // empty" error is the intended no-op signal here.
    match std::fs::remove_dir(&safe)
    {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::Other
            || e.kind() == std::io::ErrorKind::DirectoryNotEmpty => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn project_pick_folder(_app: tauri::AppHandle) -> Result<Option<String>, String> {
    // Test stub: when MPS_TEST_DIR is set, skip the native dialog and return
    // its value. Used by the Playwright smoke test (tests/driver/click-smoke.js)
    // so the test runs deterministically without a real Win32 dialog popup.
    if let Ok(test_dir) = std::env::var("MPS_TEST_DIR") {
        if !test_dir.is_empty() {
            return Ok(Some(test_dir));
        }
    }
    // Android/iOS have no folder picker (Storage Access Framework / iOS
    // sandbox are different API surfaces). Mobile UX never invokes this —
    // the auto-create flow makes the picker unreachable from JS. Return
    // None as a safe no-op so any defence-in-depth caller doesn't crash
    // the bridge.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return Ok(None);
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri_plugin_dialog::DialogExt;
        let (tx, rx) = std::sync::mpsc::channel();
        _app.dialog().file().pick_folder(move |folder_path| {
            let _ = tx.send(folder_path);
        });
        match rx.recv() {
            Ok(Some(p)) => Ok(Some(p.to_string())),
            Ok(None) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[tauri::command]
pub fn project_create_new(
    state: tauri::State<ProjectRoot>,
    path: String,
    name: String,
) -> Result<String, String> {
    let created = project_create_new_impl(&path, &name)?;
    // Eagerly seed ProjectRoot so a subsequent atomic_write_project_file
    // from the JS "save seeded Untitled" path doesn't race against the
    // user's project_open call. JS still calls project_open afterward,
    // which simply re-canonicalises the same path.
    state.set(std::path::Path::new(&created));
    Ok(created)
}

/// Pure helper backing `project_create_new`. Scaffolds the consolidated
/// layout:
///   <project>/
///     _mangaplaystudio/
///         settings/                    — machine-local state lives here
///         storyboard/                  — empty, ready for page-NNN.json
///         meta.json
///         project.json                 — id + null displayName
///     Untitled.mangaplay.md            — seeded with "# Page 1\nPanel 1\nAction line.\n"
pub fn project_create_new_impl(path: &str, name: &str) -> Result<String, String> {
    use std::path::Path;
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err("Parent path is not a directory".into());
    }
    let project_dir = dir.join(name);
    std::fs::create_dir_all(&project_dir).map_err(|e| e.to_string())?;
    // create_dir_all is recursive — both subdir creates pull the parent
    // `_mangaplaystudio/` into existence along with them.
    std::fs::create_dir_all(settings_dir(&project_dir))
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(storyboard_dir(&project_dir))
        .map_err(|e| e.to_string())?;

    // Seed an untitled script at the project root so the user has a non-empty
    // editor on open.
    let seed_script = project_dir.join("Untitled.mangaplay.md");
    std::fs::write(&seed_script, "# Page 1\nPanel 1\nAction line.\n").map_err(|e| e.to_string())?;

    let meta = serde_json::json!({
        "savedAt": chrono_iso_now(),
    });
    std::fs::write(
        meta_json_path(&project_dir),
        serde_json::to_string_pretty(&meta).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    // project.json — id + null displayName, written via atomic helper to
    // match the read path in project_open_or_mint_id.
    let pj = serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "displayName": serde_json::Value::Null,
        "createdAt": chrono_iso_now(),
    });
    atomic_write_impl(
        &project_json_path(&project_dir).to_string_lossy(),
        &serde_json::to_string_pretty(&pj).unwrap(),
    )?;

    Ok(project_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_project_art(dir: String) -> Result<Vec<String>, String> {
    let art_dir = std::path::Path::new(&dir).join("art");
    if !art_dir.is_dir() {
        return Ok(vec![]);
    }

    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&art_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") {
                files.push(name);
            }
        }
    }
    files.sort();
    Ok(files)
}

#[tauri::command]
pub fn list_project_scripts(dir: String) -> Result<Vec<serde_json::Value>, String>
{
    list_project_scripts_impl(std::path::Path::new(&dir))
}

/// Pure helper backing the `list_project_scripts` Tauri command.
///
/// Walks `<dir>` recursively (max depth 16, tracked by a counter — symlinks
/// are skipped entirely, never followed) and returns every `.mangaplay.md`
/// or `.fountain.md` script. Returned `name` is relative to `<dir>` so
/// nested files retain their subfolder prefix (e.g. `chapter-1/intro.mangaplay.md`).
///
/// Skips:
///   * dotfiles (names beginning with `.`)
///   * entries failing `validate_basename` (defence in depth)
///   * symlinks (skipped, not followed)
///
/// If `<dir>` does not exist, returns an empty Vec without erroring — callers
/// rely on this for a freshly-minted project whose `project/` dir was never
/// scaffolded.
pub fn list_project_scripts_impl(
    p: &std::path::Path,
) -> Result<Vec<serde_json::Value>, String>
{
    if !p.is_dir()
    {
        return Ok(vec![]);
    }
    let mut entries: Vec<serde_json::Value> = Vec::new();
    walk_scripts(p, p, 0, &mut entries);
    entries.sort_by(|a, b|
    {
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });
    Ok(entries)
}

/// Returns true when `name` is a script file (one of the editable plain-text
/// formats). Accepts both the `.md`-suffixed forms and the bare extensions
/// (the older convention some user projects still carry).
pub fn is_script_filename(name: &str) -> bool
{
    name.ends_with(".mangaplay.md")
        || name.ends_with(".fountain.md")
        || name.ends_with(".sup.md")
        || name.ends_with(".mangaplay")
        || name.ends_with(".fountain")
        || name.ends_with(".sup")
        || name.ends_with(".txt")
}

pub(crate) const MAX_SCRIPT_WALK_DEPTH: u32 = 16;

/// Per-project reserved app directory. All app-managed metadata, drawings,
/// and machine-local state live nested under `<project>/_mangaplaystudio/`.
/// The leading underscore sorts the directory to the top of file-manager
/// listings and signals "not user content". Reserved at depth 0 only —
/// deeper folders with the same name are rejected by `validate_basename`
/// at the create/rename API boundary, not by the explorer walker.
pub const APP_DIR: &str = "_mangaplaystudio";

/// Subdirectory of [`APP_DIR`] that holds machine-local settings
/// (session.json, fold-state.json, transient markers). The full path is
/// `<project>/_mangaplaystudio/settings/`.
pub const SETTINGS_SUBDIR: &str = "settings";

pub(crate) fn app_dir(root: &std::path::Path) -> std::path::PathBuf
{
    root.join(APP_DIR)
}

pub(crate) fn project_json_path(root: &std::path::Path) -> std::path::PathBuf
{
    app_dir(root).join("project.json")
}

pub(crate) fn meta_json_path(root: &std::path::Path) -> std::path::PathBuf
{
    app_dir(root).join("meta.json")
}

pub(crate) fn storyboard_dir(root: &std::path::Path) -> std::path::PathBuf
{
    app_dir(root).join("storyboard")
}

pub(crate) fn settings_dir(root: &std::path::Path) -> std::path::PathBuf
{
    app_dir(root).join(SETTINGS_SUBDIR)
}

/// Files/folders the explorer never surfaces. Applied at the project root
/// only (depth 0). One reserved name — [`APP_DIR`] — covers project.json,
/// meta.json, the storyboard tree, and the settings folder now that they
/// all live nested inside it.
const EXPLORER_IGNORE_NAMES: &[&str] = &[APP_DIR];

/// Read `modifiedAt` + `createdAt` (unix seconds) for `path`. One metadata
/// syscall, both fields. Returns `(modified, created)`; `created` falls
/// back to `modified` when the platform doesn't expose creation time.
/// Errors are silently zeroed — used for UI sort keys, not correctness.
fn metadata_times(path: &std::path::Path) -> (u64, u64)
{
    let meta = match std::fs::metadata(path) { Ok(m) => m, Err(_) => return (0, 0) };
    let modified_at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let created_at = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(modified_at);
    (modified_at, created_at)
}

fn walk_scripts(
    root: &std::path::Path,
    cur: &std::path::Path,
    depth: u32,
    out: &mut Vec<serde_json::Value>,
)
{
    if depth > MAX_SCRIPT_WALK_DEPTH { return; }
    let read = match std::fs::read_dir(cur)
    {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read.flatten()
    {
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy().to_string();
        if name.starts_with('.') { continue; }

        // Skip symlinks outright. symlink_metadata() returns the link's own
        // metadata (vs metadata() which follows). is_symlink() catches both
        // file and directory symlinks.
        let lmeta = match std::fs::symlink_metadata(entry.path())
        {
            Ok(m) => m,
            Err(_) => continue,
        };
        if lmeta.file_type().is_symlink() { continue; }

        if lmeta.is_dir()
        {
            walk_scripts(root, &entry.path(), depth + 1, out);
            continue;
        }
        if !lmeta.is_file() { continue; }

        let is_script = is_script_filename(&name);
        if !is_script { continue; }
        // Defence in depth: skip anything that wouldn't pass the basename
        // validator (e.g. control chars, reserved names). The walker only
        // visits real on-disk entries so this is belt-and-braces.
        if crate::validate_basename::validate_basename(&name).is_err() { continue; }

        let path = entry.path();
        let (modified_at, created_at) = metadata_times(&path);

        // Build the display name as the path relative to root, using forward
        // slashes so the JS side gets a single consistent separator across
        // platforms (the UI uses it as a unique key, not as a filesystem path).
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let rel_name = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");

        out.push(serde_json::json!({
            "name": rel_name,
            "modifiedAt": modified_at,
            "createdAt": created_at
        }));
    }
}

// ── Project tree listing (folders + scripts) ─────────────────────────────

#[tauri::command]
pub fn app_list_project_tree(dir: String) -> Result<Vec<serde_json::Value>, String>
{
    list_project_tree_impl(std::path::Path::new(&dir))
}

/// Pure helper backing the `app_list_project_tree` Tauri command.
///
/// Walks `<dir>` recursively (same rules as `list_project_scripts_impl`) but
/// emits BOTH folder and file entries. Folders are only emitted when they
/// contain at least one script (directly or transitively) — empty folders
/// that hold nothing useful are excluded so the explorer stays readable.
///
/// Entry shape: `{ name, kind, path, modifiedAt, createdAt }` where `name`
/// is the forward-slash relative path from `<dir>`.
pub fn list_project_tree_impl(
    p: &std::path::Path,
) -> Result<Vec<serde_json::Value>, String>
{
    if !p.is_dir()
    {
        return Ok(vec![]);
    }
    let mut entries: Vec<serde_json::Value> = Vec::new();
    walk_tree(p, p, 0, &mut entries);
    entries.sort_by(|a, b|
    {
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });
    Ok(entries)
}

/// Recursive walker for `list_project_tree_impl`. Returns `true` when the
/// current subtree contains at least one script — used by the caller to
/// decide whether to emit the folder row.
fn walk_tree(
    root: &std::path::Path,
    cur: &std::path::Path,
    depth: u32,
    out: &mut Vec<serde_json::Value>,
) -> bool
{
    if depth > MAX_SCRIPT_WALK_DEPTH { return false; }
    let read = match std::fs::read_dir(cur)
    {
        Ok(r) => r,
        Err(_) => return false,
    };
    let mut subtree_has_script = false;
    for entry in read.flatten()
    {
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy().to_string();
        if name.starts_with('.') { continue; }

        // Root-only ignore list: hide the per-project app directory
        // (`_mangaplaystudio/`). Deeper folders that happen to share the
        // name are rejected by `validate_basename` at the create/rename
        // API boundary, not by this walker — depth-0 is the only place
        // the explorer needs to hide the reserved entry.
        if depth == 0
        {
            if EXPLORER_IGNORE_NAMES.contains(&name.as_str()) { continue; }
        }

        let lmeta = match std::fs::symlink_metadata(entry.path())
        {
            Ok(m) => m,
            Err(_) => continue,
        };
        if lmeta.file_type().is_symlink() { continue; }

        let path = entry.path();
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let rel_name = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");

        if lmeta.is_dir()
        {
            // Always emit folders that exist on disk — empty folders are
            // expected (the user just created one with intent to put things
            // in it, and the tree UI lets them collapse what they don't
            // want). Earlier "only emit folders with scripts" filter hid
            // freshly-created folders, which made New Folder feel broken.
            let (modified_at, created_at) = metadata_times(&path);
            out.push(serde_json::json!({
                "name": rel_name,
                "kind": "folder",
                "path": path.to_string_lossy().to_string(),
                "modifiedAt": modified_at,
                "createdAt": created_at,
            }));
            let has_script = walk_tree(root, &entry.path(), depth + 1, out);
            if has_script { subtree_has_script = true; }
            continue;
        }
        if !lmeta.is_file() { continue; }

        let is_script = is_script_filename(&name);
        if !is_script { continue; }
        if crate::validate_basename::validate_basename(&name).is_err() { continue; }

        let (modified_at, created_at) = metadata_times(&path);

        out.push(serde_json::json!({
            "name": rel_name,
            "kind": "file",
            "path": path.to_string_lossy().to_string(),
            "modifiedAt": modified_at,
            "createdAt": created_at,
        }));
        subtree_has_script = true;
    }
    subtree_has_script
}

/// Read `<project_dir>/_mangaplaystudio/project.json` and return the named
/// field's string value. Returns `None` for missing file, parse failure, or
/// absent / non-string field. Read-only; never mints, never writes.
pub(crate) fn read_project_json_field(project_dir: &std::path::Path, field: &str) -> Option<String>
{
    let pj = project_json_path(project_dir);
    let raw = std::fs::read_to_string(&pj).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get(field).and_then(|x| x.as_str()).map(|s| s.to_string())
}
