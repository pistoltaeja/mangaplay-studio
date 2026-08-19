// @ts-check
/**
 * ux-mode.js — single source of truth for the frontend UX mode.
 *
 * The Rust side resolves the mode at startup (env var → .exe filename →
 * standalone) and injects `window.__MPS_UX_MODE__` via
 * `WebviewWindowBuilder::initialization_script` BEFORE any JS module
 * evaluates. The inline boot script in index.html also sets the
 * `<html data-ux-mode="...">` attribute the CSS keys off.
 *
 * At bundle time, build-bundle.js may bake a compile-time constant
 * `__MPS_UX_MODE_BAKED__` into the JS via Bun's `define` when MPS_UX_MODE
 * is set in the build env (build-app.js sets it per variant). When baked,
 * `getUxMode()` returns the constant directly and the minifier folds
 * `isMobileLike()` / `isStandalone()` calls into boolean literals — the
 * subsequent DCE pass drops the dead-branch code entirely from the bundle.
 * When NOT baked (dev bundler runs, jsdom tests), the sentinel value
 * "runtime" is substituted and we fall through to the runtime lookup.
 *
 * Frontend code asks `getUxMode()` or `isMobileLike()` instead of
 * inspecting `window.__MPS_UX_MODE__` directly so we have one place to
 * apply the fallback policy when the constant is missing.
 */

export const UX_STANDALONE = "standalone";
export const UX_MOBILE = "mobile";
export const UX_TABLET = "tablet";

// Read the baked constant defensively. In the bundled .exe, Bun's `define`
// replaces the bare identifier `__MPS_UX_MODE_BAKED__` with a string literal
// ("mobile" / "tablet" / "standalone" / "runtime"). In jsdom tests and other
// unbundled environments, the identifier is undefined at parse time — the
// `typeof` check keeps things ReferenceError-safe. At bundle time the whole
// ternary folds to just the string literal after Bun's minifier runs.
const bakedUxMode = (typeof __MPS_UX_MODE_BAKED__ !== "undefined")
    ? __MPS_UX_MODE_BAKED__
    : "runtime";

/** @returns {string} */
export function getUxMode()
{
    // Compile-time fast path. When build-bundle.js baked a mode into the
    // bundle, this branch collapses to `return "<mode>";` after minification.
    if (bakedUxMode !== "runtime")
    {
        return bakedUxMode;
    }
    const m = /** @type {any} */ (typeof window !== "undefined" ? window : globalThis).__MPS_UX_MODE__;
    if (m === UX_MOBILE || m === UX_TABLET || m === UX_STANDALONE) return m;
    return UX_STANDALONE;
}

/**
 * True when the active mode behaves like a mobile/tablet viewport — fixed
 * window size, no chrome, single-pane-at-a-time layout.
 * @returns {boolean}
 */
export function isMobileLike()
{
    const m = getUxMode();
    return m === UX_MOBILE || m === UX_TABLET;
}

/** @returns {boolean} */
export function isStandalone() { return getUxMode() === UX_STANDALONE; }

/** @returns {boolean} */
export function isMobile() { return getUxMode() === UX_MOBILE; }

/** @returns {boolean} */
export function isTablet() { return getUxMode() === UX_TABLET; }

