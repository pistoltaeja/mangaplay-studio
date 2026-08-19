// @ts-check
/**
 * google-oauth.js — public API for Google OAuth 2.0 + PKCE on Mangaplay
 * Studio desktop (and future mobile).
 *
 * Adapted from extension-fountain-studio/adapters/fps-auth.js — the
 * working Chrome-extension flow we're porting to Tauri. Key differences:
 *   - No chrome.identity.launchWebAuthFlow → transport abstraction
 *     (loopback HTTP server on desktop, deep-link on mobile).
 *   - No chrome.storage.{session,local} → Rust keyring for the token,
 *     user-settings.json for the durable profile (see ./storage.js).
 *   - Explicit numbered state machine for log traceability (./state-machine.js).
 *   - i18n via Mangaplay Studio's own subscriber, not fps-i18n.
 *
 * The CSRF `state` nonce is captured per-call (a LOCAL variable inside
 * `_runFlow`) — never a module-level slot. Without this, a safety-poll-
 * driven silent refresh launched while the user is mid-interactive flow
 * would overwrite the slot and the redirect would fail state comparison.
 */

import { invoke } from "@tauri-apps/api/core";
import { generateCodeVerifier, codeChallenge, randomNonce } from "./pkce.js";
import { classifyAuthError } from "./error-classifier.js";
import { createStateMachine, STATES } from "./state-machine.js";
import {
    loadToken, saveToken, clearToken,
    loadProfile, saveProfile, clearProfile,
    migrateScopesIfNeeded,
} from "./storage.js";
import { loadTransport } from "./transports/platform-detect.js";
import { logAuthEvent } from "../analytics/google-auth.js";
import {
    OAUTH_CLIENT_ID,
    BFF_REFRESH_URL,
    BFF_REVOKE_URL,
    EXPIRES_IN_MARGIN_MS,
} from "./oauth-config.js";
import {
    _buildAuthUrl,
    _parseRedirect,
    _extractRedirectUri,
    _extractIdTokenSub,
} from "./oauth-url.js";
import { _exchangeCodeForToken, _fetchDriveAbout } from "./oauth-bff.js";

// ─────────────────────────────────────────────────────────────────────────
// In-memory cache
// ─────────────────────────────────────────────────────────────────────────

/** @type {string|null} */
let _cachedToken = null;
/** @type {number|null} */
let _tokenExpiresAt = null;
/** @type {string|null} */
let _lastSub = null;
/** @type {string|null} */
let _lastName = null;
/** @type {string|null} */
let _lastEmail = null;
/** @type {string|null} */
let _lastPicture = null;

/**
 * Single-flight guard for the interactive flow. While set, every concurrent
 * caller awaits the same dialog. Prevents racing OAuth windows when a poll
 * fires during user-driven sign-in.
 * @type {Promise<string|null>|null}
 */
let _interactiveAuthInFlight = null;

/**
 * Loopback listener id of the currently-in-flight interactive sign-in.
 * Set by the `onListenerReady` callback threaded through
 * `startAndAwaitRedirect`; consumed by `abortInteractiveSignIn` when
 * the user clicks Cancel.
 *
 * Mobile deeplink transport never calls `onListenerReady`, so this
 * stays null for mobile flows and `abortInteractiveSignIn` becomes a
 * no-op — there is no OS-side socket to break out of.
 * @type {string|null}
 */
let _pendingAbortId = null;

/**
 * @typedef {Object} RefreshResult
 * @property {"alive"|"revoked"|"offline"|"no_refresh_token"} status
 *   "alive"             — refresh succeeded; `token` is the fresh access_token.
 *   "revoked"           — Google said invalid_grant OR id_token.sub mismatch;
 *                         storage + in-memory state already wiped.
 *   "offline"           — network error, BFF 5xx, or malformed JSON; storage
 *                         intact, caller can retry later.
 *   "no_refresh_token"  — no refresh_token in storage (pre-offline-access blob
 *                         or never signed in); storage intact, caller should
 *                         route to interactive sign-in.
 * @property {string|null} token
 *   The fresh access_token when status === "alive", else null.
 */

/**
 * Single-flight guard for the BFF refresh round-trip. N concurrent
 * getAccessToken() callers share one POST to `/v2/oauth/refresh` rather
 * than racing N requests against Google for the same refresh_token. The
 * boot probe (_ensureBootProbe) also populates this so it shares the
 * same round-trip with any concurrent getAccessToken() caller.
 * @type {Promise<RefreshResult>|null}
 */
let _refreshInFlight = null;

/**
 * Shared rehydrate promise. ensureRehydrated() is idempotent — every caller
 * awaits the same storage read.
 * @type {Promise<void>|null}
 */
let _rehydratePromise = null;

/**
 * True when the boot-time revocation probe failed with a network error.
 * Cleared on a successful subsequent refresh (online-retry hook).
 */
let _isBootOffline = false;

/** Detacher for the boot-offline online-retry listener. */
let _onlineRetryDetach = null;

const sm = createStateMachine();

// ─────────────────────────────────────────────────────────────────────────
// Auth-changed event
// ─────────────────────────────────────────────────────────────────────────

function _emitAuthChanged()
{
    if (typeof document === "undefined") return;
    try
    {
        document.dispatchEvent(new CustomEvent("mps:authChanged", {
            detail: {
                sub: _lastSub,
                name: _lastName,
                email: _lastEmail,
                picture: _lastPicture,
            },
        }));
    }
    catch (e)
    {
        console.warn(`[mps:auth] authChanged dispatch failed: ${e?.message || e}`);
    }
}

/**
 * Subscribe to auth state changes. Returns an unsubscribe function.
 * @param {(detail: { sub: string|null, name: string|null, email: string|null, picture: string|null }) => void} handler
 * @returns {() => void}
 */
