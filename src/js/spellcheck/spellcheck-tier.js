// @ts-check
/**
 * spellcheck-tier.js — pure resolver from the user's language setting
 * to a capability tier.
 *
 * Tiers
 * -----
 *   A — Harper (en-US / en-GB). Full spelling + grammar + style.
 *   B — Planned retext-spell + Hunspell (de, es, fr, it, pt, ru, vi, ko).
 *       v1 returns no diagnostics; native WebView2 spellcheck carries
 *       the load. Tracked in desktop-spellcheck-grammar.md.
 *   C — Native browser spellcheck only (id).
 *   D — Limited / no spellcheck model (ja, zh-CN, zh-TW, th).
 *
 * This module does NOT import harper.js. The `dialect` field is a plain
 * string sentinel ("American" / "British"); harper-linter.js resolves
 * it to the real `Dialect` enum value when the worker spins up. This
 * keeps the 1.5 MB Harper bundle out of the boot chunk.
 */

const TIER_B = new Set(["de", "es", "fr", "it", "pt", "ru", "vi", "ko"]);
const TIER_C = new Set(["id"]);

/**
 * @typedef {"American"|"British"} DialectName
 *
 * @typedef {Object} TierShape
 * @property {"A"|"B"|"C"|"D"} tier
 * @property {DialectName} [dialect] - Harper dialect name (Tier A only). Plain
 *                                     string sentinel; harper-linter.js maps
 *                                     it to the real `Dialect` enum value
 *                                     when the worker spins up.
 * @property {string} [hunspellId] - Hunspell dictionary id (Tier B only).
 */

/**
 * @param {string | null | undefined} spellcheckLanguage
 * @returns {TierShape}
 */
export function resolveTier(spellcheckLanguage)
{
    const lang = spellcheckLanguage || "en-US";

    if (lang === "en-US") return { tier: "A", dialect: "American" };
    if (lang === "en-GB") return { tier: "A", dialect: "British" };

    if (TIER_B.has(lang)) return { tier: "B", hunspellId: lang };
    if (TIER_C.has(lang)) return { tier: "C" };
    return { tier: "D" };
}
