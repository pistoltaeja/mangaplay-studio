/**
 * font-matrix.js
 *
 * Per-locale font configuration. Two named exports:
 *
 *   ACTIVE_FONT_CSS_VARS — for each locale code, the CSS family-list strings
 *                          to assign to --mps-font-app and --mps-font-code,
 *                          plus the warmList of font-family names that the
 *                          loader must pre-warm via document.fonts.load()
 *                          before swapping the CSS vars (so the visible
 *                          font flip is instant, not FOUC).
 *
 *   LOCALE_SHARDS        — for each locale code, the array of shard names
 *                          whose css/fonts-<shard>.css must be present in
 *                          the document. font-loader.js mounts the matching
 *                          <link rel="stylesheet"> tags.
 *
 * The screenplay-role font (Courier Prime) is NOT driven by this matrix —
 * it lives in src/css/fonts-screenplay.css, mounted as a static <link> from
 * index.html. Each locale's warmList still includes "Courier Prime" so the
 * screenplay preview's first paint after a locale switch is FOUC-free.
 *
 * Source of truth: TODO/obsidian-font-pass.md, Section 3.
 */

/**
 * @typedef {{ app: string, code: string, warmList: string[] }} LocaleFontVars
 */

const LATIN_APP  = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const LATIN_CODE = '"Source Code Pro", ui-monospace, "Cascadia Mono", Consolas, monospace';

/** @type {Record<string, LocaleFontVars>} */
export const ACTIVE_FONT_CSS_VARS =
{
    en:    { app: LATIN_APP, code: LATIN_CODE, warmList: ["Inter", "Source Code Pro", "Courier Prime"] },
    es:    { app: LATIN_APP, code: LATIN_CODE, warmList: ["Inter", "Source Code Pro", "Courier Prime"] },
    fr:    { app: LATIN_APP, code: LATIN_CODE, warmList: ["Inter", "Source Code Pro", "Courier Prime"] },
    it:    { app: LATIN_APP, code: LATIN_CODE, warmList: ["Inter", "Source Code Pro", "Courier Prime"] },
    pt:    { app: LATIN_APP, code: LATIN_CODE, warmList: ["Inter", "Source Code Pro", "Courier Prime"] },
    de:    { app: LATIN_APP, code: LATIN_CODE, warmList: ["Inter", "Source Code Pro", "Courier Prime"] },
    id:    { app: LATIN_APP, code: LATIN_CODE, warmList: ["Inter", "Source Code Pro", "Courier Prime"] },
    vi:    { app: LATIN_APP, code: LATIN_CODE, warmList: ["Inter", "Source Code Pro", "Courier Prime"] },

    // ru — Cyrillic. Inter's static TTF ships Cyrillic so the app var is
    // unchanged; the code var prepends Noto Sans Mono for Cyrillic mono
    // coverage that Source Code Pro can't provide (its static TTF is Latin
    // + Latin Ext only).
    ru:    {
        app: LATIN_APP,
        code: '"Source Code Pro", "Noto Sans Mono", Consolas, monospace',
        warmList: ["Inter", "Source Code Pro", "Noto Sans Mono", "Courier Prime"],
    },

    // th — Thai. No Thai mono in the Noto family; the code var falls
    // through Source Code Pro to Noto Sans Thai for Thai glyphs.
    th:    {
        app: '"Noto Sans Thai", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        code: '"Noto Sans Thai", "Source Code Pro", monospace',
        warmList: ["Inter", "Noto Sans Thai", "Source Code Pro", "Courier Prime"],
    },

    // CJK — Noto Sans CJK faces lead the stack; Inter / Source Code Pro
    // fill in for Latin glyphs the CJK face doesn't cover or styles awkwardly.
    ja:    {
        app: '"Noto Sans JP", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        code: '"Noto Sans JP", "Source Code Pro", monospace',
        warmList: ["Inter", "Noto Sans JP", "Source Code Pro", "Courier Prime"],
    },
    ko:    {
        app: '"Noto Sans KR", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        code: '"Noto Sans KR", "Source Code Pro", monospace',
        warmList: ["Inter", "Noto Sans KR", "Source Code Pro", "Courier Prime"],
    },
    "zh-CN": {
        app: '"Noto Sans SC", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        code: '"Noto Sans SC", "Source Code Pro", monospace',
        warmList: ["Inter", "Noto Sans SC", "Source Code Pro", "Courier Prime"],
    },
    "zh-TW": {
        app: '"Noto Sans TC", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        code: '"Noto Sans TC", "Source Code Pro", monospace',
        warmList: ["Inter", "Noto Sans TC", "Source Code Pro", "Courier Prime"],
    },
};

/** @type {Record<string, string[]>} */
export const LOCALE_SHARDS =
{
    en: ["base"],
    es: ["base"],
    fr: ["base"],
    it: ["base"],
    pt: ["base"],
    de: ["base"],
    id: ["base"],
    vi: ["base"],
    ru: ["base", "mono"],
    th: ["base", "thai"],
    ja: ["base", "jp"],
    ko: ["base", "kr"],
    "zh-CN": ["base", "sc"],
    "zh-TW": ["base", "tc"],
};
