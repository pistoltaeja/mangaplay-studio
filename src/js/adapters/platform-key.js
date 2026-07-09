// @ts-check
/**
 * platform-key.js — memoised platform identifier for update-check JSON lookup.
 *
 * Returns one of the four keys used in websites/mangaplay.studio/public/app/
 * version.json: "windows" | "macos" | "ios" | "android".
 *
 * Linux is not a shipping target for Mangaplay Studio; in a dev shell we
 * fall back to "windows" so the update-check flow doesn't crash. Same
 * fallback applies if platform() itself throws.
 *
 * Uses the same @tauri-apps/plugin-os import as
 * auth/transports/platform-detect.js.
 */

import { platform } from "@tauri-apps/plugin-os";

/** @typedef {"windows"|"macos"|"ios"|"android"} PlatformKey */

/** @type {PlatformKey|null} */
let _cached = null;

/** @returns {Promise<PlatformKey>} */
export async function getPlatformKey()
{
    if (_cached) return _cached;
    try
    {
        const p = await platform();
        if (p === "windows") _cached = "windows";
        else if (p === "macos") _cached = "macos";
        else if (p === "ios") _cached = "ios";
        else if (p === "android") _cached = "android";
        else _cached = "windows"; // linux / unknown → dev fallback
    }
    catch (_)
    {
        _cached = "windows";
    }
    return _cached;
}
