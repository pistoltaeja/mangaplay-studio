//! `scriptmap_get_or_mint` Tauri command — the only public mint API.
//!
//! JS callers never write `scriptMap` directly. They invoke this command,
//! receive `{ uuid, minted, projectJson }`, and replace their local
//! `projectJsonCache` with the returned body so reads never see stale state
//! after a Rust write.
//!
//! All read-modify-write of `project.json` happens under the per-project
//! mutex from [`ProjectJsonLocks`] so a JS-side mint can't race a
//! storyboard-scaffold mint.

use crate::locks::ProjectJsonLocks;
use crate::script_map::script_map_get_or_mint;
use crate::{read_project_json, write_project_json};

#[derive(serde::Serialize)]
pub struct ScriptMapMintResult
{
    pub uuid: String,
    pub minted: bool,
    #[serde(rename = "projectJson")]
    pub project_json: serde_json::Value,
}

#[tauri::command]
pub fn scriptmap_get_or_mint(
    locks: tauri::State<ProjectJsonLocks>,
    project_path: String,
    script_rel_path: String,
) -> Result<ScriptMapMintResult, String>
{
    scriptmap_get_or_mint_impl(&locks, &project_path, &script_rel_path)
}

/// Pure helper backing the Tauri command. Exposed `pub` so integration
/// tests can drive it without a Tauri runtime — pass a `ProjectJsonLocks`
/// instance directly.
pub fn scriptmap_get_or_mint_impl(
    locks: &ProjectJsonLocks,
    project_path: &str,
    script_rel_path: &str,
) -> Result<ScriptMapMintResult, String>
{
    let project_dir = std::path::Path::new(project_path);
    let lock = locks.lock_for(project_dir);
    let _guard = lock.lock().expect("project-json mutex poisoned");

    let mut pj = read_project_json(project_dir)?;
    let (uuid, minted) = script_map_get_or_mint(&mut pj, script_rel_path);
    if minted
    {
        write_project_json(project_dir, &pj)?;
    }

    Ok(ScriptMapMintResult
    {
        uuid,
        minted,
        project_json: pj,
    })
}
