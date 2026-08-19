// @ts-check
/**
 * render-preference.js — Per-page render preference: which layer paints on
 * the storyboard canvas for a given page.
 *
 * Contract:
 *
 *   Every page-NNN.json file MAY carry a "renderPreference" field with one
 *   of these values:
 *     - "slides"   → paint the cached Slides image; DISABLE mangaart drawing
 *                    UI (buttons present, greyed).
 *     - "mangaart" → paint the local drawing (existing behaviour).
 *
 *   ABSENCE means "mangaart". This is the safe default and lets existing
 *   projects work without a data migration. Callers reading the file MUST
 *   fall through to "mangaart" whenever the field is missing OR unrecognised.
 *
 *   Writers should NEVER emit "mangaart" explicitly. Only write "slides"
 *   when the user has accepted a Slides link and a cached image exists.
 *   To revert to mangaart, DELETE the field, don't set it to "mangaart".
 *
 * The canvas render path checks this on every paint; when preference is
 * "slides" but the cached file is missing (e.g. user deleted it), the
 * canvas falls back to the mangaart drawing and logs a soft warning. That
 * fallback logic ships with the follow-up canvas-rewire plan; this module
 * only owns the read/write helpers.
 */

/** @typedef {"slides" | "mangaart"} RenderPreference */

/**
 * Read a page's renderPreference from a parsed page-NNN.json object.
 * Absent / unrecognised values fall through to "mangaart".
 *
 * @param {object|null|undefined} pageJson — parsed page JSON, or null/undefined
 * @returns {RenderPreference}
 */
export function getRenderPreference(pageJson)
{
    if (!pageJson || typeof pageJson !== "object") return "mangaart";
    const v = pageJson.renderPreference;
    if (v === "slides") return "slides";
    return "mangaart";
}

/**
 * Return a new page JSON object with renderPreference set. Prefer using
 * `clearRenderPreference` over `setRenderPreference(json, "mangaart")` —
 * the canonical shape for the default preference is an absent field.
 *
 * @param {object} pageJson
 * @param {RenderPreference} preference
 * @returns {object}
 */
export function setRenderPreference(pageJson, preference)
{
    if (preference === "mangaart") return clearRenderPreference(pageJson);
    return { ...pageJson, renderPreference: "slides" };
}

/**
 * Return a new page JSON with any renderPreference field removed. This is
 * the canonical way to revert to the default (mangaart) preference.
 *
 * @param {object} pageJson
 * @returns {object}
 */
export function clearRenderPreference(pageJson)
{
    if (!pageJson || typeof pageJson !== "object") return pageJson;
    // eslint-disable-next-line no-unused-vars
    const { renderPreference: _dropped, ...rest } = pageJson;
    return rest;
}
