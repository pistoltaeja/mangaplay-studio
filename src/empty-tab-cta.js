// @ts-check
/**
 * empty-tab-cta.js — Obsidian-style CTA shown inside the editor host
 * whenever the active slot is a path-null placeholder (the "Create
 * New file" tab).
 *
 * Three actions:
 *   - Create a new Storyboard  → mangaplay file at project root, opens
 *                                in current tab, switches to Visual mode.
 *   - Create a new Screenplay  → fountain file at project root, opens
 *                                in current tab, switches to Text mode.
 *   - Close                    → closes the active empty tab; the slot
 *                                manager auto-spawns a fresh one.
 *
 * Click handlers are wired here so the host (app.js) only needs to pass
 * three thin callbacks.
 */

import { t } from "./adapters/tauri-i18n.js";

/**
 * @typedef {object} CtaHandlers
 * @property {() => void | Promise<void>} onCreateStoryboard
 * @property {() => void | Promise<void>} onCreateScreenplay
 * @property {() => void | Promise<void>} onClose
 */

/**
 * @param {HTMLElement} hostEl
 * @param {CtaHandlers} handlers
 * @returns {{ setVisible: (show: boolean) => void, destroy: () => void }}
 */
export function mountEmptyTabCta(hostEl, handlers)
{
    const overlay = document.createElement("div");
    overlay.className = "empty-tab-cta";
    overlay.hidden = true;

    const list = document.createElement("div");
    list.className = "empty-tab-cta-list";

    /** @param {string} labelKey @param {string} fallback @param {() => void | Promise<void>} fn */
    function addLink(labelKey, fallback, fn)
    {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "empty-tab-cta-link";
        btn.textContent = t(labelKey, fallback);
        btn.addEventListener("click", (e) =>
        {
            e.preventDefault();
            try { Promise.resolve(fn()).catch(() => {}); }
            catch (_e) { /* swallow — CTA is best-effort */ }
        });
        list.appendChild(btn);
    }

    addLink("mangaplay-studio.tabs.createStoryboardCta",
        "Create a new Storyboard",
        handlers.onCreateStoryboard);
    addLink("mangaplay-studio.tabs.createScreenplayCta",
        "Create a new Screenplay",
        handlers.onCreateScreenplay);
    addLink("mangaplay-studio.tabs.closeCta",
        "Close",
        handlers.onClose);

    overlay.appendChild(list);
    hostEl.appendChild(overlay);

    /** @param {boolean} show */
    function setVisible(show)
    {
        overlay.hidden = !show;
        if (show) hostEl.dataset.showCta = "";
        else delete hostEl.dataset.showCta;
    }

    function destroy()
    {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    return { setVisible, destroy };
}
