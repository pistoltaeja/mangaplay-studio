// ---------------------------------------------------------------------------
// slidesLinks — per-script Google Slides link registry.
//
// slidesLinks is the authority for script→presentation linkage. Lives at
// `project.json.slidesLinks`, keyed by SCRIPT UUID (not path — the path
// changes on rename, the UUID doesn't):
//
//   {
//       "slidesLinks": {
//           "<uuid>": {
//               "presentationId":    "1PqR...",
//               "linkedAt":          "2026-07-12T14:00:00Z",
//               "lastPreparedAt":    "2026-07-12T14:03:22Z",
//               "lastPrepareStatus": "clean"
//           }
//       }
//   }
//
// The user's mismatch reconciliation choice (use-local / use-deck) is
// intentionally NOT persisted here — it must be picked fresh on every
// publish/sync so the user consciously reconciles each time.
//
// UUID-keyed sibling of `scriptMap` — rename + move update scriptMap in
// place, so the link entry follows the UUID for free. Delete hook mirrors
// `script_map_drop` at the same call sites.
//
// Pure functions over `serde_json::Value`. NO I/O — every caller must hold
// the per-project `ProjectJsonLocks` mutex around their RMW cycle (see
// locks.rs).
// ---------------------------------------------------------------------------

use serde_json::Value;

/// One slidesLinks entry. Field names use camelCase on the wire; the Rust
/// side stays snake_case via serde renames.
///
/// The user's mismatch reconciliation choice (use-local / use-deck) is
/// NOT persisted — it must be chosen fresh on every publish/sync.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SlidesLink
{
    #[serde(rename = "presentationId")]
    pub presentation_id: String,
    #[serde(rename = "linkedAt")]
    pub linked_at: String,
    #[serde(rename = "lastPreparedAt")]
    pub last_prepared_at: String,
    #[serde(rename = "lastPrepareStatus")]
    pub last_prepare_status: String,

    /// Drive `headRevisionId` captured at the last successful publish/sync.
    /// Used by the JS-side background check to detect remote deck changes
    /// without a full `presentations.get`. `None` for links created before
    /// this field existed (backward-compatible via serde `default`).
    #[serde(rename = "lastKnownRevisionId",
            skip_serializing_if = "Option::is_none",
            default)]
    pub last_known_revision_id: Option<String>,

    /// Runtime-only discriminator populated by the command layer to tell
    /// the caller WHICH registry entry resolved. `Some("folder")` when the
    /// folder-scoped key hit, `Some("file")` when the file-scope entry hit.
    /// `None` for direct reads via the pure helper (persisted JSON never
    /// carries this field — `skip_serializing_if` keeps it out on disk).
    #[serde(rename = "scope",
            skip_serializing_if = "Option::is_none",
            default)]
    pub scope: Option<String>,
}

/// Read the `SlidesLink` mapped to `script_uuid` from `project.json`'s
/// `slidesLinks` section. Returns `None` if the section or key is absent,
/// or if the value fails to deserialise.
pub fn slides_link_get(
    project_json: &Value,
    script_uuid: &str,
) -> Option<SlidesLink>
{
    let entry = project_json.get("slidesLinks")?.get(script_uuid)?;
    serde_json::from_value(entry.clone()).ok()
}

/// Cheap presence check — does not allocate a `String`.
pub fn slides_link_has(project_json: &Value, script_uuid: &str) -> bool
{
    project_json
        .get("slidesLinks")
        .and_then(|m| m.get(script_uuid))
        .is_some()
}

/// Write `script_uuid → entry` into `project_json.slidesLinks`, creating
/// the `slidesLinks` object if missing. Overwrites any existing entry for
/// the same UUID.
pub fn slides_link_set(
    project_json: &mut Value,
    script_uuid: &str,
    entry: &SlidesLink,
)
{
    if !project_json.is_object()
    {
        *project_json = serde_json::json!({});
    }
    let root = project_json.as_object_mut().expect("project_json is object");
    let links = root
        .entry("slidesLinks".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !links.is_object()
    {
        *links = serde_json::json!({});
    }
    let obj = links.as_object_mut().expect("slidesLinks is object");
    let value = serde_json::to_value(entry).expect("SlidesLink serialises");
    obj.insert(script_uuid.to_string(), value);
}

/// Remove the mapping for `script_uuid`. No-op if the key or the whole
/// `slidesLinks` section is missing.
pub fn slides_link_drop(
    project_json: &mut Value,
    script_uuid: &str,
)
{
    let Some(root) = project_json.as_object_mut() else { return; };
    let Some(links) = root.get_mut("slidesLinks").and_then(|v| v.as_object_mut())
    else
    {
        return;
    };
    links.remove(script_uuid);
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "slides_links_tests.rs"]
mod tests;
