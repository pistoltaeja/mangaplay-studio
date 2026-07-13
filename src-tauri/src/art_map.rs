use crate::commands::project::storyboard_dir;

// ---------------------------------------------------------------------------
// Storyboard art relocation helpers (TODO/mangaart-storyboard-relocation.md).
// Wired up by `mangaart_scaffold_impl` (Phase 2) and `rename_file_impl`
// (Phase 3). Phases 4-6 will hook in `app_delete_file`, `app_rename_folder`,
// and folder delete; the helpers below are designed for those callers too.
//
// Layout target:
//   <project_root>/_mangaplaystudio/storyboard/<mirrored_script_dir>/<uuid>.mangaart
//
// Identity model: UUID is the durable identity. The script's current path is
// the address; the mirrored storyboard subpath is derived for human
// browsability. Mapping lives in project.json under `artMap.scripts`:
//   { "artMap": { "scripts": { "foo/baz.mangaplay.md": "<uuid>", ... } } }
// ---------------------------------------------------------------------------

/// Compute the on-disk path for a script's `.mangaart` file in the new
/// storyboard-mirrored layout.
///
/// `script_rel_path` is a project-root-relative path using forward slashes
/// (the JS side normalises to forward slashes everywhere). The script's
/// basename is stripped to obtain the mirrored directory; a root-level
/// script therefore produces
/// `<root>/_mangaplaystudio/storyboard/<uuid>.mangaart`.
pub fn resolve_art_path(
    project_root: &std::path::Path,
    script_rel_path: &str,
    uuid: &str,
) -> std::path::PathBuf
{
    let trimmed = script_rel_path.trim_matches('/');
    let mirrored_dir = match trimmed.rsplit_once('/')
    {
        Some((dir, _basename)) => dir,
        None => "",
    };

    let mut out = storyboard_dir(project_root);
    if !mirrored_dir.is_empty()
    {
        for part in mirrored_dir.split('/')
        {
            if part.is_empty() { continue; }
            out.push(part);
        }
    }
    out.push(format!("{}.mangaart", uuid));
    out
}

/// Mint a new UUID v4 for a script→art mapping. Lowercase, hyphenated.
pub fn mint_script_uuid() -> String
{
    uuid::Uuid::new_v4().to_string()
}

