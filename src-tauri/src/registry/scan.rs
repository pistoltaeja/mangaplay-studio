//! Scan-and-mint helper: reconcile the in-memory UUID registry with the
//! project tree on disk.
//!
//! See [`TODO/uuid-file-registry.md`](../../../../TODO/uuid-file-registry.md)
//! Part 3 — Command Migration (sub-pass 3b) for the design. This module is
//! the single walker used by both the fresh-migration path (Part 5) and the
//! new `registry_list_tree` command (Part 3b).
//!
//! # Reconciliation cascade
//!
//! For every file/folder visited on disk:
//!
//! 1. Compute the on-handle [`NativeId`]. Skipped for folders — walking into
//!    them is enough; native-ID reads are file-only for now.
//! 2. If the ID appears in [`LoadedRegistry::native_id_index`] the file has
//!    kept its identity across a rename/move. Reuse the UUID, heal
//!    `entry.path` if it drifted, and un-tombstone if it was buried.
//! 3. Else if the on-disk relative path appears in
//!    [`LoadedRegistry::path_index`] the same UUID survives a delete →
//!    re-create at the same path (inode is new, ID differs). Reuse the
//!    UUID, refresh `entry.native_id`, un-tombstone.
//! 4. Else mint a fresh UUID and insert.
//!
//! Any entry that was NOT touched during the walk is tombstoned at the end
//! of the scan (files that vanished while the app was closed). Tombstoned
//! entries are NOT emitted in the returned Vec; Part 5 handles purge.
//!
//! # Skips
//!
//! Mirrors `list_project_tree_impl` exactly:
//! - dot-prefixed names at any depth (`.git`, `.DS_Store`, ...);
//! - `_mangaplaystudio/` at depth 0 (reserved app dir);
//! - symlinks (via `symlink_metadata` + `is_symlink`);
//! - files that fail [`crate::validate_basename::validate_basename`];
//! - files that aren't scripts (per [`crate::commands::project::is_script_filename`]).
//!
//! Matches OLD `list_project_tree_impl` — every on-disk folder is emitted,
//! regardless of whether it has scripts. New Folder must feel responsive to
//! the user. An earlier "only emit folders with scripts" filter hid freshly-
//! created folders and made New Folder feel broken; see the comment at
//! [`crate::commands::project`] `walk_tree`'s dir branch. Do not reintroduce.

use std::collections::HashSet;
use std::fs::OpenOptions;
use std::path::Path;

use uuid::Uuid;

use crate::commands::project::{APP_DIR, MAX_SCRIPT_WALK_DEPTH, is_script_filename};
use crate::registry::fs_err::FsErr;
use crate::registry::native_id::NativeId;
use crate::registry::native_id_read::read_native_id;
use crate::registry::state::LoadedRegistry;
use crate::registry::store::RegistryEntry;
use crate::registry::tree_entry::TreeEntryDto;
use crate::validate_basename::validate_basename;

