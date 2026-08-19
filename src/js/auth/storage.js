// @ts-check
/**
 * storage.js — split-storage matching Fountain+ Studio's model.
 *
 * Access token + expires_at  → OS credential vault via Rust commands
 *                              `auth_token_store_get/set/clear`.
 *                              Linux: libsecret (default) with keyutils
 *                              fallback for headless / WSL (`linux-native`
 *                              feature of the keyring crate).
 * Profile (sub/name/email/picture) → user-settings.json via
 *                              saveUserSettings({ googleProfile: {...} }).
 *
 * Rationale for the split: tokens are 1-hour-life credentials (vault makes
 * sense). Profile is durable identity for "Signed in as X" UI on cold boot
 * (plain JSON is fine — name/email/avatar URL only).
 *
 * SCOPE_VERSION was historically coupled to extension-fountain-studio/
 * adapters/fps-auth.js because both products shared a client_id. They
 * have since diverged (Mangaplay 661305…, Fountain+ 358910…) and own
 * independent consent screens, so this counter is now Mangaplay-only.
 *
 *   v1 — userinfo.profile + drive.file + documents
 *   v2 — same set (consent surface change only)
 *   v3 — drive `documents` scope removed (was sensitive, never used —
 *        triggered "unverified app" warning on consent screen).
 *   v4 — `documents` scope re-added. Required by the publish/push/pull
 *        pipeline (documents.create, documents.batchUpdate,
 *        documents.get) — drive.file alone cannot mutate Doc body
 *        content on Google Doc mimeTypes. Full reviewer justification
 *        in google-oauth.js above OAUTH_SCOPES.
 */

import { invoke } from "@tauri-apps/api/core";
import { saveUserSettings, getUserSetting } from "../project/user-settings.js";

export const SCOPE_VERSION = 7;

const KEYRING_ACCOUNT_TOKEN = "google.access_token";
// id_token (Google's JWT) is 1.2-1.8 KB and would push the combined blob
// past Windows Credential Manager's 2560 UTF-16 char ceiling (per the
// `keyring v3 windows-native` backend). Stored in its own keyring entry
// so each entry stays under the platform limit.
const KEYRING_ACCOUNT_ID_TOKEN = "google.id_token";

// ─────────────────────────────────────────────────────────────────────────
// Test-only — pluggable storage backend so unit tests can stub the keyring
// + profile reads without touching Tauri. Production code MUST NOT import
// or call `_setStorageBackendForTest`.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} StorageBackend
 * @property {() => Promise<TokenBlob|null>} loadToken
 * @property {(blob: TokenBlob) => Promise<void>} saveToken
 * @property {() => Promise<void>} clearToken
 * @property {() => GoogleProfile|null} loadProfile
 * @property {(profile: GoogleProfile) => Promise<void>} saveProfile
 * @property {() => Promise<void>} clearProfile
 */

/** @type {StorageBackend|null} */
let _testBackend = null;

/**
 * Test-only — swap the underlying storage backend. Pass `null` to restore
 * the real Tauri-backed implementation.
 * @param {StorageBackend|null} backend
 */
export function _setStorageBackendForTest(backend)
{
    _testBackend = backend;
}

/**
 * @typedef {Object} TokenBlob
 * @property {string} accessToken
 * @property {number} expiresAt          // ms since epoch
 * @property {string|null} refreshToken  // null when no refresh token was issued (pre-offline-access era)
 * @property {string|null} idToken       // null when openid scope not requested
 * @property {number} [writtenAt]        // ms since epoch — wall-clock at saveToken. Used
 *                                       // by ensureRehydrated() to grant fresh-write
 *                                       // immunity to the id_token.sub mismatch check:
 *                                       // a boot that reads a token written seconds ago
 *                                       // is almost certainly reading its own successful
 *                                       // sign-in and should NOT clear session state on
 *                                       // a transient sub compare (which we saw signing
 *                                       // users out one second after they signed in).
 *                                       // 0 for pre-v4 blobs — treated as "unknown / old".
 */

/**
 * @typedef {Object} GoogleProfile
 * @property {string|null} sub
 * @property {string|null} name
 * @property {string|null} email
 * @property {string|null} picture
 */

// ─────────────────────────────────────────────────────────────────────────
// Token vault (Rust keyring crate)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Load the token blob from the OS keyring. Returns null on any failure
 * (missing entry / Linux keyring inaccessible / Rust command not registered
 * yet) — caller treats null as "signed out".
 *
 * Split storage: the main entry holds `{accessToken, expiresAt, refreshToken}`
 * (small — comfortably under Windows Credential Manager's 2560-UTF-16-char
 * limit). The id_token lives in a SEPARATE keyring entry because Google's
 * id_token JWT is 1.2-1.8 KB and would push the combined JSON past the
 * limit. Reads of either are independent — missing id_token returns null
 * for that field, not a load failure.
 *
 * @returns {Promise<TokenBlob|null>}
 */
