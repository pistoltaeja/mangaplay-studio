// ---------------------------------------------------------------------------
// slidesLinks — per-script Google Slides link registry
// (TODO/sync-existing-slides-prepare.md).
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
mod tests
{
    use super::*;

    fn sample_link() -> SlidesLink
    {
        SlidesLink
        {
            presentation_id: "1PqR".into(),
            linked_at: "2026-07-12T14:00:00Z".into(),
            last_prepared_at: "2026-07-12T14:03:22Z".into(),
            last_prepare_status: "clean".into(),
        }
    }

    #[test]
    fn get_on_absent_registry()
    {
        let pj = serde_json::json!({});
        assert!(slides_link_get(&pj, "abc").is_none());
    }

    #[test]
    fn get_on_empty_registry()
    {
        let pj = serde_json::json!({ "slidesLinks": {} });
        assert!(slides_link_get(&pj, "abc").is_none());
    }

    #[test]
    fn set_then_get_round_trip()
    {
        let mut pj = serde_json::json!({});
        let link = sample_link();
        slides_link_set(&mut pj, "abc", &link);

        let got = slides_link_get(&pj, "abc").expect("entry present");
        assert_eq!(got.presentation_id, "1PqR");
        assert_eq!(got.linked_at, "2026-07-12T14:00:00Z");
        assert_eq!(got.last_prepared_at, "2026-07-12T14:03:22Z");
        assert_eq!(got.last_prepare_status, "clean");
    }

    #[test]
    fn set_twice_same_uuid_overwrites()
    {
        let mut pj = serde_json::json!({});
        slides_link_set(&mut pj, "abc", &sample_link());

        let second = SlidesLink
        {
            presentation_id: "2XyZ".into(),
            linked_at: "2026-08-01T00:00:00Z".into(),
            last_prepared_at: "2026-08-01T00:00:00Z".into(),
            last_prepare_status: "with-warnings".into(),
        };
        slides_link_set(&mut pj, "abc", &second);

        let got = slides_link_get(&pj, "abc").expect("entry present");
        assert_eq!(got.presentation_id, "2XyZ");
        assert_eq!(got.last_prepare_status, "with-warnings");
    }

    #[test]
    fn drop_after_set_gets_none()
    {
        let mut pj = serde_json::json!({});
        slides_link_set(&mut pj, "abc", &sample_link());
        slides_link_drop(&mut pj, "abc");
        assert!(slides_link_get(&pj, "abc").is_none());
    }

    #[test]
    fn drop_on_absent_key_is_noop()
    {
        let mut pj = serde_json::json!({});
        slides_link_drop(&mut pj, "abc"); // absent section
        assert!(pj.is_object());

        let mut pj2 = serde_json::json!({ "slidesLinks": {} });
        slides_link_drop(&mut pj2, "abc"); // absent key
        assert!(pj2["slidesLinks"].is_object());
    }

    #[test]
    fn has_returns_correct_boolean()
    {
        let mut pj = serde_json::json!({});
        assert!(!slides_link_has(&pj, "abc"));

        slides_link_set(&mut pj, "abc", &sample_link());
        assert!(slides_link_has(&pj, "abc"));
        assert!(!slides_link_has(&pj, "other"));

        slides_link_drop(&mut pj, "abc");
        assert!(!slides_link_has(&pj, "abc"));
    }

    #[test]
    fn mismatch_policy_never_persisted()
    {
        // The reconciliation policy is a per-publish choice; the saved
        // entry never carries it — even if project.json on disk had a
        // legacy `mismatchPolicy` field it would be ignored on deserialise.
        let mut pj = serde_json::json!({});
        slides_link_set(&mut pj, "abc", &sample_link());
        let serialised = serde_json::to_string(&pj).unwrap();
        assert!(
            !serialised.contains("mismatchPolicy"),
            "field should never appear in output: {}",
            serialised
        );
    }
}
