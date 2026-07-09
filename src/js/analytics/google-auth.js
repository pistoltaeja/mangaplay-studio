// @ts-check
/**
 * analytics/google-auth.js — auth telemetry adapter.
 *
 * Fire-and-forget POST to `https://api.absolutelyskint.com/v1/log` with a
 * compact `{ event, ...payload, ts }` body.
 *
 * PRIVACY CONTRACT (do not break):
 *   - NO access tokens
 *   - NO refresh tokens
 *   - NO email addresses
 *   - NO doc IDs / doc content
 *   - sub IS allowed — it's already an opaque per-account ID
 *
 * Errors are swallowed — telemetry must never fail the user flow. The BFF
 * enforces a rate limit; no client-side throttling needed.
 *
 * EVENT CATALOG (keep alphabetised when adding new ones):
 *
 *   Auth flow:
 *     auth.signin.start        { }                 — interactive sign-in begun
 *     auth.signin.success      { ttlSec }          — sign-in completed
 *     auth.signin.cancelled    { }                 — user closed consent UI
 *     auth.signin.error        { class }           — sign-in failed
 *     auth.signout             { reason: "user" | "switch" }
 *
 *   Refresh flow (BFF /v2/oauth/refresh):
 *     auth.refresh.attempted   { }                 — refresh round-trip started
 *     auth.refresh.success     { ttlSec }          — fresh access_token cached
 *     auth.refresh.invalid_grant { }               — Google said grant is dead
 *     auth.refresh.network     { }                 — fetch threw (offline / DNS / 5xx)
 *     auth.refresh.upstream_error { status,reason? } — non-invalid_grant Google error
 *
 *   Boot-time restore (ensureRehydrated):
 *     auth.restore.attempted   { }                 — boot probe started
 *     auth.restore.success     { ttlSec }          — probe alive
 *     auth.restore.revoked     { }                 — probe found invalid_grant
 *     auth.restore.offline     { }                 — probe network error
 *     auth.restore.online_retry { }                — online-retry fired
 *
 *   Identity drift:
 *     auth.id_token.sub_mismatch { phase: "restore" | "refresh" | "signin" }
 *
 * Per TODO/AuthRefreshToken/INDEX.md ticket 11: after rollout, the rate of
 * auth.signin.start should drop ~95% relative to auth.refresh.success
 * (one sign-in per install vs. hourly refreshes). If auth.restore.revoked
 * runs above ~1-2%/week per active user, something's wrong — most likely
 * the GCP consent screen regressed from Published to Testing (precheck 00a).
 */

const ENDPOINT = "https://api.absolutelyskint.com/v1/log";

// /v1/log requires an `x-api-key` header (see api.absolutelyskint.com
// log-handler.js). The desktop app does not yet have a provisioned API
// key — until one is issued, route events to console.debug only so we
// don't pollute the BFF with 401s on every sign-in attempt.
const TRANSPORT_ENABLED = false;

// User preference — mirrors app_settings.analyticsEnabled. Defaults to
// true; boot code calls setAnalyticsAllowed(bool) after loading settings.
// When false, logAuthEvent is a no-op (including the console.debug path).
let _analyticsAllowed = true;

/** @param {boolean} allowed */
export function setAnalyticsAllowed(allowed)
{
    _analyticsAllowed = allowed !== false;
}

/**
 * @param {string} name   Event name, e.g. `auth.signin.success`.
 * @param {Record<string, any>} [payload]
 * @returns {void}        Always sync from the caller's PoV.
 */
export function logAuthEvent(name, payload = {})
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
        // Fire and forget — no await, errors swallowed.
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
