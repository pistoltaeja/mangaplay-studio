/**
 * font-loader.js — Lazy per-locale font loader.
 *
 * Each call to ensureFontsFor(locale) adds the @font-face shards (via
 * <link rel="stylesheet"> for the per-locale fonts-<shard>.css) and
 * pre-warms the FontFaceSet so first paint after a language switch has
 * glyphs ready. Once the new locale's fonts are confirmed loaded, the
 * previous locale's shards are removed via releaseFontsFor(prev) after
 * GRACE_MS — a 3s grace prevents thrash when the user toggles
 * ja <-> ko <-> zh quickly.
 */

import { ACTIVE_FONT_CSS_VARS, LOCALE_SHARDS } from "./font-matrix.js";

const GRACE_MS = 3000;

/** @type {Map<string, HTMLLinkElement>} shard name → <link> element */
const activeShards = new Map();

/** @type {Map<string, Set<string>>} shard name → set of locales currently relying on it */
const shardRefcounts = new Map();

const cssVarTarget = (typeof document !== "undefined")
    ? document.documentElement.style
    : null;

/**
 * Mount the shards a locale needs (idempotent), pre-warm its font families,
 * then apply --mps-font-app / --mps-font-code to :root so visible text
 * picks up the new family in the next paint.
 *
 * --mps-font-mono is NOT written here — it lives as a static CSS-var alias
 * of --mps-font-code in app.css :root. If we wrote it inline, the inline
 * documentElement.style write would out-rank the :root declaration and
 * pin the var to its boot-time value, breaking the indirection.
 *
 * --mps-font-screenplay-body is owned by font-prefs.js applyScreenplayFont().
 *
 * @param {string} locale
 * @returns {Promise<void>}
 */
export async function ensureFontsFor(locale)
{
    const wanted = LOCALE_SHARDS[locale] || LOCALE_SHARDS.en;

    for (const shard of wanted)
    {
        let users = shardRefcounts.get(shard);
        if (!users)
        {
            users = new Set();
            shardRefcounts.set(shard, users);
        }
        users.add(locale);

        if (activeShards.has(shard)) continue;

        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = `css/fonts-${shard}.css`;
        link.dataset.mpsFontShard = shard;
        document.head.appendChild(link);
        activeShards.set(shard, link);
    }

    // Pre-warm: ensure the FontFaceSet reports the families ready before
    // we update the CSS vars (so the visible swap is instant, no FOUC).
    const families = ACTIVE_FONT_CSS_VARS[locale] || ACTIVE_FONT_CSS_VARS.en;
    if (typeof document !== "undefined" && document.fonts && typeof document.fonts.load === "function")
    {
        try
        {
            await Promise.all(
                families.warmList.map((family) => document.fonts.load(`1em "${family}"`))
            );
        }
        catch (e)
        {
            // Pre-warm is best-effort. If a face fails to load (e.g. dev
            // build with a missing .ttf) we still swap the var so the
            // fallback chain renders something.
            console.warn("[font-loader] pre-warm failed:", e?.message || e);
        }
    }

    if (cssVarTarget)
    {
        cssVarTarget.setProperty("--mps-font-app",  families.app);
        cssVarTarget.setProperty("--mps-font-code", families.code);
    }
}

/**
 * Release the shards that were exclusive to `locale`. A shard stays
 * resident as long as at least one OTHER locale that wanted it has been
 * ensured (refcount > 0). Eviction is deferred by GRACE_MS so quick
 * back-and-forth toggles don't thrash.
 *
 * @param {string} locale
 */
export function releaseFontsFor(locale)
{
    const stale = LOCALE_SHARDS[locale] || [];
    for (const shard of stale)
    {
        const users = shardRefcounts.get(shard);
        if (users) users.delete(locale);
    }

    setTimeout(() =>
    {
        for (const shard of stale)
        {
            const users = shardRefcounts.get(shard);
            if (users && users.size > 0) continue;

            const link = activeShards.get(shard);
            if (link)
            {
                link.remove();
                activeShards.delete(shard);
            }
            shardRefcounts.delete(shard);
        }
    }, GRACE_MS);
}

/**
 * Test-only: clear all tracked shards and refcounts. Production code does not
 * call this; only the unit tests use it to reset module state between cases.
 */
export function __resetFontLoaderForTests()
{
    for (const link of activeShards.values())
    {
        try { link.remove(); } catch { /* DOM may already be detached */ }
    }
    activeShards.clear();
    shardRefcounts.clear();
    if (cssVarTarget)
    {
        cssVarTarget.removeProperty("--mps-font-app");
        cssVarTarget.removeProperty("--mps-font-code");
    }
}
