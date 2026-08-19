//! JS-facing Data Transfer Object for a registry entry.
//!
//! Return shape: `TreeEntry { uuid, name, kind, parent_uuid, rev, modified_at, created_at }`.
//!
//! Deliberately named [`TreeEntryDto`] (not `TreeEntry`) to avoid clashing
//! with the existing JSON-value-based `TreeEntry` used by
//! `list_project_tree_impl` — that type will be renamed / retired once all
//! callers have migrated to the UUID-boundary commands.

use std::path::Path;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::registry::store::RegistryEntry;

/// One row of the project tree, as seen by JS.
///
/// Fields deliberately kept minimal: JS receives UUIDs + a display-only
/// `rel_path` hint, never an absolute path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntryDto
{
    /// The entry's UUID as a lowercase-hyphenated string.
    pub uuid: String,

    /// Parent folder's UUID, or `None` for a root-level entry.
    pub parent_uuid: Option<String>,

    /// Basename only — never a full path.
    pub name: String,

    /// Project-relative, forward-slash path. **Display hint only** — the
    /// canonical identity is `uuid`, and JS must not reconstruct absolute
    /// paths from this value.
    pub rel_path: String,

    /// `"file"` or `"folder"`. Kept as a string (mirroring the on-disk
    /// schema) so future kinds can land without a JS-side migration.
    pub kind: String,

    /// Current revision counter. Used by JS as `expected_rev` on the next
    /// mutating command.
    pub rev: u64,

    /// Last-modified timestamp as RFC3339, or `None` if unavailable. The
    /// registry doesn't persist this field today — callers that want it
    /// populate it from `File::metadata()` at DTO-build time via
    /// [`TreeEntryDto::with_disk_metadata`].
    pub modified_at: Option<String>,

    /// Creation timestamp as RFC3339, or `None` if unavailable. Same
    /// contract as `modified_at`. Falls back to `modified_at` on platforms
    /// that don't expose creation time.
    pub created_at: Option<String>,
}

impl TreeEntryDto
{
    /// Project a [`RegistryEntry`] + its UUID into the JS-facing DTO.
    ///
    /// The `name` field is derived from the last path component of
    /// `entry.path` (forward-slash-split). When `entry.path` is empty
    /// (the project-root row), the derived component is also empty —
    /// fall back to the literal `"(root)"` so JS never renders a blank
    /// row label. `modified_at` and `created_at` are left `None` — callers
    /// with a live filesystem path should populate them via
    /// [`Self::with_disk_metadata`] after the resolve step.
    pub fn from_entry(uuid: Uuid, entry: &RegistryEntry) -> Self
    {
        let name = entry
            .path
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("(root)")
            .to_string();

        Self
        {
            uuid: uuid.to_string(),
            parent_uuid: entry.parent_uuid.map(|u| u.to_string()),
            name,
            rel_path: entry.path.clone(),
            kind: entry.kind.clone(),
            rev: entry.rev,
            modified_at: None,
            created_at: None,
        }
    }

    /// Populate `modified_at` + `created_at` from `std::fs::metadata(path)`.
    /// Timestamps serialise as RFC3339 (UTC). Errors are silently swallowed
    /// — a missing or unreadable file leaves both fields `None`, which the
    /// JS tooltip renders as `—`. `created_at` falls back to `modified_at`
    /// on platforms without creation-time support (mirrors
    /// `metadata_times` in `commands/project.rs`).
    pub fn with_disk_metadata(mut self, path: &Path) -> Self
    {
        if let Ok(meta) = std::fs::metadata(path)
        {
            let modified = meta.modified().ok().map(chrono::DateTime::<chrono::Utc>::from);
            let created = meta.created().ok().map(chrono::DateTime::<chrono::Utc>::from).or(modified);
            self.modified_at = modified.map(|d| d.to_rfc3339());
            self.created_at = created.map(|d| d.to_rfc3339());
        }
        self
    }
}
