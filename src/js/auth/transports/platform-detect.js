// @ts-check
/**
 * platform-detect.js — pick the right transport for the current OS.
 *
 * Desktop (windows / macos / linux) → loopback-desktop transport
 *   (Rust binds 127.0.0.1:0, captures the redirect over HTTP).
 * Mobile  (ios / android)           → deeplink-mobile transport
 *   (Tauri deep-link plugin + tauri-plugin-web-auth — skeleton today).
 *
 * Memoised — platform() is async but the answer cannot change at runtime.
 */

import { platform } from "@tauri-apps/plugin-os";

/** @type {string|null} */
let _cached = null;

/** @returns {Promise<"deeplink-mobile"|"loopback-desktop">} */
export async function getTransportName()
{
    if (_cached) return /** @type {any} */ (_cached);
    try
    {
        const p = await platform();
        if (p === "ios" || p === "android") _cached = "deeplink-mobile";
        else _cached = "loopback-desktop";
    }
    catch (_)
    {
        _cached = "loopback-desktop";
    }
    return /** @type {any} */ (_cached);
}

/**
 * Dynamic-import the transport module so a mobile build doesn't
 * eagerly pull in the loopback Rust commands (and vice versa).
 * @returns {Promise<import("./loopback-desktop.js").AuthTransport>}
 */
export async function loadTransport()
{
    const name = await getTransportName();
    if (name === "deeplink-mobile")
    {
        return (await import("./deeplink-mobile.js")).default;
    }
    return (await import("./loopback-desktop.js")).default;
}
