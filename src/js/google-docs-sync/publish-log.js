// @ts-check
//
// Thin JS wrapper over the Rust `publish_log_*` Tauri commands. The store is
// a rolling file at `<app-data-dir>/publish-log.json` containing the newest
// 200 publish entries; older entries roll over into `publish-log-NNN.json`
// archives that this module never reads back into the UI.
//
// Schema is owned by JS — Rust accepts whatever JSON we hand it. See
// `_toEntry` for the canonical shape.

import { invoke } from "@tauri-apps/api/core";

/**
 * @typedef {Object} PublishLogEntry
 * @property {string} fileName
 * @property {string} docId
 * @property {string} docUrl
 * @property {"mangaplay"|"fountain"|"text"} format
 * @property {"publish"|"collaborate"} intent
 * @property {string} createdAtUtc
 * @property {string|null} googleSub
 * @property {string|null} googleEmail
 * @property {string|null} googleName
 * @property {string|null} googlePicture
 */

/**
 * Load the active publish log. Returns an empty array on any failure so the
 * Settings tab can render an empty-state without surfacing the error.
 *
 * @returns {Promise<Array<PublishLogEntry>>}
 */
export async function loadPublishLog()
{
    try
    {
        const result = /** @type {any} */ (await invoke("publish_log_load"));
        const entries = result && result.entries;
        return Array.isArray(entries) ? entries : [];
    }
    catch (e)
    {
        console.warn("[publish-log] load failed", e);
        return [];
    }
}

/**
 * Append a single entry. Best-effort — a logging failure must never block the
 * publish success path, so this swallows errors after warning to the console.
 *
 * @param {PublishLogEntry} entry
 * @returns {Promise<void>}
 */
export async function appendPublishLog(entry)
{
    try
    {
        await invoke("publish_log_append", { entry });
    }
    catch (e)
    {
        console.warn("[publish-log] append failed", e);
    }
}

/**
 * Build a `PublishLogEntry` from the publish-state-machine's inputs. Kept
 * separate so the schema lives in one place and tests can hit it directly.
 *
 * @param {{
 *     formValues: { title: string, format: "mangaplay"|"fountain"|"text", intent: "publish"|"collaborate" },
 *     docId: string,
 *     docUrl: string,
 *     profile: { sub: string|null, name: string|null, email: string|null, picture: string|null }|null
 * }} args
 * @returns {PublishLogEntry}
 */
export function _toEntry({ formValues, docId, docUrl, profile })
{
    const p = profile || { sub: null, name: null, email: null, picture: null };
    return {
        fileName:      String(formValues.title || ""),
        docId,
        docUrl,
        format:        formValues.format,
        intent:        formValues.intent,
        createdAtUtc:  new Date().toISOString(),
        googleSub:     p.sub || null,
        googleEmail:   p.email || null,
        googleName:    p.name || null,
        googlePicture: p.picture || null
    };
}
