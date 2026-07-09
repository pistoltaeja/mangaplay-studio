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
 * OS (Windows) supports them. Phase 2 when the real mobile targets land,
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