export function onAuthChanged(handler)
{
    if (typeof document === "undefined") return () => {};
    const wrapped = /** @type {EventListener} */ ((ev) =>
    {
        const ce = /** @type {CustomEvent} */ (ev);
        try { handler(ce.detail); } catch (_) { /* best-effort */ }
    });
    document.addEventListener("mps:authChanged", wrapped);
    return () => document.removeEventListener("mps:authChanged", wrapped);
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Boot-time rehydrate: scope migration, then load token + profile from
 * storage into the in-memory cache. Idempotent — every caller awaits the
 * same promise. Safe to call multiple times.
 * @returns {Promise<void>}
 */
export function ensureRehydrated()
{
    if (_rehydratePromise) return _rehydratePromise;
    console.debug("[mps:auth:TRACE] ensureRehydrated() FIRST-CALL — starting rehydrate");
    _rehydratePromise = (async () =>
    {
        try
        {
            await migrateScopesIfNeeded();

            const token = await loadToken();
            console.debug("[mps:auth:TRACE] ensureRehydrated() loadToken() →",
                token ? { hasAccessToken: !!token.accessToken, hasRefreshToken: !!token.refreshToken, expiresAt: token.expiresAt } : "null");
            if (token)
            {
                _cachedToken = token.accessToken;
                _tokenExpiresAt = token.expiresAt;
            }

            const profile = loadProfile();
            console.debug("[mps:auth:TRACE] ensureRehydrated() loadProfile() →",
                profile ? { sub: profile.sub, email: profile.email } : "null");
            if (profile)
            {
                _lastSub = profile.sub;
                _lastName = profile.name;
                _lastEmail = profile.email;
                _lastPicture = profile.picture;
            }

            // Ticket 13 — id_token.sub verification on restore. If the
            // stored id_token's `sub` claim doesn't match the cached
            // profile's `sub`, the keyring entry has been tampered with
            // (or two accounts have collided on this machine). Wipe and
            // force re-auth BEFORE the FSM declares AUTHENTICATED so the
            // UI never briefly paints the wrong identity.
            //
            // Fresh-write immunity — if the token blob was written within
            // the last 60 seconds, this is almost certainly the app
            // restarting immediately after a successful sign-in and the
            // profile.sub on disk hasn't caught up yet (saveToken and
            // saveProfile are two separate keyring writes; a boot that
            // reads the pair mid-flight of a follow-up rehydrate could
            // see a fresh token against a stale profile). Skip the clear
            // in that case — the very next getAccessToken() will re-read
            // profile from disk and self-correct if there really is a
            // mismatch. This fixes the observed "user signs in, then
            // one second later the app deletes both keyring entries and
            // restarts" symptom.
            if (token && token.idToken != null && _lastSub)
            {
                const restoredSub = _extractIdTokenSub(token.idToken);
                if (restoredSub && restoredSub !== _lastSub)
                {
                    const ageMs = token.writtenAt ? (Date.now() - token.writtenAt) : Number.POSITIVE_INFINITY;
                    const isFresh = ageMs >= 0 && ageMs < 60_000;
                    if (isFresh)
                    {
                        console.warn("[mps:auth] id_token.sub mismatch on restore — SKIPPING clear (fresh write, ageMs=" + ageMs + ")");
                        logAuthEvent("auth.id_token.sub_mismatch_skipped_fresh", { phase: "restore", ageMs });
                    }
                    else
                    {
                        console.warn("[mps:auth] id_token.sub mismatch on restore — clearing session (ageMs=" + ageMs + ")");
                        logAuthEvent("auth.id_token.sub_mismatch", { phase: "restore", ageMs });
                        await _clearSessionState({ reason: "id_token_sub_mismatch_stale", ageMs });
                        sm.transition(STATES.IDLE);
                        _emitAuthChanged();
                        return;
                    }
                }
            }

            console.debug("[mps:auth:TRACE] ensureRehydrated() summary:", {
                hasToken: !!_cachedToken,
                tokenExpiresAt: _tokenExpiresAt,
                tokenTtlSec: _tokenTtlSec(),
                tokenValid: _isTokenLikelyValid(),
                sub: _lastSub,
                name: _lastName,
                hasPicture: !!_lastPicture,
            });

            // Ticket 12 — boot-time revocation probe. Three outcomes:
            //   alive   → AUTHENTICATED
            //   revoked → IDLE (storage already cleared by _refreshViaBff)
            //   offline → IDLE + offline-marked + online-retry scheduled
            const haveAnySession = _cachedToken || _lastSub || _lastName || _lastPicture;
            const tokenStillValid = _cachedToken && _isTokenLikelyValid();

            if (!haveAnySession)
            {
                console.debug("[mps:auth:TRACE] ensureRehydrated() → NO prior session (haveAnySession=false) → IDLE");
                // No prior session — clean idle. UI shows "Sign in to Google."
                _emitAuthChanged();
                return;
            }

            if (tokenStillValid && token && token.refreshToken)
            {
                console.debug("[mps:auth:TRACE] ensureRehydrated() → token valid + refresh_token present → AUTHENTICATED (no BFF hit)");
                // Token still valid AND we have a refresh token. No need to
                // hit the BFF — declare authenticated. Natural expiry will
                // trigger _refreshViaBff via getAccessToken() at that time.
                sm.transition(STATES.AUTHENTICATED);
                _emitAuthChanged();
                return;
            }

            if (!token || !token.refreshToken)
            {
                console.debug("[mps:auth:TRACE] ensureRehydrated() → profile present but NO refresh_token (blob=" + !!token +
                    ", refreshToken=" + !!(token && token.refreshToken) + ") → optimistic AUTHENTICATED, first API call will need interactive sign-in");
                // Profile present but no refresh token (pre-offline-access
                // blob OR mid-rollout state). Surface as "signed in" using
                // the cached profile; the first user action that needs a
                // token will fall through to interactive sign-in. No probe
                // possible without a refresh_token.
                sm.transition(STATES.AUTHENTICATED);
                _emitAuthChanged();
                return;
            }
            console.debug("[mps:auth:TRACE] ensureRehydrated() → have refresh_token but access_token expired/missing → probing BFF");

            // Have a refresh token, but the access token is either missing
            // or expired. Probe the BFF to confirm the grant is still alive.
            // Reuses the existing _refreshViaBff single-flight so this probe
            // AND the first real getAccessToken() after boot share one
            // round-trip.
            sm.transition(STATES.REFRESHING);
            _emitAuthChanged();

            const restored = await _ensureBootProbe();
            console.debug("[mps:auth:TRACE] ensureRehydrated() ← boot-probe result=", restored);
            if (restored === "alive")
            {
                sm.transition(STATES.AUTHENTICATED);
            }
            else if (restored === "revoked")
            {
                console.debug("[mps:auth:TRACE] ensureRehydrated() → boot-probe REVOKED — user will need to interactively sign in again");
                // _refreshViaBff already cleared storage + state.
                sm.transition(STATES.IDLE);
            }
            else
            {
                console.debug("[mps:auth:TRACE] ensureRehydrated() → boot-probe OFFLINE — storage preserved, will retry");
                // Network error — keep storage, mark offline. FSM lands in
                // IDLE because we can't claim AUTHENTICATED without a
                // verified token, but storage is preserved for the retry.
                _isBootOffline = true;
                sm.transition(STATES.IDLE);
                _scheduleOnlineRetry();
            }

            _emitAuthChanged();
        }
        catch (e)
        {
            console.warn("[mps:auth] ensureRehydrated failed:", e);
            // Re-throw so callers (e.g. the boot fire-and-forget path in
            // app.js) can surface a non-blocking toast via reportError.
            // Previously this catch silently swallowed the error and the
            // outer `.catch()` never fired, so users saw no indication
            // that account restore had failed and the account menu just
            // claimed "signed out" without explanation.
            throw e;
        }
    })();
    return _rehydratePromise;
}

/** @returns {boolean} */
function _isTokenLikelyValid()
{
    if (!_cachedToken) return false;
    if (!Number.isFinite(_tokenExpiresAt)) return false;
    return /** @type {number} */ (_tokenExpiresAt) - Date.now() > EXPIRES_IN_MARGIN_MS;
}

/**
 * Sync — true once ensureRehydrated() has populated the cache.
 *
 * Treats ANY identity field (sub OR name OR picture) as proof of a prior
 * sign-in. Without the `openid` scope Google's v3/userinfo endpoint can
 * omit `sub` in some response shapes — keying off `_lastSub` alone would
 * misclassify a freshly-signed-in user as signed-out. Matches the
 * Chrome extension's tolerant check (ext-auth.js:387).
 *
 * @returns {boolean}
 */
export function isAuthenticated()
{
    return !!_cachedToken || !!_lastSub || !!_lastName || !!_lastPicture;
}

/**
 * Sync — cached profile from the last sign-in. May be null pre-rehydrate.
 * `sub` is retained as an alias of `permissionId` for callers that
 * haven't been renamed yet — the underlying value is the Drive
 * about.get `permissionId` (stable per Google account).
 * @returns {{ sub: string|null, permissionId: string|null, name: string|null, email: string|null, picture: string|null }}
 */
export function getCurrentProfile()
{
    return {
        sub: _lastSub,
        permissionId: _lastSub,
        name: _lastName,
        email: _lastEmail,
        picture: _lastPicture,
    };
}

/**
 * Sync — the cached emailAddress, if any. Used as the `login_hint` passed
 * to Drive Picker OAuth so Google skips its account chooser when the
 * user has a prior sign-in on this machine.
 * @returns {string|null}
 */
export function getStoredEmail()
{
    return _lastEmail;
}

/**
 * Boot-time routing helper — true if EITHER a live token OR a cached
 * profile is present. Lets the UI render the workspace immediately and
 * the silent refresh fills in the token in the background.
 * @returns {boolean}
 */
export function hasCachedSession()
{
    return !!(_cachedToken || _lastSub || _lastName || _lastPicture);
}

/**
 * Sync — true while an INTERACTIVE sign-in (browser-opening) flow is
 * running. Deliberately reads `_interactiveAuthInFlight` only; the
 * silent BFF-refresh path (`_refreshInFlight`) does NOT count — it
 * doesn't open a browser, doesn't need a Cancel affordance, and the UI
 * should keep showing "Sign in" during a background token refresh.
 *
 * Consumers: Settings→Account and Publish→Login gate panels call this
 * on every render to decide between "Sign in" button vs "Waiting for
 * browser sign-in… / Cancel" affordance.
 *
 * @returns {boolean}
 */
export function isInteractiveSignInPending()
{
    return _interactiveAuthInFlight !== null;
}

/**
 * Abort a currently in-flight interactive sign-in by asking Rust to
 * flip the loopback listener's abort flag. Best-effort:
 *
 * - No in-flight interactive sign-in → no-op.
 * - Loopback id not yet captured (spawn race) → no-op; the 60s deadline
 *   still applies as a backstop.
 * - Rust invoke throws → logged and swallowed. The underlying promise
 *   remains in flight until timeout.
 *
 * Intentionally does NOT emit `mps:authChanged` here. The natural flow
 * — Rust emits `app:auth-redirect` with `aborted: true` → transport
 * rejects → `_runFlow` catches → classifier maps AbortedError to
 * `auth.user_cancelled` → `_runFlow` returns null → `signIn()`'s outer
 * finally nulls `_interactiveAuthInFlight` + `_pendingAbortId` and
 * fires the single `_emitAuthChanged()` for the whole flow. Emitting
 * here first would trigger a settings-modal re-render while the promise
 * is still pending; the fresh render would see
 * `isInteractiveSignInPending() === true` and stay in Waiting state
 * until the promise landed, which is the exact bug this abort path
 * is meant to prevent.
 *
 * @returns {Promise<void>}
 */
export async function abortInteractiveSignIn()
{
    if (_interactiveAuthInFlight === null) return false;
    const id = _pendingAbortId;
    if (!id) return false;
    try
    {
        await invoke("auth_abort_loopback", { id });
        return true;
    }
    catch (e)
    {
        console.warn("[mps:auth] abort_loopback invoke failed:", e);
        return false;
    }
}

/**
 * Interactive sign-in. Returns the profile on success, null on
 * cancellation. Throws on hard errors — caller should route through
 * classifyAuthError before showing UI.
 *
 * The `interactive` option is retained for API compatibility but no
 * longer affects behaviour — the silent (prompt-none) path is gone.
 * Token refresh is handled by `getAccessToken` via the BFF refresh
 * endpoint (ticket 04).
 *
 * @param {{ interactive?: boolean }} [_opts]
 * @returns {Promise<{ sub: string|null, name: string|null, email: string|null, picture: string|null }|null>}
 */
export async function signIn(_opts = {})
{
    console.debug("[mps:auth:TRACE] signIn() ENTRY — this will open a browser tab. opts=", _opts,
        " stack=\n" + new Error("signIn trace").stack);
    await ensureRehydrated();

    if (_interactiveAuthInFlight)
    {
        console.debug("[mps:auth:TRACE] signIn() joining in-flight interactive auth");
        // Concurrent caller — await the dialog already up. The stored
        // promise resolves to the token on success or `null` on cancel
        // / error (see `.catch(() => null)` at the assignment below).
        // Callers rely on this returning null on cancellation — otherwise
        // publish-modal's `onSignedIn()` would fire after a cancelled
        // sign-in with no token (loses the failure signal, slides to
        // picker, then fails on the next Drive call).
        const token = await _interactiveAuthInFlight;
        if (!token) return null;
        return getCurrentProfile();
    }

    console.debug("[mps:auth:TRACE] signIn() starting fresh _runFlow() → BROWSER WILL OPEN");
    const runP = _runFlow();
    // The stored promise resolves to the token on success or `null` on
    // cancel/error (via `.catch(() => null)`). Joiners at the top of
    // `signIn` await THIS promise and inspect the value — a null result
    // is how they detect that the primary flow was cancelled without
    // an exception path. `_interactiveAuthInFlight` and `_pendingAbortId`
    // are nulled by the primary caller's outer `finally` block below.
    _interactiveAuthInFlight = runP.then((t) => t).catch(() => null);

    // Fire authChanged now that `_interactiveAuthInFlight` is set —
    // subscribed UIs (settings-modal Account tab, publish-modal gate
    // panel) flip into the Waiting affordance immediately so the user
    // can hit Cancel if they close the browser tab. Without this the
    // UI stays in the idle "Sign in" state until the flow ends (up to
    // 60s), and a mid-flow re-render triggered by an unrelated event
    // (ensureRehydrated / storage change) is the only way the Waiting
    // UI would appear.
    _emitAuthChanged();

    try
    {
        const token = await runP;
        if (!token) return null;
        return getCurrentProfile();
    }
    finally
    {
        // Order matters: null out the in-flight + abort-id slots BEFORE
        // emitting authChanged. Waiting-state UI (Settings→Account,
        // Publish→Login) reads `isInteractiveSignInPending()` on
        // re-render; if we emit while the slot is still set, the fresh
        // render stays in Waiting until this microtask returns.
        _interactiveAuthInFlight = null;
        _pendingAbortId = null;
        // Fire authChanged so any subscribed UI (settings modal card,
        // publish gate panel) re-renders out of the Waiting affordance
        // regardless of how the flow ended (success, cancel, error).
        // The identity fields (_lastSub/etc) are already updated by
        // _runFlow before it returns, so subscribers see the correct
        // signed-in / signed-out state.
        _emitAuthChanged();
    }
}

/**
 * Logout: revoke the refresh_token via the BFF (which proxies to Google's
 * RFC 7009 revoke endpoint with the client_secret it holds), then clear
 * local storage. Falls back to revoking the access_token only when no
 * refresh_token is stored (pre-offline-access blob). Per RFC 7009 +
 * Google's semantics, revoking the refresh_token invalidates the whole
 * grant — including any access_token derived from it. Revoking the
 * access_token alone would leave the refresh_token alive, which is the
 * wrong direction (ticket 08).
 * @returns {Promise<void>}
 */
export async function signOut()
{
    // Defensive cleanup — the online-retry listener is moot once the user
    // has explicitly signed out.
    _isBootOffline = false;
    _detachOnlineRetry();

    sm.transition(STATES.REVOKING);

    const blob = await loadToken();
    const tokenToRevoke = blob?.refreshToken || _cachedToken;
    if (tokenToRevoke)
    {
        try
        {
            await fetch(BFF_REVOKE_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    token: tokenToRevoke,
                    client_id: OAUTH_CLIENT_ID,
                }),
            });
        }
        catch (_) { /* best-effort */ }
    }

    await _clearSessionState({ reason: "signOut_user" });
    sm.transition(STATES.IDLE);
    logAuthEvent("auth.signout", { reason: "user" });
    _emitAuthChanged();
}

