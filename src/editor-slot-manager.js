// @ts-check
/**
 * editor-slot-manager.js — owns one CodeMirror 6 view per open tab.
 *
 * Tab identity is a fresh per-tab id (crypto.randomUUID()), NOT the path —
 * duplicate tabs of the same file are allowed. The manager is DOM-light:
 * it owns the `.editor-slot` containers inside the `<mps-editor-host>`
 * element, but it does NOT render the tab strip. A separate tab-strip
 * module subscribes to `hooks.onTabsChanged()` and paints from
 * `manager.list()` + `manager.activeTabId`.
 *
 * Inactive slot containers stay mounted with `style.display = "none"`;
 * the active slot has `data-active` and a cleared display. CM6 measure
 * is deferred to a `requestAnimationFrame` after activation so the
 * layout has flushed before `view.requestMeasure()` runs.
 */

import { buildEditor } from "./mps-editor.js";
import { formatForFilename, stripFormatExtensions } from "./lang-registry.js";

/**
 * @typedef {object} EditorSlot
 * @property {string} tabId
 * @property {string|null} path
 * @property {string} basename
 * @property {import("@codemirror/view").EditorView} view
 * @property {HTMLDivElement} container
 * @property {import("./lang-registry.js").EditorFormat} format
 * @property {number} lastActivatedAt
 * @property {number} pageIndex
 * @property {any} parsedAst
 */

/**
 * @typedef {object} SlotManagerHooks
 * @property {(slot: EditorSlot, text: string) => void} onChange
 * @property {(slot: EditorSlot) => void} onActivate
 * @property {(slot: EditorSlot) => Promise<void>} onCloseRequest
 * @property {() => void} onTabsChanged
 */

/**
 * Derive the basename portion of an absolute path.
 * @param {string|null} path
 * @returns {string}
 */
function basenameOf(path)
{
    if (!path) return "";
    const s = String(path);
    const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return slash >= 0 ? s.slice(slash + 1) : s;
}

/**
 * Allocate a fresh tab id. Prefers crypto.randomUUID(); falls back for
 * older runtimes without crypto.randomUUID.
 * @returns {string}
 */
