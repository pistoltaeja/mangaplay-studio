// @ts-check
/**
 * platform-capabilities.js — capability detection (not platform detection).
 *
 * Frontend code asks "can this device do X?" instead of "is this mobile?".
 * Keeps capability gates working when iOS / Android land — the
 * implementation here returns different values per platform without the
 * call sites changing.
 *
 * Today (Windows prototype) capability == mode. Mobile/tablet UX modes
 * return false for desktop-only capabilities even though the underlying
 * OS (Windows) supports them. When the real mobile targets land,
 * these will read `tauri-plugin-os` for the real OS.
 */

import { isMobileLike } from "../boot/ux-mode.js";

/** Are native OS folder/file dialogs available? */
export function hasNativeFileDialog() { return !isMobileLike(); }

/** Can we open paths in the OS file manager? */
export function hasShellOpen() { return !isMobileLike(); }

/** Does the window have a draggable titlebar and minimize/maximize buttons? */
export function hasWindowChrome() { return !isMobileLike(); }

/** Does the OS provide a system-level trash / recycle bin? */
export function hasSystemTrash() { return !isMobileLike(); }

/** Are right-click context menus available (vs. long-press equivalents)? */
export function hasRightClick() { return !isMobileLike(); }

/** Is drag-and-drop available on this surface? */
export function hasDragAndDrop() { return !isMobileLike(); }

/**
 * The runtime platform — "ios", "android", or "desktop".
 * Sourced from Rust-injected `window.__MPS_PLATFORM__` (see
 * `src-tauri/src/setup/window.rs`). Falls back to "desktop" when
 * the injection hasn't landed (tests, website context).
 * @returns {"ios" | "android" | "desktop"}
 */
export function getPlatform()
{
    try
    {
        const p = /** @type {any} */ (typeof window !== "undefined" ? window : globalThis).__MPS_PLATFORM__;
        if (p === "ios" || p === "android") return p;
    }
    catch { /* noop */ }
    return "desktop";
}

/** @returns {boolean} */
export function isIOS() { return getPlatform() === "ios"; }

/** @returns {boolean} */
export function isAndroid() { return getPlatform() === "android"; }

/**
 * True when the app is running in a dev / debug build. Sourced from the
 * Rust-injected `window.__MPS_IS_DEV__` global (see
 * `src-tauri/src/setup/window.rs`), which is `cfg!(debug_assertions)` at
 * compile time. This is TRUE for every `--debug` / `bun tauri dev`
 * build on every platform (Windows, macOS, iOS, Android) and FALSE for
 * every `--release` build. The previous implementation sniffed the
 * `mpsdev://` protocol, which only worked on Windows/Linux dev because
 * the `disk-frontend` cargo feature isn't enabled on macOS/iOS/Android.
 *
 * @returns {boolean}
 */
export function isDevBuild()
{
    try
    {
        return typeof window !== "undefined"
            && /** @type {any} */ (window).__MPS_IS_DEV__ === true;
    }
    catch
    {
        return false;
    }
}
