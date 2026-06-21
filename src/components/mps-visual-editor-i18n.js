// @ts-check
/**
 * Stub i18n shim for the desktop's copy of `<mps-visual-editor>`.
 *
 * The website version pulls live language updates from `src/i18n/index.js`.
 * The desktop currently has no string table for visual-editor keys — every
 * call site in `mps-visual-editor.js` passes a hardcoded English fallback as
 * the second arg, so returning `fallback ?? key` is enough to make the
 * component render correctly for the Phase-2 spike.
 *
 * `subscribe` is a no-op returning an unsubscribe function so the visual
 * editor's `connectedCallback` doesn't blow up.
 */

/**
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
export function t(key, fallback)
{
    return fallback ?? key;
}

/**
 * @param {(lang: string) => void} _listener
 * @returns {() => void}
 */
export function subscribe(_listener)
{
    return () =>
    {
    };
}
