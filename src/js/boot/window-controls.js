// @ts-check
/**
 * window-controls.js — wire #win-minimize / #win-maximize / #win-close to the
 * Tauri window API. Replaces tauri-plugin-frame's eval-injected buttons so the
 * CSP can drop 'unsafe-eval'.
 *
 * Platform-aware:
 *   - macOS  → early-return, decorations(true) in Rust lets AppKit draw real
 *              traffic lights; our hand-rolled pips stay hidden.
 *   - Windows → render Windows-convention `_ ☐ X` glyph buttons (CSS branch
 *              via data-platform="windows").
 *   - Linux  → keep current macOS-style pips (CSS default / data-platform="linux").
 *
 * Only mounts when hasWindowChrome() is true (standalone desktop). Mobile and
 * tablet windows stay frameless — they auto-create a project and never expose a
 * close affordance to the user.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { hasWindowChrome } from "../adapters/platform-capabilities.js";
import { refreshTooltipFor } from "../tooltip/tooltip.js";
import { t } from "../adapters/tauri-i18n.js";

/**
 * Resolve the host OS. Tries `app_platform` first, falls back to
 * `navigator.platform` substring sniffing for browser dev.
 * @returns {Promise<"windows"|"macos"|"linux"|"unknown">}
 */
let cachedOs = null;
async function resolveOs()
{
    if (cachedOs) return cachedOs;
    try
    {
        /** @type {any} */
        const p = await invoke("app_platform");
        if (p && typeof p.os === "string")
        {
            cachedOs = p.os;
            return cachedOs;
        }
    }
    catch {}
    const plat = (navigator.platform || "").toLowerCase();
    if (plat.includes("win")) cachedOs = "windows";
    else if (plat.includes("mac")) cachedOs = "macos";
    else if (plat.includes("linux")) cachedOs = "linux";
    else cachedOs = "unknown";
    return cachedOs;
}

/**
 * Idempotent. Safe to call multiple times; only the first call wires listeners.
 */
let wired = false;
export async function wireWindowControls()
{
    if (wired) return;
    const host = document.getElementById("window-controls");
    if (!host) return;
    if (!hasWindowChrome()) return;

    const os = await resolveOs();
    // macOS uses Overlay title-bar style — AppKit draws real traffic lights
    // floating over the left edge of #top-bar. Our hand-rolled pips stay
    // hidden. Set a left-inset var so in-flow content clears the lights,
    // and stamp data-platform so CSS can gate macOS-only rules.
    if (os === "macos")
    {
        document.documentElement.style.setProperty("--mps-macos-titlebar-inset", "78px");
        document.documentElement.dataset.platform = "macos";
        // Traffic lights float on the LEFT (Overlay style) — the right edge has
        // no window controls, so content docking against the right edge must
        // subtract 0, not the 114px :root default (root.css). Without this the
        // collapsed storyboard-collapse button lands ~114px shy of the edge.
        document.documentElement.style.setProperty("--tauri-frame-controls-width", "0px");
        wired = true;
        return;
    }

    host.setAttribute("data-platform", os === "windows" ? "windows" : "linux");
    host.hidden = false;
    // Windows: 3 × 46px buttons, no gap, no padding = 138px.
    // macOS pips (114px) are the CSS default; override for Windows.
    const controlsWidth = os === "windows" ? "138px" : "114px";
    document.documentElement.style.setProperty("--tauri-frame-controls-width", controlsWidth);
    wired = true;

    const w = getCurrentWindow();
    const minBtn = document.getElementById("win-minimize");
    const maxBtn = document.getElementById("win-maximize");
    const closeBtn = document.getElementById("win-close");

    minBtn?.addEventListener("click", () =>
    {
        w.minimize().catch((e) => console.warn("[window-controls] minimize:", e?.message));
    });
    closeBtn?.addEventListener("click", () =>
    {
        w.close().catch((e) => console.warn("[window-controls] close:", e?.message));
    });
    maxBtn?.addEventListener("click", () =>
    {
        w.toggleMaximize().catch((e) => console.warn("[window-controls] toggleMaximize:", e?.message));
    });

    const syncMaxState = async () =>
    {
        try
        {
            const isMax = await w.isMaximized();
            if (!maxBtn) return;
            maxBtn.classList.toggle("is-maximized", isMax);
            maxBtn.setAttribute("aria-label", isMax ? "Restore" : "Maximize");
            const i18nKey = isMax ? "mangaplay-studio.chrome.tooltip.winRestore" : "mangaplay-studio.chrome.tooltip.winMaximize";
            maxBtn.setAttribute("data-i18n-tooltip", i18nKey);
            maxBtn.setAttribute("data-tooltip", t(i18nKey) || (isMax ? "Restore Down" : "Maximize"));
            refreshTooltipFor(maxBtn);
        }
        catch {}
    };
    void syncMaxState();
    try { await w.onResized(syncMaxState); }
    catch (e) { console.warn("[window-controls] onResized unavailable:", e?.message); }
}
