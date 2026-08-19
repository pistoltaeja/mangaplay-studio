// ---------------------------------------------------------------------------
// scriptMap — durable per-script identity.
//
// scriptMap is the authority for script→UUID identity. Lives at
// `project.json.scriptMap`, keyed by project-relative forward-slash path:
//
//   { "scriptMap": { "Foo/bar.txt": { "uuid": "<uuid-v4>" } } }
//
// Coexists with the older `artMap.scripts` map (see art_map.rs). `artMap`
// is read-only legacy fallback now — new mints land in scriptMap and any
// rename / move / delete site that updates artMap ALSO updates scriptMap.
// On the first read of a relpath that exists only in artMap, the entry is
// lazily copied into scriptMap so subsequent reads are clean hits.
//
// Pure functions over `serde_json::Value`. NO I/O — every caller must
// hold the per-project `ProjectJsonLocks` mutex around their RMW cycle
// (see locks.rs).
// ---------------------------------------------------------------------------

use crate::art_map::art_map_get;

/// Read the UUID mapped to `script_rel_path` from `project.json`'s
/// `scriptMap` section. Returns `None` if the section or key is absent.
pub fn script_map_get(
    project_json: &serde_json::Value,
    script_rel_path: &str,
) -> Option<String>
{
    project_json
        .get("scriptMap")
        .and_then(|m| m.get(script_rel_path))
        .and_then(|entry| entry.get("uuid"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Resolve `script_rel_path` to its UUID, preferring scriptMap and falling
/// back to the legacy `artMap.scripts` entry. When the fallback fires, the
/// entry is copied forward into scriptMap as a side effect so subsequent
/// reads avoid the fallback path.
///
/// Caller must hold the per-project lock if it intends to write the
/// possibly-mutated `project_json` back to disk.
pub fn script_map_get_with_legacy_pullforward(
    project_json: &mut serde_json::Value,
    script_rel_path: &str,
) -> Option<String>
{
    if let Some(uuid) = script_map_get(project_json, script_rel_path)
    {
        return Some(uuid);
    }
    let legacy_uuid = art_map_get(project_json, script_rel_path)?;
    script_map_set(project_json, script_rel_path, &legacy_uuid);
    Some(legacy_uuid)
}

/// Get the UUID for `script_rel_path`, minting + writing one if absent.
/// Pulls forward from `artMap.scripts` if a legacy entry exists.
///
/// Returns `(uuid, minted)`. `minted == true` means the caller MUST persist
/// `project_json` to disk (the entry was added in memory only).
///
/// Caller holds the per-project lock for the entire read-modify-write cycle.
pub fn script_map_get_or_mint(
    project_json: &mut serde_json::Value,
    script_rel_path: &str,
) -> (String, bool)
{
    if let Some(uuid) = script_map_get(project_json, script_rel_path)
    {
        return (uuid, false);
    }
    if let Some(legacy_uuid) = art_map_get(project_json, script_rel_path)
    {
        script_map_set(project_json, script_rel_path, &legacy_uuid);
        // Pulled forward — still a mutation, must persist.
        return (legacy_uuid, true);
    }
    let uuid = uuid::Uuid::new_v4().to_string();
    script_map_set(project_json, script_rel_path, &uuid);
    (uuid, true)
}

/// Write `script_rel_path → { uuid }` into `project_json.scriptMap`,
/// creating the `scriptMap` object if missing. Overwrites any existing
/// entry for the same key.
pub fn script_map_set(
    project_json: &mut serde_json::Value,
    script_rel_path: &str,
    uuid: &str,
)
{
    if !project_json.is_object()
    {
        *project_json = serde_json::json!({});
    }
    let root = project_json.as_object_mut().expect("project_json is object");
    let script_map = root
        .entry("scriptMap".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !script_map.is_object()
    {
        *script_map = serde_json::json!({});
    }
    let obj = script_map.as_object_mut().expect("scriptMap is object");
    obj.insert(
        script_rel_path.to_string(),
        serde_json::json!({ "uuid": uuid }),
    );
}

/// Remove the mapping for `script_rel_path`. No-op if the key or the whole
/// `scriptMap` section is missing.
pub fn script_map_drop(
    project_json: &mut serde_json::Value,
    script_rel_path: &str,
)
{
    let Some(root) = project_json.as_object_mut() else { return; };
    let Some(script_map) = root.get_mut("scriptMap").and_then(|v| v.as_object_mut())
    else
    {
        return;
    };
    script_map.remove(script_rel_path);
}

/// Rewrite a single key in `scriptMap`. No-op if `old_rel == new_rel` or
/// the old key is missing.
pub fn script_map_rewrite_key(
    project_json: &mut serde_json::Value,
    old_rel: &str,
    new_rel: &str,
)
{
    if old_rel == new_rel { return; }
    let Some(root) = project_json.as_object_mut() else { return; };
    let Some(script_map) = root.get_mut("scriptMap").and_then(|v| v.as_object_mut())
    else
    {
        return;
    };
    if let Some(entry) = script_map.remove(old_rel)
    {
        script_map.insert(new_rel.to_string(), entry);
    }
}

/// Rewrite every key under `<old_prefix>/` to live under `<new_prefix>/`.
/// Trailing-slash semantics match `art_map_rewrite_prefix` — prefixes
/// should NOT carry a trailing slash; the function appends one to prevent
/// partial-name collisions (`foo` vs `foobar/...`).
pub fn script_map_rewrite_prefix(
    project_json: &mut serde_json::Value,
    old_prefix: &str,
    new_prefix: &str,
)
{
    let Some(root) = project_json.as_object_mut() else { return; };
    let Some(script_map) = root.get_mut("scriptMap").and_then(|v| v.as_object_mut())
    else
    {
        return;
    };
    crate::util::json_prefix::map_rewrite_prefix(script_map, old_prefix, new_prefix);
}

/// Remove every key under `<prefix>/`. Trailing-slash semantics match
/// [`script_map_rewrite_prefix`].
pub fn script_map_drop_prefix(
    project_json: &mut serde_json::Value,
    prefix: &str,
)
{
    let Some(root) = project_json.as_object_mut() else { return; };
    let Some(script_map) = root.get_mut("scriptMap").and_then(|v| v.as_object_mut())
    else
    {
        return;
    };
    crate::util::json_prefix::map_drop_prefix(script_map, prefix);
}
