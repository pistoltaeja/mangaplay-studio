// @ts-check
/**
 * editor-tabs.js — render the Chrome-style tab strip in the global top bar.
 *
 * Consumes the slot manager: `manager.list()` and `manager.activeTabId`.
 * The slot manager is constructed AFTER `mountEditorTabs()` runs (so the
 * manager's `onTabsChanged` hook can call `editorTabs.render()`). Until
 * `setManager()` is called, click handlers no-op.
 *
 * Tab DOM:
 *   <button class="editor-tab" data-tab-id data-active data-tooltip>
 *     <span class="editor-tab-name">label</span>
 *     <span class="editor-tab-close" role="button" aria-label="Close tab">
 *       <span data-icon="x"></span>
 *     </span>
 *   </button>
 *   ... more tabs ...
 *   <button class="editor-tab-new" data-tooltip="New tab">
 *     <span data-icon="plus"></span>
 *   </button>
 */

import { stripFormatExtensions } from "./lang-registry.js";
import { icon } from "./icons.js";
import { t } from "./adapters/tauri-i18n.js";
import { escapeHtml } from "./util/escape-html.js";

/**
 * Resolve the label for a slot. Untitled scratch tabs (no path, empty
 * basename) get the localised "New tab" string; otherwise strip format
 * extensions from the basename.
 * @param {import("./editor-slot-manager.js").EditorSlot} slot
 * @returns {string}
 */
function labelForSlot(slot)
{
    if (slot.path === null && slot.basename === "")
    {
        return t("mangaplay-studio.tabs.newTab", "New tab");
    }
    return stripFormatExtensions(slot.basename);
}

/**
 * Mount the tab strip into the given container element. Reads tabs from
 * the slot manager; rebuilds the strip whenever the manager fires
 * `onTabsChanged`. Click handlers route into the slot manager.
 *
 * The slot manager is passed in lazily via `setManager()` because the
 * manager's constructor needs an `onTabsChanged: () => editorTabs.render()`
 * hook that points back at the value returned by THIS function. Pattern:
 *
 *   const editorTabs = mountEditorTabs(tabBarEl, null, { onNewTab });
 *   const manager = new EditorSlotManager(hostEl, tabBarEl, {
 *       ...,
 *       onTabsChanged: () => editorTabs.render()
 *   });
 *   editorTabs.setManager(manager);
 *
 * @param {HTMLElement} container - the .top-bar-tabs <div> from index.html
 * @param {import("./editor-slot-manager.js").EditorSlotManager | null} slotManager
 * @param {object} [hooks]
 * @param {(path: string | null) => void} [hooks.onNewTab]
 *   - called on "+" click. If omitted, defaults to
 *     slotManager.openNew(null, "", "general-text").
 * @returns {{ render: () => void, destroy: () => void, setManager: (m: import("./editor-slot-manager.js").EditorSlotManager) => void }}
 */
export function mountEditorTabs(container, slotManager, hooks = {})
{
    /** @type {import("./editor-slot-manager.js").EditorSlotManager | null} */
    let manager = slotManager;

    /**
     * Delegated click handler on the tab strip. Differentiates between:
     *   - close X button (or its icon child) → close()
     *   - tab body → activate()
     *   - "+" button → onNewTab
     */
    function onClick(event)
    {
        if (!manager) return;
        const target = /** @type {HTMLElement} */ (event.target);

        // "+" new-tab button.
        const plusEl = target.closest(".editor-tab-new");
        if (plusEl)
        {
            event.preventDefault();
            if (hooks.onNewTab)
            {
                hooks.onNewTab(null);
            }
            else
            {
                manager.openNew(null, "", "general-text");
            }
            return;
        }

        // Close X (clicked anywhere inside .editor-tab-close, including its
        // icon span).
        const closeEl = target.closest(".editor-tab-close");
        if (closeEl)
        {
            event.preventDefault();
            event.stopPropagation();
            const tabEl = closeEl.closest(".editor-tab");
            const tabId = tabEl instanceof HTMLElement ? tabEl.dataset.tabId : null;
            if (tabId && tabEl instanceof HTMLElement)
            {
                // Animate the tab's collapse-to-0 width via the CSS
                // [data-closing] rule, then destroy the slot. The 140ms
                // matches the CSS `transition: flex-basis 140ms ease`.
                tabEl.dataset.closing = "";
                setTimeout(() =>
                {
                    /** @type {import("./editor-slot-manager.js").EditorSlotManager | null} */
                    const m = manager;
                    m?.close(tabId);
                }, 140);
            }
            return;
        }

        // Tab body — activate.
        const tabEl = target.closest(".editor-tab");
        if (tabEl instanceof HTMLElement && tabEl.dataset.tabId)
        {
            event.preventDefault();
            manager.activate(tabEl.dataset.tabId);
        }
    }

    container.addEventListener("click", onClick);

    /**
     * Rebuild the entire strip from `manager.list()` and `manager.activeTabId`.
     * Cheap — the strip is small (< 20 tabs in practice). Untitled tabs and
     * close-button tooltip text are resolved via `t()` on every render so
     * locale changes are picked up automatically.
     */
    function render()
    {
        if (!manager)
        {
            container.innerHTML = "";
            return;
        }

        const slots = manager.list();
        const activeId = manager.activeTabId;
        const xIconSvg = icon("x", { size: 12 });
        const plusIconSvg = icon("plus", { size: 14 });
        const closeLabel = t("mangaplay-studio.tabs.closeTab", "Close tab");
        const newTabLabel = t("mangaplay-studio.tabs.newTab", "New tab");

        const tabsHtml = slots.map((slot) =>
        {
            const label = labelForSlot(slot);
            const isActive = slot.tabId === activeId;
            return `<button class="editor-tab" data-tab-id="${escapeHtml(slot.tabId)}"`
                 + `${isActive ? " data-active" : ""}`
                 + ` data-tooltip="${escapeHtml(label)}"`
                 + ` data-tooltip-side="bottom"`
                 + ` type="button">`
                 + `<span class="editor-tab-name">${escapeHtml(label)}</span>`
                 + `<span class="editor-tab-close" role="button"`
                 + ` aria-label="${escapeHtml(closeLabel)}"`
                 + ` data-tooltip="${escapeHtml(closeLabel)}"`
                 + ` data-tooltip-side="bottom"`
                 + ` tabindex="-1">`
                 + `<span data-icon="x">${xIconSvg}</span>`
                 + `</span>`
                 + `</button>`;
        }).join("");

        const plusHtml = `<button class="editor-tab-new" type="button"`
                      + ` data-tooltip="${escapeHtml(newTabLabel)}"`
                      + ` data-tooltip-side="bottom"`
                      + ` aria-label="${escapeHtml(newTabLabel)}">`
                      + `<span data-icon="plus">${plusIconSvg}</span>`
                      + `</button>`;

        container.innerHTML = `<div class="editor-tabs">${tabsHtml}${plusHtml}</div>`;
    }

    /**
     * Wire a back-reference to the slot manager after this module has been
     * mounted (the manager is constructed later so its onTabsChanged hook can
     * call render()). Triggers an initial render once the manager is known.
     * @param {import("./editor-slot-manager.js").EditorSlotManager} m
     */
    function setManager(m)
    {
        manager = m;
        render();
    }

    function destroy()
    {
        container.removeEventListener("click", onClick);
        container.innerHTML = "";
        manager = null;
    }

    // If a manager was passed in eagerly, render now.
    if (manager) render();

    return { render, destroy, setManager };
}
