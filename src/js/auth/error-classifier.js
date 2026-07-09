// @ts-check
/**
 * error-classifier.js — auth error taxonomy.
 *
 * Mirror of extension-mangaplay-studio/adapters/ext-error-classifier.js.
 * Every catch site in the auth module funnels errors through this so the
 * UI never sees raw fetch / OAuth / Tauri errors.
 *
 * PRIVACY CONTRACT: the returned `diagnostic` is `${name}: ${msg}`
 * truncated to 200 chars. NO tokens. NO PII. NO doc IDs. NO doc content.
 *
 * Classes (matching the Chrome ext taxonomy):
 *   auth.user_cancelled            silent
 *   auth.network                   toast
 *   auth.scope_denied              modal
 *   auth.token_expired             silent        (transient access-token expiry)
 *   auth.refresh_token_expired     modal         (refresh-grant invalid_grant — user must re-sign-in)
 *   permissions.doc_access_revoked modal
 *   fatal.config                   full-screen   (wrong client / redirect)
 *   fatal.unknown                  full-screen
 */

const MAX_DIAGNOSTIC_LEN = 200;

/**
 * @typedef {Object} ClassifiedAuthError
 * @property {string} class
 * @property {"inline-retry"|"toast"|"modal"|"silent"|"full-screen"} surface
 * @property {boolean} recoverable
 * @property {string} diagnostic
 */

/**
 * @param {unknown} error
 * @param {{ origin?: "refresh"|"signin"|"signout"|"other" }} [context]
 * @returns {ClassifiedAuthError}
 */
export function classifyAuthError(error, context = {})
{
    const name = _safeName(error);
    const msg = _safeMessage(error);
    const lower = (msg + " " + name).toLowerCase();
    const diagnostic = _truncate(`${name}: ${msg}`, MAX_DIAGNOSTIC_LEN);

    // user_cancelled — silent retry path. Closing the consent screen,
    // closing the loopback browser tab, hitting "Deny" on consent screen.
    if (lower.includes("user_cancelled")
        || lower.includes("user cancelled")
        || lower.includes("cancelled")
        || lower.includes("canceled")
        || lower.includes("access_denied")
        || lower.includes("user closed")
        || lower.includes("aborted"))
    {
        return { class: "auth.user_cancelled", surface: "silent", recoverable: true, diagnostic };
    }

    // fatal.config — wrong client_id / redirect URI / OAuth mis-setup.
    // Check BEFORE network because some of these arrive as 4xx fetch errors.
    if (lower.includes("invalid_client")
        || lower.includes("redirect_uri_mismatch")
        || lower.includes("redirect_mismatch")
        || lower.includes("unauthorized_client"))
    {
        return { class: "fatal.config", surface: "full-screen", recoverable: false, diagnostic };
    }

    // scope_denied — Google's OAuth `invalid_scope` path. Currently not
    // user-triggerable in modern Google consent UI but kept for completeness.
    if (lower.includes("invalid_scope") || lower.includes("scope_denied"))
    {
        return { class: "auth.scope_denied", surface: "modal", recoverable: true, diagnostic };
    }

    // refresh_token_expired — Google's `invalid_grant` returned from the
    // refresh-token-grant flow (user revoked via Dashboard, 6-month idle,
    // or password change with a Gmail scope in the set). The refresh token
    // is dead at Google; only an interactive sign-in recovers. Surface as
    // MODAL because the UI must explicitly route the user back to sign-in.
    //
    // CONTEXT-GUARDED: `invalid_grant` is ALSO emitted by Google for clock-skew
    // on JWT-bearer (service-account) flows and other code paths. Without an
    // explicit `origin: "refresh"` tag we fall through — surfacing a misleading
    // "please sign in again" MODAL on an unrelated error would be a footgun.
    if (context.origin === "refresh" && lower.includes("invalid_grant"))
    {
        return { class: "auth.refresh_token_expired", surface: "modal", recoverable: true, diagnostic };
    }

    // token_expired — transient access-token expiry. The new refresh path
    // (ticket 04) handles this silently; legacy `invalid_token` / `expired`
    // strings are retained for any caller that still surfaces a raw 401.
    if (lower.includes("token_expired")
        || lower.includes("invalid_token")
        || lower.includes("expired"))
    {
        return { class: "auth.token_expired", surface: "silent", recoverable: true, diagnostic };
    }

    // doc_access_revoked — 403 on a previously-grant Drive/Docs call, OR
    // 404 on a known-good doc id (user revoked or deleted).
    if (lower.includes("permission")
        || lower.includes("forbidden")
        || lower.includes("revoked")
        || lower.includes("doc_access_revoked"))
    {
        return { class: "permissions.doc_access_revoked", surface: "modal", recoverable: true, diagnostic };
    }

    // network — TypeError from fetch, NetworkError, offline, DNS, 5xx.
    // Check LAST so it doesn't swallow the more-specific 4xx classes above.
    if (name === "TypeError"
        || lower.includes("network")
        || lower.includes("failed to fetch")
        || lower.includes("ratelimit")
        || lower.includes("offline")
        || lower.includes("timeout")
        || /\b5\d{2}\b/.test(lower))
    {
        return { class: "auth.network", surface: "toast", recoverable: true, diagnostic };
    }

    return { class: "fatal.unknown", surface: "full-screen", recoverable: false, diagnostic };
}

/** @param {unknown} e @returns {string} */
function _safeName(e)
{
    if (e && typeof e === "object" && "name" in e && typeof e.name === "string") return e.name;
    return "Error";
}

/** @param {unknown} e @returns {string} */
function _safeMessage(e)
{
    if (typeof e === "string") return e;
    if (e && typeof e === "object")
    {
        if ("message" in e && typeof e.message === "string") return e.message;
        try { return String(e); } catch (_) { return ""; }
    }
    return "";
}

/** @param {string} s @param {number} max @returns {string} */
function _truncate(s, max)
{
    if (!s) return "";
    return s.length > max ? s.slice(0, max) : s;
}