export async function loadToken()
{
    if (_testBackend) return _testBackend.loadToken();
    try
    {
        const raw = await invoke("auth_token_store_get", {
            account: KEYRING_ACCOUNT_TOKEN,
        });
        if (!raw || typeof raw !== "string") return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        if (typeof parsed.accessToken !== "string") return null;
        if (!Number.isFinite(parsed.expiresAt)) return null;
        // refreshToken added in ticket 03. Pre-existing blobs without it
        // read as null; the refresh path then falls through to interactive
        // sign-in once.
        const refreshToken = typeof parsed.refreshToken === "string" ? parsed.refreshToken : null;

        // writtenAt added alongside the documents-scope migration. Pre-existing
        // blobs read as 0 → the sub-mismatch check falls back to its original
        // "no immunity" behaviour for older tokens (safe).
        const writtenAt = Number.isFinite(parsed.writtenAt) ? parsed.writtenAt : 0;

        // id_token lives in a separate keyring entry — see note above.
        // Missing entry => null. A keyring read error here MUST NOT fail
        // the whole loadToken — id_token verification is best-effort.
        let idToken = null;
        try
        {
            const rawId = await invoke("auth_token_store_get", {
                account: KEYRING_ACCOUNT_ID_TOKEN,
            });
            if (typeof rawId === "string" && rawId.length > 0) idToken = rawId;
        }
        catch (e)
        {
            console.debug("[mps:auth] loadToken: id_token entry read failed", e);
        }

        return {
            accessToken: parsed.accessToken,
            expiresAt: parsed.expiresAt,
            refreshToken,
            idToken,
            writtenAt,
        };
    }
    catch (e)
    {
        console.debug("[mps:auth] loadToken: keyring read failed", e);
        return null;
    }
}

/**
 * Persist the token blob across two keyring entries (see loadToken for
 * the split rationale). If the id_token write fails (e.g. platform
 * limit), the main entry is still committed — caller's refresh path
 * tolerates a null id_token, but sub verification will be skipped.
 *
 * @param {TokenBlob} blob
 * @returns {Promise<void>}
 */
export async function saveToken(blob)
{
    if (_testBackend) return _testBackend.saveToken(blob);
    // Stamp writtenAt at save time so the value on disk always reflects THIS
    // write, regardless of what the caller put in the blob. Callers that
    // pass an explicit writtenAt (test fixtures that need to simulate an
    // old blob) are honoured.
    const writtenAt = Number.isFinite(blob.writtenAt) && blob.writtenAt > 0
        ? blob.writtenAt
        : Date.now();
    const raw = JSON.stringify({
        accessToken: blob.accessToken,
        expiresAt: blob.expiresAt,
        refreshToken: blob.refreshToken || null,
        writtenAt,
    });
    await invoke("auth_token_store_set", {
        account: KEYRING_ACCOUNT_TOKEN,
        value: raw,
    });

    // Separate entry for id_token (size-bounded — see note in loadToken).
    // Empty / null id_token clears the entry so a sign-out-followed-by-
    // sign-in path doesn't leave a stale id_token from a prior account.
    try
    {
        if (blob.idToken)
        {
            await invoke("auth_token_store_set", {
                account: KEYRING_ACCOUNT_ID_TOKEN,
                value: blob.idToken,
            });
        }
        else
        {
            await invoke("auth_token_store_clear", {
                account: KEYRING_ACCOUNT_ID_TOKEN,
            });
        }
    }
    catch (e)
    {
        // Non-fatal — main token persisted, sub verification will be
        // skipped on next restore.
        console.warn("[mps:auth] saveToken: id_token write failed (non-fatal)", e);
    }
}

