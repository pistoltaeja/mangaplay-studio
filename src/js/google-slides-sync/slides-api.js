/**
 * Mangaplay Studio — Google Slides REST wrapper for the sync-existing-slides
 * preparation flow.
 *
 * Pure `fetch` + logic. NO imports from `mangaplay-studio/src/`. NO Tauri
 * `invoke` calls. The orchestrator wires this into the modal separately.
 *
 * Error `kind` taxonomy mirrors the `_accessCheck` classifier in
 * `publish-slides-modal.js` so the modal's existing error surface can
 * consume both transports uniformly:
 *
 *   - "auth"       — 401 (token expired / invalid). No retry.
 *   - "no-access"  — 403 (grant not landed for this file). No retry.
 *   - "not-found"  — 404 (wrong id / deleted). No retry.
 *   - "network"    — fetch itself threw (offline, DNS, aborted mid-flight,
 *                    or a bare `TypeError` from the platform).
 *   - "http"       — non-2xx that wasn't 401/403/404; also the terminal
 *                    class after retry exhaustion on 5xx.
 */

const SLIDES_API_BASE = "https://slides.googleapis.com/v1/presentations";

/** Per-request timeout for `presentations.get`. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Max attempts including the initial call (so 1 + 2 retries = 3 total). */
const MAX_ATTEMPTS = 3;

/**
 * Exponential backoff schedule between attempts, in milliseconds. Index 0 is
 * the pause BEFORE attempt #2 (the first retry). Length must be
 * `MAX_ATTEMPTS - 1`.
 */
const BACKOFF_MS = [500, 1000, 2000];

/** Freshness threshold for `isPresentationStale`. 20 minutes. */
const DEFAULT_MAX_AGE_MS = 20 * 60 * 1000;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms)
{
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build an Error with a `.kind` tag matching the `_accessCheck` convention.
 * @param {string} message
 * @param {"auth" | "not-found" | "no-access" | "network" | "http"} kind
 * @returns {Error & { kind: string }}
 */
function makeKindError(message, kind)
{
    const err = /** @type {Error & { kind: string }} */ (new Error(message));
    err.kind = kind;
    return err;
}

/**
 * Perform a single `presentations.get` call with a hard per-request timeout.
 *
 * Classifies the outcome as either:
 *   - `{ ok: true, presentation, refreshedAt }` on 2xx.
 *   - Throws a `.kind`-tagged Error on any non-2xx or transport failure.
 *
 * `refreshedAt` is captured AFTER the response body parses successfully so
 * the caller's staleness math is based on the moment fresh JSON was in hand,
 * not the moment the request left the wire.
 *
 * @param {string} id
 * @param {string} token
 * @returns {Promise<{ presentation: Record<string, unknown>, refreshedAt: number }>}
 */
async function requestOnce(id, token)
{
    const url = `${SLIDES_API_BASE}/${encodeURIComponent(id)}`;

    let response;
    try
    {
        response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    }
    catch (e)
    {
        // Fetch itself threw — offline, DNS, timeout abort, TypeError.
        // The retry wrapper decides whether to try again.
        const msg = e instanceof Error ? e.message : String(e);
        throw makeKindError(`network: ${msg}`, "network");
    }

    if (response.status === 401)
    {
        throw makeKindError("http-401", "auth");
    }
    if (response.status === 403)
    {
        throw makeKindError("http-403", "no-access");
    }
    if (response.status === 404)
    {
        throw makeKindError("http-404", "not-found");
    }
    if (!(response.status >= 200 && response.status < 300))
    {
        throw makeKindError(`http-${response.status}`, "http");
    }

    const presentation = /** @type {Record<string, unknown>} */ (await response.json());
    const refreshedAt = Date.now();
    return { presentation, refreshedAt };
}

/**
 * Whether a caught error should trigger a retry attempt.
 *
 * Retry ONLY on:
 *   - "network" (fetch threw — offline, DNS, TypeError, mid-flight abort).
 *   - "http" (non-2xx that wasn't 401/403/404 — practically the 5xx band).
 *
 * Never retry on "auth" / "no-access" / "not-found" — those are terminal
 * user-facing conditions that no amount of backoff will change.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
function isRetryable(e)
{
    if (!e || typeof e !== "object") return false;
    const kind = /** @type {{ kind?: string }} */ (e).kind;
    return kind === "network" || kind === "http";
}

/**
 * Fetch a Google Slides presentation by id.
 *
 * `AbortSignal.timeout(30_000)` per request. Up to `MAX_ATTEMPTS` total
 * attempts (1 initial + 2 retries), with exponential backoff of
 * 500ms → 1000ms → 2000ms between them. Retries only on 5xx / network /
 * `TypeError`. 4xx surfaces immediately with the corresponding `.kind`.
 *
 * `refreshedAt` is a `Date.now()` millis timestamp captured at the moment
 * the successful response body was parsed. Callers use this with
 * `isPresentationStale()` to gate later work (e.g. download batches).
 *
 * @param {string} id
 * @param {string} token
 * @returns {Promise<{ presentation: Record<string, unknown>, refreshedAt: number }>}
 * @throws {Error & { kind: "auth" | "not-found" | "no-access" | "network" | "http" }}
 */
