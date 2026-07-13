// @ts-check
/**
 * picker-client.js — thin JS wrapper for the Rust `picker_open` command.
 *
 * Flow:
 *   1. Call `pickFile({ kind })`.
 *   2. Kind resolves to MIME types via `mimetypes.js::kindToMimetypes`.
 *   3. Rust `picker_open` opens the system browser, awaits the loopback
 *      callback, and returns the raw exchange inputs
 *      `{ code, code_verifier, redirect_uri, picked_file_ids, event_name }`.
 *   4. We POST those to `https://api.absolutelyskint.com/v2/picker/exchange`
 *      which redeems the code with Google (client_secret is injected
 *      server-side) and returns `{ access_token, refresh_token?, id_token?,
 *      expires_in, picked_file_ids }`.
 *   5. We return `{ fileId, fileIds, token, refreshToken?, expiresIn,
 *      idToken? }` to the caller. `fileId` is the first id — convenience
 *      for the single-pick case.
 *
 * This module is *lazy-import safe*: zero top-level side effects beyond
 * imports. The publish-slides-modal picker button dynamically imports it
 * inside the click handler so the picker code never enters the cold-boot
 * bundle. Do NOT add module-level `invoke(...)` calls or event listeners.
 *
 * Errors are thrown as one of four typed classes so callers can bucket
 * with `instanceof`:
 *
 *   - `PickerCancelledError`  — user closed the browser tab or Google
 *                                returned `access_denied` / `no_code`.
 *   - `PickerTimeoutError`    — no callback within Rust's 5-min budget.
 *   - `PickerInFlightError`   — a previous `pickFile()` is still awaiting
 *                                a callback. UI is expected to debounce.
 *   - `PickerFailedError`     — everything else (bind failure, exchange
 *                                network error, bridge 5xx).
 */

import { invoke } from "@tauri-apps/api/core";
import { kindToMimetypes } from "./mimetypes.js";

// ─────────────────────────────────────────────────────────────────────────
// Error classes
// ─────────────────────────────────────────────────────────────────────────

export class PickerCancelledError extends Error
{
    /** @param {string} [msg] */
    constructor(msg)
    {
        super(msg || "Picker cancelled");
        this.name = "PickerCancelledError";
    }
}

export class PickerTimeoutError extends Error
{
    /** @param {string} [msg] */
    constructor(msg)
    {
        super(msg || "Picker timed out");
        this.name = "PickerTimeoutError";
    }
}

export class PickerInFlightError extends Error
{
    /** @param {string} [msg] */
    constructor(msg)
    {
        super(msg || "A picker is already open");
        this.name = "PickerInFlightError";
    }
}

