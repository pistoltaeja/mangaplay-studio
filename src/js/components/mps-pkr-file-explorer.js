// @ts-check
/**
 * <mps-pkr-file-explorer> — Left-side file explorer for the picker shell.
 *
 * Renders the recent-projects list, per-item context menu, and the
 * "invalid last path" note. Extracted from mps-picker-shell so it can
 * survive phase changes (bootstrap → picker → onboarding) without being
 * torn down and rebuilt on every _render().
 *
 * Public API:
 *   setRecent(list)                — replace the recent-projects list.
 *   setLastPathInvalid(flag)       — toggle the muted note.
 *
 * Emits bubbling CustomEvents that the picker-shell's parent handlers
 * still listen for (contract preserved):
 *   - mps-picker-pick            { detail: { path } }
 *   - mps-picker-remove          { detail: { path } }
 *   - mps-picker-reveal          { detail: { path } }
 *   - mps-picker-rename-project  { detail: { path, displayName, scope } }
 *   - mps-picker-rename-folder   { detail: { path, newBasename } }
 */

import { t, subscribe } from "../adapters/tauri-i18n.js";
import { escapeHtml } from "../util/index.js";
import { openContextMenu, closeContextMenu } from "./mps-context-menu.js";

class MpsPkrFileExplorer extends HTMLElement
{
    constructor()
    {
        super();
        /** @type {Array<{id?:string, path:string, name?:string, resolvedName?:string, exists?:boolean}>} */
        this._recent = [];
        this._openMenuPath = null;
        this._lastPathInvalid = false;
        this._onDocClick = this._onDocClick.bind(this);
    }

    connectedCallback()
    {
        this._render();
        document.addEventListener("click", this._onDocClick, true);
        this._langUnsub = subscribe(() => this._render());
    }

    disconnectedCallback()
    {
        document.removeEventListener("click", this._onDocClick, true);
        this._langUnsub?.();
        this._langUnsub = null;
    }

    /** Public API */
    setRecent(list)
    {
        this._recent = list || [];
        this._render();
    }

    setLastPathInvalid(flag)
    {
        this._lastPathInvalid = !!flag;
        this._render();
    }

    _emit(type, detail = {})
    {
        this.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
    }

    _onDocClick(e)
    {
        if (!this._openMenuPath) return;
        const inside = /** @type {Element} */ (e.target).closest?.(".pkr-menu");
        const isMenuBtn = /** @type {Element} */ (e.target).closest?.(".pkr-handle");
        if (!inside && !isMenuBtn)
        {
            this._openMenuPath = null;
            this._render();
        }
    }

    _render()
    {
        this.innerHTML = `
            <div class="pkr-left-header">${escapeHtml(t("mangaplay-studio.picker.recentHeading"))}</div>
            ${this._lastPathInvalid ? `<p class="pkr-recents-note" data-state="invalid-last-path">${escapeHtml(t("mangaplay-studio.picker.invalidLastPath"))}</p>` : ""}
            <div class="pkr-recent-list" role="list"></div>
        `;

        const list = this.querySelector(".pkr-recent-list");
        if (list)
        {
            if (this._recent.length === 0)
            {
                const empty = document.createElement("div");
                empty.className = "pkr-empty";
                empty.textContent = t("mangaplay-studio.picker.noRecentYet");
                list.appendChild(empty);
            }
            for (const r of this._recent)
            {
                list.appendChild(this._renderRecentRow(r));
            }
        }
    }

    _renderRecentRow(r)
    {
        const missing = r.exists === false;
        const card = document.createElement("div");
        card.className = "pkr-item" + (missing ? " is-missing" : "");
        card.dataset.path = r.path;
        card.setAttribute("role", "listitem");

        const main = document.createElement("button");
        main.type = "button";
        main.className = "pkr-item-main";
        const name = document.createElement("div");
        name.className = "pkr-item-name";
        name.textContent = r.resolvedName || r.name || r.path;
        const path = document.createElement("div");
        path.className = "pkr-item-path";
        path.textContent = r.path;
        main.appendChild(name);
        main.appendChild(path);
        if (missing)
        {
            const tag = document.createElement("div");
            tag.className = "pkr-item-missing";
            tag.textContent = t("mangaplay-studio.picker.folderNotFound");
            main.appendChild(tag);
        }
        main.addEventListener("click", () =>
        {
            if (missing)
            {
                const anchorEl = card.querySelector(".pkr-handle") || card;
                const rect = anchorEl.getBoundingClientRect();
                this._openMenuPath = r.path;
                openContextMenu({
                    x: Math.round(rect.right + 4),
                    y: Math.round(rect.top),
                    items: this._buildMenuItems(r),
                    onClose: () => { this._openMenuPath = null; },
                });
                return;
            }
            this._emit("mps-picker-pick", { path: r.path });
        });
        card.appendChild(main);

        // ⋮ handle
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "pkr-handle";
        handle.setAttribute("aria-label", t("mangaplay-studio.picker.openActions"));
        handle.innerHTML = "<span>⋮</span>";
        handle.addEventListener("click", (e) =>
        {
            e.stopPropagation();
            if (this._openMenuPath === r.path)
            {
                this._openMenuPath = null;
                closeContextMenu();
                return;
            }
            const rect = handle.getBoundingClientRect();
            this._openMenuPath = r.path;
            openContextMenu({
                x: Math.round(rect.right + 4),
                y: Math.round(rect.top),
                items: this._buildMenuItems(r),
                onClose: () => { this._openMenuPath = null; },
            });
        });
        card.appendChild(handle);

        // Right-click also opens the menu
        card.addEventListener("contextmenu", (e) =>
        {
            e.preventDefault();
            this._openMenuPath = r.path;
            openContextMenu({
                x: e.clientX,
                y: e.clientY,
                items: this._buildMenuItems(r),
                onClose: () => { this._openMenuPath = null; },
            });
        });

        return card;
    }

