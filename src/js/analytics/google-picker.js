// @ts-check
/**
 * analytics/google-picker.js — picker telemetry adapter.
 *
 * Thin wrapper over the unified analytics façade (`mps-analytics.js`). Kept
 * as a dedicated file (not folded into google-auth.js) because the picker
 * flow is orthogonal to sign-in — a user may pick without ever running the
 * OAuth interactive flow, and vice versa. See google-auth.js for the full
 * privacy contract (no tokens, no doc content, sub allowed).
 *
 * EVENT CATALOG:
 *
 *   picker.opened        { kind, mode, transport }
 *   picker.completed     { kind, ms }
 *   picker.cancelled     { kind, reason }
 *   picker.timeout       { kind }
 *   picker.error         { kind, class }
 *   picker.token_merged  { had_session, got_refresh_token }
 */

import { track, setAnalyticsAllowed as facadeSetAllowed } from "./mps-analytics.js";

/** @param {boolean} allowed */
export function setAnalyticsAllowed(allowed)
{
    facadeSetAllowed(allowed);
}

/**
 * Fire a picker analytics event. Always fire-and-forget from the caller's
 * PoV — errors swallowed, no throw.
 *
 * @param {string} name             Event name, e.g. `picker.opened`.
 * @param {Record<string, any>} [payload]
 * @returns {void}
 */
export function logPickerEvent(name, payload = {})
{
    track(name, payload);
}