export class PickerFailedError extends Error
{
    /** @param {string} [msg] */
    constructor(msg)
    {
        super(msg || "Picker failed");
        this.name = "PickerFailedError";
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Rust error-string → error-class mapping
// ─────────────────────────────────────────────────────────────────────────

/**
 * Map a raw Rust `Err(String)` from `picker_open` to one of the four
 * typed error classes. Preserves the original message for logging.
 * @param {unknown} raw
 * @returns {Error}
 */
function _classifyRustError(raw)
{
    const msg = raw instanceof Error ? raw.message : String(raw ?? "");
    if (msg === "picker_already_in_flight")
    {
        return new PickerInFlightError(msg);
    }
    if (msg === "picker_timeout")
    {
        return new PickerTimeoutError(msg);
    }
    if (msg.startsWith("picker_cancelled:"))
    {
        return new PickerCancelledError(msg);
    }
    if (msg.startsWith("picker_transport_not_wired"))
    {
        return new PickerFailedError(msg);
    }
    // Anything else — bind/accept/malformed — is a generic failure.
    return new PickerFailedError(msg || "picker_failed");
}

// ─────────────────────────────────────────────────────────────────────────
// Exchange endpoint
// ─────────────────────────────────────────────────────────────────────────

const PICKER_EXCHANGE_URL = "https://api.absolutelyskint.com/v2/picker/exchange";

// Bridge's HTTPS callback URL that Google sees at authorize time. The
// exchange redirect_uri must match this byte-exact — Rust's loopback URL
// is only what the BRIDGE 302s to after Google callback, never what Google
// itself sees. Sending the loopback here would fail Google's exchange
// with redirect_uri_mismatch (400) and the bridge's own guard rejects it
// before ever hitting Google.
const PICKER_CALLBACK_URL = "https://api.absolutelyskint.com/v2/picker/callback";

// Matches google-oauth.js OAUTH_CLIENT_ID (Windows Web client). Repeated
// locally rather than imported so this module has no dependency on the
// auth module — keeps the lazy-import contract clean (the auth module
// carries a lot of state that we don't want to instantiate on first pick).
const OAUTH_CLIENT_ID =
    "661305516089-nk6i26qc8hlk0c37f9ucadjstq0isuhr.apps.googleusercontent.com";

/**
 * @typedef {Object} ExchangeResponse
 * @property {string} access_token
 * @property {string} [refresh_token]
 * @property {string} [id_token]
 * @property {number} expires_in
 * @property {string[]} [picked_file_ids]
 */

/**
 * POST the raw callback payload to the bridge exchange endpoint. Returns
 * the parsed response body on 2xx; throws `PickerFailedError` otherwise.
 *
 * @param {{ code: string, codeVerifier: string, redirectUri: string }} args
 * @returns {Promise<ExchangeResponse>}
 */
async function _exchangeCode(args)
{
    let resp;
    try
    {
        resp = await fetch(PICKER_EXCHANGE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                code: args.code,
                code_verifier: args.codeVerifier,
                client_id: OAUTH_CLIENT_ID,
                redirect_uri: args.redirectUri,
            }),
        });
    }
    catch (e)
    {
        throw new PickerFailedError(`picker_exchange_network: ${e?.message || e}`);
    }
    if (!resp.ok)
    {
        throw new PickerFailedError(`picker_exchange_status: ${resp.status}`);
    }
    let json;
    try
    {
        json = await resp.json();
    }
    catch (e)
    {
        throw new PickerFailedError(`picker_exchange_malformed: ${e?.message || e}`);
    }
    if (!json || typeof json.access_token !== "string")
    {
        throw new PickerFailedError("picker_exchange_missing_access_token");
    }
    return /** @type {ExchangeResponse} */ (json);
}

// ─────────────────────────────────────────────────────────────────────────
// In-flight guard (JS-side belt-and-braces around the Rust AtomicBool)
// ─────────────────────────────────────────────────────────────────────────

let _inFlight = false;

/**
 * Returns true if a `pickFile()` call is still awaiting its Rust callback +
 * exchange. Callers use this to short-circuit UI transitions (e.g. Back
 * button from the Sync form panel) without invoking Rust.
 * @returns {boolean}
 */
