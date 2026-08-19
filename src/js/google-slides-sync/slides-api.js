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
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ presentationId: string, replies: Array<Record<string, unknown>> }>}
 * @throws {Error & { kind: "auth" | "not-found" | "no-access" | "network" | "http" }}
 */
export async function batchUpdatePresentation(presentationId, requests, token, opts)
{
    const url = `${SLIDES_API_BASE}/${encodeURIComponent(presentationId)}:batchUpdate`;
    const body = JSON.stringify({ requests });
    const fetchImpl = (opts && opts.fetchImpl) || globalThis.fetch;

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
        response = await fetchImpl(url, {
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

// ── Drive REST helpers (used by the JS upload transport) ─────────────────
//
// These three helpers implement the Drive-side surface needed to push PNG
// bytes into Google Slides via the JS upload transport in
// `slides-upload-transport.js`. Kept here so the low-level HTTP shape is
// unit-testable in isolation with the same mock-fetch pattern used by
// `getPresentation` / `batchUpdatePresentation`.
//
// See also `src-tauri/src/commands/slides_upload.rs`, whose docstring
// records that the Rust-side upload path is intentionally deferred; the
// JS transport is the canonical implementation.

/** Drive upload / metadata / permission endpoints. */
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

/**
 * Build the multipart/related body for a Drive multipart upload.
 *
 * Two-part payload: JSON metadata (`Content-Type: application/json; charset=UTF-8`)
 * followed by the raw PNG bytes (`Content-Type: image/png`). Boundary is a
 * 32-char hex string.
 *
 * Exported for unit tests; not part of the module's public surface.
 *
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @returns {{ boundary: string, body: Blob }}
 */
export function _buildDriveMultipartBody(bytes, filename)
{
    // 32-char hex boundary is unambiguous against PNG magic bytes and JSON.
    let boundary = "";
    for (let i = 0; i < 4; i++)
    {
        boundary += Math.random().toString(16).slice(2, 10);
    }
    boundary = `mps_${boundary}`;

    const metadata = JSON.stringify({ name: filename, mimeType: "image/png" });
    const encoder = new TextEncoder();

    const header = encoder.encode(
        `--${boundary}\r\n`
        + "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        + `${metadata}\r\n`
        + `--${boundary}\r\n`
        + "Content-Type: image/png\r\n"
        + "Content-Transfer-Encoding: binary\r\n\r\n",
    );
    const footer = encoder.encode(`\r\n--${boundary}--`);

    // Blob composes without an intermediate contiguous buffer.
    const body = new Blob([header, bytes, footer], {
        type: `multipart/related; boundary=${boundary}`,
    });

    return { boundary, body };
}

/**
 * Backoff schedule (ms) reused for Drive upload + permission retries.
 * Same shape as `getPresentation`'s policy: retry only on network / 5xx / 429.
 */
const DRIVE_RETRY_BACKOFF_MS = [500, 1000, 2000];

/**
 * Whether a Drive error should trigger a retry attempt.
 *
 * Retry on:
 *   - `network` (fetch itself threw)
 *   - `http` (non-2xx that wasn't 401/403/404, i.e. 5xx or 429)
 *
 * 429 lands as `http` per the `getPresentation` classifier — the retry
 * policy already treats it correctly.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
function _isDriveRetryable(e)
{
    if (!e || typeof e !== "object") return false;
    const kind = /** @type {{ kind?: string }} */ (e).kind;
    return kind === "network" || kind === "http";
}

/**
 * Upload a PNG to the user's Google Drive using multipart upload.
 *
 * Retry policy: up to 3 attempts (500ms / 1s / 2s backoff) on network /
 * 5xx / 429. 401 / 403 / 404 surface immediately with the corresponding
 * `.kind` so the error classifier can route them.
 *
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @param {string} token
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ id: string }>}
 * @throws {Error & { kind: "auth" | "not-found" | "no-access" | "network" | "http" }}
 */
export async function driveUploadPng(bytes, filename, token, opts)
{
    const fetchImpl = (opts && opts.fetchImpl) || globalThis.fetch;
    const signal = opts && opts.signal ? opts.signal : undefined;

    /** @type {unknown} */
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)
    {
        // Build a fresh body per attempt — the Blob is single-consumption
        // in some fetch implementations after abort.
        const { body } = _buildDriveMultipartBody(bytes, filename);

        let response;
        try
        {
            response = await fetchImpl(DRIVE_UPLOAD_URL, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${token}`,
                    // Content-Type is set by the Blob (includes the boundary).
                },
                body,
                signal,
            });
        }
        catch (e)
        {
            lastErr = makeKindError(
                `network: ${e instanceof Error ? e.message : String(e)}`,
                "network",
            );
            if (!_isDriveRetryable(lastErr) || attempt >= MAX_ATTEMPTS) throw lastErr;
            await sleep(DRIVE_RETRY_BACKOFF_MS[attempt - 1]);
            continue;
        }

        if (response.status === 401) throw makeKindError("http-401", "auth");
        if (response.status === 403) throw makeKindError("http-403", "no-access");
        if (response.status === 404) throw makeKindError("http-404", "not-found");

        if (response.status >= 200 && response.status < 300)
        {
            const payload = /** @type {any} */ (await response.json());
            const id = payload && typeof payload.id === "string" ? payload.id : "";
            if (!id) throw makeKindError("drive-upload: missing id", "http");
            return { id };
        }

        // 5xx / 429 / other non-2xx → retry class.
        lastErr = makeKindError(`http-${response.status}`, "http");
        if (!_isDriveRetryable(lastErr) || attempt >= MAX_ATTEMPTS) throw lastErr;
        await sleep(DRIVE_RETRY_BACKOFF_MS[attempt - 1]);
    }
    // Unreachable — loop either returns or throws.
    throw lastErr;
}

/**
 * Set a Drive file's permissions so anyone can read it.
 *
 * Required so the Slides API can fetch
 * `https://drive.google.com/uc?id=<id>&export=download` server-side when
 * resolving `createImage.url` / `replaceImage.url`. Same retry policy as
 * `driveUploadPng`.
 *
 * @param {string} fileId
 * @param {string} token
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<void>}
 * @throws {Error & { kind: "auth" | "not-found" | "no-access" | "network" | "http" }}
 */
export async function drivePermissionAnyoneReader(fileId, token, opts)
{
    const fetchImpl = (opts && opts.fetchImpl) || globalThis.fetch;
    const signal = opts && opts.signal ? opts.signal : undefined;
    const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/permissions`;
    const body = JSON.stringify({ role: "reader", type: "anyone" });

    /** @type {unknown} */
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)
    {
        let response;
        try
        {
            response = await fetchImpl(url, {
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
            lastErr = makeKindError(
                `network: ${e instanceof Error ? e.message : String(e)}`,
                "network",
            );
            if (!_isDriveRetryable(lastErr) || attempt >= MAX_ATTEMPTS) throw lastErr;
            await sleep(DRIVE_RETRY_BACKOFF_MS[attempt - 1]);
            continue;
        }

        if (response.status === 401) throw makeKindError("http-401", "auth");
        if (response.status === 403) throw makeKindError("http-403", "no-access");
        if (response.status === 404) throw makeKindError("http-404", "not-found");
        if (response.status >= 200 && response.status < 300) return;

        lastErr = makeKindError(`http-${response.status}`, "http");
        if (!_isDriveRetryable(lastErr) || attempt >= MAX_ATTEMPTS) throw lastErr;
        await sleep(DRIVE_RETRY_BACKOFF_MS[attempt - 1]);
    }
    throw lastErr;
}

/**
 * Delete a Drive file. Best-effort — NO retries. Callers use this only to
 * sweep the temp PNGs uploaded during the batchUpdate step; a leaked file
 * is ugly but not user-facing.
 *
 * Returns `{ ok: true }` on 2xx / 404 (already-gone counts as success), or
 * `{ ok: false, status }` on any other status. Never throws for HTTP —
 * only for fetch-level failures (network / abort).
 *
 * @param {string} fileId
 * @param {string} token
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: boolean, status?: number }>}
 */
export async function driveDelete(fileId, token, opts)
{
    const fetchImpl = (opts && opts.fetchImpl) || globalThis.fetch;
    const signal = opts && opts.signal ? opts.signal : undefined;
    const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`;

    const response = await fetchImpl(url, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` },
        signal,
    });

    if (response.status === 404) return { ok: true, status: 404 };
    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status };
    return { ok: false, status: response.status };
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

/**
 * Fetch the `headRevisionId` of a Google Slides presentation via the
 * Drive `files.get` endpoint. Much cheaper than `presentations.get` —
 * the response is ~80 bytes vs potentially megabytes for the full deck.
 *
 * Best-effort, single attempt, 10s timeout. Returns `null` on any
 * failure (network, auth, 404) — the caller uses this for a background
 * sync-status check and degrades silently when the API is unreachable.
 *
 * @param {string} presentationId — the Slides presentation ID (also a Drive file ID)
 * @param {string} token — OAuth access token
 * @returns {Promise<string | null>}
 */
export async function getHeadRevisionId(presentationId, token)
{
    const url = `${DRIVE_FILES_URL}/${encodeURIComponent(presentationId)}?fields=headRevisionId`;
    try
    {
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return null;
        const data = /** @type {any} */ (await response.json());
        return data && typeof data.headRevisionId === "string"
            ? data.headRevisionId
            : null;
    }
    catch (_)
    {
        return null;
    }
}
