// @ts-check
/**
 * deeplink-mobile.js — SKELETON ONLY mobile OAuth transport (iOS / Android).
 *
 * On desktop, this module's `startAndAwaitRedirect()` immediately throws
 * `{ name: 'PlatformError', message: 'mobile transport called on desktop
 * platform' }` — fail-loud so any misrouting in platform-detect.js is
 * caught in dev before it ships.
 *
 * --- iOS ---
 * Tauri 2's deep-link plugin auto-generates `CFBundleURLTypes` in
 * Info.plist from `tauri.conf.json plugins.deep-link.desktop.schemes`.
 * The mobile bundle ID `studio.mangaplay.app` will declare the
 * `mangaplay` scheme so iOS routes `mangaplay://auth-callback?...` back
 * to the app.
 *
 * The actual browser launch on iOS MUST use `ASWebAuthenticationSession`
 * (not `SFSafariViewController`, not `WKWebView`) so the user's existing
 * Google SSO cookie carries over from Safari. `tauri-plugin-web-auth`
 * provides this — add as a follow-up dep when mobile builds land.
 *
 * Apple's "Sign in with Apple" mandate was REVOKED 2024-01 — Google
 * sign-in alone is App Store-compliant. Re-verify at iOS submission.
 *
 * --- Android ---
 * Google deprecated loopback for Android in Aug 2022 — MUST use App
 * Links (HTTPS scheme), not a custom URI scheme. The custom `mangaplay://`
 * scheme is for iOS only.
 *
 * Requires `websites/mangaplay.studio/public/.well-known/assetlinks.json`
 * with package name `studio.mangaplay.app` and the SHA-256 fingerprint
 * of the release signing cert. Placeholder file exists with TODO_FINGERPRINT;
 * populate during mobile build setup.
 *
 * Android intent-filter needs `android:autoVerify="true"` — Tauri's
 * deep-link plugin emits this automatically when the scheme is `https`.
 *
 * Browser launch on Android uses Chrome Custom Tabs (via
 * `tauri-plugin-web-auth`).
 *
 * @typedef {import("./loopback-desktop.js").AuthTransport} AuthTransport
 */

import { invoke } from "@tauri-apps/api/core";

const REDIRECT_DEADLINE_MS = 65 * 1000;

/** @type {AuthTransport} */
const transport = {
    name: "deeplink-mobile",

    async startAndAwaitRedirect(authUrlBuilder)
    {
        // Fail-loud on desktop: platform-detect routes here only for
        // ios/android. If we got here on desktop, something is wrong.
        let p = "unknown";
        try
        {
            const os = await import("@tauri-apps/plugin-os");
            p = await os.platform();
        }
        catch (_) { /* leave as unknown */ }

        if (p !== "ios" && p !== "android")
        {
            const err = new Error("mobile transport called on desktop platform");
            err.name = "PlatformError";
            throw err;
        }

        // iOS: custom URI scheme. Android: HTTPS App Link.
        const redirectUri = p === "ios"
            ? "mangaplay://auth-callback"
            : "https://mangaplay.studio/auth/callback";

        // TODO mobile: requires tauri-plugin-web-auth for browser launch.
        // The plugin returns the redirect URL as a Promise — replace the
        // event-listen path below once the dep is added.
        // const webAuth = await import("tauri-plugin-web-auth-api");

        /** @type {(() => void)|null} */
        let unsubscribe = null;
        /** @type {ReturnType<typeof setTimeout>|null} */
        let timeoutHandle = null;

        try
        {
            const redirectPromise = new Promise((resolve, reject) =>
            {
                // TODO mobile: replace with the plugin's promise-based launch.
                // For now, scaffolded to listen for the existing app:deep-link
                // event ([lib.rs:367-371](mangaplay-studio/src-tauri/src/lib.rs#L367-L371))
                // emitted by the Tauri deep-link plugin.
                import("@tauri-apps/api/event").then(({ listen }) =>
                {
                    listen("app:deep-link", (event) =>
                    {
                        const payload = /** @type {any} */ (event.payload);
                        const url = typeof payload === "string"
                            ? payload
                            : (payload && payload.url) || null;
                        if (!url) return;
                        // Filter for our auth-callback URLs only.
                        if (!String(url).includes("auth-callback")
                            && !String(url).includes("/auth/callback")) return;
                        resolve({ url: String(url) });
                    })
                    .then((un) => { unsubscribe = un; })
                    .catch((e) => reject(e));
                })
                .catch((e) => reject(e));
            });

            const timeoutPromise = new Promise((_resolve, reject) =>
            {
                timeoutHandle = setTimeout(() =>
                {
                    const err = new Error("deeplink redirect deadline exceeded");
                    err.name = "TimeoutError";
                    reject(err);
                }, REDIRECT_DEADLINE_MS);
            });

            const authUrl = await authUrlBuilder(redirectUri);

            // ── iOS launcher contract (HARD requirement, do not relax) ─────
            // Google's OAuth 2.0 native-app docs block WKWebView with
            // `disallowed_useragent`. SFSafariViewController lacks the
            // callback-URL-scheme contract OAuth needs. The ONLY iOS API
            // that (a) carries Safari's Google SSO cookies into the auth
            // flow AND (b) supports the callback URL scheme contract is
            // ASWebAuthenticationSession.
            //
            // When tauri-plugin-web-auth lands, the iOS branch MUST route
            // through ASWebAuthenticationSession. Using any other browser-
            // launch primitive on iOS will break sign-in for users who are
            // already signed into Google in Safari (they'll be forced to
            // re-enter credentials, defeating the whole indefinite-session
            // promise of the long-lived-session model).
            //
            // Refresh token grants (POST /v2/oauth/refresh) do NOT need a
            // browser at all — they're just a JSON POST. So only the
            // *initial* interactive sign-in is affected by this constraint.
            //
            // Android uses Chrome Custom Tabs via App Links (the redirectUri
            // above resolves to https://mangaplay.studio/auth/callback).
            // Custom Tabs share Chrome's cookie jar, same SSO benefit.
            //
            // TODO mobile: requires tauri-plugin-web-auth for browser launch.
            // Today this falls through to the shared `auth_open_browser`
            // command (which itself returns Err on mobile under #[cfg(mobile)]).
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
