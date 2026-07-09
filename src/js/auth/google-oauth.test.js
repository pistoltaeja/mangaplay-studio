// @ts-check
/**
 * google-oauth.test.js — Bun tests for the refresh / restore / sub
 * verification paths landed in TODO/AuthRefreshToken tickets 02-04, 08-09,
 * 12-13.
 *
 * The module under test has module-scope state and imports real Tauri
 * adapters, so the tests use the test-only seams declared in
 * `google-oauth.js` (`_testOnly`) and `storage.js`
 * (`_setStorageBackendForTest`) instead of `mock.module`. Each test resets
 * module state in `beforeEach` so order is irrelevant.
 *
 * Privacy + scope: NO production import of `_testOnly` is permitted —
 * verify with
 *   `grep -rn "_testOnly" mangaplay-studio/src --exclude="*.test.js"`.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { _testOnly, getAccessToken, ensureRehydrated } from "./google-oauth.js";
import { _setStorageBackendForTest } from "./storage.js";

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

/** Build a synthetic id_token (header.payload.signature, base64url). */
function makeIdToken(payload)
{
    const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.sig`;
}

/** Minimal Response-shaped object for the mocked fetch. */
function jsonResp(body, status = 200)
{
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** Install an EventTarget-backed stub window so _scheduleOnlineRetry can hook
 *  `window.addEventListener("online", ...)` without a full jsdom load. */
function installFakeWindow()
{
    const et = new EventTarget();
    const stub = {
        addEventListener: (type, handler) => et.addEventListener(type, handler),
        removeEventListener: (type, handler) => et.removeEventListener(type, handler),
        dispatchEvent: (ev) => et.dispatchEvent(ev),
    };
    globalThis.window = /** @type {any} */ (stub);
    return stub;
}

function uninstallFakeWindow()
{
    // @ts-ignore — delete is the only way to make `typeof window === "undefined"`
    delete globalThis.window;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-test scaffolding
// ─────────────────────────────────────────────────────────────────────────

let originalFetch;
/** @type {ReturnType<typeof mock>} */
let fetchMock;
let storageBackend;

beforeEach(() =>
{
    originalFetch = globalThis.fetch;

    // Default: any unstubbed fetch is a test bug — fail loud.
    fetchMock = mock(async (url) =>
    {
        throw new Error(`unexpected fetch in test: ${url}`);
    });
    globalThis.fetch = /** @type {any} */ (fetchMock);

    storageBackend = {
        token: /** @type {any} */ (null),
        profile: /** @type {any} */ (null),
        loadToken: async () => storageBackend.token,
        saveToken: async (blob) => { storageBackend.token = blob; },
        clearToken: async () => { storageBackend.token = null; },
        loadProfile: () => storageBackend.profile,
        saveProfile: async (p) => { storageBackend.profile = p; },
        clearProfile: async () => { storageBackend.profile = null; },
    };
    _setStorageBackendForTest(storageBackend);

    _testOnly.resetForTest();
});

afterEach(() =>
{
    globalThis.fetch = originalFetch;
    _setStorageBackendForTest(null);
    _testOnly.resetForTest();
    uninstallFakeWindow();
});

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe("_refreshViaBff — success path (test case 1)", () =>
{
    test("200 OK returns alive + caches token + persists new expiresAt", async () =>
    {
        storageBackend.token = {
            accessToken: "old-access",
            expiresAt: Date.now() - 1000,
            refreshToken: "rt-1",
            idToken: null,
        };

        const before = Date.now();
        fetchMock.mockImplementationOnce(async () => jsonResp({
            access_token: "new-access",
            expires_in: 3600,
            refresh_token: null,
            id_token: null,
        }));

        const result = await _testOnly.refreshViaBff();

        expect(fetchMock.mock.calls.length).toBe(1);
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toContain("/v2/oauth/refresh");
        expect(opts.method).toBe("POST");
        const body = JSON.parse(opts.body);
        expect(body.refresh_token).toBe("rt-1");

        expect(result.status).toBe("alive");
        expect(result.token).toBe("new-access");

        const s = _testOnly.getStateForTest();
        expect(s.cachedToken).toBe("new-access");
        expect(s.tokenExpiresAt).toBeGreaterThan(before);

        // Persisted blob keeps the old refresh_token (Google omitted rotation).
        expect(storageBackend.token.accessToken).toBe("new-access");
        expect(storageBackend.token.refreshToken).toBe("rt-1");
    });

    test("rotated refresh_token in response replaces the stored one", async () =>
    {
        storageBackend.token = {
            accessToken: "old-access",
            expiresAt: Date.now() - 1000,
            refreshToken: "rt-old",
            idToken: null,
        };

        fetchMock.mockImplementationOnce(async () => jsonResp({
            access_token: "new-access",
            expires_in: 3600,
            refresh_token: "rt-rotated",
            id_token: null,
        }));

        await _testOnly.refreshViaBff();

        expect(storageBackend.token.refreshToken).toBe("rt-rotated");
    });
});

describe("_refreshViaBff — invalid_grant (test case 2)", () =>
{
    test("400 invalid_grant clears storage + state + returns revoked", async () =>
    {
        storageBackend.token = {
            accessToken: "old-access",
            expiresAt: Date.now() - 1000,
            refreshToken: "rt-dead",
            idToken: null,
        };
        storageBackend.profile = { sub: "user-1", name: "Pete", email: "p@example.com", picture: null };
        _testOnly.setStateForTest({
            cachedToken: "old-access",
            tokenExpiresAt: Date.now() - 1000,
            lastSub: "user-1",
            lastName: "Pete",
            lastEmail: "p@example.com",
        });

        fetchMock.mockImplementationOnce(async () => jsonResp({ error: "invalid_grant" }, 400));

        // Observe auth-changed via the document dispatch — `document` may not
        // exist in Bun's default env, so subscribe via the stub when present
        // OR just verify state-clear side effects (covers the contract).
        const result = await _testOnly.refreshViaBff();

        expect(result.status).toBe("revoked");
        expect(result.token).toBeNull();

        const s = _testOnly.getStateForTest();
        expect(s.cachedToken).toBeNull();
        expect(s.tokenExpiresAt).toBeNull();
        expect(s.lastSub).toBeNull();
        expect(s.lastName).toBeNull();
        expect(s.lastEmail).toBeNull();
        expect(s.lastPicture).toBeNull();

        expect(storageBackend.token).toBeNull();
        expect(storageBackend.profile).toBeNull();
    });

    test("400 with non-invalid_grant error preserves storage (treated offline)", async () =>
    {
        storageBackend.token = {
            accessToken: "old-access",
            expiresAt: Date.now() - 1000,
            refreshToken: "rt",
            idToken: null,
        };

        fetchMock.mockImplementationOnce(async () => jsonResp({ error: "server_error" }, 400));

        const result = await _testOnly.refreshViaBff();

        expect(result.status).toBe("offline");
        expect(result.token).toBeNull();
        expect(storageBackend.token).not.toBeNull();
        expect(storageBackend.token.refreshToken).toBe("rt");
    });
});

describe("Single-flight (test cases 3 + 4)", () =>
{
    test("5 concurrent getAccessToken calls share one BFF round-trip", async () =>
    {
        // Boot with empty storage so ensureRehydrated does NOT fire its
        // probe (no session to restore). After rehydrate is cached, seed
        // storage with an expired token + refresh_token so getAccessToken's
        // first caller triggers exactly one POST and the other four share.
        await ensureRehydrated();

        storageBackend.token = {
            accessToken: "old",
            expiresAt: Date.now() - 1000,
            refreshToken: "rt-shared",
            idToken: null,
        };
        _testOnly.setStateForTest({
            cachedToken: "old",
            tokenExpiresAt: Date.now() - 1000,
        });

        // Stall fetch resolution until the test allows it — every concurrent
        // getAccessToken caller must reach the single-flight gate before the
        // first one's promise resolves.
        let releaseFetch;
        const gate = new Promise((res) => { releaseFetch = res; });
        fetchMock.mockImplementationOnce(async () =>
        {
            await gate;
            return jsonResp({
                access_token: "fresh",
                expires_in: 3600,
                refresh_token: null,
                id_token: null,
            });
        });

        const pending = [
            getAccessToken(),
            getAccessToken(),
            getAccessToken(),
            getAccessToken(),
            getAccessToken(),
        ];

        // Let every caller register with _refreshInFlight before unblocking.
        await new Promise((r) => setTimeout(r, 5));
        releaseFetch();

        const results = await Promise.all(pending);

        expect(fetchMock.mock.calls.length).toBe(1);
        for (const t of results) expect(t).toBe("fresh");
    });

    test("boot probe + concurrent getAccessToken share one round-trip", async () =>
    {
        storageBackend.token = {
            accessToken: "old",
            expiresAt: Date.now() - 1000,
            refreshToken: "rt-shared",
            idToken: null,
        };

        let releaseFetch;
        const gate = new Promise((res) => { releaseFetch = res; });
        fetchMock.mockImplementationOnce(async () =>
        {
            await gate;
            return jsonResp({
                access_token: "fresh-boot",
                expires_in: 3600,
                refresh_token: null,
                id_token: null,
            });
        });

        const boot = ensureRehydrated();
        const tokenP = getAccessToken();

        await new Promise((r) => setTimeout(r, 5));
        releaseFetch();

        await boot;
        const token = await tokenP;

        expect(fetchMock.mock.calls.length).toBe(1);
        expect(token).toBe("fresh-boot");
        expect(_testOnly.getStateForTest().cachedToken).toBe("fresh-boot");
    });
});

describe("Backward compat — old TokenBlob without refreshToken (test case 5)", () =>
{
    test("_refreshViaBff returns no_refresh_token + does NOT touch storage", async () =>
    {
        storageBackend.token = {
            accessToken: "legacy",
            expiresAt: Date.now() + 30_000,
            refreshToken: null,
            idToken: null,
        };

        const result = await _testOnly.refreshViaBff();

        expect(result.status).toBe("no_refresh_token");
        expect(result.token).toBeNull();
        expect(fetchMock.mock.calls.length).toBe(0);
        expect(storageBackend.token).not.toBeNull();
        expect(storageBackend.token.accessToken).toBe("legacy");
    });

    test("getAccessToken returns null when storage has no refresh_token AND no live access token", async () =>
    {
        storageBackend.token = {
            accessToken: "legacy",
            expiresAt: Date.now() - 1000, // already expired
            refreshToken: null,
            idToken: null,
        };

        // Ensure cache is in sync with storage (rehydrate would mirror it).
        _testOnly.setStateForTest({
            cachedToken: "legacy",
            tokenExpiresAt: Date.now() - 1000,
        });

        const token = await getAccessToken();

        expect(token).toBeNull();
        expect(fetchMock.mock.calls.length).toBe(0);
        // Storage is untouched — caller routes to interactive sign-in.
        expect(storageBackend.token).not.toBeNull();
    });
});

describe("Expiry margin (test case 6)", () =>
{
    test("at 58 min (>60s remaining) getAccessToken returns cached, no refresh", async () =>
    {
        const now = Date.now();
        const expiresAt = now + (2 * 60_000); // 2 min remaining

        storageBackend.token = {
            accessToken: "cached",
            expiresAt,
            refreshToken: "rt",
            idToken: null,
        };
        _testOnly.setStateForTest({
            cachedToken: "cached",
            tokenExpiresAt: expiresAt,
        });

        const token = await getAccessToken();

        expect(token).toBe("cached");
        expect(fetchMock.mock.calls.length).toBe(0);
    });

    test("at 59m1s (inside margin) refresh fires from getAccessToken", async () =>
    {
        const now = Date.now();
        const expiresAt = now + 30_000;

        // No storage refresh-token-driven rehydrate path: token valid in cache,
        // but tipped over the margin once we set it to stale. Achieve that
        // by first running rehydrate with a still-valid token, then manually
        // tipping cached state.
        storageBackend.token = {
            accessToken: "stale",
            expiresAt: now + (5 * 60_000), // valid for 5 min → boot probe skipped
            refreshToken: "rt",
            idToken: null,
        };
        await ensureRehydrated();

        // Now tip the cache + storage into the margin window.
        storageBackend.token.expiresAt = expiresAt;
        _testOnly.setStateForTest({
            cachedToken: "stale",
            tokenExpiresAt: expiresAt,
        });

        fetchMock.mockImplementationOnce(async () => jsonResp({
            access_token: "refreshed",
            expires_in: 3600,
            refresh_token: null,
            id_token: null,
        }));

        const token = await getAccessToken();

        expect(token).toBe("refreshed");
        expect(fetchMock.mock.calls.length).toBe(1);
    });
});

describe("id_token.sub mismatch (test case 7)", () =>
{
    test("sub mismatch on refresh clears storage + returns revoked", async () =>
    {
        storageBackend.token = {
            accessToken: "old",
            expiresAt: Date.now() - 1000,
            refreshToken: "rt",
            idToken: null,
        };
        storageBackend.profile = { sub: "alice", name: "Alice", email: null, picture: null };

        _testOnly.setStateForTest({
            cachedToken: "old",
            tokenExpiresAt: Date.now() - 1000,
            lastSub: "alice",
            lastName: "Alice",
        });

        const bobIdToken = makeIdToken({ sub: "bob", aud: "test", iss: "test" });

        fetchMock.mockImplementationOnce(async () => jsonResp({
            access_token: "would-be-new",
            expires_in: 3600,
            refresh_token: null,
            id_token: bobIdToken,
        }));

        const result = await _testOnly.refreshViaBff();

        expect(result.status).toBe("revoked");
        expect(result.token).toBeNull();

        // Storage + state both cleared via _clearSessionState.
        expect(storageBackend.token).toBeNull();
        expect(storageBackend.profile).toBeNull();
        const s = _testOnly.getStateForTest();
        expect(s.cachedToken).toBeNull();
        expect(s.lastSub).toBeNull();
    });

    test("sub match on refresh succeeds + keeps id_token", async () =>
    {
        storageBackend.token = {
            accessToken: "old",
            expiresAt: Date.now() - 1000,
            refreshToken: "rt",
            idToken: null,
        };
        _testOnly.setStateForTest({ lastSub: "alice" });

        const aliceIdToken = makeIdToken({ sub: "alice" });

        fetchMock.mockImplementationOnce(async () => jsonResp({
            access_token: "new",
            expires_in: 3600,
            refresh_token: null,
            id_token: aliceIdToken,
        }));

        const result = await _testOnly.refreshViaBff();

        expect(result.status).toBe("alive");
        expect(result.token).toBe("new");
        expect(storageBackend.token.idToken).toBe(aliceIdToken);
    });
});

describe("Network error during boot probe (test case 8)", () =>
{
    test("TypeError sets _isBootOffline=true + storage preserved + online retries", async () =>
    {
        const win = installFakeWindow();

        storageBackend.token = {
            accessToken: "stored",
            expiresAt: Date.now() - 1000,
            refreshToken: "rt-keep",
            idToken: null,
        };

        // First call — network failure.
        fetchMock.mockImplementationOnce(async () => { throw new TypeError("Failed to fetch"); });

        await ensureRehydrated();

        expect(_testOnly.getStateForTest().isBootOffline).toBe(true);
        // Storage MUST still hold the refresh token.
        expect(storageBackend.token).not.toBeNull();
        expect(storageBackend.token.refreshToken).toBe("rt-keep");
        expect(_testOnly.getStateForTest().hasOnlineRetryDetach).toBe(true);

        // Second call — succeeds.
        fetchMock.mockImplementationOnce(async () => jsonResp({
            access_token: "online-recovered",
            expires_in: 3600,
            refresh_token: null,
            id_token: null,
        }));

        win.dispatchEvent(new Event("online"));

        // Allow the handler's async chain to settle.
        await new Promise((r) => setTimeout(r, 10));

        expect(fetchMock.mock.calls.length).toBe(2);
        const sFinal = _testOnly.getStateForTest();
        expect(sFinal.isBootOffline).toBe(false);
        expect(sFinal.cachedToken).toBe("online-recovered");
        expect(sFinal.hasOnlineRetryDetach).toBe(false);
    });

    test("BFF 5xx during probe is also treated as offline (storage preserved)", async () =>
    {
        installFakeWindow();

        storageBackend.token = {
            accessToken: "stored",
            expiresAt: Date.now() - 1000,
            refreshToken: "rt-keep",
            idToken: null,
        };

        fetchMock.mockImplementationOnce(async () => jsonResp({ error: "server_error" }, 503));

        await ensureRehydrated();

        expect(_testOnly.getStateForTest().isBootOffline).toBe(true);
        expect(storageBackend.token).not.toBeNull();
        expect(storageBackend.token.refreshToken).toBe("rt-keep");
    });
});

describe("_extractIdTokenSub", () =>
{
    test("parses sub from a base64url JWT payload", () =>
    {
        const tok = makeIdToken({ sub: "1234567890", iss: "google" });
        expect(_testOnly.extractIdTokenSub(tok)).toBe("1234567890");
    });

    test("returns null for malformed token", () =>
    {
        expect(_testOnly.extractIdTokenSub("not-a-jwt")).toBeNull();
        expect(_testOnly.extractIdTokenSub("a.b")).toBeNull();
        expect(_testOnly.extractIdTokenSub("a.@@@.c")).toBeNull();
    });

    test("returns null when sub is missing or non-string", () =>
    {
        expect(_testOnly.extractIdTokenSub(makeIdToken({ foo: "bar" }))).toBeNull();
        expect(_testOnly.extractIdTokenSub(makeIdToken({ sub: 12345 }))).toBeNull();
    });
});