    _buildMenuItems(r)
    {
        const missing = r.exists === false;
        if (missing)
        {
            return [
                { id: "remove", label: t("mangaplay-studio.picker.menu.removeFromList"), danger: true,
                  onSelect: () => this._handleMenu("remove", r) },
            ];
        }
        return [
            { id: "rename-project", label: t("mangaplay-studio.picker.menu.renameProject"),
              onSelect: () => this._handleMenu("rename-project", r) },
            { id: "rename-folder", label: t("mangaplay-studio.picker.menu.renameFolder"),
              onSelect: () => this._handleMenu("rename-folder", r) },
            { id: "reveal", label: t("mangaplay-studio.picker.menu.revealInExplorer"),
              onSelect: () => this._handleMenu("reveal", r) },
            { kind: "divider" },
            { id: "remove", label: t("mangaplay-studio.picker.menu.removeFromList"), danger: true,
              onSelect: () => this._handleMenu("remove", r) },
        ];
    }

    _handleMenu(action, r)
    {
        this._openMenuPath = null;
        closeContextMenu();
        switch (action)
        {
            case "rename-project":
                this._openRenameProjectModal(r);
                break;
            case "rename-folder":
                this._openRenameFolderModal(r);
                break;
            case "reveal":
                this._emit("mps-picker-reveal", { path: r.path });
                break;
            case "remove":
                this._emit("mps-picker-remove", { path: r.path });
                break;
        }
    }

    _openRenameProjectModal(r)
    {
        const cur = r.resolvedName || r.name || "";
        this._modal({
            title: t("mangaplay-studio.picker.renameModal.title"),
            body: `
                <label class="pkr-modal-label">${escapeHtml(t("mangaplay-studio.picker.renameModal.newNameLabel"))}</label>
                <input type="text" class="pkr-modal-input" data-field="name" value="${escapeHtml(cur)}">
                <div class="pkr-modal-radios">
                    <label class="pkr-modal-radio">
                        <input type="radio" name="scope" value="local" checked>
                        <span><strong>${escapeHtml(t("mangaplay-studio.picker.renameModal.localScope.heading"))}</strong><br><small>${escapeHtml(t("mangaplay-studio.picker.renameModal.localScope.help"))}</small></span>
                    </label>
                    <label class="pkr-modal-radio">
                        <input type="radio" name="scope" value="shared">
                        <span><strong>${escapeHtml(t("mangaplay-studio.picker.renameModal.sharedScope.heading"))}</strong><br><small>${escapeHtml(t("mangaplay-studio.picker.renameModal.sharedScope.help"))}</small></span>
                    </label>
                </div>
            `,
            confirmLabel: t("mangaplay-studio.picker.renameModal.confirm"),
            onConfirm: (modal) =>
            {
                const name = /** @type {HTMLInputElement} */ (modal.querySelector(".pkr-modal-input[data-field='name']"))?.value || "";
                const scope = (/** @type {HTMLInputElement} */ (modal.querySelector("input[name='scope']:checked"))?.value) === "shared" ? "shared" : "local";
                this._emit("mps-picker-rename-project", { path: r.path, displayName: name.trim() || null, scope });
            },
        });
    }

    _openRenameFolderModal(r)
    {
        const base = (r.path || "").split(/[\\/]/).pop() || "";
        this._modal({
            title: t("mangaplay-studio.picker.renameFolder.title"),
            body: `
                <label class="pkr-modal-label">${escapeHtml(t("mangaplay-studio.picker.renameFolder.newNameLabel"))}</label>
                <input type="text" class="pkr-modal-input" data-field="basename" value="${escapeHtml(base)}">
                <p class="pkr-modal-note">${escapeHtml(t("mangaplay-studio.picker.renameFolder.note"))}</p>
            `,
            confirmLabel: t("mangaplay-studio.picker.renameFolder.confirm"),
            onConfirm: (modal) =>
            {
                const nb = /** @type {HTMLInputElement} */ (modal.querySelector(".pkr-modal-input[data-field='basename']"))?.value || "";
                this._emit("mps-picker-rename-folder", { path: r.path, newBasename: nb.trim() });
            },
        });
    }

    _modal({ title, body, confirmLabel, onConfirm })
    {
        const back = document.createElement("div");
        back.className = "pkr-modal-back";
        back.innerHTML = `
            <div class="pkr-modal">
                <div class="pkr-modal-title">${escapeHtml(title)}</div>
                <div class="pkr-modal-body">${body}</div>
                <div class="pkr-modal-actions">
                    <button type="button" class="pkr-btn pkr-btn-secondary" data-action="cancel">${escapeHtml(t("mangaplay-studio.picker.cancel"))}</button>
                    <button type="button" class="pkr-btn pkr-btn-primary" data-action="confirm">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>
        `;
        const close = () => back.remove();
        back.querySelector("[data-action='cancel']")?.addEventListener("click", close);
        back.querySelector("[data-action='confirm']")?.addEventListener("click", () =>
        {
            onConfirm(back);
            close();
        });
        back.addEventListener("click", (e) => { if (e.target === back) close(); });
        // Mount modal on the picker-shell so it inherits picker CSS variables
        // and z-index context. Fall back to body if we're detached.
        const host = this.closest("mps-picker-shell") || document.body;
        host.appendChild(back);
    }
}

if (!customElements.get("mps-pkr-file-explorer"))
{
    customElements.define("mps-pkr-file-explorer", MpsPkrFileExplorer);
}

export { MpsPkrFileExplorer };
