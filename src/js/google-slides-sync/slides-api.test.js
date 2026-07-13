/**
 * Unit tests for slides-api.js.
 *
 * NOTE — this test file is not wired into the harness `bun run test` script;
 * it's invoked directly as `bun test ./src/js/google-slides-sync/slides-api.test.js`
 * as agreed for isolated files during initial development.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
    batchUpdatePresentation,
    getPresentation,
    getPresentationForRefresh,
    isPresentationStale,
} from "./slides-api.js";

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Build a minimal `Response`-shaped stub. Bun's global `Response` works too,
 * but this keeps the test surface completely predictable.
 * @param {number} status
 * @param {object} [body]
 * @returns {{ status: number, json: () => Promise<object> }}
 */
function fakeResponse(status, body = {})
{
    return {
        status,
        json: async () => body,
    };
}

/**
 * Wire a scripted sequence of fetch outcomes. Each entry is either:
 *   - A function `() => any` — return value (Promise or value) is passed
 *     through to the caller. `throw` inside the fn simulates fetch failure.
 *   - Any other value — returned as-is (fetch resolves with it).
 * @param {Array<Function | unknown>} script
 * @returns {{ fetch: (url: string, init?: object) => Promise<unknown>, calls: Array<{ url: string, init: object | undefined }> }}
 */
function scriptedFetch(script)
{
    /** @type {Array<{ url: string, init: object | undefined }>} */
    const calls = [];
    let i = 0;
    return {
        calls,
        fetch: async (url, init) =>
        {
            calls.push({ url, init });
            if (i >= script.length)
            {
                throw new Error(`scriptedFetch: no more responses (call #${i + 1})`);
            }
            const step = script[i++];
            if (typeof step === "function")
            {
                return step();
            }
            return step;
        },
    };
}

describe("getPresentation", () =>
{
    /** @type {ReturnType<typeof scriptedFetch> | null} */
    let mock = null;

    beforeEach(() =>
    {
        mock = null;
    });

    afterEach(() =>
    {
        globalThis.fetch = ORIGINAL_FETCH;
    });

    test("200 → resolves with presentation and truthy refreshedAt", async () =>
    {
        mock = scriptedFetch([fakeResponse(200, { presentationId: "abc", title: "Deck" })]);
        globalThis.fetch = /** @type {any} */ (mock.fetch);

        const before = Date.now();
        const result = await getPresentation("abc", "tok");
        const after = Date.now();

        expect(result.presentation).toEqual({ presentationId: "abc", title: "Deck" });
        expect(result.refreshedAt).toBeGreaterThanOrEqual(before);
        expect(result.refreshedAt).toBeLessThanOrEqual(after);
        expect(mock.calls.length).toBe(1);
        expect(mock.calls[0].url).toBe("https://slides.googleapis.com/v1/presentations/abc");
        const headers = /** @type {any} */ (mock.calls[0].init).headers;
        expect(headers.Authorization).toBe("Bearer tok");
    });

    test("401 → throws kind:auth without retry", async () =>
    {
        mock = scriptedFetch([fakeResponse(401)]);
        globalThis.fetch = /** @type {any} */ (mock.fetch);

        let caught;
        try { await getPresentation("abc", "tok"); }
        catch (e) { caught = e; }

        expect(caught).toBeInstanceOf(Error);
        expect(/** @type {any} */ (caught).kind).toBe("auth");
        expect(mock.calls.length).toBe(1);
    });

    test("403 → throws kind:no-access without retry", async () =>
    {
        mock = scriptedFetch([fakeResponse(403)]);
        globalThis.fetch = /** @type {any} */ (mock.fetch);

        let caught;
        try { await getPresentation("abc", "tok"); }
        catch (e) { caught = e; }

        expect(/** @type {any} */ (caught).kind).toBe("no-access");
        expect(mock.calls.length).toBe(1);
    });

    test("404 → throws kind:not-found without retry", async () =>
    {
        mock = scriptedFetch([fakeResponse(404)]);
        globalThis.fetch = /** @type {any} */ (mock.fetch);

        let caught;
        try { await getPresentation("abc", "tok"); }
        catch (e) { caught = e; }

        expect(/** @type {any} */ (caught).kind).toBe("not-found");
        expect(mock.calls.length).toBe(1);
    });

    test("500 twice then 200 → succeeds on third try", async () =>
    {
        mock = scriptedFetch([
            fakeResponse(500),
            fakeResponse(503),
            fakeResponse(200, { presentationId: "xyz" }),
        ]);
        globalThis.fetch = /** @type {any} */ (mock.fetch);

        const result = await getPresentation("xyz", "tok");
        expect(result.presentation).toEqual({ presentationId: "xyz" });
        expect(mock.calls.length).toBe(3);
    });

    test("persistent 500 → throws kind:http after 3 attempts", async () =>
    {
        mock = scriptedFetch([
            fakeResponse(500),
            fakeResponse(500),
            fakeResponse(500),
        ]);
        globalThis.fetch = /** @type {any} */ (mock.fetch);

        let caught;
        try { await getPresentation("abc", "tok"); }
        catch (e) { caught = e; }

        expect(/** @type {any} */ (caught).kind).toBe("http");
        expect(mock.calls.length).toBe(3);
    });

    test("network TypeError → retries then throws kind:network", async () =>
    {
        mock = scriptedFetch([
            () => { throw new TypeError("fetch failed"); },
            () => { throw new TypeError("fetch failed"); },
            () => { throw new TypeError("fetch failed"); },
        ]);
        globalThis.fetch = /** @type {any} */ (mock.fetch);

        let caught;
        try { await getPresentation("abc", "tok"); }
        catch (e) { caught = e; }

        expect(/** @type {any} */ (caught).kind).toBe("network");
        expect(mock.calls.length).toBe(3);
    });

    test("getPresentationForRefresh is currently an alias — same behaviour", async () =>
    {
        mock = scriptedFetch([fakeResponse(200, { presentationId: "same" })]);
        globalThis.fetch = /** @type {any} */ (mock.fetch);

        const result = await getPresentationForRefresh("same", "tok");
        expect(result.presentation).toEqual({ presentationId: "same" });
        expect(mock.calls.length).toBe(1);
    });
});

