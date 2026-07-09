// @ts-check
/**
 * mps-mobile-tabbar.js — bottom tab bar for the mobile / tablet UX modes.
 *
 * Mounts only when isMobileLike() returns true. Three tabs: Files /
 * Editor / Storyboard. Tapping a tab flips `<html data-active-pane>` so
 * CSS reveals the right pane and hides the others.
 *
 * Every tab switch re-measures the now-visible pane (review item #4):
 *   - canvas: fitToContainer(true) — clientWidth/Height are 0 while hidden.
 *   - editor: EditorView.requestMeasure() — CM6 gutters paint stale otherwise.
 *
 * Both calls are no-ops in standalone (the tabbar isn't mounted).
 */

import { isMobileLike, getActivePane, setActivePane } from "../boot/ux-mode.js";
import { t } from "../adapters/tauri-i18n.js";
import { escapeAttr } from "../util/index.js";

/**
 * Re-measure the workspace after a tab switch reveals a hidden pane.
 * Exported so any other tab-show path (settings → workspace, etc.) can
 * trigger the same fix without duplicating the logic.
 */
export function remeasureWorkspace()
{
    requestAnimationFrame(() =>
    {
        const c = /** @type {any} */ (document.querySelector("mps-canvas"));
        if (c)
        {
            try { c.fitToContainer?.(true); } catch (_) {}
            try { c.resizeDrawingCanvas?.(); } catch (_) {}
        }
        // CM6 editor: dispatch a no-op transition so the view re-measures.
        // mps-editor.js exposes the active EditorView via getActiveView().
        try
        {
            const evRef = /** @type {any} */ (window).__mpsActiveEditorView;
            if (evRef && typeof evRef.requestMeasure === "function")
            {
                evRef.requestMeasure();
            }
        }
        catch (_) {}
    });
}

class MpsMobileTabbar extends HTMLElement
{
    constructor()
    {
        super();
        this._onActivePaneChange = this._onActivePaneChange.bind(this);
    }

    connectedCallback()
    {
        if (!isMobileLike()) return; // defensive — only mount in mobile-like modes
        this._render();
        document.addEventListener("mps-active-pane-change", this._onActivePaneChange);
        document.addEventListener("mps-lang-change", () => this._render());
    }

    disconnectedCallback()
    {
        document.removeEventListener("mps-active-pane-change", this._onActivePaneChange);
    }

    _render()
    {
        const active = getActivePane();
        this.innerHTML = `
            <button type="button" class="mps-tabbar-btn" data-pane="files" aria-label="${escapeAttr(t("mangaplay-studio.ui.tabbar.files"))}" aria-pressed="${active === "files"}">
                <span class="mps-tabbar-icon">&#128193;</span>
                <span class="mps-tabbar-label">${escapeAttr(t("mangaplay-studio.ui.tabbar.files"))}</span>
            </button>
            <button type="button" class="mps-tabbar-btn" data-pane="editor" aria-label="${escapeAttr(t("mangaplay-studio.ui.tabbar.editor"))}" aria-pressed="${active === "editor"}">
                <span class="mps-tabbar-icon">&#9998;</span>
                <span class="mps-tabbar-label">${escapeAttr(t("mangaplay-studio.ui.tabbar.editor"))}</span>
            </button>
            <button type="button" class="mps-tabbar-btn" data-pane="storyboard" aria-label="${escapeAttr(t("mangaplay-studio.ui.tabbar.storyboard"))}" aria-pressed="${active === "storyboard"}">
                <span class="mps-tabbar-icon">&#9744;</span>
                <span class="mps-tabbar-label">${escapeAttr(t("mangaplay-studio.ui.tabbar.storyboard"))}</span>
            </button>
        `;
        this.setAttribute("role", "tablist");

        this.querySelectorAll(".mps-tabbar-btn").forEach((btn) =>
        {
            btn.addEventListener("click", (e) =>
            {
                const pane = /** @type {HTMLElement} */ (e.currentTarget).dataset.pane;
                if (pane === "files" || pane === "editor" || pane === "storyboard")
                {
                    setActivePane(pane);
                }
            });
        });
    }

    _onActivePaneChange()
    {
        // Update aria-pressed without rebuilding the DOM.
        const active = getActivePane();
        this.querySelectorAll(".mps-tabbar-btn").forEach((btn) =>
        {
            const b = /** @type {HTMLElement} */ (btn);
            b.setAttribute("aria-pressed", b.dataset.pane === active ? "true" : "false");
        });
        remeasureWorkspace();
    }
}

if (typeof customElements !== "undefined" && !customElements.get("mps-mobile-tabbar"))
{
    customElements.define("mps-mobile-tabbar", MpsMobileTabbar);
}