export async function getPresentation(id, token)
{
    /** @type {unknown} */
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)
    {
        try
        {
            return await requestOnce(id, token);
        }
        catch (e)
        {
            lastErr = e;
            if (!isRetryable(e) || attempt >= MAX_ATTEMPTS)
            {
                throw e;
            }
            await sleep(BACKOFF_MS[attempt - 1]);
        }
    }
    // Unreachable — loop either returns or throws.
    throw lastErr;
}

/**
 * Fetch a Slides presentation bypassing any caller-side memoisation.
 *
 * TODAY this is a straight alias for `getPresentation` — there is no
 * memoisation layer YET, so both names hit the network on every call.
 * Callers should nevertheless use `getPresentationForRefresh` whenever they
 * explicitly need bypass semantics (e.g. after a `contentUrl` 403's mid-batch
 * and every remaining page needs fresh short-lived URLs). When memoisation
 * lands, `getPresentation` will start returning cached hits and
 * `getPresentationForRefresh` will remain a forced round-trip. The two names
 * are the API contract for that future split.
 *
 * @param {string} id
 * @param {string} token
 * @returns {Promise<{ presentation: Record<string, unknown>, refreshedAt: number }>}
 * @throws {Error & { kind: "auth" | "not-found" | "no-access" | "network" | "http" }}
 */
export async function getPresentationForRefresh(id, token)
{
    return getPresentation(id, token);
}

/**
 * POST `presentations.batchUpdate` for a Google Slides presentation.
 *
 * Same origin + auth as `getPresentation` — the JS-side transport is the
 * canonical path for text-write requests (`deleteText` + `insertText` per
 * paired page). The old Rust `slides_update_page_text` stub is gone; this
 * function is the sole entry point.
 *
 * Single hard-timeout attempt — no retry loop. Text writes are idempotent
 * enough (deleteText + insertText produce the same final content on retry)
 * that a caller-driven "run step 2 again" is the right recovery model, not
 * a silent in-request retry that could double-apply on a mid-flight
 * response drop.
 *
 * @param {string} presentationId
 * @param {Array<Record<string, unknown>>} requests — Slides API request
 *   objects (e.g. `{ deleteText: { objectId, textRange: { type: "ALL" } } }`,
 *   `{ insertText: { objectId, text, insertionIndex: 0 } }`).
 * @param {string} token
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ presentationId: string, replies: Array<Record<string, unknown>> }>}
 * @throws {Error & { kind: "auth" | "not-found" | "no-access" | "network" | "http" }}
 */
export async function batchUpdatePresentation(presentationId, requests, token, opts)
{
    const url = `${SLIDES_API_BASE}/${encodeURIComponent(presentationId)}:batchUpdate`;
    const body = JSON.stringify({ requests });

    // Compose our timeout signal with any caller-supplied AbortSignal so
    // the caller can cancel independently.
    const timeoutSig = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    /** @type {AbortSignal} */
    let signal = timeoutSig;
    if (opts && opts.signal)
    {
        // `AbortSignal.any` lands broadly; Node/Bun 1.x has it.
        if (typeof (/** @type {any} */ (AbortSignal).any) === "function")
        {
            signal = /** @type {any} */ (AbortSignal).any([timeoutSig, opts.signal]);
        }
        else
        {
            // Fallback: if the caller's signal aborts, we abort a
            // synthetic controller wired into the fetch.
            const ctrl = new AbortController();
            const onCallerAbort = () => ctrl.abort();
            const onTimeout = () => ctrl.abort();
            opts.signal.addEventListener("abort", onCallerAbort, { once: true });
            timeoutSig.addEventListener("abort", onTimeout, { once: true });
            signal = ctrl.signal;
        }
    }

    let response;
    try
    {
        response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type":  "application/json",
            },
            body,
            signal,
        });
    }
    catch (e)
    {
        const msg = e instanceof Error ? e.message : String(e);
        throw makeKindError(`network: ${msg}`, "network");
    }

    if (response.status === 401)
    {
        throw makeKindError("http-401", "auth");
    }
    if (response.status === 403)
    {
        throw makeKindError("http-403", "no-access");
    }
    if (response.status === 404)
    {
        throw makeKindError("http-404", "not-found");
    }
    if (!(response.status >= 200 && response.status < 300))
    {
        throw makeKindError(`http-${response.status}`, "http");
    }

    const payload = /** @type {any} */ (await response.json());
    return {
        presentationId: String(payload?.presentationId || presentationId),
        replies: Array.isArray(payload?.replies) ? payload.replies : [],
    };
}

/**
 * Whether a `refreshedAt` timestamp is older than `maxAgeMs`.
 *
 * The orchestrator uses this before starting a download batch: if the
 * initial `presentations.get` result is older than 20 minutes, the
 * short-lived `contentUrl` values it contained are close to expiry (or
 * already gone) and a fresh fetch is forced first.
 *
 * Pure function; safe to call anywhere.
 *
 * @param {number} refreshedAt — millis (JS `Date.now()`).
 * @param {number} [maxAgeMs] — defaults to 20 minutes.
 * @returns {boolean}
 */
export function isPresentationStale(refreshedAt, maxAgeMs = DEFAULT_MAX_AGE_MS)
{
    return Date.now() - refreshedAt > maxAgeMs;
}