function allocTabId()
{
    const c = /** @type {any} */ (globalThis).crypto;
    if (c && typeof c.randomUUID === "function")
    {
        return c.randomUUID();
    }
    return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class EditorSlotManager
{
    /**
     * @param {HTMLElement} hostEl  - the `<mps-editor-host>` element
     * @param {HTMLElement|null} tabsEl - the tab strip container (may be null
     *                                    until the tab-strip module wires
     *                                    itself; manager just stores it)
     * @param {SlotManagerHooks} hooks
     */
    constructor(hostEl, tabsEl, hooks)
    {
        this.hostEl = hostEl;
        this.tabsEl = tabsEl;
        this.hooks = hooks;
        /** @type {EditorSlot[]} */
        this.slots = [];
        /** @type {string|null} */
        this.activeTabId = null;
    }

    /**
     * Open `path` with `text` in a NEW tab. Returns the new slot.
     * If `path` is null, opens an empty "new tab" with no file association.
     * @param {string|null} path
     * @param {string} text
     * @param {import("./lang-registry.js").EditorFormat} [format]
     * @returns {EditorSlot}
     */
    openNew(path, text, format)
    {
        const basename = path ? basenameOf(path) : "";
        const resolvedFormat = format ?? formatForFilename(basename);

        const container = document.createElement("div");
        container.className = "editor-slot";
        const tabId = allocTabId();
        container.dataset.tabId = tabId;
        if (path) container.dataset.path = path;
        // New slots start hidden; activate() flips the display.
        container.style.display = "none";
        this.hostEl.appendChild(container);

        // Build the slot record first so the onChange closure can reference it.
        /** @type {EditorSlot} */
        const slot = /** @type {any} */ ({
            tabId,
            path,
            basename,
            view: /** @type {any} */ (null),
            container,
            format: resolvedFormat,
            lastActivatedAt: 0,
            pageIndex: 0,
            parsedAst: null
        });

        const view = buildEditor(container, {
            doc: text,
            onChange: (newText) => this.hooks.onChange(slot, newText),
            format: resolvedFormat
        });
        slot.view = view;

        this.slots.push(slot);
        this.activate(tabId);
        this.hooks.onTabsChanged();
        return slot;
    }

    /**
     * Replace the content of the currently-active tab with `path` + `text`.
     * If no tab is active, behaves like `openNew`.
     * @param {string|null} path
     * @param {string} text
     * @param {import("./lang-registry.js").EditorFormat} [format]
     * @returns {EditorSlot}
     */
    replaceActive(path, text, format)
    {
        const slot = this.getActive();
        if (!slot)
        {
            return this.openNew(path, text, format);
        }

        const basename = path ? basenameOf(path) : "";
        const resolvedFormat = format ?? formatForFilename(basename);

        // Invalidate cached parse before any view mutation — the next
        // mps-change cycle re-populates it against the new doc.
        slot.parsedAst = null;

        if (slot.format === resolvedFormat)
        {
            // Same format: reuse the view, replace the doc in one dispatch.
            const view = slot.view;
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: text }
            });
        }
        else
        {
            // Different format: destroy the view and rebuild in the same
            // container so the language extensions reflect the new format.
            slot.view.destroy();
            const view = buildEditor(slot.container, {
                doc: text,
                onChange: (newText) => this.hooks.onChange(slot, newText),
                format: resolvedFormat
            });
            slot.view = view;
        }

        slot.path = path;
        slot.basename = basename;
        slot.format = resolvedFormat;
        slot.pageIndex = 0;

        if (path)
        {
            slot.container.dataset.path = path;
        }
        else
        {
            delete slot.container.dataset.path;
        }

        // Treat replace as a re-activation — the slot's CONTENT changed,
        // so any consumer of `onActivate` (CTA visibility, parse cache,
        // canvas pageIndex, etc.) must re-run against the new state.
        // Without this, file-explorer clicks on an empty tab would
        // re-label the tab but leave the editor's CTA overlay covering
        // the file content and skip the storyboard re-parse.
        this.hooks.onActivate(slot);
        this.hooks.onTabsChanged();
        return slot;
    }

    /**
     * Make `tabId` the visible slot. Returns the slot, or null if unknown.
     * @param {string} tabId
     * @returns {EditorSlot|null}
     */
    activate(tabId)
    {
        const next = this.get(tabId);
        if (!next) return null;

        // Defensively hide ALL slots except the target — earlier we only
        // hid the slot tracked by `activeTabId`, which left orphaned
        // visible slots if a previous activate() got interrupted mid-flow
        // or if `activeTabId` had drifted out of sync. Iterating every
        // slot guarantees only one is visible after this call returns.
        for (const s of this.slots)
        {
            if (s.tabId === tabId) continue;
            if (s.container.hasAttribute("data-active"))
            {
                delete s.container.dataset.active;
            }
            if (s.container.style.display !== "none")
            {
                s.container.style.display = "none";
            }
        }

        // Show the new active slot.
        next.container.dataset.active = "";
        next.container.style.display = "";
        next.lastActivatedAt = Date.now();
        this.activeTabId = tabId;

        // Mirror the active view onto the legacy global so editor-clipboard /
        // context menu / existing smoke tests that query `__mpsActiveEditorView`
        // continue to see the current slot's view, not the most-recently-mounted
        // one.
        /** @type {any} */ (window).__mpsActiveEditorView = next.view;

        // CM6 measure code is lazy — a view in display:none has a zero rect.
        // Defer the remeasure to after layout has flushed.
        requestAnimationFrame(() =>
        {
            try { next.view.requestMeasure(); }
            catch (_e) { /* view may have been destroyed mid-frame */ }
            try { next.view.focus(); }
            catch (_e) { /* focus may fail if container is detached */ }
        });

        this.hooks.onActivate(next);
        this.hooks.onTabsChanged();
        return next;
    }

    /**
     * Close & destroy the slot for `tabId`. Calls `onCloseRequest` first so
     * the caller can flush the broker. If the closed tab was the LAST tab,
     * automatically opens a fresh empty `openNew(null, "", "general-text")`
     * so the strip is never empty.
     * @param {string} tabId
     * @returns {Promise<void>}
     */
    async close(tabId)
    {
        const idx = this.slots.findIndex((s) => s.tabId === tabId);
        if (idx === -1) return;
        const slot = this.slots[idx];

        // Let the caller flush autosave for this slot's path before we drop
        // the in-memory view.
        await this.hooks.onCloseRequest(slot);

        const wasActive = this.activeTabId === tabId;

        // Tear down view + container.
        try { slot.view.destroy(); }
        catch (_e) { /* defensive: already destroyed */ }
        if (slot.container.parentNode)
        {
            slot.container.parentNode.removeChild(slot.container);
        }
        this.slots.splice(idx, 1);

        if (wasActive)
        {
            this.activeTabId = null;
            if (this.slots.length === 0)
            {
                // Invariant: tab strip is never empty.
                this.openNew(null, "", "general-text");
                return; // openNew calls onTabsChanged for us.
            }
            // Prefer the tab to the right (now at the same index after splice);
            // fall back to the tab on the left if we just removed the rightmost.
            const nextIdx = idx < this.slots.length ? idx : this.slots.length - 1;
            this.activate(this.slots[nextIdx].tabId);
            return; // activate calls onTabsChanged for us.
        }

        this.hooks.onTabsChanged();
    }

    /**
     * Update the path/basename/format of the slot for `tabId`. Used by the
     * rename flow (user renames the file via the explorer) and by the
     * external-rename branch of the FS watcher. Does NOT rebuild the CM6
     * view; the doc stays untouched. Fires `onTabsChanged` so the tab
     * label re-renders.
     * @param {string} tabId
     * @param {string|null} newPath
     */
    renamePath(tabId, newPath)
    {
        const slot = this.slots.find((s) => s.tabId === tabId);
        if (!slot) return;
        slot.path = newPath;
        slot.basename = newPath
            ? (newPath.split(/[\\/]/).pop() || "")
            : "";
        if (newPath)
        {
            slot.format = /** @type {any} */ (formatForFilename(slot.basename));
            slot.container.dataset.path = newPath;
        }
        else
        {
            delete slot.container.dataset.path;
        }
        this.hooks.onTabsChanged?.();
    }

    /**
     * @returns {EditorSlot|null}
     */
    getActive()
    {
        if (!this.activeTabId) return null;
        return this.get(this.activeTabId);
    }

    /**
     * @param {string} tabId
     * @returns {EditorSlot|null}
     */
    get(tabId)
    {
        return this.slots.find((s) => s.tabId === tabId) ?? null;
    }

    /**
     * @returns {EditorSlot[]}
     */
    list()
    {
        return this.slots.slice();
    }

    /**
     * Snapshot for session persistence. Scratch tabs (path === null) are
     * persisted as placeholders only — body is not stored (locked decision
     * #8 in the plan).
     * @returns {{ openTabs: Array<{ id: string, path: string|null }>, activeTabId: string|null }}
     */
    serialize()
    {
        return {
            openTabs: this.slots.map((s) => ({ id: s.tabId, path: s.path })),
            activeTabId: this.activeTabId
        };
    }
}

// Re-export for callers that want the label helper alongside the manager.
export { stripFormatExtensions };
