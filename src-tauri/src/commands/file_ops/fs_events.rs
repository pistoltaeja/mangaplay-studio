//! FS event types + filename utilities. Extracted from lib.rs verbatim.
//!
//! # Two parallel events
//!
//! Two `Emitter::emit` calls fire from the watcher hot path on every mapped
//! event:
//!
//! - `project-fs-changed` — the OLD path-only payload
//!   ([`FsChangedPayload`] + [`FsChange`]). Every existing JS listener still
//!   depends on this shape.
//! - `registry-fs-changed` — the NEW UUID-carrying payload
//!   ([`RegistryFsChangedPayload`] + [`RegistryFsChange`]). JS listeners
//!   migrate over one at a time; once all have moved, the OLD event and
//!   its emit call sites are deleted.
//!
//! See the registry implementation for the target shape and watcher event
//! handling for the JS-side reconciliation the new payload feeds.

use std::path::Path;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::Emitter;
use uuid::Uuid;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::registry::ProjectRegistryState;
use crate::registry::state::LoadedRegistry;

#[derive(serde::Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum FsChange
{
    Created { path: String },
    CreatedDir { path: String },
    Modified { path: String },
    Deleted,
    Renamed { to: String },
    Copied { to: String },
}

#[derive(serde::Serialize, Clone)]
pub struct FsChangedPayload
{
    pub path: String,
    pub change: FsChange,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// Broadcasts a `project-fs-changed` event. NOTE: `path` strings carry
/// platform-native separators (backslashes on Windows, forward slashes on
/// Unix). JS-side handlers must use the shared paths.js normaliser
/// before comparing against `currentProject.path`.
pub(crate) fn emit_fs_changed(app: &tauri::AppHandle, path: &str, change: FsChange)
{
    let _ = app.emit("project-fs-changed", FsChangedPayload {
        path: path.into(),
        change,
    });
}

// ---------------------------------------------------------------------------
// registry-fs-changed event
// ---------------------------------------------------------------------------

/// UUID-carrying payload variants for the new `registry-fs-changed` event.
///
/// Serde-tagged on the enum itself — the variant name lands as
/// `change: "created" | "modified" | ...` in the emitted JSON. Every
/// multi-word field carries an explicit `#[serde(rename = "kebab-case")]`
/// so the emitted keys are deterministic; `rename_all` on the enum does
/// NOT propagate into per-variant field names (hard-won lesson —
/// see the note on [`crate::registry::FsErr`]).
///
/// Emitted JSON shapes (JS handlers consume these verbatim):
///
/// | Variant     | Emitted JSON keys                                                  |
/// |-------------|---------------------------------------------------------------------|
/// | `Created`   | `change="created"`, `uuid`, `parent-uuid`, `name`, `rel-path`, `rev`, `kind` |
/// | `Modified`  | `change="modified"`, `uuid`, `rel-path`, `rev`                     |
/// | `Deleted`   | `change="deleted"`, `uuid`, `rel-path`                             |
/// | `Renamed`   | `change="renamed"`, `uuid`, `rel-path`, `new-name`, `rev`          |
/// | `Moved`     | `change="moved"`, `uuid`, `rel-path`, `new-parent-uuid`, `rev`     |
/// | `Unknown`   | `change="unknown"`, `rel-path`                                     |
///
/// The `Unknown` variant is the escape hatch: whenever the registry can't
/// resolve the path (either because the registry isn't loaded, or the
/// path is genuinely new / was already deleted before the last scan),
/// the emit still fires — JS treats `Unknown` as a hint to call
/// `registry_list_tree` and refresh.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(tag = "change", rename_all = "kebab-case")]
pub enum RegistryFsChange
{
    /// Not emitted by the watcher; reserved for synthetic emits from
    /// mutation commands.
    Created
    {
        uuid: String,
        #[serde(rename = "parent-uuid")]
        parent_uuid: Option<String>,
        name: String,
        #[serde(rename = "rel-path")]
        rel_path: String,
        rev: u64,
        kind: String,
    },
    Modified
    {
        uuid: String,
        #[serde(rename = "rel-path")]
        rel_path: String,
        rev: u64,
    },
    Deleted
    {
        uuid: String,
        #[serde(rename = "rel-path")]
        rel_path: String,
    },
    Renamed
    {
        uuid: String,
        #[serde(rename = "rel-path")]
        rel_path: String,
        #[serde(rename = "new-name")]
        new_name: String,
        rev: u64,
    },
    /// Not emitted by the watcher; reserved for synthetic emits from
    /// mutation commands.
    Moved
    {
        uuid: String,
        #[serde(rename = "rel-path")]
        rel_path: String,
        #[serde(rename = "new-parent-uuid")]
        new_parent_uuid: Option<String>,
        rev: u64,
    },
    /// Registry doesn't know this path. JS should refresh the tree.
    Unknown
    {
        #[serde(rename = "rel-path")]
        rel_path: String,
    },
}

/// Envelope for the `registry-fs-changed` Tauri event.
///
/// Note the shape flattens the change type into the enum tag itself —
/// one less nesting layer than the OLD `FsChangedPayload { path, change }`.
#[derive(serde::Serialize, Clone)]
pub struct RegistryFsChangedPayload
{
    pub change: RegistryFsChange,
}

/// Normalise a watcher-supplied absolute path to a project-relative
/// forward-slash string using `root_path` as the prefix.
///
/// On Windows the watcher hands us backslash paths; we strip the project
/// root prefix and rewrite separators. If the path is outside the root
/// (should not happen — the watcher only watches subtrees of it) we fall
/// back to the raw slash-rewritten form so callers still see something
/// they can log.
fn to_rel_path(root: &Path, abs_path: &str) -> String
{
    let abs = Path::new(abs_path);
    let rel = abs.strip_prefix(root).unwrap_or(abs);
    rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// Extract the basename portion of an absolute-or-relative path. Handles
/// both `/` and `\` separators — the incoming `to` on Windows carries
/// backslashes.
fn basename_of(path: &str) -> String
{
    path.rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(path)
        .to_string()
}

/// Look up a `rel_path` in the registry's `path_index` and return the
/// matching entry's UUID + rev + tombstone flag. Tombstoned rows are
/// returned as-is; callers that need "live only" filter after the call.
fn lookup_path(reg: &LoadedRegistry, rel_path: &str) -> Option<(Uuid, u64, bool)>
{
    let uuid = reg.path_index.get(rel_path).copied()?;
    let entry = reg.entries.get(&uuid)?;
    Some((uuid, entry.rev, entry.tombstone))
}

/// Snapshot-only resolver: translate a `(path, FsChange)` pair from the
/// watcher into a [`RegistryFsChange`] using a read-only view of the
/// registry.
///
/// Never mutates the registry. That means:
/// - `Created` / `CreatedDir` always map to `Unknown { rel_path }` —
///   watcher fires BEFORE JS calls `registry_list_tree`, so the registry
///   has no UUID for the new file yet. JS handles `Unknown` by refreshing
///   the tree, which mints the UUID on the next scan.
/// - `Copied { to }` similarly maps to `Unknown { rel_path: to }` — the
///   destination is a brand-new file.
/// - `Modified` / `Deleted` / `Renamed` map to their UUID-carrying
///   variants when `path_index` recognises the OLD path; otherwise fall
///   back to `Unknown`.
///
/// Watcher contract (post-3c.ii-fix): for `FsChange::Renamed`, the outer
/// `path` argument is the OLD absolute path; `to` inside the enum is the
/// NEW absolute path. This matches the OLD `project-fs-changed` JS handler
/// at app.js which expects `payload.path` to be the OLD path.
///
/// Returns `None` only when we would otherwise emit "nothing" — the
/// caller (`emit_registry_fs_changed`) treats `None` as "emit Unknown
/// with the normalised rel_path" so the event still fires.
pub fn resolve_path_to_registry_change(
    reg: &LoadedRegistry,
    path: &str,
    change: &FsChange,
) -> Option<RegistryFsChange>
{
    let rel_path = to_rel_path(&reg.root_path, path);

    match change
    {
        FsChange::Created { .. } | FsChange::CreatedDir { .. } =>
        {
            // Registry hasn't minted a UUID yet — JS must refresh.
            Some(RegistryFsChange::Unknown { rel_path })
        }

        FsChange::Modified { .. } =>
        {
            match lookup_path(reg, &rel_path)
            {
                Some((uuid, rev, _)) => Some(RegistryFsChange::Modified
                {
                    uuid: uuid.to_string(),
                    rel_path,
                    rev,
                }),
                None => Some(RegistryFsChange::Unknown { rel_path }),
            }
        }

        FsChange::Deleted =>
        {
            match lookup_path(reg, &rel_path)
            {
                Some((uuid, _, _)) => Some(RegistryFsChange::Deleted
                {
                    uuid: uuid.to_string(),
                    rel_path,
                }),
                None => Some(RegistryFsChange::Unknown { rel_path }),
            }
        }

        FsChange::Renamed { to } =>
        {
            // `rel_path` here is the OLD path (from the payload's `path`
            // field). The registry's `entry.path` still reflects the OLD
            // location — external renames only sync on `scan_and_reconcile`.
            let new_name = basename_of(to);
            match lookup_path(reg, &rel_path)
            {
                Some((uuid, rev, _)) => Some(RegistryFsChange::Renamed
                {
                    uuid: uuid.to_string(),
                    rel_path,
                    new_name,
                    rev,
                }),
                None => Some(RegistryFsChange::Unknown { rel_path }),
            }
        }

        FsChange::Copied { to } =>
        {
            // Destination is a brand-new file — no UUID yet.
            let rel_to = to_rel_path(&reg.root_path, to);
            Some(RegistryFsChange::Unknown { rel_path: rel_to })
        }
    }
}

/// Broadcasts the NEW `registry-fs-changed` event alongside the OLD
/// `project-fs-changed` one.
///
/// If no project is loaded (or the inner mutex is poisoned), we still
/// emit an `Unknown` event carrying a best-effort `rel_path` — the JS
/// side treats it as "refresh the tree" which is the safe default.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn emit_registry_fs_changed(
    app: &tauri::AppHandle,
    registry_state: &ProjectRegistryState,
    path: &str,
    change: &FsChange,
)
{
    let payload = match registry_state.0.lock()
    {
        Ok(guard) =>
        {
            match guard.as_ref()
            {
                Some(reg) =>
                {
                    let rfc = resolve_path_to_registry_change(reg, path, change)
                        .unwrap_or_else(|| RegistryFsChange::Unknown
                        {
                            rel_path: to_rel_path(&reg.root_path, path),
                        });
                    RegistryFsChangedPayload { change: rfc }
                }
                None =>
                {
                    // No project loaded — we can't strip a prefix, so emit
                    // the raw path (slashes rewritten) as the rel_path hint.
                    RegistryFsChangedPayload
                    {
                        change: RegistryFsChange::Unknown
                        {
                            rel_path: path.replace('\\', "/"),
                        },
                    }
                }
            }
        }
        Err(_) =>
        {
            // Poisoned mutex — fall back to the raw path.
            RegistryFsChangedPayload
            {
                change: RegistryFsChange::Unknown
                {
                    rel_path: path.replace('\\', "/"),
                },
            }
        }
    };

    let _ = app.emit("registry-fs-changed", payload);
}

/// Case-insensitive path equality (matches the renamer's case-only rename
/// detection on Windows / macOS).
pub fn path_eq_caseless(a: &Path, b: &Path) -> bool
{
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// Split a directory entry name into `(base, ext_chain)` for the duplicate
/// numbering. Recognised double-suffixes: `.mangaplay.md`, `.fountain.md`,
/// `.sup.md`. Falls back to splitting on the last `.` for everything else.
pub(crate) fn split_base_and_ext(name: &str) -> (String, String)
{
    for suffix in &[".mangaplay.md", ".fountain.md", ".sup.md"]
    {
        if let Some(stem) = name.strip_suffix(suffix)
        {
            return (stem.to_string(), (*suffix).to_string());
        }
    }
    match name.rfind('.')
    {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

/// Strip a numeric "Foo 2" suffix from a stem so duplicates are numbered
/// from the original base rather than "Foo 2 2".
pub(super) fn strip_trailing_number(stem: &str) -> String
{
    if let Some(idx) = stem.rfind(' ')
    {
        let tail = &stem[idx + 1..];
        if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit())
        {
            return stem[..idx].to_string();
        }
    }
    stem.to_string()
}

#[cfg(test)]
mod tests
{
    use super::split_base_and_ext;

    #[test]
    fn split_base_and_ext_parity()
    {
        assert_eq!(
            split_base_and_ext("Untitled.mangaplay.md"),
            ("Untitled".to_string(), ".mangaplay.md".to_string()),
        );
        assert_eq!(
            split_base_and_ext("foo.fountain.md"),
            ("foo".to_string(), ".fountain.md".to_string()),
        );
        assert_eq!(
            split_base_and_ext("bar.sup.md"),
            ("bar".to_string(), ".sup.md".to_string()),
        );
        assert_eq!(
            split_base_and_ext("note.txt"),
            ("note".to_string(), ".txt".to_string()),
        );
        assert_eq!(
            split_base_and_ext("plain"),
            ("plain".to_string(), "".to_string()),
        );
    }
}
