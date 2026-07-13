// @ts-check
/**
 * visual-editor-find.js — Find engine for `<mps-visual-editor>`.
 *
 * DOM in the visual editor is a mix of `<textarea>` (panel description,
 * dialogue text, page-header direction) and `<input>` (dialogue character,
 * SFX text, title-page fields). Browsers don't support inline decoration
 * of form-control text, so this engine:
 *   1. Scans all matching fields for the query.
 *   2. Highlights the CONTAINING `.panel-card` (or nearest structural
 *      block) with `data-find-match` / `data-find-current` attributes —
 *      the "whole rectangle" from the reference design.
 *   3. On step, focuses the input/textarea and calls
 *      `setSelectionRange()` so the native selection paints the run.
 *
 * The scan is re-run on every `runFindOn()` call (visual editor mutates
 * heavily on every keystroke; caching the matches is not worth it).
 */

const MATCH_ATTR = "data-find-match";
const CURRENT_ATTR = "data-find-current";

/**
 * @typedef {Object} VisualMatch
 * @property {HTMLInputElement | HTMLTextAreaElement} field
 * @property {number} start                  - index in field.value
 * @property {number} end
 * @property {HTMLElement} block             - .panel-card / .title-block / .page-header to highlight
 */

/** @type {WeakMap<HTMLElement, VisualMatch[]>} */
const cache = new WeakMap();

/**
 * @param {HTMLElement} root                  - the `<mps-visual-editor>` element
 * @returns {NodeListOf<HTMLInputElement|HTMLTextAreaElement>}
 */
function scannableFields(root)
{
    return /** @type {any} */ (root.querySelectorAll(
        "textarea, input[type='text'], input:not([type])"
    ));
}

/**
 * Nearest visible rectangle for a field. Panels get `.panel-card`; page
 * headers/title block fall back to the visual-editor-body child that
 * contains them.
 * @param {HTMLElement} field
 * @returns {HTMLElement}
 */
function blockFor(field)
{
    return /** @type {HTMLElement} */ (
        field.closest(".panel-card")
        || field.closest(".visual-editor-page-header")
        || field.closest(".visual-editor-title-block")
        || field.parentElement
        || field
    );
}

/**
 * @param {string} query
 * @param {string} hay
 * @returns {number[]}  starting offsets
 */
function scanText(query, hay)
{
    if (!query || !hay) return [];
    const q = query.toLowerCase();
    const h = hay.toLowerCase();
    /** @type {number[]} */
    const out = [];
    let idx = 0;
    while (idx <= h.length - q.length)
    {
        const hit = h.indexOf(q, idx);
        if (hit === -1) break;
        out.push(hit);
        idx = hit + Math.max(q.length, 1);
    }
    return out;
}

/**
 * Clear every find attribute + selection artefact under `root`.
 * @param {HTMLElement} root
 */
export function clearFind(root)
{
    if (!root) return;
    for (const el of root.querySelectorAll(`[${MATCH_ATTR}], [${CURRENT_ATTR}]`))
    {
        el.removeAttribute(MATCH_ATTR);
        el.removeAttribute(CURRENT_ATTR);
    }
    cache.delete(root);
}

/**
 * Run `query` against the visual editor. Highlights every containing
 * block once (dedup), returns match count + 1-based current index.
 *
 * @param {HTMLElement} root
 * @param {string} query
 * @returns {{ total: number, current: number }}
 */
export function runFindOn(root, query)
{
    if (!root) return { total: 0, current: 0 };
    clearFind(root);
    if (!query) return { total: 0, current: 0 };

    /** @type {VisualMatch[]} */
    const matches = [];
    for (const field of scannableFields(root))
    {
        const value = field.value || "";
        if (!value) continue;
        const hits = scanText(query, value);
        if (hits.length === 0) continue;
        const block = blockFor(field);
        for (const start of hits)
        {
            matches.push({ field, start, end: start + query.length, block });
        }
    }

    if (matches.length === 0) return { total: 0, current: 0 };

    // Mark every unique block with the base attribute; step() adds the
    // current attribute.
    const seen = new Set();
    for (const m of matches)
    {
        if (seen.has(m.block)) continue;
        seen.add(m.block);
        m.block.setAttribute(MATCH_ATTR, "");
    }
    cache.set(root, matches);
    moveTo(root, 0);
    return { total: matches.length, current: 1 };
}

/**
 * Move current pointer to `index` (0-based). Focuses the target field
 * and selects the match run so the native selection paints it.
 * @param {HTMLElement} root
 * @param {number} index
 */
function moveTo(root, index)
{
    const matches = cache.get(root);
    if (!matches || matches.length === 0) return;
    // Clear previous current
    for (const el of root.querySelectorAll(`[${CURRENT_ATTR}]`))
    {
        el.removeAttribute(CURRENT_ATTR);
    }
    const m = matches[index];
    m.block.setAttribute(CURRENT_ATTR, "");
    try
    {
        m.field.focus();
        m.field.setSelectionRange(m.start, m.end);
    }
    catch (_) { /* field may have detached mid-render */ }
    try
    {
        m.block.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    catch (_) { /* older WebView2 lacks smooth scrolling */ }
    // Stash the current index on the root so step() can advance without
    // needing a caller-side counter.
    /** @type {any} */ (root)._findCurrentIndex = index;
}

/**
 * @param {HTMLElement} root
 * @param {"next"|"prev"} dir
 * @returns {{ total: number, current: number }}
 */
export function step(root, dir)
{
    const matches = cache.get(root);
    if (!matches || matches.length === 0) return { total: 0, current: 0 };
    let idx = /** @type {any} */ (root)._findCurrentIndex ?? 0;
    idx = (dir === "next")
        ? (idx + 1) % matches.length
        : (idx - 1 + matches.length) % matches.length;
    moveTo(root, idx);
    return { total: matches.length, current: idx + 1 };
}