/// Walk the project tree and reconcile the in-memory registry with what's
/// on disk.
///
/// See the module-level docs for the full cascade. Returns a
/// `Vec<TreeEntryDto>` sorted by `rel_path` — the same shape (folder rows +
/// file rows) the JS tree UI expects from the OLD `app_list_project_tree`.
///
/// Callers must hold the registry mutex via
/// [`crate::registry::ProjectRegistryState::with_loaded`]; that closure
/// automatically rebuilds the reverse indices on return so this function
/// does not need to.
///
/// Tombstoned entries mutate `reg.dirty = true` but the returned Vec never
/// contains them — the JS tree is a live-view.
pub fn scan_and_reconcile(reg: &mut LoadedRegistry) -> Result<Vec<TreeEntryDto>, FsErr>
{
    // UUIDs touched during this walk. Anything in `reg.entries` NOT in this
    // set is tombstoned at the tail. HashSet<Uuid> — cheap for the sizes
    // we're realistically dealing with (small thousands at worst).
    let mut visited: HashSet<Uuid> = HashSet::new();

    // Root path is borrowed for the whole walk; clone once to avoid holding
    // an immutable borrow of `reg` while we mutate `reg.entries`.
    let root_path = reg.root_path.clone();

    // Guard: if root doesn't exist, refuse to walk rather than
    // silently tombstoning every entry.
    if !root_path.is_dir()
    {
        return Err(FsErr::Io
        {
            message: format!(
                "project-root-missing:{}",
                root_path.display(),
            ),
        });
    }

    // Recursive walker. Every on-disk folder + script it visits is added
    // to `visited`; anything already in `reg.entries` that wasn't visited
    // is tombstoned below.
    walk_dir(reg, &root_path, &root_path, 0, None, &mut visited)?;

    // Tombstone anything not seen. Skip already-tombstoned rows so we don't
    // needlessly flip `dirty` on unchanged state.
    let mut newly_tombstoned = 0usize;
    for (uuid, entry) in reg.entries.iter_mut()
    {
        if visited.contains(uuid)
        {
            continue;
        }
        if !entry.tombstone
        {
            entry.tombstone = true;
            entry.rev = entry.rev.saturating_add(1);
            newly_tombstoned += 1;
        }
    }
    if newly_tombstoned > 0
    {
        reg.dirty = true;
    }

    // Indices are rebuilt by `with_loaded` on return — do not do it here.

    // Emit DTOs for every non-tombstoned entry. Sorted by rel_path to
    // match `list_project_tree_impl`'s output order (JS uses it as a
    // stable display key). Timestamps come from a per-row `metadata()`
    // syscall — cheap for the sizes we deal with, and the file explorer
    // tooltip depends on them ("Last modified at" / "Created at").
    let mut dtos: Vec<TreeEntryDto> = reg
        .entries
        .iter()
        .filter(|(_, e)| !e.tombstone)
        .map(|(uuid, entry)|
        {
            let abs = root_path.join(entry.path.replace('/', std::path::MAIN_SEPARATOR_STR));
            TreeEntryDto::from_entry(*uuid, entry).with_disk_metadata(&abs)
        })
        .collect();
    dtos.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    Ok(dtos)
}

/// Recursive walk step.
///
/// Matches `list_project_tree_impl::walk_tree`'s scan semantics exactly:
/// - depth cap via [`MAX_SCRIPT_WALK_DEPTH`],
/// - dot-prefix skip,
/// - depth-0 reserved-name skip ([`APP_DIR`]),
/// - symlink skip,
/// - `validate_basename` gate on files,
/// - `is_script_filename` gate on files.
///
/// Every on-disk folder that survives the skip gates is reconciled and
/// added to `visited` — matches OLD `list_project_tree_impl` where empty
/// folders are always emitted so the JS tree UI can render a freshly-
/// created New Folder before the user drops a script in.
fn walk_dir(
    reg: &mut LoadedRegistry,
    root: &Path,
    cur: &Path,
    depth: u32,
    parent_uuid: Option<Uuid>,
    visited: &mut HashSet<Uuid>,
) -> Result<(), FsErr>
{
    if depth > MAX_SCRIPT_WALK_DEPTH
    {
        return Ok(());
    }

    let read = match std::fs::read_dir(cur)
    {
        Ok(r) => r,
        // A read_dir error inside the tree is not fatal — treat as
        // "no entries here", mirroring the OLD walker.
        Err(_) => return Ok(()),
    };

    for entry in read.flatten()
    {
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy().to_string();
        if name.starts_with('.')
        {
            continue;
        }

        // Root-only reserved-name skip. Matches `list_project_tree_impl`.
        if depth == 0 && name == APP_DIR
        {
            continue;
        }

        let path = entry.path();

        let lmeta = match std::fs::symlink_metadata(&path)
        {
            Ok(m) => m,
            Err(_) => continue,
        };
        if lmeta.file_type().is_symlink()
        {
            continue;
        }

        // Project-relative forward-slash path.
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let rel_str = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");

        if lmeta.is_dir()
        {
            // Register or reuse the folder entry first so we have a UUID
            // to pass down as the children's `parent_uuid`. Folder
            // native-ID reads are not attempted here (Windows placeholder
            // + we don't need identity for folders yet); use
            // `NativeId::Unknown`. The folder is unconditionally added to
            // `visited` inside `reconcile_folder`; empty folders are
            // emitted just like OLD `list_project_tree_impl`.
            let folder_uuid = reconcile_folder(
                reg,
                &rel_str,
                parent_uuid,
                visited,
            );

            walk_dir(
                reg,
                root,
                &path,
                depth + 1,
                Some(folder_uuid),
                visited,
            )?;
            continue;
        }

        if !lmeta.is_file()
        {
            continue;
        }
        if !is_script_filename(&name)
        {
            continue;
        }
        if validate_basename(&name).is_err()
        {
            continue;
        }

        // Read native ID from an open handle — TOCTOU-safe.
        let f = match OpenOptions::new().read(true).open(&path)
        {
            Ok(f) => f,
            Err(_) => continue,
        };
        let native = read_native_id(&f).unwrap_or(NativeId::Unknown);
        drop(f);

        reconcile_file(
            reg,
            &rel_str,
            &native,
            parent_uuid,
            visited,
        );
    }

    Ok(())
}