/**
 * Force the account chooser to pick another Google account.
 * Equivalent to signOut() + signIn({ interactive: true }).
 * @returns {Promise<{ sub: string|null, name: string|null, email: string|null, picture: string|null }|null>}
 */
export async function switchAccount()
{
    logAuthEvent("auth.signout", { reason: "switch" });
    await signOut();
    return signIn({ interactive: true });
}

/**
 * Get a usable access token. Auto-refreshes on expiry by exchanging the
 * stored refresh_token via the BFF (`/v2/oauth/refresh`) — no browser
 * window, no silent authorize round-trip. Returns null when no refresh
 * token is available (caller should route to interactive sign-in) or
 * when Google has invalidated the grant.
 *
 * Concurrent callers share a single refresh round-trip via
 * `_refreshInFlight` — N getAccessToken() calls during the same expiry
 * window result in ONE POST to the BFF.
 *
 * @param {{ allowRefresh?: boolean }} [opts]
 * @returns {Promise<string|null>}
 */
export async function getAccessToken({ allowRefresh = true } = {})
{
    console.debug("[mps:auth:TRACE] getAccessToken() ENTRY allowRefresh=", allowRefresh,
        " stack=\n" + new Error("getAccessToken trace").stack);
    await ensureRehydrated();

    if (_isTokenLikelyValid())
    {
        console.debug("[mps:auth:TRACE] getAccessToken() → cached token still valid, ttl=", _tokenTtlSec(), "s");
        return _cachedToken;
    }

    if (!allowRefresh)
    {
        console.debug("[mps:auth:TRACE] getAccessToken() → no valid cached token AND allowRefresh=false → returning null");
        return null;
    }

    if (_refreshInFlight)
    {
        console.debug("[mps:auth:TRACE] getAccessToken() → joining in-flight BFF refresh");
        const shared = await _refreshInFlight;
        console.debug("[mps:auth:TRACE] getAccessToken() ← shared BFF refresh returned token=", shared.token ? ("len=" + shared.token.length) : "null");
        return shared.token;
    }

    console.debug("[mps:auth:TRACE] getAccessToken() → starting BFF refresh (silent, no browser)");
    _refreshInFlight = (async () =>
    {
        try
        {
            return await _refreshViaBff();
        }
        finally
        {
            _refreshInFlight = null;
        }
    })();

    const result = await _refreshInFlight;
    console.debug("[mps:auth:TRACE] getAccessToken() ← BFF refresh done status=", result.status,
        " token=", result.token ? ("len=" + result.token.length) : "null");
    return result.token;
}