describe("isPresentationStale", () =>
{
    test("fresh timestamp is not stale", () =>
    {
        expect(isPresentationStale(Date.now())).toBe(false);
        expect(isPresentationStale(Date.now() - 60_000)).toBe(false);
    });

    test("timestamp from 21 minutes ago IS stale (default threshold 20 min)", () =>
    {
        const twentyOneMinAgo = Date.now() - 21 * 60 * 1000;
        expect(isPresentationStale(twentyOneMinAgo)).toBe(true);
    });

    test("explicit maxAgeMs override works", () =>
    {
        const tenSecAgo = Date.now() - 10_000;
        expect(isPresentationStale(tenSecAgo, 5_000)).toBe(true);
        expect(isPresentationStale(tenSecAgo, 60_000)).toBe(false);
    });
});

describe("batchUpdatePresentation", () =>
{
    afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

    test("200 → resolves with replies + presentationId", async () =>
    {
        /** @type {Array<{ url: string, init: any }>} */
        const calls = [];
        globalThis.fetch = async (url, init) =>
        {
            calls.push({ url: String(url), init });
            return fakeResponse(200, {
                presentationId: "abc",
                replies: [{}, {}],
            });
        };
        const out = await batchUpdatePresentation(
            "abc",
            [{ deleteText: { objectId: "s1", textRange: { type: "ALL" } } }],
            "tok",
        );
        expect(out.presentationId).toBe("abc");
        expect(out.replies.length).toBe(2);
        expect(calls.length).toBe(1);
        expect(calls[0].url.endsWith(":batchUpdate")).toBe(true);
        expect(calls[0].init.method).toBe("POST");
        expect(calls[0].init.headers.Authorization).toBe("Bearer tok");
        expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
        // Body serialises the requests array.
        const body = JSON.parse(calls[0].init.body);
        expect(Array.isArray(body.requests)).toBe(true);
        expect(body.requests.length).toBe(1);
    });

    test("401 → auth kind", async () =>
    {
        globalThis.fetch = async () => fakeResponse(401);
        await expect(batchUpdatePresentation("abc", [], "tok"))
            .rejects.toMatchObject({ kind: "auth" });
    });

    test("403 → no-access kind", async () =>
    {
        globalThis.fetch = async () => fakeResponse(403);
        await expect(batchUpdatePresentation("abc", [], "tok"))
            .rejects.toMatchObject({ kind: "no-access" });
    });

    test("404 → not-found kind", async () =>
    {
        globalThis.fetch = async () => fakeResponse(404);
        await expect(batchUpdatePresentation("abc", [], "tok"))
            .rejects.toMatchObject({ kind: "not-found" });
    });

    test("500 → http kind", async () =>
    {
        globalThis.fetch = async () => fakeResponse(500);
        await expect(batchUpdatePresentation("abc", [], "tok"))
            .rejects.toMatchObject({ kind: "http" });
    });

    test("fetch throws → network kind", async () =>
    {
        globalThis.fetch = async () => { throw new TypeError("offline"); };
        await expect(batchUpdatePresentation("abc", [], "tok"))
            .rejects.toMatchObject({ kind: "network" });
    });
});
