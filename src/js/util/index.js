// @ts-check
/**
 * util/index.js — small shared helpers. Consolidated from four sub-40-line
 * files (is-tauri, basename, debounce, escape-html) so a call site can pull
 * every primitive it needs from one import path.
 */

// ── Tauri detection ────────────────────────────────────────────────────────

/**
 * Truthy when the WebView2 / native shell has injected `window.__TAURI_INTERNALS__`
 * (the bridge the @tauri-apps/api/core `invoke` reads). Falsy in jsdom tests +
 * browser dev — call sites then fall back to their own stubs.
 *
 * Use `in` not `=== undefined`: tests delete the key to restore state, and
 * `= undefined` would still match a `key in obj` check.
 *
 * @returns {boolean}
 */
export function isTauri()
{
    return typeof window !== "undefined"
        && "__TAURI_INTERNALS__" in (/** @type {any} */ (window));
}

// ── Path basename ──────────────────────────────────────────────────────────

/**
 * Cross-platform basename — splits on either separator and returns the
 * last segment. Empty string for null/undefined/empty inputs.
 * @param {string | null | undefined} p
 * @returns {string}
 */
export function basename(p)
{
    if (!p) return "";
    const parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || "";
}

// ── Debounce ───────────────────────────────────────────────────────────────

/**
 * Trailing-edge debounce. Returns a function that, when called repeatedly,
 * fires `fn` only after `ms` ms have passed since the last call.
 *
 * Variadic — works for both single-arg "save" patterns and multi-arg
 * event-listener patterns.
 *
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} ms
 * @returns {(...args: Parameters<F>) => void}
 */
export function debounce(fn, ms)
{
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    return (...args) =>
    {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

// ── HTML / attribute escape ────────────────────────────────────────────────

const ESCAPE_TABLE = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
};

/**
 * Escape a string for safe insertion into HTML text content or an attribute.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s)
{
    return String(s).replace(/[&<>"']/g, (c) => ESCAPE_TABLE[c] || c);
}

/**
 * Escape a string for safe insertion into an HTML attribute value.
 * Identical implementation to `escapeHtml`; separate name so attribute-value
 * call sites read intentionally.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeAttr(s)
{
    return String(s).replace(/[&<>"']/g, (c) => ESCAPE_TABLE[c] || c);
}
