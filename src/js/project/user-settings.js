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
 *     appVersionCreated: "<version>",   // legacy — kept one release for back-compat
 *     createdVersion: string | null,    // userDataVersion at first stamp
 *     currentVersion: string | null,    // bumped ONLY by the migration ladder
 *     lastMigrationAttempt: object | null,  // { from, to, error, attemptedAt, consecutiveFailures }
 *     lastProjectPath: string | null,
 *     lastSettingsTab: string,
 *     updatedAt: ISO-8601 }
 *
 * In-memory cache so reads after the first call are sync via getSetting().
 * The cache may also carry transient boot-time flags that the Rust side
 * does NOT persist:
 *   _isFresh — true when user-settings.json did not exist on disk before
 *     the load. Survives only the current boot; isFreshUserBoot() reads it.
 *   lastProjectPathInvalid — see getLastProjectPathInvalid().
 */

import { isTauri } from "../util/index.js";

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
                createdVersion: null,
                currentVersion: null,
                lastMigrationAttempt: null,
                lastProjectPath: null,
                lastSettingsTab: "general",
                spellcheckEnabled: true,
                spellcheckLanguage: null,
                onboardingCompleted: false,
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
    _applyBackCompatShim(cache);
    return cache;
}

/**
 * Back-compat shim — IN-MEMORY ONLY. Mutates the passed cache object.
 *
 * Existing users wrote `appVersionCreated` but never `createdVersion`
 * or `currentVersion`. Without this seed, callers that read
 * `currentVersion` directly from the cache would see null and assume
 * the user is on the newest schema — bypassing the migration ladder.
 *
 * We deliberately do NOT persist these seeded values: writing
 * `currentVersion = appVersionCreated` to DISK would make Rust's
 * `user_data_ensure_version` think the user is already migrated
 * (because Rust reads the on-disk value). The on-disk value MUST
 * stay missing so the Rust gate's own back-compat fallback
 * (`currentVersion ?? appVersionCreated ?? "1.0.0"`) triggers and
 * the ladder runs. Both sides are belt-and-braces.
 *
 * Exposed for tests — `_` prefix marks it as test surface, not public API.
 * @param {Record<string, any> | null | undefined} c
 */
export function _applyBackCompatShim(c)
{
    if (!c || !c.appVersionCreated) return;
    if (c.createdVersion === null || c.createdVersion === undefined)
    {
        c.createdVersion = c.appVersionCreated;
    }
    if (c.currentVersion === null || c.currentVersion === undefined)
    {
        c.currentVersion = c.appVersionCreated;
    }
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

/**
 * Returns true when the Rust load-impl detected that user-settings.json
 * did NOT exist on disk at boot — i.e. this is a fresh user. Reads the
 * transient `_isFresh` flag set by Rust pre-merge. The flag is dropped
 * by the Rust save-impl (not in USER_SETTINGS_KNOWN), so subsequent
 * loads after the first save return false.
 *
 * Boot-time only: kept on the cache for the lifetime of the current
 * boot so multiple modules can read it after `loadUserSettings()`.
 * @returns {boolean}
 */
export function isFreshUserBoot()
{
    if (!cache) return false;
    return cache._isFresh === true;
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
    const { detectSystemSpellcheckLocale } = await import("../spellcheck/system-locale-detector.js");
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
