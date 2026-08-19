//! artMap → registry UUID re-alignment on first project open.
//!
//! Existing projects have UUIDs baked into `project.json.artMap.scripts`
//! that must survive the migration to the UUID file registry so the
//! script → mangaart continuity holds. This module walks the artMap and
//! re-keys any registry entry whose UUID differs from the artMap's UUID
//! for the same relative path.
//!
//! See `migrate_legacy_slides_cache()` and `project_open` for where this runs.

use uuid::Uuid;

use crate::registry::fs_err::FsErr;
use crate::registry::state::LoadedRegistry;

/// Fold `project.json.artMap.scripts` into `reg`. For each
/// `(rel_path, uuid)` mapping:
///
/// - Skip if the value isn't a parseable UUID string.
/// - Skip if no registry entry exists at `rel_path` (file was deleted
///   between the artMap being written and this project open).
/// - Skip if the registry entry's current UUID already matches the artMap
///   UUID (aligned — nothing to do).
/// - Otherwise re-key the entry under the artMap UUID: remove it under
///   the current UUID, bump `rev`, re-insert under the artMap UUID.
///   `path`, `kind`, `parent_uuid`, `native_id`, `tombstone`, and
///   `content_hash_head` are all preserved. Marks `reg.dirty`.
///
/// Returns the number of entries migrated.
///
/// Callers should hold the registry mutex via
/// [`crate::registry::state::ProjectRegistryState::with_loaded`]; the
/// closure auto-rebuilds `native_id_index` and `path_index` on return, so
/// this function updates `path_index` in-place for correctness within the
/// loop but does not rebuild the reverse indices itself.
pub fn fold_artmap_into_registry(
    reg: &mut LoadedRegistry,
    art_map_scripts: &serde_json::Map<String, serde_json::Value>,
) -> Result<usize, FsErr>
{
    let mut migrated = 0usize;

    for (rel_path, value) in art_map_scripts
    {
        // 1. Value must be a string.
        let artmap_uuid_str = match value.as_str()
        {
            Some(s) => s,
            None => continue,
        };
        // 2. String must parse as a UUID.
        let artmap_uuid = match Uuid::parse_str(artmap_uuid_str)
        {
            Ok(u) => u,
            Err(_) => continue,
        };

        // 3. rel_path must resolve to a live registry entry.
        let current_uuid = match reg.path_index.get(rel_path.as_str())
        {
            Some(u) => *u,
            None => continue,
        };

        // 4. Already aligned → no-op.
        if current_uuid == artmap_uuid
        {
            continue;
        }

        // 5. Collision guard — if the artMap UUID already belongs to a
        //    different entry (either another artMap row we already folded
        //    this pass, or a scan-minted UUID that happens to collide),
        //    skip rather than clobber. Overwriting would silently lose the
        //    original entry at `artmap_uuid`.
        if reg.entries.contains_key(&artmap_uuid)
        {
            eprintln!(
                "[fold_artmap] skipping {}: artmap UUID {} already assigned to another entry",
                rel_path, artmap_uuid,
            );
            continue;
        }

        // 6. Re-key the entry under the artMap UUID. Preserve every
        //    field except `rev`, which is bumped once for the rename.
        let mut entry = match reg.entries.remove(&current_uuid)
        {
            Some(e) => e,
            None => continue,
        };
        entry.rev = entry.rev.saturating_add(1);

        // Update path_index immediately so subsequent iterations of this
        // loop see the new UUID at this path. (The auto-rebuild on
        // `with_loaded` return would fix this too, but keeping the index
        // consistent inside the loop is defensive against future callers
        // that read `reg.path_index` between iterations.)
        reg.path_index.insert(rel_path.clone(), artmap_uuid);

        reg.entries.insert(artmap_uuid, entry);
        reg.dirty = true;
        migrated += 1;
    }

    Ok(migrated)
}
