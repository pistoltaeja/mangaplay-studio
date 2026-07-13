//! UUID-boundary Tauri commands (Parts 3b + 3c.i of `TODO/uuid-file-registry.md`).
//!
//! These commands are the NEW UUID-first entry points. They coexist with the
//! legacy path-based commands (`app_list_project_tree`, `read_project_file`,
//! ...) while Part 4 flips JS callers over one at a time. The legacy
//! commands are deleted at the very end.
//!
//! # Locking model
//!
//! Every mutating pass through the registry must serialise against the
//! project's [`ProjectJsonLocks`] entry — the same lock that gates the
//! `project.json` RMW cycle. Locking here avoids a torn write between the
//! scan (which may mint UUIDs / heal paths / tombstone entries) and the
//! `flush_if_dirty` that persists those mutations.
//!
//! # Deferred / out of scope for 3c.i
//!
//! - Project-root mutations (`registry_rename_project`, `registry_rename_folder`,
//!   `registry_move_folder`) — these touch the registry's `root_path` anchor
//!   and require re-opening the project. Deferred to a follow-up; the OLD
//!   path-based commands (`app_rename_project`, `app_rename_folder`,
//!   `app_move_folder`) remain in the invoke_handler.
//! - Mangaart / scriptmap (`mangaart_resolve_path`, `mangaart_scaffold`,
//!   `scriptmap_get_or_mint`) — these touch script→art UUID linking which
//!   the registry subsumes in Part 5. OLD commands remain running.
//! - Save-file-dialog (`app_save_file_dialog`) — a native picker, not a
//!   registry-aware fs operation. OLD command untouched.
//! - Watcher payload (fs_watch.rs) — Part 3c.ii.

use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;

use serde::Serialize;
use uuid::Uuid;

use crate::art_map::art_map_find_script_by_uuid;
use crate::commands::file_ops::trash::{apply_art_cleanup_remove_locked, apply_art_cleanup_trash_locked};
use crate::commands::mangaart::mangaart_resolve_by_uuid_impl;
use crate::commands::project::{is_script_filename, storyboard_dir};
use crate::commands::project_mutations::{read_project_json, write_project_json};
use crate::fs_helpers::{atomic_write_impl, next_free_name, trash_or_remove};
use crate::locks::ProjectJsonLocks;
use crate::registry::fs_err::{FsErr, to_command_result};
use crate::registry::native_id::NativeId;
use crate::registry::native_id_read::read_native_id;
use crate::registry::resolve::resolve_and_open;
use crate::registry::scan::scan_and_reconcile;
use crate::registry::state::{LoadedRegistry, ProjectRegistryState, RegistryStateErr};
use crate::registry::store::RegistryEntry;
use crate::registry::tree_entry::TreeEntryDto;
use crate::validate_basename::validate_basename;

/// Map a [`RegistryStateErr`] into the [`FsErr`] taxonomy JS understands.
/// `NoProjectOpen` stays semantic; everything else collapses to
/// `FsErr::Internal` so JS can log-and-toast without misclassifying a
/// poisoned-mutex or failed save as "please pick a project again".
fn state_err_to_fs_err(e: RegistryStateErr) -> FsErr
{
    match e
    {
        RegistryStateErr::NoProjectOpen => FsErr::NoProjectOpen,
        RegistryStateErr::MutexPoisoned(m) => FsErr::Internal { message: m },
        RegistryStateErr::SaveFailed(m) => FsErr::Internal { message: m },
    }
}

/// Parse a UUID string. On failure, return `FsErr::UnknownUuid` — the JS
/// side already treats an unrecognised UUID as "force refresh", which is
/// the same reaction it should have to malformed input.
fn parse_uuid(s: &str) -> Result<Uuid, FsErr>
{
    Uuid::parse_str(s).map_err(|_| FsErr::UnknownUuid { uuid: s.to_string() })
}

/// Optimistic-concurrency check. `expected == 0` is treated as "don't
/// check" so boot-time JS reads that don't yet track a rev can pass.
fn check_expected_rev(current: u64, expected: u64, uuid: Uuid) -> Result<(), FsErr>
{
    if expected == 0 || current == expected
    {
        Ok(())
    }
    else
    {
        Err(FsErr::StaleRev
        {
            uuid: uuid.to_string(),
            current_rev: current,
            expected_rev: expected,
        })
    }
}

/// Acquire the outer per-project lock, snapshot the current root_path in
/// one step. Returns the root path + owning `MutexGuard`.
///
/// Every mutating command follows this recipe:
///   1. Snapshot root_path via `with_loaded`.
///   2. Acquire per-project lock (held across the mutation + flush).
///   3. Do work via a second `with_loaded` (impl helper).
///   4. Flush if dirty.
fn snapshot_root_path(
    registry_state: &ProjectRegistryState,
) -> Result<PathBuf, FsErr>
{
    registry_state
        .with_loaded(|reg| reg.root_path.clone())
        .map_err(state_err_to_fs_err)
}

// ===========================================================================
// registry_list_tree — Part 3b
// ===========================================================================

/// UUID-boundary replacement for `app_list_project_tree`.
///
/// Walks the currently-open project's tree, reconciles the in-memory
/// registry against disk (mint / heal / tombstone), flushes any resulting
/// mutations, and returns the tree as a `Vec<TreeEntryDto>` sorted by
/// `rel_path`.
///
/// The old command stays registered — Part 4 flips callers over
/// incrementally. Both coexist during the migration.
#[tauri::command]
pub fn registry_list_tree(
    registry_state: tauri::State<ProjectRegistryState>,
    locks: tauri::State<ProjectJsonLocks>,
) -> Result<Vec<TreeEntryDto>, String>
{
    let root_path = match snapshot_root_path(&registry_state)
    {
        Ok(p) => p,
        Err(e) => return to_command_result(Err(e)),
    };

    let mtx = locks.lock_for(&root_path);
    let _guard = match mtx.lock()
    {
        Ok(g) => g,
        Err(e) =>
        {
            return to_command_result(Err(FsErr::Internal
            {
                message: format!("project-lock-poisoned:{}", e),
            }));
        }
    };

    let dtos = match registry_state.with_loaded(|reg| scan_and_reconcile(reg))
    {
        Ok(inner) => match inner
        {
            Ok(v) => v,
            Err(fs_err) => return to_command_result(Err(fs_err)),
        },
        Err(e) => return to_command_result(Err(state_err_to_fs_err(e))),
    };

    if let Err(e) = registry_state.flush_if_dirty()
    {
        return to_command_result(Err(state_err_to_fs_err(e)));
    }

    Ok(dtos)
}

