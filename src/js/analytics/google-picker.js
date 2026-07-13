// @ts-check
/**
 * analytics/google-picker.js — picker telemetry adapter.
 *
 * Mirrors the shape and transport of `analytics/google-auth.js::logAuthEvent`
 * so both catalogues emit through identical plumbing. See google-auth.js
 * for the full privacy contract (no tokens, no doc content, sub allowed).
 *
 * EVENT CATALOG:
 *
 *   picker.opened        { kind, mode, transport }
 *   picker.completed     { kind, ms }
 *   picker.cancelled     { kind, reason }
 *   picker.timeout       { kind }
 *   picker.error         { kind, class }
 *   picker.token_merged  { had_session, got_refresh_token }
 *
 * Kept in a dedicated file (not folded into google-auth.js) because the
 * picker flow is orthogonal to sign-in — a user may pick without ever
 * running the OAuth interactive flow, and vice versa.
 */

const ENDPOINT = "https://api.absolutelyskint.com/v1/log";

// Match google-auth.js — the desktop app has no /v1/log API key yet, so
// events currently emit to console.debug only. Flip once the BFF issues
// a key.
const TRANSPORT_ENABLED = false;

// Mirrors _analyticsAllowed in google-auth.js. Boot code toggles both
// through this module's setter after loading app settings.
let _analyticsAllowed = true;

/** @param {boolean} allowed */
export function setAnalyticsAllowed(allowed)
{
    _analyticsAllowed = allowed !== false;
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
    try
    {
        if (!_analyticsAllowed) return;
        const body = { event: name, ...payload, ts: Date.now() };
        if (!TRANSPORT_ENABLED)
        {
            console.debug("[mps:analytics]", body);
            return;
        }
        fetch(ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            keepalive: true,
        }).catch(() => { /* swallow */ });
    }
    catch (_)
    {
        // Stringify or fetch threw synchronously — drop silently.
    }
}
