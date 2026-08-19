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

/**
 * True when the runtime OS is a real IAP store platform (android/ios).
 * Memoised via getPlatformKey(). UX mode is irrelevant — a Mobile-UX build
 * on Windows/macOS/Linux returns false (no store behind it).
 * @returns {Promise<boolean>}
 */
export async function isIapPlatform()
{
    const p = await getPlatformKey();
    return p === "android" || p === "ios";
}

/**
 * Synchronous read of the memoised platform key. Returns null until
 * getPlatformKey() has resolved at least once. Callers that need a sync
 * answer (render loops) must ensure the async resolve ran earlier at boot.
 * @returns {PlatformKey|null}
 */
export function getPlatformKeyCached()
{
    return _cached;
}

/**
 * Synchronous "is this a real IAP store platform?" read of the memoised
 * key. Returns false until getPlatformKey() has resolved — a SAFE default:
 * false = no IAP gating (desktop behaviour). Premium skins are hidden
 * off-store anyway, so an unresolved-yet read never wrongly shows them.
 * @returns {boolean}
 */
export function isStorePlatformCached()
{
    return _cached === "android" || _cached === "ios";
}