/** @returns {number} */
function _tokenTtlSec()
{
    if (!Number.isFinite(_tokenExpiresAt)) return 0;
    return Math.max(0, Math.round((/** @type {number} */ (_tokenExpiresAt) - Date.now()) / 1000));
}

// ─────────────────────────────────────────────────────────────────────────
// Refresh-via-BFF + session-clear + id_token helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Exchange the stored refresh_token for a fresh access_token via the BFF.
 * On Google `invalid_grant` (refresh token revoked / 6mo idle / Gmail-scope
 * password change) clears storage and emits auth-changed → signed-out.
 * On any other error (network, BFF 5xx) leaves storage intact and lets the
 * caller retry later.
 *
 * Returns a RefreshResult tagged with the outcome so callers (boot probe,
 * getAccessToken) can route without inspecting side-effects like _lastSub.
 * Telemetry events (`auth.refresh.invalid_grant` vs `auth.id_token.sub_mismatch`)
 * remain distinct even though both collapse to `status: "revoked"`.
 *
 * @returns {Promise<RefreshResult>}
 */
async function _refreshViaBff()
{
    console.debug("[mps:auth:TRACE] _refreshViaBff() ENTRY — loading stored token blob");
    const blob = await loadToken();
    if (!blob || !blob.refreshToken)
    {
        console.debug("[mps:auth:TRACE] _refreshViaBff() → NO refresh_token in keyring (blob=", !!blob,
            ", refreshToken=", !!(blob && blob.refreshToken), ") → returning no_refresh_token");
        // No refresh token (pre-offline-access blob OR never signed in).
        // Caller should route to interactive sign-in.
        return { status: "no_refresh_token", token: null };
    }
    console.debug("[mps:auth:TRACE] _refreshViaBff() → have refresh_token, POSTing to BFF");

    logAuthEvent("auth.refresh.attempted", {});

    let resp;
    try
    {
        resp = await fetch(BFF_REFRESH_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                refresh_token: blob.refreshToken,
                client_id: OAUTH_CLIENT_ID,
            }),
        });
    }
    catch (e)
    {
        // Network failure — keep storage, return offline so caller can retry.
        logAuthEvent("auth.refresh.network", {});
        console.warn("[mps:auth] refresh network error:", e);
        return { status: "offline", token: null };
    }

    if (!resp.ok)
    {
        const body = await resp.json().catch(() => ({}));
        if (resp.status === 400 && body?.error === "invalid_grant")
        {
            console.debug("[mps:auth:TRACE] _refreshViaBff() → BFF returned invalid_grant → WIPING SESSION → interactive sign-in required");
            // Refresh token is dead at Google. Wipe local state and let
            // the UI route to interactive sign-in via the auth-changed
            // listener. The error-classifier maps `invalid_grant` →
            // auth.refresh_token_expired (MODAL) for any caller that
            // surfaces it directly.
            logAuthEvent("auth.refresh.invalid_grant", {});
            await _clearSessionState({ reason: "refresh_invalid_grant" });
            sm.transition(STATES.IDLE);
            _emitAuthChanged();
            return { status: "revoked", token: null };
        }
        // Other upstream errors — keep storage, return offline.
        logAuthEvent("auth.refresh.upstream_error", { status: resp.status });
        console.warn("[mps:auth] refresh upstream error:", resp.status, body);
        return { status: "offline", token: null };
    }

    let data;
    try { data = await resp.json(); }
    catch (e)
    {
        logAuthEvent("auth.refresh.upstream_error", { status: 200, reason: "malformed_json" });
        console.warn("[mps:auth] refresh 200 with malformed JSON:", e);
        return { status: "offline", token: null };
    }
    const newAccessToken = data.access_token;
    const newExpiresIn = data.expires_in || 3600;
    // Google rarely rotates refresh tokens for installed-app clients —
    // fall back to the stored one when the response omits it.
    const newRefreshToken = (typeof data.refresh_token === "string" && data.refresh_token)
        ? data.refresh_token
        : blob.refreshToken;
    const newIdToken = (typeof data.id_token === "string" && data.id_token)
        ? data.id_token
        : blob.idToken;

    // Ticket 13 — verify id_token.sub against the cached sub. Mismatch
    // means keyring tampering or cross-account confusion; wipe state.
    // Telemetry stays distinct from invalid_grant via the dedicated
    // `auth.id_token.sub_mismatch` event, but the user-visible outcome
    // (signed out, must reauth) is identical so the status collapses to
    // "revoked" for the caller.
    if (newIdToken != null && _lastSub)
    {
        const sub = _extractIdTokenSub(newIdToken);
        if (sub && sub !== _lastSub)
        {
            console.debug("[mps:auth:TRACE] _refreshViaBff() → id_token.sub MISMATCH → WIPING SESSION → interactive sign-in required");
            logAuthEvent("auth.id_token.sub_mismatch", { phase: "refresh" });
            await _clearSessionState({ reason: "id_token_sub_mismatch_refresh" });
            sm.transition(STATES.IDLE);
            _emitAuthChanged();
            return { status: "revoked", token: null };
        }
    }

    _cachedToken = newAccessToken;
    _tokenExpiresAt = Date.now() + (newExpiresIn * 1000) - EXPIRES_IN_MARGIN_MS;

    await saveToken({
        accessToken: newAccessToken,
        expiresAt: /** @type {number} */ (_tokenExpiresAt),
        refreshToken: newRefreshToken,
        idToken: newIdToken,
    });

    logAuthEvent("auth.refresh.success", { ttlSec: newExpiresIn });
    return { status: "alive", token: newAccessToken };
}

