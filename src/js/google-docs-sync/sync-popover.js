// @ts-check
/**
 * sync-popover.js — small panel anchored above the gear button.
 *
 * Per TODO/mangaplay-studio-google-docs-sync.md §7 "Sync popover". Opens
 * when the gear is clicked in any non-Grey state. Closes on outside-click
 * or Escape.
 *
 * The popover is a callbacks-only surface — all real Push / Pull /
 * View / Refresh / Unlink work lives in the caller (Phase 4). This file
 * builds the DOM, wires the buttons, and manages the singleton open/close
 * lifecycle.
 */

import { t } from "../adapters/tauri-i18n.js";
import { humaniseSyncState, lockSvg } from "./footer-bar.js";

/** @typedef {"unsynced"|"idle"|"checking"|"local-ahead"|"remote-ahead"|"error"} SyncState */
/** @typedef {"unsynced"|"unlocked"|"locked-by-me"|"locked-by-other"|"stale"} LockState */

/**
 * @typedef {Object} OpenPopoverOpts
 * @property {HTMLElement} anchor              — element to anchor against (the gear)
 * @property {SyncState} state
 * @property {string|null} [lastCheckedAt]
 * @property {string} [filename]              — script basename (shown in header)
 * @property {LockState} [lockState]          — lock state for the inline padlock
 * @property {() => (void|Promise<void>)} [onPush]
 * @property {() => (void|Promise<void>)} [onPull]
 * @property {() => (void|Promise<void>)} [onViewInBrowser]
 * @property {() => (void|Promise<void>)} [onRefresh]
 * @property {() => (void|Promise<void>)} [onUnlink]
 * @property {() => (void|Promise<void>)} [onPadlock]
 */

/** @type {{ root: HTMLElement, dispose: () => void } | null} */
let activePopover = null;

/**
 * Open the sync popover, anchored above `opts.anchor`. Closes any existing
 * popover first. Use `closeSyncPopover()` to dismiss programmatically.
 *
 * @param {OpenPopoverOpts} opts
 */