/// Reconcile a folder entry. Folders don't participate in native-ID
/// matching (see module docs), so lookup collapses to `path_index` only.
/// Mints when absent.
///
/// Returns the folder's UUID either way.
fn reconcile_folder(
    reg: &mut LoadedRegistry,
    rel_path: &str,
    parent_uuid: Option<Uuid>,
    visited: &mut HashSet<Uuid>,
) -> Uuid
{
    if let Some(&uuid) = reg.path_index.get(rel_path)
    {
        // Path match: re-adopt, un-tombstone if needed.
        if let Some(slot) = reg.entries.get_mut(&uuid)
        {
            let mut mutated = false;
            if slot.tombstone
            {
                slot.tombstone = false;
                mutated = true;
            }
            if slot.parent_uuid != parent_uuid
            {
                slot.parent_uuid = parent_uuid;
                mutated = true;
            }
            if mutated
            {
                slot.rev = slot.rev.saturating_add(1);
                reg.dirty = true;
            }
            visited.insert(uuid);
            return uuid;
        }
        // path_index pointed at a UUID that isn't in `entries` — index
        // corruption (should be impossible under the current invariants).
        // Fall through and mint.
    }

    // Mint fresh.
    let uuid = Uuid::new_v4();
    reg.entries.insert(
        uuid,
        RegistryEntry
        {
            native_id: NativeId::Unknown,
            path: rel_path.to_string(),
            kind: "folder".to_string(),
            parent_uuid,
            rev: 1,
            tombstone: false,
            content_hash_head: None,
        },
    );
    reg.path_index.insert(rel_path.to_string(), uuid);
    reg.dirty = true;
    visited.insert(uuid);
    uuid
}

