// @ts-check
/**
 * preflight.js — five checks the Publish flow runs before any Drive write.
 *
 * Each check is a pure async function. On success → `{ ok: true }` (plus
 * optional warning). On failure → throws an Error that the
 * `core/google-docs/error-classifier.js` can route. The state machine in a
 * later wave wraps these in min-dwell timers and progress percentages.
 *
 * Why pure async functions rather than a class: the publish state machine
 * calls each one independently between progress-bar updates, and the
 * unit-test surface is dramatically smaller this way.
 */

import { pathExists } from "../project/user-settings.js";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

const OIDC_URL = "https://accounts.google.com/.well-known/openid-configuration";
const DEFAULT_NETWORK_TIMEOUT_MS = 3000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const QUOTA_OVER_THRESHOLD = 0.95;

/**
 * Build a classified `Error` with shape the error-classifier recognises.
 * Keeping this local rather than reaching into the classifier module keeps
 * preflight reusable in non-classifier contexts (e.g. headless tests).
 *
 * @param {string} name
 * @param {string} message
 * @returns {Error & { name: string, status: number, responseBody: string }}
 */
function _err(name, message)
{
    const e = /** @type {Error & { name: string, status: number, responseBody: string }} */ (new Error(message));
    e.name = name;
    e.status = 0;
    e.responseBody = "";
    return e;
}

/**
 * Step 1 — network reachability via HEAD to Google's OIDC config endpoint.
 * 3s timeout via AbortController; missing the timeout would let the publish
 * UI hang forever on a captive portal.
 *
 * Returns `{ ok: true, response }` so step 2 (`preflightGoogleAccess`) can
 * inspect the same response without re-fetching.
 *
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: true, response: Response }>}
 */
export async function preflightNetwork({ timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS, fetchImpl } = {})
{
    const f = fetchImpl || fetch;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try
    {
        const response = await f(OIDC_URL, { method: "HEAD", signal: ctrl.signal });
        return { ok: true, response };
    }
    catch (err)
    {
        const e = /** @type {any} */ (err);
        const msg = (e && e.name === "AbortError")
            ? `network timeout after ${timeoutMs}ms`
            : `network error: ${e?.message || e}`;
        throw _err("NetworkError", msg);
    }
    finally
    {
        clearTimeout(tid);
    }
}

/**
 * Step 2 — verify the response from step 1 has a 200. Anything else
 * (captive portal returning HTML, 5xx from Google) is a network failure.
 *
 * @param {{ response: Response }} args
 * @returns {Promise<{ ok: true }>}
 */
export async function preflightGoogleAccess({ response })
{
    if (!response || response.status !== 200)
    {
        const status = response ? response.status : 0;
        throw _err("NetworkError", `Google reachability check failed (status ${status})`);
    }
    return { ok: true };
}

/**
 * Step 3 — silent token refresh if the current token expires within
 * `TOKEN_REFRESH_BUFFER_MS`. The existing auth module exposes
 * `getAccessToken({ allowRefresh })`; we pass it through and treat a null
 * return as a token-expired failure (matches the existing auth module's
 * "refresh failed silently" contract).
 *
 * Tests inject `authClient` so they don't need the real OAuth flow.
 *
 * @param {{ authClient: { getAccessToken: (opts?: { allowRefresh?: boolean }) => Promise<string|null> } }} args
 * @returns {Promise<{ ok: true, token: string }>}
 */
export async function preflightToken({ authClient })
{
    let token = null;
    try
    {
        token = await authClient.getAccessToken({ allowRefresh: true });
    }
    catch (err)
    {
        const e = /** @type {any} */ (err);
        throw _err("AuthError", `token refresh failed: ${e?.message || e}`);
    }
    if (!token)
    {
        throw _err("AuthError", "no access token available (sign-in required)");
    }
    return { ok: true, token };
}

/**
 * Step 4 — local file readable & non-empty.
 *
 * Uses the existing Tauri commands (`path_exists`, `read_project_file`)
 * rather than `@tauri-apps/api/fs` because the desktop app doesn't depend
 * on `fs-plugin` — it routes all FS calls through the project-scoped
 * commands in `lib.rs` to keep the sandbox tight.
 *
 * @param {{ localPath: string, fsClient?: { exists: (p: string) => Promise<boolean>, read: (p: string) => Promise<string> } }} args
 * @returns {Promise<{ ok: true, size: number }>}
 */
