// @ts-check
/**
 * loopback-desktop.js — desktop OAuth transport (Windows / macOS / Linux).
 *
 * Flow:
 *   1. invoke('auth_listen_loopback') → Rust binds 127.0.0.1:<ephemeral>
 *      and returns `{ id, port, redirect_uri }`. Rust holds the socket
 *      until Google redirects to it (60s deadline).
 *   2. Subscribe to `app:auth-redirect` event from @tauri-apps/api/event
 *      and filter on the returned `id` so concurrent flows don't cross.
 *   3. Build the OAuth URL via the supplied `authUrlBuilder(redirect_uri)`
 *      callback — the caller owns scopes / PKCE / state nonce.
 *   4. invoke('auth_open_browser', { url }) → Rust opens the system browser.
 *   5. Race the listener with a 65s setTimeout. The Rust side has a 60s
 *      deadline; 5s buffer to drain the event-bus.
 *   6. ALWAYS clean up the listener in a finally — leaked listeners are
 *      the #1 cause of "second sign-in does nothing" bugs in similar
 *      codebases.
 *
 * @typedef {Object} AuthTransport
 * @property {string} name
 * @property {(authUrlBuilder: (redirectUri: string) => Promise<string>|string, onListenerReady?: (info: { id: string|null, port: number|null }) => void) => Promise<{ url: string }>} startAndAwaitRedirect
 *
 * `onListenerReady` is OPTIONAL. Desktop loopback fires it the instant
 * the Rust socket binds, exposing the listener `id` so a caller can
 * later invoke `auth_abort_loopback(id)` to break the accept-poll loop
 * before Google's 60-second deadline. The mobile deeplink transport
 * does NOT call this callback (no bindable socket, no abort surface)
 * — callers MUST treat the absence of a subsequent id as "no abort
 * possible" rather than an error.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const REDIRECT_DEADLINE_MS = 65 * 1000;

/** @type {AuthTransport} */
const transport = {
    name: "loopback-desktop",

    async startAndAwaitRedirect(authUrlBuilder, onListenerReady)
    {
        /** @type {{ id: string, port: number, redirect_uri: string }} */
        const listener = await invoke("auth_listen_loopback");
        if (!listener || typeof listener !== "object"
            || typeof listener.id !== "string"
            || typeof listener.redirect_uri !== "string")
        {
            const err = new Error("auth_listen_loopback returned malformed payload");
            err.name = "ConfigError";
            throw err;
        }

        const expectedId = listener.id;

        // Expose the listener id + port to the caller synchronously so
        // it can stash the id for a later `auth_abort_loopback` invoke.
        // Callback is optional; ignore any exception it throws so a
        // buggy caller can't tear down the OAuth flow.
        if (typeof onListenerReady === "function")
        {
            try
            {
                onListenerReady({ id: listener.id, port: listener.port });
            }
            catch (e)
            {
                console.warn("[mps:auth] onListenerReady callback threw:", e);
            }
        }

        /** @type {(() => void)|null} */
        let unsubscribe = null;
        /** @type {ReturnType<typeof setTimeout>|null} */
        let timeoutHandle = null;

        try
        {
            const redirectPromise = new Promise((resolve, reject) =>
            {
                listen("app:auth-redirect", (event) =>
                {
                    const payload = /** @type {any} */ (event.payload);
                    if (!payload || payload.id !== expectedId) return;
                    if (typeof payload.url === "string")
                    {
                        resolve({ url: payload.url });
                    }
                    else if (payload.error)
                    {
                        const err = new Error(String(payload.error));
                        err.name = "RedirectError";
                        reject(err);
                    }
                    else if (payload.aborted)
                    {
                        // User clicked Cancel — Rust flipped the abort
                        // flag and closed the socket. "AbortedError" /
                        // "aborted" matches the classifier's
                        // `auth.user_cancelled` branch, so the caller's
                        // catch resolves the sign-in as cancelled.
                        const err = new Error("user aborted sign-in");
                        err.name = "AbortedError";
                        reject(err);
                    }
                    else if (payload.timeout)
                    {
                        // 60-second Rust deadline expired without any
                        // redirect. Classifier maps `TimeoutError` →
                        // `auth.network` (more accurate than the old
                        // `RedirectError` → `fatal.unknown` route).
                        const err = new Error("sign-in timed out");
                        err.name = "TimeoutError";
                        reject(err);
                    }
                    else
                    {
                        const err = new Error("redirect event missing url");
                        err.name = "RedirectError";
                        reject(err);
                    }
                })
                .then((un) => { unsubscribe = un; })
                .catch((e) => reject(e));
            });

            const timeoutPromise = new Promise((_resolve, reject) =>
            {
                timeoutHandle = setTimeout(() =>
                {
                    const err = new Error("loopback redirect deadline exceeded");
                    err.name = "TimeoutError";
                    reject(err);
                }, REDIRECT_DEADLINE_MS);
            });

            const authUrl = await authUrlBuilder(listener.redirect_uri);
            await invoke("auth_open_browser", { url: authUrl });

            return await /** @type {Promise<{ url: string }>} */ (Promise.race([redirectPromise, timeoutPromise]));
        }
        finally
        {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (unsubscribe)
            {
                try { unsubscribe(); } catch (_) { /* best-effort */ }
            }
        }
    },
};

export default transport;