/// Read the UUID mapped to `script_rel_path` from `project.json`'s
/// `artMap.scripts` section. Returns `None` if the section or key is absent.
pub fn art_map_get(
    project_json: &serde_json::Value,
    script_rel_path: &str,
) -> Option<String>
{
    project_json
        .get("artMap")
        .and_then(|m| m.get("scripts"))
        .and_then(|s| s.get(script_rel_path))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Reverse-lookup: given a UUID, find the script rel-path in
/// `project.json.artMap.scripts` whose value equals it. Returns `None` if
/// no entry maps to this uuid.
pub fn art_map_find_script_by_uuid(
    project_json: &serde_json::Value,
    uuid: &str,
) -> Option<String>
{
    project_json
        .get("artMap")?
        .get("scripts")?
        .as_object()?
        .iter()
        .find_map(|(k, v)|
        {
            if v.as_str() == Some(uuid) { Some(k.clone()) } else { None }
        })
}

/// Write `script_rel_path → uuid` into `project_json.artMap.scripts`,
/// creating the `artMap` and `scripts` objects if missing. Overwrites any
/// existing value for the same key.
pub fn art_map_set(
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
    let art_map = root
        .entry("artMap".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !art_map.is_object()
    {
        *art_map = serde_json::json!({});
    }
    let art_map_obj = art_map.as_object_mut().expect("artMap is object");
    let scripts = art_map_obj
        .entry("scripts".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !scripts.is_object()
    {
        *scripts = serde_json::json!({});
    }
    let scripts_obj = scripts.as_object_mut().expect("scripts is object");
    scripts_obj.insert(
        script_rel_path.to_string(),
        serde_json::Value::String(uuid.to_string()),
    );
}

/// Remove the mapping for `script_rel_path`. No-op if the key, the `scripts`
/// object, or the whole `artMap` section is missing.
pub fn art_map_drop(
    project_json: &mut serde_json::Value,
    script_rel_path: &str,
)
{
    let Some(root) = project_json.as_object_mut() else { return; };
    let Some(art_map) = root.get_mut("artMap").and_then(|v| v.as_object_mut())
    else
    {
        return;
    };
    let Some(scripts) = art_map.get_mut("scripts").and_then(|v| v.as_object_mut())
    else
    {
        return;
    };
    scripts.remove(script_rel_path);
}

/// Rewrite every `scripts` key under `<old_prefix>/` to live under
/// `<new_prefix>/` instead. Used by folder rename. No-op if
/// `old_prefix == new_prefix`. Prefixes should NOT carry a trailing slash —
/// this function appends one when matching, which prevents partial-name
/// collisions like `foo` matching `foobar/...`.
pub fn art_map_rewrite_prefix(
    project_json: &mut serde_json::Value,
    old_prefix: &str,
    new_prefix: &str,
)
{
    if old_prefix == new_prefix { return; }

    let Some(root) = project_json.as_object_mut() else { return; };
    let Some(art_map) = root.get_mut("artMap").and_then(|v| v.as_object_mut())
    else
    {
        return;
    };
    let Some(scripts) = art_map.get_mut("scripts").and_then(|v| v.as_object_mut())
    else
    {
        return;
    };

    let old_with_slash = format!("{}/", old_prefix.trim_end_matches('/'));
    let new_trimmed = new_prefix.trim_end_matches('/');

    // Collect keys first to avoid mutating while iterating.
    let keys_to_rewrite: Vec<String> = scripts
        .keys()
        .filter(|k| k.starts_with(&old_with_slash))
        .cloned()
        .collect();

    for old_key in keys_to_rewrite
    {
        let suffix = &old_key[old_with_slash.len()..];
        let new_key = format!("{}/{}", new_trimmed, suffix);
        if let Some(value) = scripts.remove(&old_key)
        {
            scripts.insert(new_key, value);
        }
    }
}

/// Remove every `scripts` key under `<prefix>/`. Used by folder delete.
/// Same trailing-slash semantics as [`art_map_rewrite_prefix`].
pub fn art_map_drop_prefix(
    project_json: &mut serde_json::Value,
    prefix: &str,
)
{
    let Some(root) = project_json.as_object_mut() else { return; };
    let Some(art_map) = root.get_mut("artMap").and_then(|v| v.as_object_mut())
    else
    {
        return;
    };
    let Some(scripts) = art_map.get_mut("scripts").and_then(|v| v.as_object_mut())
    else
    {
        return;
    };

    let with_slash = format!("{}/", prefix.trim_end_matches('/'));
    let keys_to_drop: Vec<String> = scripts
        .keys()
        .filter(|k| k.starts_with(&with_slash))
        .cloned()
        .collect();

    for key in keys_to_drop
    {
        scripts.remove(&key);
    }
}

/// Read `project.json` and return its `artMap.scripts` object as an owned
/// `serde_json::Map`. Returns `None` when `project.json` is missing,
/// unparseable, has no `artMap` section, has no `scripts` submap, or the
/// submap isn't an object.
///
/// Used by the Part 5 migration hook in `project_open` to fold legacy
/// script→UUID mappings into the UUID file registry so existing projects
/// keep their script → mangaart continuity.
pub fn read_all_scripts(
    project_dir: &std::path::Path,
) -> Option<serde_json::Map<String, serde_json::Value>>
{
    let pj_path = crate::commands::project::project_json_path(project_dir);
    let raw = std::fs::read_to_string(&pj_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("artMap")
        .and_then(|m| m.get("scripts"))
        .and_then(|s| s.as_object())
        .cloned()
}