export async function preflightFile({ localPath, fsClient })
{
    if (!localPath)
    {
        throw _err("FatalConfig", "local file path missing (fatal.config)");
    }

    const exists = fsClient
        ? await fsClient.exists(localPath)
        : await pathExists(localPath);
    if (!exists)
    {
        throw _err("FatalConfig", `local file not found: ${localPath} (fatal.config)`);
    }

    let contents = "";
    try
    {
        contents = fsClient
            ? await fsClient.read(localPath)
            : await tauriInvoke("read_project_file", { path: localPath });
    }
    catch (err)
    {
        const e = /** @type {any} */ (err);
        throw _err("FatalConfig", `unable to read local file: ${e?.message || e} (fatal.config)`);
    }

    const size = (contents || "").length;
    if (size === 0)
    {
        throw _err("FatalConfig", `local file is empty: ${localPath} (fatal.config)`);
    }
    return { ok: true, size };
}

/**
 * Step 5 — destination folder exists and isn't in the trash. `null` /
 * `"root"` skip the check (My Drive root always exists).
 *
 * @param {{ driveClient: { filesGet: (args: { token: string, fileId: string, fields?: string }) => Promise<any> }, token: string, folderId: string|null }} args
 * @returns {Promise<{ ok: true }>}
 */
export async function preflightDestFolder({ driveClient, token, folderId })
{
    if (!folderId || folderId === "root") return { ok: true };

    let resp;
    try
    {
        resp = await driveClient.filesGet({
            token,
            fileId: folderId,
            fields: "id,trashed"
        });
    }
    catch (err)
    {
        const e = /** @type {any} */ (err);
        // If the Drive client already threw a classified error, re-throw it
        // so the classifier maps 404→PermissionError, 401→AuthError, etc.
        if (e && e.name === "DocumentNotFoundError")
        {
            throw _err("PermissionError", `destination folder not found: ${folderId}`);
        }
        throw err;
    }

    if (!resp || resp.trashed)
    {
        throw _err("PermissionError", `destination folder is trashed: ${folderId}`);
    }
    return { ok: true };
}

/**
 * Step 6 — Drive storage quota check. NEVER throws — the user can still
 * publish even when over quota (Drive will reject the write itself if it
 * really matters). Returns `{ ok: true, warning: "over95" }` so the modal
 * can surface a soft banner.
 *
 * @param {{ driveClient: { aboutGet: (args: { token: string, fields?: string }) => Promise<any> }, token: string }} args
 * @returns {Promise<{ ok: true, warning?: "over95" }>}
 */
export async function preflightQuota({ driveClient, token })
{
    try
    {
        const resp = await driveClient.aboutGet({ token, fields: "storageQuota" });
        const q = resp && resp.storageQuota;
        if (!q) return { ok: true };

        const usage = Number(q.usage || q.usageInDrive || 0);
        const limit = Number(q.limit || 0);
        if (limit > 0 && (usage / limit) > QUOTA_OVER_THRESHOLD)
        {
            return { ok: true, warning: "over95" };
        }
        return { ok: true };
    }
    catch
    {
        // Warn-only check — quota probe failure is not a publish blocker.
        return { ok: true };
    }
}

/**
 * Convenience: run all six preflight checks in order. Stops at the first
 * thrown error and returns `{ ok: false, failedAt, error }`. Quota
 * warnings are collected into `warnings: []`.
 *
 * The publish state machine drives each step individually to update the
 * progress bar between them. This helper exists for tests and non-modal
 * callers.
 *
 * @param {{ driveClient: any, authClient: any, localPath: string, folderId: string|null }} args
 * @returns {Promise<{ ok: boolean, warnings: Array<string>, failedAt?: string, error?: any, token?: string }>}
 */
export async function runAll({ driveClient, authClient, localPath, folderId })
{
    const warnings = [];
    /** @type {string|undefined} */
    let token;

    const steps = [
        { key: "network",     fn: async () =>
            {
                const { response } = await preflightNetwork({});
                await preflightGoogleAccess({ response });
            }
        },
        { key: "token",       fn: async () =>
            {
                const r = await preflightToken({ authClient });
                token = r.token;
            }
        },
        { key: "file",        fn: async () => { await preflightFile({ localPath }); } },
        { key: "destFolder",  fn: async () =>
            {
                if (!token) throw _err("AuthError", "preflight ordering bug: token missing");
                await preflightDestFolder({ driveClient, token, folderId });
            }
        },
        { key: "quota",       fn: async () =>
            {
                if (!token) return;
                const r = await preflightQuota({ driveClient, token });
                if (r.warning) warnings.push(r.warning);
            }
        }
    ];

    for (const step of steps)
    {
        try
        {
            await step.fn();
        }
        catch (error)
        {
            return { ok: false, warnings, failedAt: step.key, error };
        }
    }

    return { ok: true, warnings, token };
}