/**
 * Merge tokens returned by the Google Drive Picker exchange into the
 * live auth session. Three cases, matching the plan `js-picker-token-store`
 * contract and the shape of `_refreshViaBff` above:
 *
 *   (a) `!isAuthenticated()` — the picker doubled as a sign-in. Seed
 *       `_cachedToken`, decode `id_token` if present to seed
 *       `_lastSub` / `_lastName` / `_lastPicture`, persist to keyring,
 *       emit `auth.picker.signed_in`.
 *   (b) `isAuthenticated()` AND picker returned `refresh_token` — save
 *       the fresh refresh_token (NEVER overwrite the stored one with
 *       null / undefined) and update in-memory access_token + expiry.
 *   (c) `isAuthenticated()` AND no `refresh_token` — refresh in-memory
 *       access_token + expiry only; call `saveToken` to update the
 *       persisted access_token slot but preserve the existing
 *       refresh_token from disk.
 *
 * @param {{
 *   token: string,
 *   refreshToken?: string,
 *   expiresIn?: number,
 *   idToken?: string,
 * }} pickerResult
 * @returns {Promise<void>}
 */
export async function mergePickerTokens(pickerResult)
{
    if (!pickerResult || typeof pickerResult.token !== "string" || !pickerResult.token)
    {
        return;
    }

    const expiresIn = Number.isFinite(pickerResult.expiresIn)
        ? /** @type {number} */ (pickerResult.expiresIn)
        : 3600;
    const expiresAt = Date.now() + (expiresIn * 1000) - EXPIRES_IN_MARGIN_MS;
    const idToken = typeof pickerResult.idToken === "string" && pickerResult.idToken
        ? pickerResult.idToken
        : null;
    const freshRefreshToken = typeof pickerResult.refreshToken === "string"
            && pickerResult.refreshToken
        ? pickerResult.refreshToken
        : null;

    if (!isAuthenticated())
    {
        // Case (a) — sign-in via picker. Populate _cachedToken FIRST so
        // Drive about.get below can use it. Identity now comes from Drive
        // about.get (drive.file scope only — no id_token since openid was
        // dropped). id_token decode remains as a fast-path fallback for
        // any future flow that does include it.
        _cachedToken = pickerResult.token;
        _tokenExpiresAt = expiresAt;

        if (idToken)
        {
            const parts = String(idToken).split(".");
            if (parts.length === 3)
            {
                try
                {
                    const padded = parts[1] + "===".slice((parts[1].length + 3) % 4);
                    const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
                    const payload = JSON.parse(decoded);
                    if (typeof payload?.sub === "string") _lastSub = payload.sub;
                    if (typeof payload?.name === "string") _lastName = payload.name;
                    if (typeof payload?.email === "string") _lastEmail = payload.email;
                    if (typeof payload?.picture === "string") _lastPicture = payload.picture;
                }
                catch (_) { /* best-effort */ }
            }
        }

        // Drive about.get — the identity source for the drive.file-only
        // era. Runs when id_token didn't fully populate identity (i.e.
        // the normal case now that openid scope is gone).
        if (!_lastEmail || !_lastSub)
        {
            try
            {
                const info = await _fetchDriveAbout(pickerResult.token);
                if (!_lastSub && info.permissionId) _lastSub = info.permissionId;
                if (!_lastName && info.name) _lastName = info.name;
                if (!_lastEmail && info.email) _lastEmail = info.email;
                if (!_lastPicture && info.picture) _lastPicture = info.picture;
            }
            catch (e)
            {
                console.warn("[mps:auth] mergePickerTokens: drive.about failed (non-fatal):", e);
            }
        }

        await saveToken({
            accessToken: pickerResult.token,
            expiresAt,
            refreshToken: freshRefreshToken,
            idToken,
        });
        if (_lastSub || _lastName || _lastEmail || _lastPicture)
        {
            await saveProfile({
                sub: _lastSub,
                name: _lastName,
                email: _lastEmail,
                picture: _lastPicture,
            });
        }
        sm.transition(STATES.AUTHENTICATED);
        _emitAuthChanged();
        logAuthEvent("auth.picker.signed_in", { hadIdToken: !!idToken });
        return;
    }

    // Cases (b) + (c) — signed-in already. Preserve stored refresh_token
    // when the picker exchange did not return a fresh one; Google only
    // issues refresh_tokens on first-consent / `prompt=consent`, so the
    // absence is expected on subsequent picks and MUST NOT wipe the
    // stored one (that would force re-consent every session).
    _cachedToken = pickerResult.token;
    _tokenExpiresAt = expiresAt;

    const stored = await loadToken();
    const preservedRefreshToken = freshRefreshToken
        || (stored && stored.refreshToken)
        || null;
    const preservedIdToken = idToken
        || (stored && stored.idToken)
        || null;

    await saveToken({
        accessToken: pickerResult.token,
        expiresAt,
        refreshToken: preservedRefreshToken,
        idToken: preservedIdToken,
    });

    logAuthEvent("auth.picker.token_merged", {
        had_session: true,
        got_refresh_token: !!freshRefreshToken,
    });
}