export function isPickerInFlight()
{
    return _inFlight;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PickFileArgs
 * @property {"slide" | "doc" | "any"} kind
 * @property {boolean} [allowMultiple]
 * @property {string} [hint] — emailAddress passed as `login_hint` to skip
 *   Google's account chooser when the user has a prior sign-in on this
 *   machine. Caller supplies from stored identity; picker-client does not
 *   read auth state directly (lazy-import invariant).
 */

/**
 * @typedef {Object} PickFileResult
 * @property {string} fileId          First picked file id (convenience).
 * @property {string[]} fileIds       Full list — length 1 unless allowMultiple.
 * @property {string} token           Fresh access_token.
 * @property {string} [refreshToken]  Only present when Google issued one.
 * @property {number} expiresIn       Seconds until access_token expiry.
 * @property {string} [idToken]       Only when `openid` was granted.
 */

/**
 * @typedef {Object} RustPickerResult
 * @property {string} code
 * @property {string} code_verifier
 * @property {string} redirect_uri
 * @property {string[]} picked_file_ids
 * @property {string} event_name
 */

/**
 * Open the Google Drive Picker and return the picked file plus the fresh
 * OAuth tokens minted for it. Single-pick convenience surfaces first id
 * as `fileId`; `fileIds` always carries the full list.
 *
 * @param {PickFileArgs} args
 * @returns {Promise<PickFileResult>}
 */
export async function pickFile(args)
{
    console.warn(`[picker-client] pickFile() ENTRY — args=${JSON.stringify(args)} _inFlight=${_inFlight}`);
    // JS-side rage-click guard. Rust also enforces this via AtomicBool,
    // but checking here means we can short-circuit before crossing the
    // IPC boundary and returning a typed error class.
    if (_inFlight)
    {
        console.warn(`[picker-client] pickFile REJECTED — already in flight`);
        throw new PickerInFlightError("picker_already_in_flight");
    }
    _inFlight = true;
    try
    {
        const kind = args?.kind || "any";
        const allowMultiple = args?.allowMultiple === true;
        const hint = typeof args?.hint === "string" && args.hint ? args.hint : null;
        const mimetypes = kindToMimetypes(kind);
        console.warn(`[picker-client] pickFile: calling Rust invoke("picker_open") with kind=${kind} mimetypes=${JSON.stringify(mimetypes)} hint=${hint ? "PRESENT" : "null"} — this OPENS SYSTEM BROWSER`);

        /** @type {RustPickerResult} */
        let rust;
        try
        {
            rust = /** @type {RustPickerResult} */ (
                await invoke("picker_open", {
                    args: {
                        kind,
                        mimetypes,
                        allow_multiple: allowMultiple,
                        hint,
                    },
                })
            );
            console.warn(`[picker-client] Rust picker_open RETURNED — code=${rust?.code ? rust.code.slice(0, 8) + "…" : "null"} picked_file_ids=${JSON.stringify(rust?.picked_file_ids)}`);
        }
        catch (raw)
        {
            console.warn(`[picker-client] Rust picker_open THREW: ${String(raw).slice(0, 200)}`);
            throw _classifyRustError(raw);
        }

        if (!rust || typeof rust.code !== "string" || !rust.code)
        {
            console.warn(`[picker-client] pickFile: Rust result missing code — throwing PickerFailedError`);
            throw new PickerFailedError("picker_missing_code");
        }
        if (!Array.isArray(rust.picked_file_ids) || rust.picked_file_ids.length === 0)
        {
            console.warn(`[picker-client] pickFile: Rust returned empty picked_file_ids — treating as USER CANCELLED`);
            // Bridge said success but sent no ids — treat as user-cancel.
            throw new PickerCancelledError("picker_no_ids");
        }

        console.warn(`[picker-client] pickFile: exchanging code with api.absolutelyskint.com/v2/picker/exchange…`);
        const exchange = await _exchangeCode({
            code: rust.code,
            codeVerifier: rust.code_verifier,
            redirectUri: PICKER_CALLBACK_URL,
        });
        console.warn(`[picker-client] pickFile: exchange RESOLVED — access_token=${exchange?.access_token ? "PRESENT" : "NULL"} picked_file_ids=${JSON.stringify(exchange?.picked_file_ids)}`);

        const fileIds = Array.isArray(exchange.picked_file_ids) && exchange.picked_file_ids.length > 0
            ? exchange.picked_file_ids
            : rust.picked_file_ids;

        console.warn(`[picker-client] pickFile RETURNING — fileId=${fileIds[0]} fileIds.length=${fileIds.length}`);
        return {
            fileId: fileIds[0],
            fileIds,
            token: exchange.access_token,
            refreshToken: typeof exchange.refresh_token === "string" ? exchange.refresh_token : undefined,
            expiresIn: typeof exchange.expires_in === "number" ? exchange.expires_in : 3600,
            idToken: typeof exchange.id_token === "string" ? exchange.id_token : undefined,
        };
    }
    finally
    {
        _inFlight = false;
        console.warn(`[picker-client] pickFile FINALLY — cleared _inFlight`);
    }
}
