// @ts-check
/**
 * spellcheck-tier.js — pure resolver from `spellcheckLanguage` (the user-
 * settings dropdown value) to a capability tier.
 *
 *   Tier A — Harper (en-US / en-GB), spelling + grammar + style.
 *   Tier B — `retext-spell` + Hunspell (de, es, fr, it, pt, ru, vi, ko).
 *            v1 returns no Diagnostics from Harper for these; the
 *            contenteditable native `spellcheck="true"` carries the load
 *            until retext is wired in a follow-up.
 *   Tier C — native browser spellcheck only (id).
 *   Tier D — limited / no spellcheck model (ja, zh-CN, zh-TW, th).
 *
 * IMPORTANT: this module no longer imports `harper.js` so the 1.5 MB
 * Harper bundle stays out of the boot chunk. The `dialect` field returns a
 * plain string ("American" / "British"); harper-linter.js resolves it to
 * `Dialect.American` / `Dialect.British` internally when the worker is
 * lazy-loaded.
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