// ===========================================================================
// Read DTOs
// ===========================================================================

/// Payload for [`registry_read_file`] — file contents + current rev.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult
{
    pub contents: String,
    pub rev: u64,
}

/// Payload for write commands that don't return a full DTO.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevResult
{
    pub rev: u64,
}

// ===========================================================================
// registry_read_file
// ===========================================================================

/// Pure impl behind [`registry_read_file`]. Reads via the resolved handle.
pub fn registry_read_file_impl(
    reg: &mut LoadedRegistry,
    uuid: Uuid,
) -> Result<ReadResult, FsErr>
{
    let (mut file, entry) = resolve_and_open(reg, uuid, false)?;
    if entry.kind == "folder"
    {
        return Err(FsErr::Io { message: "is-a-folder".to_string() });
    }
    let mut buf = String::new();
    file.read_to_string(&mut buf).map_err(FsErr::from)?;
    Ok(ReadResult { contents: buf, rev: entry.rev })
}

#[tauri::command]
pub fn registry_read_file(
    registry_state: tauri::State<ProjectRegistryState>,
    locks: tauri::State<ProjectJsonLocks>,
    uuid: String,
) -> Result<ReadResult, String>
{
    let parsed = match parse_uuid(&uuid)
    {
        Ok(u) => u,
        Err(e) => return to_command_result(Err(e)),
    };
    let root_path = match snapshot_root_path(&registry_state)
    {
        Ok(p) => p,
        Err(e) => return to_command_result(Err(e)),
    };
    let mtx = locks.lock_for(&root_path);
    let _guard = match mtx.lock()
    {
        Ok(g) => g,
        Err(e) => return to_command_result(Err(FsErr::Internal
        {
            message: format!("project-lock-poisoned:{}", e),
        })),
    };
    let result: Result<ReadResult, FsErr> = registry_state
        .with_loaded(|reg| registry_read_file_impl(reg, parsed))
        .map_err(state_err_to_fs_err)
        .and_then(|r| r);
    // Read paths never mutate registry semantics except via a heal, which
    // sets `dirty`; flush unconditionally so a heal is persisted.
    if result.is_ok()
    {
        if let Err(e) = registry_state.flush_if_dirty()
        {
            return to_command_result(Err(state_err_to_fs_err(e)));
        }
    }
    to_command_result(result)
}

// ===========================================================================
// registry_list_scripts / registry_list_art
// ===========================================================================