export function openSyncPopover(opts)
{
    closeSyncPopover();

    const root = document.createElement("div");
    root.className = "sync-popover";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label",
        t("mangaplay-studio.googleDocsSync.popover.title", "Sync"));

    // ── Header (title + padlock) ──
    const header = document.createElement("div");
    header.className = "sync-popover-header";
    const headerTitle = document.createElement("span");
    headerTitle.className = "sync-popover-header-title";
    headerTitle.textContent = t("mangaplay-studio.googleDocsSync.popover.title", "Sync");
    header.appendChild(headerTitle);
    if (opts.onPadlock)
    {
        const padlockBtn = document.createElement("button");
        padlockBtn.type = "button";
        padlockBtn.className = "sync-popover-padlock sync-padlock";
        const ls = /** @type {LockState} */ (opts.lockState || "unsynced");
        padlockBtn.dataset.state = ls;
        padlockBtn.innerHTML = lockSvg(ls);
        padlockBtn.disabled = (ls === "unsynced");
        padlockBtn.setAttribute("aria-label", "Lock");
        padlockBtn.addEventListener("click", (ev) =>
        {
            ev.stopPropagation();
            if (opts.onPadlock) Promise.resolve(opts.onPadlock()).catch(() => {});
        });
        header.appendChild(padlockBtn);
    }
    root.appendChild(header);

    // ── Filename ──
    if (opts.filename)
    {
        const fnRow = document.createElement("div");
        fnRow.className = "sync-popover-filename";
        fnRow.textContent = opts.filename;
        root.appendChild(fnRow);
    }

    // ── Status row ──
    const statusRow = document.createElement("div");
    statusRow.className = "sync-popover-row";
    const statusLabel = document.createElement("span");
    statusLabel.className = "sync-popover-label";
    statusLabel.textContent = t("mangaplay-studio.googleDocsSync.popover.status", "Status:");
    const statusValue = document.createElement("span");
    statusValue.className = "sync-popover-value";
    statusValue.dataset.state = opts.state;
    statusValue.textContent = humaniseSyncState({
        state: opts.state,
        lastCheckedAt: opts.lastCheckedAt || null
    });
    statusRow.appendChild(statusLabel);
    statusRow.appendChild(statusValue);
    root.appendChild(statusRow);

    // ── Primary actions ──
    const actions = document.createElement("div");
    actions.className = "sync-popover-actions";

    const pushBtn = _button(
        t("mangaplay-studio.googleDocsSync.popover.push", "Push to Google Docs™"),
        opts.state === "local-ahead" ? "primary" : "secondary",
        async () =>
        {
            if (opts.onPush) await opts.onPush();
            closeSyncPopover();
        });
    const pullBtn = _button(
        t("mangaplay-studio.googleDocsSync.popover.pull", "Pull from Google Docs™"),
        opts.state === "remote-ahead" ? "primary" : "secondary",
        async () =>
        {
            if (opts.onPull) await opts.onPull();
            closeSyncPopover();
        });
    const viewBtn = _button(
        `${t("mangaplay-studio.googleDocsSync.popover.view", "View in Browser")} ↗`,
        "secondary",
        async () =>
        {
            if (opts.onViewInBrowser) await opts.onViewInBrowser();
            // Don't close — the user may still want to act in-app.
        });

    actions.appendChild(pushBtn);
    actions.appendChild(pullBtn);
    actions.appendChild(viewBtn);
    root.appendChild(actions);

    // ── Divider + secondary actions ──
    const divider = document.createElement("div");
    divider.className = "sync-popover-divider";
    root.appendChild(divider);

    const secondary = document.createElement("div");
    secondary.className = "sync-popover-actions";

    const refreshBtn = _button(
        t("mangaplay-studio.googleDocsSync.popover.refresh", "Refresh now"),
        "secondary",
        async () =>
        {
            if (opts.onRefresh) await opts.onRefresh();
            closeSyncPopover();
        });

    const unlinkBtn = _button(
        t("mangaplay-studio.googleDocsSync.popover.unlink", "Unlink"),
        "secondary",
        async () =>
        {
            const ok = window.confirm(
                t("mangaplay-studio.googleDocsSync.popover.unlinkConfirm",
                  "Unlink from Google Docs™? Local file stays, Drive document stays, but they'll no longer sync."));
            if (!ok) return;
            if (opts.onUnlink) await opts.onUnlink();
            closeSyncPopover();
        });

    secondary.appendChild(refreshBtn);
    secondary.appendChild(unlinkBtn);
    root.appendChild(secondary);

    document.body.appendChild(root);
    _anchorAbove(root, opts.anchor);

    // ── Outside-click + Escape ──
    /** @param {MouseEvent} ev */
    const onDocClick = (ev) =>
    {
        if (!activePopover) return;
        const target = /** @type {Node|null} */ (ev.target);
        if (!target) return;
        if (root.contains(target)) return;
        if (opts.anchor.contains(target)) return;
        closeSyncPopover();
    };
    /** @param {KeyboardEvent} ev */
    const onKey = (ev) =>
    {
        if (ev.key === "Escape") closeSyncPopover();
    };

    // Defer click binding by one frame so the click that opened the
    // popover doesn't immediately close it.
    requestAnimationFrame(() =>
    {
        document.addEventListener("click", onDocClick, true);
    });
    document.addEventListener("keydown", onKey, true);

    const dispose = () =>
    {
        try { document.removeEventListener("click", onDocClick, true); } catch {}
        try { document.removeEventListener("keydown", onKey, true); } catch {}
        try { root.remove(); } catch {}
    };
    activePopover = { root, dispose };
}

export function closeSyncPopover()
{
    if (activePopover)
    {
        const cur = activePopover;
        activePopover = null;
        cur.dispose();
    }
}

/**
 * @param {HTMLElement} popover
 * @param {HTMLElement} anchor
 */
function _anchorAbove(popover, anchor)
{
    const rect = anchor.getBoundingClientRect();
    popover.style.position = "fixed";
    popover.style.zIndex = "10000";
    const ph = popover.offsetHeight || 200;
    // Right-align with the anchor; sit above it.
    const right = Math.max(8, window.innerWidth - rect.right);
    const top = Math.max(8, rect.top - ph - 8);
    popover.style.right = `${right}px`;
    popover.style.left = "auto";
    popover.style.top = `${top}px`;
    popover.style.maxWidth = "280px";
}

/**
 * Build a footer-row button with a stop-propagated click handler. The CSS
 * class prefix is parameterised so the same factory powers both the sync
 * popover and the conflict toast — each call site passes its own prefix
 * (e.g. `"sync-popover-btn"` or `"gds-conflict-toast-btn"`).
 *
 * @param {string} classPrefix
 * @param {string} label
 * @param {"primary"|"secondary"} kind
 * @param {() => (void|Promise<void>)} onClick
 * @returns {HTMLButtonElement}
 */
export function makeFooterButton(classPrefix, label, kind, onClick)
{
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `${classPrefix} ${classPrefix}-${kind}`;
    btn.textContent = label;
    btn.addEventListener("click", (ev) =>
    {
        ev.stopPropagation();
        try { Promise.resolve(onClick()).catch(() => {}); }
        catch {}
    });
    return btn;
}

/**
 * @param {string} label
 * @param {"primary"|"secondary"} kind
 * @param {() => (void|Promise<void>)} onClick
 */
function _button(label, kind, onClick)
{
    return makeFooterButton("sync-popover-btn", label, kind, onClick);
}