/** @returns {Promise<void>} */
export async function clearToken()
{
    if (_testBackend) return _testBackend.clearToken();
    try
    {
        await invoke("auth_token_store_clear", {
            account: KEYRING_ACCOUNT_TOKEN,
        });
    }
    catch (e)
    {
        console.debug("[mps:auth] clearToken: keyring clear failed", e);
    }
    // Best-effort: also clear the id_token entry. Independent try/catch so
    // failure here doesn't prevent the main clear from being acknowledged.
    try
    {
        await invoke("auth_token_store_clear", {
            account: KEYRING_ACCOUNT_ID_TOKEN,
        });
    }
    catch (e)
    {
        console.debug("[mps:auth] clearToken: id_token clear failed", e);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Profile (user-settings.json)
// ─────────────────────────────────────────────────────────────────────────

/** @returns {GoogleProfile|null} */
export function loadProfile()
{
    if (_testBackend) return _testBackend.loadProfile();
    try
    {
        const v = /** @type {any} */ (getUserSetting("googleProfile", null));
        if (!v || typeof v !== "object") return null;
        // Reader tolerates both `permissionId` (SCOPE_VERSION 7+) and the
        // legacy `sub` field (SCOPE_VERSION 6 and earlier) so a user whose
        // token blob survived the scope migration doesn't get a null id
        // on first boot. Drop the `sub` fallback the next time
        // SCOPE_VERSION advances.
        const permissionId = typeof v.permissionId === "string"
            ? v.permissionId
            : (typeof v.sub === "string" ? v.sub : null);
        return {
            sub: permissionId,
            name: typeof v.name === "string" ? v.name : null,
            email: typeof v.email === "string" ? v.email : null,
            picture: typeof v.picture === "string" ? v.picture : null,
        };
    }
    catch (_)
    {
        // getUserSetting throws when user-settings cache hasn't loaded yet.
        // Caller is expected to have awaited loadUserSettings() first.
        return null;
    }
}

/**
 * @param {GoogleProfile} profile
 * @returns {Promise<void>}
 */
export async function saveProfile(profile)
{
    if (_testBackend) return _testBackend.saveProfile(profile);
    await saveUserSettings({
        googleProfile: {
            permissionId: profile.sub || null,
            name: profile.name || null,
            email: profile.email || null,
            picture: profile.picture || null,
        },
    });
}

/** @returns {Promise<void>} */
export async function clearProfile()
{
    if (_testBackend) return _testBackend.clearProfile();
    await saveUserSettings({ googleProfile: null });
}

// ─────────────────────────────────────────────────────────────────────────
// Scope-version migration
// ─────────────────────────────────────────────────────────────────────────

/** @returns {number} */
export function loadScopeVersion()
{
    try
    {
        const v = getUserSetting("googleScopeVersion", 0);
        return Number.isFinite(v) ? Number(v) : 0;
    }
    catch (_)
    {
        // Cache not warm yet — return SCOPE_VERSION so migrateScopesIfNeeded
        // treats this as up-to-date and skips the clear path. A caller that
        // races ahead of loadUserSettings() must not be allowed to trigger
        // a spurious migration that wipes keyring tokens.
        return SCOPE_VERSION;
    }
}

/**
 * @param {number} v
 * @returns {Promise<void>}
 */
export async function saveScopeVersion(v)
{
    await saveUserSettings({ googleScopeVersion: v });
}

/**
 * One-shot scope migration — clears cached token + profile when
 * SCOPE_VERSION advances so the next signIn triggers a fresh consent
 * under the new scope set. Idempotent.
 *
 * Distinguishes three cases:
 *   1. Fresh install (no stored version, no stored token) → just record
 *      the current SCOPE_VERSION. NO clear (nothing to clear and clearing
 *      a freshly-written token would corrupt a sign-in race).
 *   2. Stale version (stored version < SCOPE_VERSION AND it was set to a
 *      non-zero prior value) → clear tokens + profile, bump version.
 *      This is the genuine migration case.
 *   3. Up-to-date (stored version >= SCOPE_VERSION) → no-op.
 *
 * Persists the new SCOPE_VERSION FIRST in case (2). If `clearToken` then
 * fails for any reason, the next boot still sees current == SCOPE_VERSION
 * and doesn't re-trigger. Trading "potentially stale tokens for one boot"
 * for "definitely doesn't wipe tokens every boot."
 *
 * Mirrors fps-auth.js `_migrateScopesIfNeeded` but harder against
 * persistence races on the desktop (file-based user-settings vs. Chrome's
 * chrome.storage.local).
 *
 * @returns {Promise<void>}
 */
export async function migrateScopesIfNeeded()
{
    // Tests stub the backend; bypass the user-settings touchpoints below so
    // the migration is a no-op when `_testBackend` is set. Production paths
    // are unchanged.
    if (_testBackend) return;
    try
    {
        const current = loadScopeVersion();
        if (current >= SCOPE_VERSION)
        {
            // Up-to-date — common steady-state path. No log to avoid noise.
            return;
        }

        // Case (1): Fresh install OR pre-versioning-era boot. If there's
        // no stored token AND current is 0 (the default fallback), just
        // seed the version without clearing anything.
        const hasStoredToken = await _peekHasStoredToken();
        if (current === 0 && !hasStoredToken)
        {
            await saveScopeVersion(SCOPE_VERSION);
            console.log("[mps:auth] scope version seeded", { to: SCOPE_VERSION });
            return;
        }

        // Case (2): Genuine migration — write the new version FIRST so a
        // subsequent clear failure doesn't loop us every boot.
        console.log("[mps:auth] scope migration starting", { from: current, to: SCOPE_VERSION });
        await saveScopeVersion(SCOPE_VERSION);
        await clearToken();
        await clearProfile();
        console.log("[mps:auth] scope migration complete", { from: current, to: SCOPE_VERSION });
    }
    catch (e)
    {
        console.warn("[mps:auth] scope migration failed:", e);
    }
}

/**
 * Best-effort probe for whether the keyring holds a token entry. Used
 * by migrateScopesIfNeeded to distinguish "fresh install" from
 * "pre-versioning-era user with a real token in keyring."
 *
 * Returns false on any failure — the caller treats false as "no token
 * worth preserving."
 *
 * @returns {Promise<boolean>}
 */
async function _peekHasStoredToken()
{
    try
    {
        const raw = await invoke("auth_token_store_get", {
            account: KEYRING_ACCOUNT_TOKEN,
        });
        return typeof raw === "string" && raw.length > 0;
    }
    catch (_)
    {
        return false;
    }
}