/// Pure impl behind [`registry_list_scripts`]. Filters current registry to
/// script files (non-tombstoned), sorted by rel_path.
pub fn registry_list_scripts_impl(reg: &LoadedRegistry) -> Vec<TreeEntryDto>
{
    let mut out: Vec<TreeEntryDto> = reg
        .entries
        .iter()
        .filter(|(_, e)| !e.tombstone && e.kind == "file")
        .filter(|(_, e)|
        {
            let basename = e.path.rsplit('/').next().unwrap_or("");
            is_script_filename(basename)
        })
        .map(|(u, e)| TreeEntryDto::from_entry(*u, e))
        .collect();
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

#[tauri::command]
pub fn registry_list_scripts(
    registry_state: tauri::State<ProjectRegistryState>,
) -> Result<Vec<TreeEntryDto>, String>
{
    let result: Result<Vec<TreeEntryDto>, FsErr> = registry_state
        .with_loaded(|reg| registry_list_scripts_impl(reg))
        .map_err(state_err_to_fs_err);
    to_command_result(result)
}

/// Pure impl behind [`registry_list_art`]. Filters to `.mangaart` files
/// under `_mangaplaystudio/storyboard/`.
pub fn registry_list_art_impl(reg: &LoadedRegistry) -> Vec<TreeEntryDto>
{
    let mut out: Vec<TreeEntryDto> = reg
        .entries
        .iter()
        .filter(|(_, e)| !e.tombstone && e.kind == "file")
        .filter(|(_, e)|
        {
            e.path.starts_with("_mangaplaystudio/storyboard/")
                && e.path.ends_with(".mangaart")
        })
        .map(|(u, e)| TreeEntryDto::from_entry(*u, e))
        .collect();
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

#[tauri::command]
pub fn registry_list_art(
    registry_state: tauri::State<ProjectRegistryState>,
) -> Result<Vec<TreeEntryDto>, String>
{
    let result: Result<Vec<TreeEntryDto>, FsErr> = registry_state
        .with_loaded(|reg| registry_list_art_impl(reg))
        .map_err(state_err_to_fs_err);
    to_command_result(result)
}

// ===========================================================================
// registry_write_bytes
// ===========================================================================

/// Pure impl behind [`registry_write_bytes`]. Writes via the resolved
/// handle: `set_len(0)` + `write_all`. Bumps rev.
pub fn registry_write_bytes_impl(
    reg: &mut LoadedRegistry,
    uuid: Uuid,
    bytes: &[u8],
    expected_rev: u64,
) -> Result<RevResult, FsErr>
{
    let (mut file, entry) = resolve_and_open(reg, uuid, true)?;
    if entry.kind == "folder"
    {
        return Err(FsErr::Io { message: "is-a-folder".to_string() });
    }
    check_expected_rev(entry.rev, expected_rev, uuid)?;

    file.set_len(0).map_err(FsErr::from)?;
    file.write_all(bytes).map_err(FsErr::from)?;
    file.sync_all().ok();
    drop(file);

    // Bump rev on the live entry.
    let slot = reg.entries.get_mut(&uuid).ok_or_else(|| FsErr::UnknownUuid
    {
        uuid: uuid.to_string(),
    })?;
    slot.rev = slot.rev.saturating_add(1);
    let new_rev = slot.rev;
    reg.dirty = true;
    Ok(RevResult { rev: new_rev })
}

#[tauri::command]
pub fn registry_write_bytes(
    registry_state: tauri::State<ProjectRegistryState>,
    locks: tauri::State<ProjectJsonLocks>,
    uuid: String,
    bytes: Vec<u8>,
    expected_rev: u64,
) -> Result<RevResult, String>
{
    let parsed = match parse_uuid(&uuid)
    {
        Ok(u) => u,
        Err(e) => return to_command_result(Err(e)),
    };
    let root_path = match snapshot_root_path(&registry_state)
    {
        Ok(p) => p,
        Err(e) => return to_command_result(Err(e)),
    };
    let mtx = locks.lock_for(&root_path);
    let _guard = match mtx.lock()
    {
        Ok(g) => g,
        Err(e) => return to_command_result(Err(FsErr::Internal
        {
            message: format!("project-lock-poisoned:{}", e),
        })),
    };
    let result: Result<RevResult, FsErr> = registry_state
        .with_loaded(|reg| registry_write_bytes_impl(reg, parsed, &bytes, expected_rev))
        .map_err(state_err_to_fs_err)
        .and_then(|r| r);
    if result.is_ok()
    {
        if let Err(e) = registry_state.flush_if_dirty()
        {
            return to_command_result(Err(state_err_to_fs_err(e)));
        }
    }
    to_command_result(result)
}

// ===========================================================================
// registry_atomic_write
// ===========================================================================

/// Pure impl behind [`registry_atomic_write`]. Uses the atomic write helper
/// (write .tmp + rename) instead of writing through the resolved handle so
/// concurrent readers see the whole payload or nothing.
///
/// Post-rename, the entry's `native_id` is refreshed from the newly-created
/// file (POSIX gives it a fresh inode; NTFS the same via `FILE_ID_INFO`).
pub fn registry_atomic_write_impl_fn(
    reg: &mut LoadedRegistry,
    uuid: Uuid,
    contents: &str,
    expected_rev: u64,
) -> Result<RevResult, FsErr>
{
    // Resolve first — validates UUID, heals path, verifies existence.
    let (file, entry) = resolve_and_open(reg, uuid, false)?;
    if entry.kind == "folder"
    {
        return Err(FsErr::Io { message: "is-a-folder".to_string() });
    }
    check_expected_rev(entry.rev, expected_rev, uuid)?;
    drop(file);

    let abs = reg.root_path.join(&entry.path);
    let abs_str = abs.to_string_lossy().to_string();
    atomic_write_impl(&abs_str, contents).map_err(|m| FsErr::Io { message: m })?;

    // Refresh native_id from the newly-renamed file (fresh inode on POSIX).
    let refreshed = File::open(&abs).map_err(FsErr::from)?;
    let new_native = read_native_id(&refreshed).unwrap_or(NativeId::Unknown);
    drop(refreshed);

    let slot = reg.entries.get_mut(&uuid).ok_or_else(|| FsErr::UnknownUuid
    {
        uuid: uuid.to_string(),
    })?;
    // Remove any stale native_id_index binding before installing the new one.
    let old_native = std::mem::replace(&mut slot.native_id, new_native.clone());
    slot.rev = slot.rev.saturating_add(1);
    let new_rev = slot.rev;
    // Fix reverse indices in-place so subsequent lookups see the fresh id.
    reg.native_id_index.remove(&old_native);
    if !matches!(new_native, NativeId::Unknown)
    {
        reg.native_id_index.insert(new_native, uuid);
    }
    reg.dirty = true;
    Ok(RevResult { rev: new_rev })
}

#[tauri::command]
pub fn registry_atomic_write(
    registry_state: tauri::State<ProjectRegistryState>,
    locks: tauri::State<ProjectJsonLocks>,
    uuid: String,
    contents: String,
    expected_rev: u64,
) -> Result<RevResult, String>
{
    let parsed = match parse_uuid(&uuid)
    {
        Ok(u) => u,
        Err(e) => return to_command_result(Err(e)),
    };
    let root_path = match snapshot_root_path(&registry_state)
    {
        Ok(p) => p,
        Err(e) => return to_command_result(Err(e)),
    };
    let mtx = locks.lock_for(&root_path);
    let _guard = match mtx.lock()
    {
        Ok(g) => g,
        Err(e) => return to_command_result(Err(FsErr::Internal
        {
            message: format!("project-lock-poisoned:{}", e),
        })),
    };
    let result: Result<RevResult, FsErr> = registry_state
        .with_loaded(|reg| registry_atomic_write_impl_fn(reg, parsed, &contents, expected_rev))
        .map_err(state_err_to_fs_err)
        .and_then(|r| r);
    if result.is_ok()
    {
        if let Err(e) = registry_state.flush_if_dirty()
        {
            return to_command_result(Err(state_err_to_fs_err(e)));
        }
    }
    to_command_result(result)
}

// ===========================================================================
// registry_create_file
// ===========================================================================

/// The kinds accepted by [`registry_create_file`]. Mirrors the OLD
/// `create_file_impl` enum in `commands/file_ops/crud.rs`.
///
/// Returns `(ext_chain, seed_bytes)` — `None` seed means "no file, this is a
/// folder".
fn kind_to_ext_and_seed(kind: &str) -> Result<(&'static str, Option<&'static str>), FsErr>
{
    match kind
    {
        "folder" => Ok(("", None)),
        "mangaplay" => Ok((".mangaplay.md", Some("# Page 1\nPanel 1\nAction line.\n"))),
        "fountain" => Ok((".fountain.md", Some(""))),
        "superscript" => Ok((".sup.md", Some(""))),
        "text" => Ok((".txt", Some(""))),
        other => Err(FsErr::Io { message: format!("invalid-kind:{}", other) }),
    }
}

/// Split a candidate basename into `(base, ext_chain)` for
/// [`next_free_name`]. Recognises the standard script chains so
/// `next_free_name(parent, "Untitled", ".mangaplay.md", 1)` produces the
/// right numbered fallback.
fn split_base_ext(name: &str) -> (String, String)
{
    for chain in [".mangaplay.md", ".fountain.md", ".sup.md"]
    {
        if let Some(stem) = name.strip_suffix(chain)
        {
            return (stem.to_string(), chain.to_string());
        }
    }
    // Single-extension fallback: everything after the last dot (if any).
    if let Some(dot_ix) = name.rfind('.')
    {
        return (name[..dot_ix].to_string(), name[dot_ix..].to_string());
    }
    (name.to_string(), String::new())
}

/// Pure impl behind [`registry_create_file`].
pub fn registry_create_file_impl(
    reg: &mut LoadedRegistry,
    parent_uuid: Option<Uuid>,
    basename: &str,
    kind: &str,
) -> Result<TreeEntryDto, FsErr>
{
    validate_basename(basename).map_err(|e| FsErr::Io { message: e.to_string() })?;
    let (_ext, seed) = kind_to_ext_and_seed(kind)?;

    // Resolve parent → absolute path + relative prefix.
    let (parent_abs, parent_rel_prefix) = match parent_uuid
    {
        None => (reg.root_path.clone(), String::new()),
        Some(pu) =>
        {
            let pe = reg.entries.get(&pu).ok_or_else(|| FsErr::UnknownUuid
            {
                uuid: pu.to_string(),
            })?;
            if pe.tombstone
            {
                return Err(FsErr::Deleted { uuid: pu.to_string() });
            }
            if pe.kind != "folder"
            {
                return Err(FsErr::Io { message: "parent-not-folder".to_string() });
            }
            (reg.root_path.join(&pe.path), pe.path.clone())
        }
    };

    if !parent_abs.is_dir()
    {
        return Err(FsErr::Io { message: "parent-not-dir".to_string() });
    }

    // Collision-avoidance via next_free_name — mirrors OLD create_file_impl.
    let (base, ext_chain) = split_base_ext(basename);
    let final_name = next_free_name(&parent_abs, &base, &ext_chain, 1);
    let final_abs = parent_abs.join(&final_name);

    // Create on disk.
    if kind == "folder"
    {
        std::fs::create_dir(&final_abs).map_err(FsErr::from)?;
    }
    else
    {
        std::fs::write(&final_abs, seed.unwrap_or("")).map_err(FsErr::from)?;
    }

    // Compute rel path + native_id for the new entry.
    let rel_path = if parent_rel_prefix.is_empty()
    {
        final_name.clone()
    }
    else
    {
        format!("{}/{}", parent_rel_prefix, final_name)
    };

    let native_id = if kind == "folder"
    {
        NativeId::Unknown
    }
    else
    {
        match File::open(&final_abs)
        {
            Ok(f) => read_native_id(&f).unwrap_or(NativeId::Unknown),
            Err(_) => NativeId::Unknown,
        }
    };

    let new_uuid = Uuid::new_v4();
    let entry_kind = if kind == "folder" { "folder" } else { "file" };
    let entry = RegistryEntry
    {
        native_id: native_id.clone(),
        path: rel_path.clone(),
        kind: entry_kind.to_string(),
        parent_uuid,
        rev: 1,
        tombstone: false,
        content_hash_head: None,
    };
    reg.entries.insert(new_uuid, entry.clone());
    reg.path_index.insert(rel_path, new_uuid);
    if !matches!(native_id, NativeId::Unknown)
    {
        reg.native_id_index.insert(native_id, new_uuid);
    }
    reg.dirty = true;
    Ok(TreeEntryDto::from_entry(new_uuid, &entry))
}

#[tauri::command]
pub fn registry_create_file(
    registry_state: tauri::State<ProjectRegistryState>,
    locks: tauri::State<ProjectJsonLocks>,
    parent_uuid: Option<String>,
    basename: String,
    kind: String,
) -> Result<TreeEntryDto, String>
{
    let parsed_parent = match parent_uuid
    {
        None => None,
        Some(s) => match parse_uuid(&s)
        {
            Ok(u) => Some(u),
            Err(e) => return to_command_result(Err(e)),
        },
    };
    let root_path = match snapshot_root_path(&registry_state)
    {
        Ok(p) => p,
        Err(e) => return to_command_result(Err(e)),
    };
    let mtx = locks.lock_for(&root_path);
    let _guard = match mtx.lock()
    {
        Ok(g) => g,
        Err(e) => return to_command_result(Err(FsErr::Internal
        {
            message: format!("project-lock-poisoned:{}", e),
        })),
    };
    let result: Result<TreeEntryDto, FsErr> = registry_state
        .with_loaded(|reg| registry_create_file_impl(reg, parsed_parent, &basename, &kind))
        .map_err(state_err_to_fs_err)
        .and_then(|r| r);
    if result.is_ok()
    {
        if let Err(e) = registry_state.flush_if_dirty()
        {
            return to_command_result(Err(state_err_to_fs_err(e)));
        }
    }
    to_command_result(result)
}

// ===========================================================================
// registry_rename
// ===========================================================================

/// Pure impl behind [`registry_rename`]. Renames on disk, updates the
/// entry's `path`, bumps rev, and cascades path rewrites (with rev bumps)
/// through any descendants when the renamed entry is a folder.
pub fn registry_rename_impl(
    reg: &mut LoadedRegistry,
    uuid: Uuid,
    new_basename: &str,
    expected_rev: u64,
) -> Result<TreeEntryDto, FsErr>
{
    validate_basename(new_basename).map_err(|e| FsErr::Io { message: e.to_string() })?;

    let entry = reg.entries.get(&uuid).ok_or_else(|| FsErr::UnknownUuid
    {
        uuid: uuid.to_string(),
    })?.clone();
    if entry.tombstone
    {
        return Err(FsErr::Deleted { uuid: uuid.to_string() });
    }
    check_expected_rev(entry.rev, expected_rev, uuid)?;

    let old_rel = entry.path.clone();
    let old_abs = reg.root_path.join(&old_rel);

    let parent_rel = match old_rel.rsplit_once('/')
    {
        Some((p, _)) => p.to_string(),
        None => String::new(),
    };
    let new_rel = if parent_rel.is_empty()
    {
        new_basename.to_string()
    }
    else
    {
        format!("{}/{}", parent_rel, new_basename)
    };
    let new_abs = reg.root_path.join(&new_rel);

    if new_abs.exists() && old_abs != new_abs
    {
        return Err(FsErr::Io { message: "target-exists".to_string() });
    }

    std::fs::rename(&old_abs, &new_abs).map_err(FsErr::from)?;

    // Update the renamed entry itself.
    if let Some(slot) = reg.entries.get_mut(&uuid)
    {
        slot.path = new_rel.clone();
        slot.rev = slot.rev.saturating_add(1);
    }

    // Cascade for folders: rewrite every descendant path from
    // "<old_rel>/..." → "<new_rel>/...". Bump each descendant's rev so
    // JS-side clients invalidate their cached rel_path.
    if entry.kind == "folder"
    {
        let prefix_with_slash = format!("{}/", old_rel);
        for (dchild_uuid, dchild) in reg.entries.iter_mut()
        {
            if *dchild_uuid == uuid
            {
                continue;
            }
            if let Some(suffix) = dchild.path.strip_prefix(&prefix_with_slash)
            {
                dchild.path = format!("{}/{}", new_rel, suffix);
                dchild.rev = dchild.rev.saturating_add(1);
            }
        }
    }

    // Rewrite scriptMap / artMap keys + relocate storyboard subtree.
    // Caller `registry_rename` already holds the per-project lock — do NOT
    // re-acquire it (not reentrant) and do NOT call `apply_folder_art_relocation`.
    if new_rel != old_rel
    {
        let root = reg.root_path.clone();
        if entry.kind == "folder"
        {
            // Folder: prefix rewrite + physical storyboard subtree move.
            match read_project_json(&root)
            {
                Ok(mut pj) =>
                {
                    crate::art_map_rewrite_prefix(&mut pj, &old_rel, &new_rel);
                    crate::script_map_rewrite_prefix(&mut pj, &old_rel, &new_rel);
                    if let Err(e) = write_project_json(&root, &pj)
                    {
                        log::warn!(
                            "[registry_rename] failed to write project.json for {} -> {}: {}",
                            old_rel, new_rel, e,
                        );
                    }
                }
                Err(e) =>
                {
                    log::warn!(
                        "[registry_rename] project.json unreadable ({}); skipping map rewrite",
                        e,
                    );
                }
            }

            // Physical storyboard subtree move — inline rel_join since
            // crud.rs's helper is `pub(super)`.
            let sb_root = storyboard_dir(&root);
            let mut old_subtree = sb_root.clone();
            for part in old_rel.trim_matches('/').split('/')
            {
                if part.is_empty() { continue; }
                old_subtree.push(part);
            }
            let mut new_subtree = sb_root.clone();
            for part in new_rel.trim_matches('/').split('/')
            {
                if part.is_empty() { continue; }
                new_subtree.push(part);
            }
            if old_subtree.exists()
            {
                if let Some(parent) = new_subtree.parent()
                {
                    if let Err(e) = std::fs::create_dir_all(parent)
                    {
                        log::warn!(
                            "[registry_rename] failed to create storyboard parent {}: {}",
                            parent.display(), e,
                        );
                    }
                    else if let Err(e) = std::fs::rename(&old_subtree, &new_subtree)
                    {
                        log::warn!(
                            "[registry_rename] failed to move storyboard {} -> {}: {}",
                            old_subtree.display(), new_subtree.display(), e,
                        );
                    }
                }
            }
        }
        else
        {
            // File: rewrite maps only for script filenames. Don't move the
            // .mangaart on disk — identity-fallback resolver finds it by UUID.
            let basename = new_rel.rsplit('/').next().unwrap_or(&new_rel).to_string();
            if is_script_filename(&basename)
            {
                if let Ok(mut pj) = read_project_json(&root)
                {
                    let pre = pj.clone();
                    if let Some(uuid_val) = crate::art_map_get(&pj, &old_rel)
                    {
                        crate::art_map_drop(&mut pj, &old_rel);
                        crate::art_map_set(&mut pj, &new_rel, &uuid_val);
                    }
                    crate::script_map_rewrite_key(&mut pj, &old_rel, &new_rel);
                    if pj != pre
                    {
                        if let Err(e) = write_project_json(&root, &pj)
                        {
                            log::warn!(
                                "[registry_rename] failed to write project.json for {} -> {}: {}",
                                old_rel, new_rel, e,
                            );
                        }
                    }
                }
            }
        }
    }

    reg.dirty = true;
    let updated = reg.entries.get(&uuid).cloned().expect("entry present");
    Ok(TreeEntryDto::from_entry(uuid, &updated))
}

#[tauri::command]
pub fn registry_rename(
    registry_state: tauri::State<ProjectRegistryState>,
    locks: tauri::State<ProjectJsonLocks>,
    uuid: String,
    new_basename: String,
    expected_rev: u64,
) -> Result<TreeEntryDto, String>
{
    let parsed = match parse_uuid(&uuid)
    {
        Ok(u) => u,
        Err(e) => return to_command_result(Err(e)),
    };
    let root_path = match snapshot_root_path(&registry_state)
    {
        Ok(p) => p,
        Err(e) => return to_command_result(Err(e)),
    };
    let mtx = locks.lock_for(&root_path);
    let _guard = match mtx.lock()
    {
        Ok(g) => g,
        Err(e) => return to_command_result(Err(FsErr::Internal
        {
            message: format!("project-lock-poisoned:{}", e),
        })),
    };
    let result: Result<TreeEntryDto, FsErr> = registry_state
        .with_loaded(|reg| registry_rename_impl(reg, parsed, &new_basename, expected_rev))
        .map_err(state_err_to_fs_err)
        .and_then(|r| r);
    if result.is_ok()
    {
        if let Err(e) = registry_state.flush_if_dirty()
        {
            return to_command_result(Err(state_err_to_fs_err(e)));
        }
    }
    to_command_result(result)
}

// ===========================================================================
// registry_move
// ===========================================================================

/// Pure impl behind [`registry_move`]. Moves the entry to a new parent
/// folder, updates its `path` + `parent_uuid`, bumps rev, and cascades
/// descendant path rewrites for folder moves.
pub fn registry_move_impl(
    reg: &mut LoadedRegistry,
    uuid: Uuid,
    new_parent_uuid: Option<Uuid>,
    expected_rev: u64,
) -> Result<TreeEntryDto, FsErr>
{
    let entry = reg.entries.get(&uuid).ok_or_else(|| FsErr::UnknownUuid
    {
        uuid: uuid.to_string(),
    })?.clone();
    if entry.tombstone
    {
        return Err(FsErr::Deleted { uuid: uuid.to_string() });
    }
    check_expected_rev(entry.rev, expected_rev, uuid)?;

    let (dest_abs, dest_rel_prefix) = match new_parent_uuid
    {
        None => (reg.root_path.clone(), String::new()),
        Some(pu) =>
        {
            let pe = reg.entries.get(&pu).ok_or_else(|| FsErr::UnknownUuid
            {
                uuid: pu.to_string(),
            })?;
            if pe.tombstone
            {
                return Err(FsErr::Deleted { uuid: pu.to_string() });
            }
            if pe.kind != "folder"
            {
                return Err(FsErr::Io { message: "parent-not-folder".to_string() });
            }
            (reg.root_path.join(&pe.path), pe.path.clone())
        }
    };

    let old_rel = entry.path.clone();
    let basename = old_rel.rsplit('/').next().unwrap_or(&old_rel).to_string();
    let new_rel = if dest_rel_prefix.is_empty()
    {
        basename.clone()
    }
    else
    {
        format!("{}/{}", dest_rel_prefix, basename)
    };

    // No-op guard.
    if new_rel == old_rel
    {
        // Nothing to do — treat as success, return current DTO.
        return Ok(TreeEntryDto::from_entry(uuid, &entry));
    }

    // Guard: moving a folder into its own descendant.
    if entry.kind == "folder"
    {
        let self_prefix = format!("{}/", old_rel);
        if new_rel.starts_with(&self_prefix) || new_rel == old_rel
        {
            return Err(FsErr::Io { message: "move-into-own-descendant".to_string() });
        }
    }

    let old_abs = reg.root_path.join(&old_rel);
    let new_abs = dest_abs.join(&basename);
    if new_abs.exists()
    {
        return Err(FsErr::Io { message: "target-exists".to_string() });
    }

    std::fs::rename(&old_abs, &new_abs).map_err(FsErr::from)?;

    if let Some(slot) = reg.entries.get_mut(&uuid)
    {
        slot.path = new_rel.clone();
        slot.parent_uuid = new_parent_uuid;
        slot.rev = slot.rev.saturating_add(1);
    }

    if entry.kind == "folder"
    {
        let prefix_with_slash = format!("{}/", old_rel);
        for (dchild_uuid, dchild) in reg.entries.iter_mut()
        {
            if *dchild_uuid == uuid
            {
                continue;
            }
            if let Some(suffix) = dchild.path.strip_prefix(&prefix_with_slash)
            {
                dchild.path = format!("{}/{}", new_rel, suffix);
                dchild.rev = dchild.rev.saturating_add(1);
            }
        }
    }

    // Rewrite scriptMap / artMap keys + relocate storyboard subtree.
    // Caller `registry_move` already holds the per-project lock — do NOT
    // re-acquire it (not reentrant) and do NOT call `apply_folder_art_relocation`.
    if new_rel != old_rel
    {
        let root = reg.root_path.clone();
        if entry.kind == "folder"
        {
            // Folder: prefix rewrite + physical storyboard subtree move.
            match read_project_json(&root)
            {
                Ok(mut pj) =>
                {
                    crate::art_map_rewrite_prefix(&mut pj, &old_rel, &new_rel);
                    crate::script_map_rewrite_prefix(&mut pj, &old_rel, &new_rel);
                    if let Err(e) = write_project_json(&root, &pj)
                    {
                        log::warn!(
                            "[registry_move] failed to write project.json for {} -> {}: {}",
                            old_rel, new_rel, e,
                        );
                    }
                }
                Err(e) =>
                {
                    log::warn!(
                        "[registry_move] project.json unreadable ({}); skipping map rewrite",
                        e,
                    );
                }
            }

            // Physical storyboard subtree move — inline rel_join since
            // crud.rs's helper is `pub(super)`.
            let sb_root = storyboard_dir(&root);
            let mut old_subtree = sb_root.clone();
            for part in old_rel.trim_matches('/').split('/')
            {
                if part.is_empty() { continue; }
                old_subtree.push(part);
            }
            let mut new_subtree = sb_root.clone();
            for part in new_rel.trim_matches('/').split('/')
            {
                if part.is_empty() { continue; }
                new_subtree.push(part);
            }
            if old_subtree.exists()
            {
                if let Some(parent) = new_subtree.parent()
                {
                    if let Err(e) = std::fs::create_dir_all(parent)
                    {
                        log::warn!(
                            "[registry_move] failed to create storyboard parent {}: {}",
                            parent.display(), e,
                        );
                    }
                    else if let Err(e) = std::fs::rename(&old_subtree, &new_subtree)
                    {
                        log::warn!(
                            "[registry_move] failed to move storyboard {} -> {}: {}",
                            old_subtree.display(), new_subtree.display(), e,
                        );
                    }
                }
            }
        }
        else
        {
            // File: rewrite maps only for script filenames. Don't move the
            // .mangaart on disk — identity-fallback resolver finds it by UUID.
            let basename = new_rel.rsplit('/').next().unwrap_or(&new_rel).to_string();
            if is_script_filename(&basename)
            {
                if let Ok(mut pj) = read_project_json(&root)
                {
                    let pre = pj.clone();
                    if let Some(uuid_val) = crate::art_map_get(&pj, &old_rel)
                    {
                        crate::art_map_drop(&mut pj, &old_rel);
                        crate::art_map_set(&mut pj, &new_rel, &uuid_val);
                    }
                    crate::script_map_rewrite_key(&mut pj, &old_rel, &new_rel);
                    if pj != pre
                    {
                        if let Err(e) = write_project_json(&root, &pj)
                        {
                            log::warn!(
                                "[registry_move] failed to write project.json for {} -> {}: {}",
                                old_rel, new_rel, e,
                            );
                        }
                    }
                }
            }
        }
    }

    reg.dirty = true;
    let updated = reg.entries.get(&uuid).cloned().expect("entry present");
    Ok(TreeEntryDto::from_entry(uuid, &updated))
}

#[tauri::command]
pub fn registry_move(
    registry_state: tauri::State<ProjectRegistryState>,
    locks: tauri::State<ProjectJsonLocks>,
    uuid: String,
    new_parent_uuid: Option<String>,
    expected_rev: u64,
) -> Result<TreeEntryDto, String>
{
    let parsed = match parse_uuid(&uuid)
    {
        Ok(u) => u,
        Err(e) => return to_command_result(Err(e)),
    };
    let parsed_parent = match new_parent_uuid
    {
        None => None,
        Some(s) => match parse_uuid(&s)
        {
            Ok(u) => Some(u),
            Err(e) => return to_command_result(Err(e)),
        },
    };
    let root_path = match snapshot_root_path(&registry_state)
    {
        Ok(p) => p,
        Err(e) => return to_command_result(Err(e)),
    };
    let mtx = locks.lock_for(&root_path);
    let _guard = match mtx.lock()
    {
        Ok(g) => g,
        Err(e) => return to_command_result(Err(FsErr::Internal
        {
            message: format!("project-lock-poisoned:{}", e),
        })),
    };
    let result: Result<TreeEntryDto, FsErr> = registry_state
        .with_loaded(|reg| registry_move_impl(reg, parsed, parsed_parent, expected_rev))
        .map_err(state_err_to_fs_err)
        .and_then(|r| r);
    if result.is_ok()
    {
        if let Err(e) = registry_state.flush_if_dirty()
        {
            return to_command_result(Err(state_err_to_fs_err(e)));
        }
    }
    to_command_result(result)
}

// ===========================================================================
// registry_delete / registry_delete_force
// ===========================================================================

/// Delete strategy for [`registry_delete_impl`].
#[derive(Clone, Copy)]
pub enum DeleteMode
{
    /// OS trash (desktop) or `remove_file` / `remove_dir_all` (mobile).
    Trash,
    /// Hard delete: `remove_file` or `remove_dir_all` on every platform.
    Force,
}

/// Pure impl behind [`registry_delete`] / [`registry_delete_force`]. Deletes
/// from disk (trash or hard) and tombstones the entry (+ all descendants
/// for folders).
pub fn registry_delete_impl(
    reg: &mut LoadedRegistry,
    uuid: Uuid,
    expected_rev: u64,
    mode: DeleteMode,
) -> Result<(), FsErr>
{
    let entry = reg.entries.get(&uuid).ok_or_else(|| FsErr::UnknownUuid
    {
        uuid: uuid.to_string(),
    })?.clone();
    if entry.tombstone
    {
        return Err(FsErr::Deleted { uuid: uuid.to_string() });
    }
    check_expected_rev(entry.rev, expected_rev, uuid)?;

    let abs = reg.root_path.join(&entry.path);
    match mode
    {
        DeleteMode::Trash =>
        {
            trash_or_remove(&abs).map_err(|m| FsErr::Io { message: m })?;
        }
        DeleteMode::Force =>
        {
            let meta = std::fs::symlink_metadata(&abs).map_err(FsErr::from)?;
            if meta.is_dir()
            {
                std::fs::remove_dir_all(&abs).map_err(FsErr::from)?;
            }
            else
            {
                std::fs::remove_file(&abs).map_err(FsErr::from)?;
            }
        }
    }

    // Tombstone the entry.
    if let Some(slot) = reg.entries.get_mut(&uuid)
    {
        slot.tombstone = true;
        slot.rev = slot.rev.saturating_add(1);
    }

    // Cascade tombstones for folders.
    if entry.kind == "folder"
    {
        let prefix_with_slash = format!("{}/", entry.path);
        for (dchild_uuid, dchild) in reg.entries.iter_mut()
        {
            if *dchild_uuid == uuid
            {
                continue;
            }
            if dchild.path.starts_with(&prefix_with_slash) && !dchild.tombstone
            {
                dchild.tombstone = true;
                dchild.rev = dchild.rev.saturating_add(1);
            }
        }
    }

    reg.dirty = true;

    // Best-effort art cleanup — mirror `app_delete_file`'s post-trash step.
    // Never returns Err from here; the source file is already gone and the
    // user's intent is satisfied. Only fires for script files (folder delete
    // is handled separately by the caller of `delete_file_impl`; the
    // registry-level delete for folders relies on `art_map_drop_prefix`
    // running in the folder-delete path elsewhere).
    if entry.kind != "folder"
    {
        let uuid_str = uuid.to_string();
        let root = reg.root_path.clone();
        art_cleanup_best_effort(&root, &uuid_str, mode);
    }

    Ok(())
}

/// Best-effort mangaart + artMap cleanup keyed by the file's registry UUID.
/// Called AFTER the source has been trashed/removed and the registry entry
/// tombstoned. NEVER returns; every failure is logged and swallowed so the
/// delete stays committed.
///
/// Two paths:
///   1. `artMap.scripts` has an entry whose value == `uuid` → use the shared
///      `apply_art_cleanup_{trash,remove}` helper (drops the map entry AND
///      trashes/removes the `.mangaart`).
///   2. No map entry → the script may have been renamed after scaffold, so
///      the map key is stale. Fall back to scanning the storyboard tree for
///      `<uuid>.mangaart` via `mangaart_resolve_by_uuid_impl`, and trash or
///      remove the file if found.
fn art_cleanup_best_effort(root: &std::path::Path, uuid: &str, mode: DeleteMode)
{
    let pj = match read_project_json(root)
    {
        Ok(v) => v,
        Err(e) =>
        {
            eprintln!(
                "[registry_delete] art cleanup best-effort failed: project.json unreadable at {}: {}",
                root.display(),
                e,
            );
            return;
        }
    };

    if let Some(script_rel) = art_map_find_script_by_uuid(&pj, uuid)
    {
        // NOTE: use the `_locked` variants — `delete_dispatch` already holds
        // `ProjectJsonLocks::lock_for(root_path)`. The public helpers
        // re-acquire the same mutex, which is non-reentrant → deadlock.
        match mode
        {
            DeleteMode::Trash => apply_art_cleanup_trash_locked(root, &script_rel, uuid),
            DeleteMode::Force => apply_art_cleanup_remove_locked(root, &script_rel, uuid),
        }
        return;
    }

    // No map entry — try to find `<uuid>.mangaart` on disk anyway.
    let root_str = root.to_string_lossy().to_string();
    let resolved = match mangaart_resolve_by_uuid_impl(&root_str, uuid)
    {
        Ok(v) => v,
        Err(e) =>
        {
            eprintln!(
                "[registry_delete] art cleanup best-effort failed: resolve_by_uuid({}) errored: {}",
                uuid, e,
            );
            return;
        }
    };
    let Some(art_path_str) = resolved else { return; };
    let art_path = std::path::Path::new(&art_path_str);
    if !art_path.exists() { return; }
    match mode
    {
        DeleteMode::Trash =>
        {
            if let Err(e) = trash_or_remove(art_path)
            {
                eprintln!(
                    "[registry_delete] art cleanup best-effort failed: trash({}) errored: {}",
                    art_path.display(), e,
                );
            }
        }
        DeleteMode::Force =>
        {
            if let Err(e) = std::fs::remove_file(art_path)
            {
                eprintln!(
                    "[registry_delete] art cleanup best-effort failed: remove({}) errored: {}",
                    art_path.display(), e,
                );
            }
        }
    }
}

#[tauri::command]
pub fn registry_delete(
    registry_state: tauri::State<ProjectRegistryState>,
    locks: tauri::State<ProjectJsonLocks>,
    uuid: String,
    expected_rev: u64,
) -> Result<(), String>
{
    delete_dispatch(&registry_state, &locks, uuid, expected_rev, DeleteMode::Trash)
}

#[tauri::command]
pub fn registry_delete_force(
    registry_state: tauri::State<ProjectRegistryState>,
    locks: tauri::State<ProjectJsonLocks>,
    uuid: String,
    expected_rev: u64,
) -> Result<(), String>
{
    delete_dispatch(&registry_state, &locks, uuid, expected_rev, DeleteMode::Force)
}

fn delete_dispatch(
    registry_state: &tauri::State<ProjectRegistryState>,
    locks: &tauri::State<ProjectJsonLocks>,
    uuid: String,
    expected_rev: u64,
    mode: DeleteMode,
) -> Result<(), String>
{
    let parsed = match parse_uuid(&uuid)
    {
        Ok(u) => u,
        Err(e) => return to_command_result(Err(e)),
    };
    let root_path = match snapshot_root_path(registry_state)
    {
        Ok(p) => p,
        Err(e) => return to_command_result(Err(e)),
    };
    let mtx = locks.lock_for(&root_path);
    let _guard = match mtx.lock()
    {
        Ok(g) => g,
        Err(e) => return to_command_result(Err(FsErr::Internal
        {
            message: format!("project-lock-poisoned:{}", e),
        })),
    };
    let result: Result<(), FsErr> = registry_state
        .with_loaded(|reg| registry_delete_impl(reg, parsed, expected_rev, mode))
        .map_err(state_err_to_fs_err)
        .and_then(|r| r);
    if result.is_ok()
    {
        if let Err(e) = registry_state.flush_if_dirty()
        {
            return to_command_result(Err(state_err_to_fs_err(e)));
        }
    }
    to_command_result(result)
}

// ===========================================================================
// registry_copy
// ===========================================================================

/// Pure impl behind [`registry_copy`]. Reads the source file, writes to a
/// fresh next-free-name candidate in the same parent, mints a new UUID.
pub fn registry_copy_impl(
    reg: &mut LoadedRegistry,
    uuid: Uuid,
) -> Result<TreeEntryDto, FsErr>
{
    let (mut src_file, src_entry) = resolve_and_open(reg, uuid, false)?;
    if src_entry.kind == "folder"
    {
        return Err(FsErr::Io { message: "copy-folder-not-supported".to_string() });
    }
    let mut buf: Vec<u8> = Vec::new();
    src_file.read_to_end(&mut buf).map_err(FsErr::from)?;
    drop(src_file);

    let src_abs = reg.root_path.join(&src_entry.path);
    let src_basename = src_abs
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| FsErr::Io { message: "no-basename".to_string() })?
        .to_string();
    let (base, ext_chain) = split_base_ext(&src_basename);
    let parent = src_abs
        .parent()
        .ok_or_else(|| FsErr::Io { message: "no-parent".to_string() })?
        .to_path_buf();
    // Start numbering at 2 so we never re-collide with the original name.
    let new_name = next_free_name(&parent, &base, &ext_chain, 2);
    let new_abs = parent.join(&new_name);

    std::fs::write(&new_abs, &buf).map_err(FsErr::from)?;

    let new_native = match File::open(&new_abs)
    {
        Ok(f) => read_native_id(&f).unwrap_or(NativeId::Unknown),
        Err(_) => NativeId::Unknown,
    };

    let parent_rel = src_entry
        .path
        .rsplit_once('/')
        .map(|(p, _)| p.to_string())
        .unwrap_or_default();
    let new_rel = if parent_rel.is_empty()
    {
        new_name
    }
    else
    {
        format!("{}/{}", parent_rel, new_name)
    };

    let new_uuid = Uuid::new_v4();
    let entry = RegistryEntry
    {
        native_id: new_native.clone(),
        path: new_rel.clone(),
        kind: "file".to_string(),
        parent_uuid: src_entry.parent_uuid,
        rev: 1,
        tombstone: false,
        content_hash_head: None,
    };
    reg.entries.insert(new_uuid, entry.clone());
    reg.path_index.insert(new_rel, new_uuid);
    if !matches!(new_native, NativeId::Unknown)
    {
        reg.native_id_index.insert(new_native, new_uuid);
    }
    reg.dirty = true;
    Ok(TreeEntryDto::from_entry(new_uuid, &entry))
}

#[tauri::command]
pub fn registry_copy(
    registry_state: tauri::State<ProjectRegistryState>,
    locks: tauri::State<ProjectJsonLocks>,
    uuid: String,
) -> Result<TreeEntryDto, String>
{
    let parsed = match parse_uuid(&uuid)
    {
        Ok(u) => u,
        Err(e) => return to_command_result(Err(e)),
    };
    let root_path = match snapshot_root_path(&registry_state)
    {
        Ok(p) => p,
        Err(e) => return to_command_result(Err(e)),
    };
    let mtx = locks.lock_for(&root_path);
    let _guard = match mtx.lock()
    {
        Ok(g) => g,
        Err(e) => return to_command_result(Err(FsErr::Internal
        {
            message: format!("project-lock-poisoned:{}", e),
        })),
    };
    let result: Result<TreeEntryDto, FsErr> = registry_state
        .with_loaded(|reg| registry_copy_impl(reg, parsed))
        .map_err(state_err_to_fs_err)
        .and_then(|r| r);
    if result.is_ok()
    {
        if let Err(e) = registry_state.flush_if_dirty()
        {
            return to_command_result(Err(state_err_to_fs_err(e)));
        }
    }
    to_command_result(result)
}

