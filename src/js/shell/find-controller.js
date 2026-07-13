// @ts-check
/**
 * find-controller.js — glue between `<mps-find-widget>` and the active
 * editor. Two engines are supported:
 *
 *   - CodeMirror (Source / Text editor modes) — decorations painted
 *     directly on the EditorView via `../editor/find-engine.js`.
 *   - Visual Editor (`<mps-visual-editor>`) — `.panel-card` rectangle
 *     highlights + native input selection via
 *     `../components/visual-editor-find.js`.
 *
 * Target selection at `openFind()` time:
 *   1. If `<mps-visual-editor>` is present and visible (display !== "none"),
 *      the visual engine wins.
 *   2. Otherwise the currently-focused CM6 view (via focused-view-registry)
 *      is bound.
 */

import "../components/mps-find-widget.js";
import { getFocusedView } from "../editor/focused-view-registry.js";
import {
    runFindOn as cmRunFindOn,
    step as cmStep,
    clearFind as cmClearFind
} from "../editor/find-engine.js";
import {
    runFindOn as veRunFindOn,
    step as veStep,
    clearFind as veClearFind
} from "../components/visual-editor-find.js";

/** @type {HTMLElement | null} */
let widgetEl = null;

/**
 * @typedef {{ kind: "cm", view: import("@codemirror/view").EditorView } |
 *           { kind: "visual", el: HTMLElement }} FindTarget
 */

/** @type {FindTarget | null} */
let target = null;

/** @type {string} */
let lastQuery = "";

/** @returns {HTMLElement | null} */
function findVisualEditor()
{
    const el = /** @type {HTMLElement | null} */ (
        document.querySelector("mps-visual-editor")
    );
    if (!el) return null;
    if (el.style.display === "none") return null;
    if (el.offsetParent === null && el.getClientRects().length === 0) return null;
    return el;
}

/** @returns {FindTarget | null} */
function pickTarget()
{
    const visual = findVisualEditor();
    if (visual) return { kind: "visual", el: visual };
    const view = getFocusedView();
    if (view) return { kind: "cm", view };
    return null;
}

/** @param {FindTarget} t @param {string} q */
function runOn(t, q)
{
    return t.kind === "cm" ? cmRunFindOn(t.view, q) : veRunFindOn(t.el, q);
}
/** @param {FindTarget} t @param {"next"|"prev"} dir */
function stepOn(t, dir)
{
    return t.kind === "cm" ? cmStep(t.view, dir) : veStep(t.el, dir);
}
/** @param {FindTarget} t */
function clearOn(t)
{
    if (t.kind === "cm") cmClearFind(t.view);
    else veClearFind(t.el);
}

function ensureWidget()
{
    if (widgetEl) return widgetEl;
    const el = document.querySelector("mps-find-widget");
    if (!el)
    {
        const host = document.querySelector("mps-editor-host")
            || document.querySelector("main.workspace")
            || document.body;
        const w = /** @type {HTMLElement} */ (document.createElement("mps-find-widget"));
        w.hidden = true;
        host.appendChild(w);
        widgetEl = w;
    }
    else
    {
        widgetEl = /** @type {HTMLElement} */ (el);
    }

    widgetEl.addEventListener("find:query", (/** @type {any} */ ev) =>
    {
        const q = String(ev.detail?.query ?? "");
        lastQuery = q;
        if (!target) { updateCount(0, 0); return; }
        if (!q)
        {
            clearOn(target);
            updateCount(0, 0);
            return;
        }
        const { total, current } = runOn(target, q);
        updateCount(current, total);
    });

    widgetEl.addEventListener("find:next", () => advance("next"));
    widgetEl.addEventListener("find:prev", () => advance("prev"));
    widgetEl.addEventListener("find:close", () => closeFind());

    return widgetEl;
}

/** @param {"next"|"prev"} dir */
function advance(dir)
{
    if (!target) return;
    const q = /** @type {any} */ (widgetEl)?.getQuery?.() ?? "";
    if (!q) return;
    if (q !== lastQuery)
    {
        lastQuery = q;
        const { total, current } = runOn(target, q);
        updateCount(current, total);
        return;
    }
    const { total, current } = stepOn(target, dir);
    updateCount(current, total);
}

/** @param {number} current @param {number} total */
function updateCount(current, total)
{
    /** @type {any} */ (widgetEl)?.setMatches?.(current, total);
}

/**
 * Open the find widget bound to whichever editor is currently active.
 */
export function openFind()
{
    const w = ensureWidget();
    target = pickTarget();
    /** @type {any} */ (w).open?.(lastQuery);
    if (target && lastQuery)
    {
        const { total, current } = runOn(target, lastQuery);
        updateCount(current, total);
    }
    else
    {
        updateCount(0, 0);
    }
}

export function closeFind()
{
    if (widgetEl) /** @type {any} */ (widgetEl).close?.();
    if (target)
    {
        clearOn(target);
        if (target.kind === "cm")
        {
            try { target.view.focus(); } catch (_) { /* view may be gone */ }
        }
    }
}

export function toggleFind()
{
    const w = ensureWidget();
    if (/** @type {any} */ (w).isOpen?.()) closeFind();
    else openFind();
}

/**
 * Return true when any overlaying popup (modal, context menu, dropdown,
 * popover) is live in the DOM. Used to defer Escape → Find so that the
 * popup consumes the first Escape and Find consumes the second.
 *
 * Selector list matches every popup class the app currently uses:
 *   .settings-backdrop  — modal shells (settings, confirm, help, export...)
 *   .ctx-menu           — right-click / More Options context menu
 *   .footer-mode-menu   — editor-mode picker in the app footer
 *   .sync-popover       — Google Docs sync padlock popover
 *   .mps-toast          — transient toast (rare, but still overlays)
 *
 * @param {HTMLElement} widgetEl - the find widget; excluded from the check
 * @returns {boolean}
 */
function hasOpenPopupOver(widgetEl)
{
    const nodes = document.querySelectorAll(
        ".settings-backdrop, .ctx-menu, .footer-mode-menu, .sync-popover"
    );
    for (const n of nodes)
    {
        if (n === widgetEl || widgetEl.contains(n)) continue;
        return true;
    }
    return false;
}

/**
 * Global keyboard shortcuts. Installed once at boot.
 *
 * Two separate listeners with different phases so Escape layers correctly:
 *
 *   - Ctrl/Cmd+F: window CAPTURE phase — beats WebView2's native find
 *     popup and any downstream handler.
 *   - Escape:     document BUBBLE phase — runs LAST, so any popup /
 *     modal / dropdown Escape handler (which all listen on
 *     `document.addEventListener("keydown", ...)` bubble phase) gets to
 *     run first and, if it wants exclusive control, can `stopPropagation`
 *     to swallow the event before it reaches Find. If nothing else
 *     handled it and the widget is open, Find closes.
 */
export function installFindShortcut()
{
    window.addEventListener("keydown", (e) =>
    {
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && (e.key === "f" || e.key === "F"))
        {
            e.preventDefault();
            e.stopPropagation();
            openFind();
        }
    }, { capture: true });

    document.addEventListener("keydown", (e) =>
    {
        if (e.key !== "Escape") return;
        if (e.defaultPrevented) return;
        if (!widgetEl || !(/** @type {any} */ (widgetEl).isOpen?.())) return;
        // Defer to any open popup / modal / dropdown. Their own Escape
        // handlers should close them first; the NEXT Escape closes Find.
        if (hasOpenPopupOver(widgetEl)) return;
        e.preventDefault();
        closeFind();
    });
}