/// Reconcile a file entry via the native-ID → path cascade described in
/// the module docs. Mints when neither lookup succeeds.
///
/// The `reg.path_index` and `reg.native_id_index` are updated in-place so
/// subsequent siblings in the same directory see fresh data. `reg.dirty`
/// is set on mint, heal, and un-tombstone.
fn reconcile_file(
    reg: &mut LoadedRegistry,
    rel_path: &str,
    native_id: &NativeId,
    parent_uuid: Option<Uuid>,
    visited: &mut HashSet<Uuid>,
)
{
    // 1. Native-ID match — survives external rename.
    //    Skip when the ID is Unknown — Windows placeholder + Linux tmpfs
    //    would all collide on the same key otherwise.
    if !matches!(native_id, NativeId::Unknown)
    {
        if let Some(&uuid) = reg.native_id_index.get(native_id)
        {
            if let Some(slot) = reg.entries.get_mut(&uuid)
            {
                let mut mutated = false;
                if slot.path != rel_path
                {
                    // Heal path: remove old path-index binding, insert new.
                    reg.path_index.remove(&slot.path);
                    slot.path = rel_path.to_string();
                    reg.path_index.insert(rel_path.to_string(), uuid);
                    mutated = true;
                }
                if slot.parent_uuid != parent_uuid
                {
                    slot.parent_uuid = parent_uuid;
                    mutated = true;
                }
                if slot.tombstone
                {
                    slot.tombstone = false;
                    mutated = true;
                }
                if mutated
                {
                    slot.rev = slot.rev.saturating_add(1);
                    reg.dirty = true;
                }
                visited.insert(uuid);
                return;
            }
        }
    }

    // 2a. Tombstoned same-native_id match. Reverse indices skip tombstoned
    //     rows (see [`LoadedRegistry::rebuild_indices`]) so we linear-scan
    //     for a buried entry with our native_id. This catches "delete →
    //     scan → re-create at a different path" — the native_id survives
    //     on Linux/macOS as long as the inode is reused (rare, but the
    //     path cascade below is the more common revival route).
    if !matches!(native_id, NativeId::Unknown)
    {
        let dead = reg
            .entries
            .iter()
            .find(|(_, e)| e.tombstone && &e.native_id == native_id)
            .map(|(u, _)| *u);
        if let Some(uuid) = dead
        {
            if let Some(slot) = reg.entries.get_mut(&uuid)
            {
                if slot.path != rel_path
                {
                    slot.path = rel_path.to_string();
                }
                slot.parent_uuid = parent_uuid;
                slot.tombstone = false;
                slot.rev = slot.rev.saturating_add(1);
                reg.path_index.insert(rel_path.to_string(), uuid);
                reg.native_id_index.insert(native_id.clone(), uuid);
                reg.dirty = true;
                visited.insert(uuid);
                return;
            }
        }
    }

    // 2b. Tombstoned same-path match. Same rationale as 2a but keyed on
    //     path — this is the "same-path re-creation" case with a new
    //     inode (delete then recreate on Linux/macOS).
    {
        let dead = reg
            .entries
            .iter()
            .find(|(_, e)| e.tombstone && e.path == rel_path)
            .map(|(u, _)| *u);
        if let Some(uuid) = dead
        {
            if let Some(slot) = reg.entries.get_mut(&uuid)
            {
                // Path already matches by construction.
                // Update native_id to the freshly-read one.
                reg.native_id_index.remove(&slot.native_id);
                slot.native_id = native_id.clone();
                slot.parent_uuid = parent_uuid;
                slot.tombstone = false;
                slot.rev = slot.rev.saturating_add(1);
                reg.path_index.insert(rel_path.to_string(), uuid);
                if !matches!(native_id, NativeId::Unknown)
                {
                    reg.native_id_index.insert(native_id.clone(), uuid);
                }
                reg.dirty = true;
                visited.insert(uuid);
                return;
            }
        }
    }

    // 2. Path match — same location, possibly new inode (delete +
    //    recreate). Un-tombstone, refresh native_id.
    if let Some(&uuid) = reg.path_index.get(rel_path)
    {
        if let Some(slot) = reg.entries.get_mut(&uuid)
        {
            let mut mutated = false;
            if &slot.native_id != native_id
            {
                // Remove stale native_id_index binding (if any) and
                // install the fresh one.
                reg.native_id_index.remove(&slot.native_id);
                slot.native_id = native_id.clone();
                if !matches!(native_id, NativeId::Unknown)
                {
                    reg.native_id_index.insert(native_id.clone(), uuid);
                }
                mutated = true;
            }
            if slot.parent_uuid != parent_uuid
            {
                slot.parent_uuid = parent_uuid;
                mutated = true;
            }
            if slot.tombstone
            {
                slot.tombstone = false;
                mutated = true;
            }
            if mutated
            {
                slot.rev = slot.rev.saturating_add(1);
                reg.dirty = true;
            }
            visited.insert(uuid);
            return;
        }
    }

    // 3. Mint fresh.
    let uuid = Uuid::new_v4();
    reg.entries.insert(
        uuid,
        RegistryEntry
        {
            native_id: native_id.clone(),
            path: rel_path.to_string(),
            kind: "file".to_string(),
            parent_uuid,
            rev: 1,
            tombstone: false,
            content_hash_head: None,
        },
    );
    reg.path_index.insert(rel_path.to_string(), uuid);
    if !matches!(native_id, NativeId::Unknown)
    {
        reg.native_id_index.insert(native_id.clone(), uuid);
    }
    reg.dirty = true;
    visited.insert(uuid);
}
