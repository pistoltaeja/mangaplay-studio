// @ts-check
/**
 * spellcheck-state.js — single source of truth for the runtime spellcheck
 * configuration read by the CM6 linter. Updated by settings-modal
 * handlers (toggle + language dropdown) and by the boot-time seeding
 * step in `user-settings.js`.
 *
 * Kept deliberately tiny: a module-level object, three accessors. The
 * linter calls `getSpellcheckConfig()` once per lint run.
 */

import { resolveTier } from "./spellcheck-tier.js";

let state = { enabled: true, language: "en-US" };

/**
 * Shallow-merge partial state. Unknown keys are kept (cheap forward
 * compat). No notification — callers are responsible for reconfiguring
 * the active editor view(s).
 * @param {{ enabled?: boolean, language?: string }} next
 */
export function setSpellcheckState(next)
{
    state = { ...state, ...next };
    // Mirror to window for benchmark/CDP probes. No-op outside browser.
    try { if (typeof window !== "undefined") /** @type {any} */ (window).__mpsSpellcheckState = state; }
    catch (_) { /* ignore */ }
}

/** @returns {{ enabled: boolean, language: string }} */
export function getSpellcheckState()
{
    return state;
}

/**
 * Returns the tier shape for the linter. When the master toggle is OFF
 * we surface a sentinel `{ tier: "OFF" }` so the linter can short-circuit
 * without re-resolving.
 * @returns {{ tier: string, dialect?: any, hunspellId?: string }}
 */
export function getSpellcheckConfig()
{
    if (!state.enabled) return { tier: "OFF" };
    return resolveTier(state.language);
}
