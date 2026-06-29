// @ts-check
/**
 * user-settings.js — thin wrapper for the user-data-store MVP.
 *
 * Wraps the Rust commands `user_settings_load` / `user_settings_save`
 * (defined in src-tauri/src/lib.rs). Distinct from settings-modal.js's
 * `app_settings_get/set` which owns view/theme/font state — this module
 * owns cross-cutting preferences (defaultLanguage, lastProjectPath,
 * lastSettingsTab) and is what `boot()` reads to decide whether to
 * auto-open the last project.
 *
 * Schema (mirrors `default_user_settings()` in lib.rs):
 *   { format: "user-settings:v1",
 *     defaultLanguage: "en",
 *     appVersionCreated: "<version>",
 *     lastProjectPath: string | null,
 *     lastSettingsTab: string,
 *     updatedAt: ISO-8601 }
 *
 * In-memory cache so reads after the first call are sync via getSetting().
 */

import { isTauri } from "./util/is-tauri.js";

/** Tauri invoke helper — falls back to a stub outside Tauri so jsdom tests
 *  can import this module without the Tauri runtime being present. */
async function invoke(cmd, args)
{
    if (!isTauri())
    {
        // Mirror the default shape so callers get sensible behaviour even
        // when running headless. Save is a no-op; load returns defaults.
        if (cmd === "user_settings_load")
        {
            return {
                format: "user-settings:v1",
                defaultLanguage: "en",
                appVersionCreated: "0.0.0",
                lastProjectPath: null,
                lastSettingsTab: "general",
                spellcheckEnabled: true,
                spellcheckLanguage: null,
            };
        }
        if (cmd === "user_settings_save") return undefined;
        if (cmd === "path_exists") return false;
        throw new Error("Tauri unavailable");
    }
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke(cmd, args);
}

let cache = /** @type {Record<string, any> | null} */ (null);

/** Load user-settings.json. Caches in-memory after the first call. */
export async function loadUserSettings()
{
    if (cache) return cache;
    cache = await invoke("user_settings_load");
    return cache;
}

/**
 * Save a partial user-settings patch. Shallow-merges over the cache and
 * persists to disk via Rust. Unknown keys are dropped silently by the
 * Rust merge_user_settings helper.
 * @param {Record<string, any>} partial
 */
export async function saveUserSettings(partial)
{
    const merged = { ...(cache || {}), ...partial };
    cache = merged;
    await invoke("user_settings_save", { value: partial });
}

/**
 * Sync read of a known key from the cache. Throws if loadUserSettings()
 * hasn't run yet — callers must await loadUserSettings() at boot.
 * @param {string} key
 * @param {any} [fallback]
 */
export function getUserSetting(key, fallback = null)
{
    if (!cache) throw new Error("user-settings not loaded — call loadUserSettings() in boot()");
    const v = cache[key];
    return v === undefined || v === null ? fallback : v;
}

/**
 * Returns true if the Rust load-impl cleared `lastProjectPath` on this boot
 * because the stored value was invalid for the current platform (non-absolute
 * or non-existent). Transient flag — Rust does NOT persist it; future loads
 * after a clean save will return false.
 * @returns {boolean}
 */
export function getLastProjectPathInvalid()
{
    if (!cache) return false;
    return cache.lastProjectPathInvalid === true;
}

/** Cheap exists probe via the `path_exists` Tauri command. Used by the
 *  auto-open-last-project flow to skip the start screen when the last
 *  project's folder is still on disk. */
export async function pathExists(path)
{
    if (!path) return false;
    try { return await invoke("path_exists", { path }); }
    catch { return false; }
}

/**
 * One-time seed for the `spellcheckLanguage` key. If the persisted value
 * is null (new user OR existing user on first upgrade), runs the system-
 * locale detector and writes the result. Subsequent calls return the
 * cached value without touching the detector again.
 * @returns {Promise<string>}
 */
export async function ensureSpellcheckSeed()
{
    await loadUserSettings();
    const cur = cache && cache.spellcheckLanguage;
    if (cur) return cur;
    const { detectSystemSpellcheckLocale } = await import("./system-locale-detector.js");
    let detected = "en-US";
    try { detected = await detectSystemSpellcheckLocale(); }
    catch (_) { /* keep en-US fallback */ }
    await saveUserSettings({ spellcheckLanguage: detected });
    return detected;
}

/** Reset cache — only used by tests. */
export function _resetCacheForTests()
{
    cache = null;
}