/**
 * Wipe in-memory + on-disk session state. Best-effort on both storage
 * calls — a keyring failure does not throw. Used by signOut, refresh
 * invalid_grant, and sub-mismatch paths.
 *
 * Forensic logging — every call site tags a `reason` so we can trace the
 * "keyring entries deleted a moment after sign-in" symptom to its
 * source in app.log. `console.warn` funnels to the Rust log target via
 * console_capture, so the reason + full JS stack land in app.log next
 * to the surrounding `keyring[DEBUG] delete entry` lines.
 *
 * @param {{ reason?: string, ageMs?: number }} [ctx]
 * @returns {Promise<void>}
 */
async function _clearSessionState(ctx)
{
    const reason = (ctx && ctx.reason) || "unspecified";
    const ageMs = ctx && Number.isFinite(ctx.ageMs) ? ctx.ageMs : null;

    // Log level depends on reason:
    //   signOut_user — routine event, downgrade to info (no stack). Users
    //     were spooked by seeing an Error trace in the log after clicking
    //     Sign Out; the trace was diagnostic-only and doesn't indicate a
    //     problem when the reason is a user-initiated signout.
    //   everything else — warn + stack, because these are the buggy paths
    //     we chased earlier (sub-mismatch, invalid_grant, unspecified).
    //     Console_capture forwards these to app.log for triage.
    if (reason === "signOut_user")
    {
        console.log("[mps:auth] _clearSessionState fired — reason=signOut_user (user-initiated, clean)");
    }
    else
    {
        console.log("[mps:auth] Clearing stored Google session — reason=" + reason
            + (ageMs !== null ? " ageMs=" + ageMs : ""));
    }

    _cachedToken = null;
    _tokenExpiresAt = null;
    _lastSub = null;
    _lastName = null;
    _lastEmail = null;
    _lastPicture = null;
    // Reset the boot-time rehydrate promise so the NEXT ensureRehydrated()
    // call re-reads the (now-empty) keyring + profile. Without this the
    // cached rehydrate promise from boot short-circuits every future
    // ensureRehydrated call and any code that reads `_lastSub` via that
    // path silently sees stale data. Harmless today because we also null
    // out _cachedToken above and _isTokenLikelyValid() returns false, but
    // fragile — a future change reading identity fields (e.g. profile
    // .sub, .email) via ensureRehydrated would silently see the old
    // signed-in user for the rest of the process lifetime.
    _rehydratePromise = null;
    try { await clearToken(); } catch (_) { /* best-effort */ }
    try { await clearProfile(); } catch (_) { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────
// Boot-time revocation probe (ticket 12)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Boot-time revocation probe. Wraps _refreshViaBff and classifies the
 * outcome into alive / revoked / offline for the boot path.
 *
 * Reuses _refreshInFlight via _refreshViaBff so this probe AND the first
 * getAccessToken() call after boot share one round-trip.
 *
 * Returns:
 *   "alive"   — refresh succeeded, _cachedToken is now fresh
 *   "revoked" — Google said invalid_grant; _refreshViaBff already wiped
 *               storage + state. Caller should transition to IDLE +
 *               surface signed-out UI.
 *   "offline" — network error or non-invalid_grant upstream error.
 *               Storage is intact, caller should mark offline state and
 *               schedule a retry.
 *
 * @returns {Promise<"alive"|"revoked"|"offline">}
 */
async function _ensureBootProbe()
{
    logAuthEvent("auth.restore.attempted", {});

    // Populate _refreshInFlight so any concurrent getAccessToken() caller
    // shares this boot-probe round-trip instead of firing a second BFF
    // request. Mirrors the single-flight wiring inside getAccessToken.
    if (!_refreshInFlight)
    {
        _refreshInFlight = (async () =>
        {
            try
            {
                return await _refreshViaBff();
            }
            finally
            {
                _refreshInFlight = null;
            }
        })();
    }

    const result = await _refreshInFlight;

    if (result.status === "alive")
    {
        logAuthEvent("auth.restore.success", {
            ttlSec: _tokenTtlSec(),
        });
        return "alive";
    }

    if (result.status === "revoked")
    {
        // _refreshViaBff already wiped storage + in-memory state and
        // emitted auth-changed. Telemetry for invalid_grant vs
        // sub_mismatch already fired inside _refreshViaBff; this event
        // captures the boot-path classification.
        logAuthEvent("auth.restore.revoked", {});
        return "revoked";
    }

    // "offline" — and "no_refresh_token" shouldn't reach here because
    // ensureRehydrated short-circuits the boot path when refreshToken is
    // null. Treat it as "offline" defensively.
    logAuthEvent("auth.restore.offline", {});
    return "offline";
}

/**
 * Schedule a one-shot online-retry of the boot probe. When the OS reports
 * the network is back, re-run _ensureBootProbe and update FSM accordingly.
 * Detaches itself on the first terminal outcome (alive or revoked).
 */
function _scheduleOnlineRetry()
{
    if (_onlineRetryDetach) return; // already scheduled
    if (typeof window === "undefined") return; // SSR / test environment

    const handler = async () =>
    {
        if (!_isBootOffline) return;
        logAuthEvent("auth.restore.online_retry", {});

        const restored = await _ensureBootProbe();
        if (restored === "alive")
        {
            _isBootOffline = false;
            sm.transition(STATES.AUTHENTICATED);
            _emitAuthChanged();
            _detachOnlineRetry();
        }
        else if (restored === "revoked")
        {
            _isBootOffline = false;
            sm.transition(STATES.IDLE);
            _emitAuthChanged();
            _detachOnlineRetry();
        }
        // else still offline — keep listener, wait for next online event.
    };

    window.addEventListener("online", handler);
    _onlineRetryDetach = () => window.removeEventListener("online", handler);
}

function _detachOnlineRetry()
{
    if (_onlineRetryDetach)
    {
        _onlineRetryDetach();
        _onlineRetryDetach = null;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Core flow runner — drives the state machine through 1→8.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Drives the interactive sign-in state machine through steps 1→8. The
 * silent (`interactive: false`) variant is gone — refresh now happens
 * via `_refreshViaBff`, not by re-running authorize silently.
 * @returns {Promise<string|null>}
 */
async function _runFlow()
{
    console.debug("[mps:auth:TRACE] _runFlow() ENTRY — OAuth flow beginning");
    logAuthEvent("auth.signin.start", {});

    try
    {
        // ── Step 1 — build URL ────────────────────────────────────────
        sm.transition(STATES.BUILDING_URL);
        const expectedState = randomNonce();
        const codeVerifier = generateCodeVerifier();
        const challenge = await codeChallenge(codeVerifier);

        // ── Step 2 — open browser + Step 3 — await redirect ──────────
        console.debug("[mps:auth:TRACE] _runFlow() → AWAITING_BROWSER (loading transport)");
        sm.transition(STATES.AWAITING_BROWSER);
        const transport = await loadTransport();

        console.debug("[mps:auth:TRACE] _runFlow() → startAndAwaitRedirect (BROWSER OPENS NOW)");
        sm.transition(STATES.AWAITING_REDIRECT);
        const { url: redirectUrl } = await transport.startAndAwaitRedirect(
            (redirectUri) =>
                _buildAuthUrl({ interactive: true, redirectUri, state: expectedState, challenge: challenge }),
            // Stash the loopback listener id so `abortInteractiveSignIn()`
            // can flip its abort flag if the user clicks Cancel. Mobile
            // deeplink transport doesn't invoke this callback (no
            // bindable socket, no abort surface); `_pendingAbortId`
            // stays null in that case and abort becomes a no-op.
            (info) =>
            {
                if (info && typeof info.id === "string") _pendingAbortId = info.id;
            }
        );

        // ── Step 4 — parse + CSRF check ───────────────────────────────
        sm.transition(STATES.PARSING_REDIRECT);
        const parsed = _parseRedirect(redirectUrl);

        if (!parsed.state || parsed.state !== expectedState)
        {
            const err = new Error("state mismatch — possible CSRF");
            err.name = "CsrfError";
            throw err;
        }

        if (parsed.error)
        {
            const err = new Error(parsed.error);
            err.name = parsed.error;
            throw err;
        }

        if (!parsed.code)
        {
            const err = new Error("no authorization code in redirect");
            err.name = "MissingCode";
            throw err;
        }

        // The redirect URI sent to Google MUST exactly match what the BFF
        // sees on the exchange call. Pull it from the URL itself so the
        // ephemeral loopback port lines up.
        const redirectUri = _extractRedirectUri(redirectUrl);

        // ── Step 5 — exchange ────────────────────────────────────────
        sm.transition(STATES.EXCHANGING);
        const tokens = await _exchangeCodeForToken({
            code: parsed.code,
            codeVerifier,
            redirectUri,
        });

        _cachedToken = tokens.access_token;
        _tokenExpiresAt = Date.now() + (tokens.expires_in * 1000) - EXPIRES_IN_MARGIN_MS;

        // ── Step 6 — identity via Drive about.get ────────────────────
        sm.transition(STATES.FETCHING_PROFILE);
        const info = await _fetchDriveAbout(_cachedToken);
        _lastSub = info.permissionId;
        _lastName = info.name;
        _lastEmail = info.email;
        _lastPicture = info.picture;

        // id_token is no longer requested (openid not in OAUTH_SCOPES);
        // Google returns null in that case. Verification stays best-effort
        // — skipped entirely when idToken is absent.
        if (tokens.id_token != null && _lastSub)
        {
            const idSub = _extractIdTokenSub(tokens.id_token);
            if (idSub && idSub !== _lastSub)
            {
                console.warn("[mps:auth] id_token.sub != permissionId on sign-in (non-fatal)");
                logAuthEvent("auth.id_token.sub_mismatch", { phase: "signin" });
            }
        }

        // ── Step 7 — persist ─────────────────────────────────────────
        sm.transition(STATES.PERSISTING);
        await saveToken({
            accessToken: _cachedToken,
            expiresAt: /** @type {number} */ (_tokenExpiresAt),
            refreshToken: tokens.refresh_token,
            idToken: tokens.id_token,
        });
        await saveProfile({
            sub: _lastSub,
            name: _lastName,
            email: _lastEmail,
            picture: _lastPicture,
        });

        // ── Step 8 — authenticated ───────────────────────────────────
        sm.transition(STATES.AUTHENTICATED);
        // NB: authChanged is emitted by `signIn()`'s outer finally AFTER
        // `_interactiveAuthInFlight` + `_pendingAbortId` are nulled.
        // Emitting here would fire while the in-flight guard is still
        // set, causing subscribers (settings-modal, publish-modal) to
        // re-render in the Waiting affordance for one microtask before
        // flipping to signed-in — a visible flicker on the success path.

        // Defensive cleanup — a fresh interactive sign-in supersedes any
        // boot-time offline state.
        _isBootOffline = false;
        _detachOnlineRetry();

        logAuthEvent("auth.signin.success", { ttlSec: tokens.expires_in });

        return _cachedToken;
    }
    catch (e)
    {
        const cls = classifyAuthError(e);
        if (cls.class === "auth.user_cancelled")
        {
            logAuthEvent("auth.signin.cancelled", {});
        }
        else
        {
            logAuthEvent("auth.signin.error", { class: cls.class });

            // Raise the app window so the user sees the classified error
            // banner instead of the browser tab — the callback page no
            // longer claims success, but the user may still be looking
            // at it. Best-effort: command is missing on test stubs and
            // platform focus-steal policies can deny the raise.
            try { await invoke("auth_raise_window"); }
            catch (_) { /* non-fatal */ }
        }
        sm.transition(STATES.IDLE, { class: cls.class });
        if (cls.class === "auth.user_cancelled") return null;
        throw e;
    }
}

// Rehydrate is kicked off by boot() in app.js AFTER loadUserSettings()
// resolves. Do NOT fire here — module evaluation runs before the
// user-settings cache is warm, which would make loadScopeVersion()
// throw, fall back to 0, and trigger a spurious "scope migration" that
// wipes the keyring tokens every boot.

// ─────────────────────────────────────────────────────────────────────────
// Test-only hooks (NOT FOR PRODUCTION USE)
//
// `_testOnly` lets unit tests reach the private refresh/restore/sub helpers
// and reset module-scope state between cases. Production code MUST NOT
// import this symbol — `grep -rn "_testOnly" mangaplay-studio/src
// --exclude="*.test.js"` should return only the declaration below.
// ─────────────────────────────────────────────────────────────────────────

export const _testOnly = {
    /** @returns {Promise<RefreshResult>} */
    refreshViaBff: () => _refreshViaBff(),

    /** @returns {Promise<"alive"|"revoked"|"offline">} */
    ensureBootProbe: () => _ensureBootProbe(),

    /**
     * @param {string} idToken
     * @returns {string|null}
     */
    extractIdTokenSub: (idToken) => _extractIdTokenSub(idToken),

    /** @returns {Promise<void>} */
    clearSessionState: () => _clearSessionState(),

    /** Reset every module-scope slot to its boot-time default. */
    resetForTest: () =>
    {
        _cachedToken = null;
        _tokenExpiresAt = null;
        _lastSub = null;
        _lastName = null;
        _lastEmail = null;
        _lastPicture = null;
        _interactiveAuthInFlight = null;
        _refreshInFlight = null;
        _isBootOffline = false;
        if (_onlineRetryDetach)
        {
            try { _onlineRetryDetach(); } catch (_) { /* best-effort */ }
            _onlineRetryDetach = null;
        }
        _rehydratePromise = null;
    },

    /**
     * Seed module-scope state for a test. Only the keys passed are
     * overwritten — other slots keep their current value.
     * @param {{
     *   cachedToken?: string|null,
     *   tokenExpiresAt?: number|null,
     *   lastSub?: string|null,
     *   lastName?: string|null,
     *   lastEmail?: string|null,
     *   lastPicture?: string|null,
     *   isBootOffline?: boolean,
     * }} state
     */
    setStateForTest: (state) =>
    {
        if (state.cachedToken !== undefined) _cachedToken = state.cachedToken;
        if (state.tokenExpiresAt !== undefined) _tokenExpiresAt = state.tokenExpiresAt;
        if (state.lastSub !== undefined) _lastSub = state.lastSub;
        if (state.lastName !== undefined) _lastName = state.lastName;
        if (state.lastEmail !== undefined) _lastEmail = state.lastEmail;
        if (state.lastPicture !== undefined) _lastPicture = state.lastPicture;
        if (state.isBootOffline !== undefined) _isBootOffline = state.isBootOffline;
    },

    getStateForTest: () => ({
        cachedToken: _cachedToken,
        tokenExpiresAt: _tokenExpiresAt,
        lastSub: _lastSub,
        lastName: _lastName,
        lastEmail: _lastEmail,
        lastPicture: _lastPicture,
        isBootOffline: _isBootOffline,
        hasRefreshInFlight: _refreshInFlight !== null,
        hasOnlineRetryDetach: _onlineRetryDetach !== null,
    }),
};
