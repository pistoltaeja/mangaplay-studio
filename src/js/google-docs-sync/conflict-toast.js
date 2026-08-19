// @ts-check
/**
 * conflict-toast.js — top-anchored "Someone else edited X in Google Docs"
 * toast with the Keep mine / Keep theirs / Open both buttons.
 *
 * Conflict — plain-language UX. Renders once at a time (singleton); calling `showConflictToast` again
 * dismisses the previous toast before opening a new one. Auto-dismisses on
 * action click; manual dismiss via the "×" close button.
 *
 * No global toast helper exists in mangaplay-studio at the moment (the
 * settings-modal has a private `showToast` but it's scoped to that file), so
 * this is a self-contained DOM factory that injects its own scoped CSS the
 * first time it's used.
 */

import { t } from "../adapters/tauri-i18n.js";
import { makeFooterButton } from "./sync-popover.js";

/** @type {{ root: HTMLElement, dispose: () => void } | null} */
let active = null;
let stylesInjected = false;

/**
 * @typedef {Object} ConflictToastOpts
 * @property {string} title                                  — document title
 * @property {() => (void|Promise<void>)} [onKeepMine]
 * @property {() => (void|Promise<void>)} [onKeepTheirs]
 * @property {() => (void|Promise<void>)} [onOpenBoth]
 */

/**
 * Open the conflict toast. Closes any previously open instance first.
 *
 * @param {ConflictToastOpts} opts
 * @returns {{ dismiss: () => void }}
 */
export function showConflictToast(opts)
{
    dismissConflictToast();
    _ensureStyles();

    const root = document.createElement("div");
    root.className = "gds-conflict-toast";
    root.setAttribute("role", "alert");
    root.setAttribute("aria-live", "assertive");

    const message = document.createElement("div");
    message.className = "gds-conflict-toast-message";
    const tpl = t(
        "mangaplay-studio.googleDocsSync.conflict.toastMessage",
        "Someone else edited \"{title}\" in Google Docs™.");
    message.textContent = tpl.replace("{title}", opts.title || "");
    root.appendChild(message);

    const actions = document.createElement("div");
    actions.className = "gds-conflict-toast-actions";

    const mineBtn = _button(
        t("mangaplay-studio.googleDocsSync.conflict.keepMine", "Keep my version"),
        "primary",
        async () =>
        {
            if (opts.onKeepMine) await opts.onKeepMine();
            dismissConflictToast();
        });

    const theirsBtn = _button(
        t("mangaplay-studio.googleDocsSync.conflict.keepTheirs", "Keep their version"),
        "secondary",
        async () =>
        {
            if (opts.onKeepTheirs) await opts.onKeepTheirs();
            dismissConflictToast();
        });

    const bothBtn = _button(
        `${t("mangaplay-studio.googleDocsSync.conflict.openBoth", "Open both")} ↗`,
        "secondary",
        async () =>
        {
            if (opts.onOpenBoth) await opts.onOpenBoth();
            // Don't auto-dismiss — opening the doc in a browser doesn't
            // resolve the conflict, only the Keep buttons do.
        });

    actions.appendChild(mineBtn);
    actions.appendChild(theirsBtn);
    actions.appendChild(bothBtn);
    root.appendChild(actions);

    // Close button (×) — far-right.
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "gds-conflict-toast-close";
    closeBtn.setAttribute("aria-label",
        t("mangaplay-studio.googleDocsSync.conflict.dismiss", "Dismiss"));
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (ev) =>
    {
        ev.stopPropagation();
        dismissConflictToast();
    });
    root.appendChild(closeBtn);

    document.body.appendChild(root);

    const dispose = () =>
    {
        try { root.remove(); } catch {}
    };
    active = { root, dispose };

    return { dismiss: dismissConflictToast };
}

/**
 * Dismiss the active conflict toast, if any. Idempotent.
 */
export function dismissConflictToast()
{
    if (active)
    {
        const cur = active;
        active = null;
        cur.dispose();
    }
}

/**
 * @param {string} label
 * @param {"primary"|"secondary"} kind
 * @param {() => (void|Promise<void>)} onClick
 */
function _button(label, kind, onClick)
{
    return makeFooterButton("gds-conflict-toast-btn", label, kind, onClick);
}

function _ensureStyles()
{
    if (stylesInjected) return;
    if (typeof document === "undefined") return;
    const style = document.createElement("style");
    style.setAttribute("data-gds-conflict-toast", "");
    style.textContent = `
.gds-conflict-toast
{
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px 10px 14px;
    background: var(--bg-elevated, #1f1f1f);
    color: var(--text-default, #fafafa);
    border: 1px solid var(--accent-red, #d54a4a);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    font-size: 13px;
    z-index: 10001;
    max-width: 90vw;
}
.gds-conflict-toast-message
{
    flex: 1;
    min-width: 0;
    line-height: 1.4;
}
.gds-conflict-toast-actions
{
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}
.gds-conflict-toast-btn
{
    background: transparent;
    color: inherit;
    border: 1px solid var(--border-subtle, rgba(255,255,255,0.15));
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    line-height: 1.3;
}
.gds-conflict-toast-btn:hover
{
    background: var(--bg-hover, rgba(255,255,255,0.06));
}
.gds-conflict-toast-btn-primary
{
    background: var(--accent-blue, #3b82f6);
    border-color: transparent;
    color: #fff;
}
.gds-conflict-toast-btn-primary:hover
{
    background: var(--accent-blue-hover, #2563eb);
}
.gds-conflict-toast-close
{
    background: transparent;
    border: 0;
    color: inherit;
    font-size: 18px;
    line-height: 1;
    padding: 2px 6px;
    cursor: pointer;
    opacity: 0.7;
}
.gds-conflict-toast-close:hover
{
    opacity: 1;
}
`;
    document.head.appendChild(style);
    stylesInjected = true;
}
