// @ts-check
/**
 * <mps-picker-shell> — Dark surface that combines the old loading/start
 * screens into a single fluid surface.
 *
 * States (via data-phase attr):
 *   - bootstrap   : pre-paint; rendered hidden, no work
 *   - picker      : two-column layout, recent list + brand + actions
 *   - opening     : centered card, "Opening <name>…" + progress sliver
 *
 * Emits CustomEvents (bubble on the host):
 *   - mps-picker-pick    { detail: { path } }   user picked a recent entry
 *   - mps-picker-new                            user clicked New Project
 *   - mps-picker-open                           user clicked Open Folder
 *   - mps-picker-remove  { detail: { path } }   user dismissed a recent
 *   - mps-picker-rename-project { detail: { path, displayName, scope } }
 *   - mps-picker-rename-folder  { detail: { path, newBasename } }
 *   - mps-picker-move-folder    { detail: { path } }
 *   - mps-picker-reveal         { detail: { path } }
 *   - mps-picker-copy-id        { detail: { id } }
 *
 * Animation is owned by CSS — switching phases is a single attribute write
 * and CSS cross-fades the .picker-body vs .opening-body containers.
 */

import "./mps-lang-select.js";
import { SUPPORTED_LANGUAGES_LIST } from "../adapters/languages.js";
import { t, subscribe } from "../adapters/tauri-i18n.js";
import { pathExists } from "../user-settings.js";

class MpsPickerShell extends HTMLElement
{
    constructor()
    {
        super();
        /** @type {Array<{id?:string, path:string, name?:string, resolvedName?:string, exists?:boolean}>} */
        this._recent = [];
        this._openMenuPath = null;     // path of the entry whose context menu is open
        this._phase = "bootstrap";
        this._openingMsg = "";
        this._openingProgress = 0;
        this._appVersion = "";
        // True only on the boot where Rust cleared lastProjectPath because
        // the stored value was invalid for the current platform. Drives the
        // muted note rendered above the recents list.
        this._lastPathInvalid = false;
        // Create-project inline panel state. `_page` is "rows" or "create"
        // and drives the slide via data-page on .pkr-shell-pages.
        this._page = "rows";
        this._createState = { name: "", parentPath: "", targetExists: false };
        this._createDebounce = null;
        this._onDocClick = this._onDocClick.bind(this);
    }

    static get observedAttributes()
    {
        return ["data-phase"];
    }

    connectedCallback()
    {
        // Bake-time version from package.json. Bun's `define` in
        // scripts/build-bundle.js replaces `__APP_VERSION__` with the literal
        // string before the bundle is written. Same source-of-truth as
        // Cargo.toml + tauri.conf.json (all templated from package.json).
        // No IPC, no async, no boot-timing race.
        if (!this._appVersion && typeof __APP_VERSION__ === "string")
        {
            this._appVersion = __APP_VERSION__;
        }
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

    attributeChangedCallback(name, _old, val)
    {
        if (name === "data-phase")
        {
            this._phase = val || "bootstrap";
            this._render();
        }
    }

    /** Public API */
    setRecent(list) { this._recent = list || []; this._render(); }
    setAppVersion(v) { this._appVersion = v || ""; this._render(); }
    setLastPathInvalid(flag) { this._lastPathInvalid = !!flag; this._render(); }
    setOpening(name, progress) {
        this._openingMsg = name || "";
        this._openingProgress = Math.max(0, Math.min(1, progress || 0));
        this._render();
    }
    setPhase(p) { this.setAttribute("data-phase", p); }

    /** Called by app.js after Browse picks a parent folder. */
    setCreatePanel({ parentPath })
    {
        this._createState.parentPath = parentPath || "";
        this._updateCreateUi();
        this._scheduleExistsCheck();
    }

    /** Slide the create-form panel in/out. Called by app.js on mps-picker-new. */
    showCreatePanel()
    {
        this._page = "create";
        this._createState = { name: "", parentPath: "", targetExists: false };
        // Clear DOM input so re-entry starts fresh.
        const input = /** @type {HTMLInputElement|null} */ (this.querySelector(".pkr-create-name"));
        if (input) input.value = "";
        this._applyPageAttr();
        this._updateCreateUi();
        // Focus name input after the slide completes.
        setTimeout(() =>
        {
            const focusInput = /** @type {HTMLInputElement|null} */ (this.querySelector(".pkr-create-name"));
            focusInput?.focus();
        }, 320);
    }

    hideCreatePanel()
    {
        this._page = "rows";
        this._applyPageAttr();
        // Refocus the Create button on the rows page.
        setTimeout(() =>
        {
            const btn = /** @type {HTMLElement|null} */ (this.querySelector(".pkr-btn[data-action='new']"));
            btn?.focus();
        }, 320);
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
        const phase = this._phase;
        if (phase === "bootstrap")
        {
            this.innerHTML = `<div class="pkr-bootstrap"></div>`;
            return;
        }
        if (phase === "opening")
        {
            this._renderOpening();
            return;
        }
        this._renderPicker();
    }

    _renderPicker()
    {
        this.innerHTML = `
            <div class="pkr-shell" data-phase="picker">
                <div class="pkr-titlebar" aria-hidden="false">
                    <button type="button" class="pkr-tb-btn" data-tb-action="minimize" title="${escapeHtml(t("mangaplay-studio.picker.titlebar.minimise"))}" aria-label="${escapeHtml(t("mangaplay-studio.picker.titlebar.minimise"))}">
                        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" stroke-width="1.4"/></svg>
                    </button>
                    <button type="button" class="pkr-tb-btn pkr-tb-close" data-tb-action="close" title="${escapeHtml(t("mangaplay-studio.picker.titlebar.close"))}" aria-label="${escapeHtml(t("mangaplay-studio.picker.titlebar.close"))}">
                        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                            <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.4"/>
                            <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.4"/>
                        </svg>
                    </button>
                </div>
                <aside class="pkr-left mps-scrollbar">
                    <div class="pkr-left-header">${escapeHtml(t("mangaplay-studio.picker.recentHeading"))}</div>
                    ${this._lastPathInvalid ? `<p class="pkr-recents-note" data-state="invalid-last-path">${escapeHtml(t("mangaplay-studio.picker.invalidLastPath"))}</p>` : ""}
                    <div class="pkr-recent-list" role="list"></div>
                </aside>
                <section class="pkr-right">
                    <div class="pkr-right-header">
                        <img class="pkr-mascot" src="./img/master-foreground.png" alt="">
                        <h1 class="pkr-brand">${escapeHtml(t("mangaplay-studio.picker.brand"))}</h1>
                        <div class="pkr-version">${escapeHtml(t("mangaplay-studio.picker.versionLabel", { version: this._appVersion || "0.0.0" }))}</div>
                    </div>
                    <div class="pkr-shell-pages" data-page="${this._page}">
                        <div class="pkr-shell-page pkr-shell-page-rows" data-role="rows">
                            <div class="pkr-card">
                                <div class="pkr-row" data-action="new">
                                    <div class="pkr-row-label">
                                        <div class="pkr-row-title">${escapeHtml(t("mangaplay-studio.picker.createNew.title"))}</div>
                                        <div class="pkr-row-help">${escapeHtml(t("mangaplay-studio.picker.createNew.help"))}</div>
                                    </div>
                                    <button type="button" class="pkr-btn pkr-btn-primary" data-action="new">${escapeHtml(t("mangaplay-studio.picker.createButton"))}</button>
                                </div>
                                <div class="pkr-divider"></div>
                                <div class="pkr-row" data-action="open">
                                    <div class="pkr-row-label">
                                        <div class="pkr-row-title">${escapeHtml(t("mangaplay-studio.picker.openExisting.title"))}</div>
                                        <div class="pkr-row-help">${escapeHtml(t("mangaplay-studio.picker.openExisting.help"))}</div>
                                    </div>
                                    <button type="button" class="pkr-btn pkr-btn-secondary" data-action="open">${escapeHtml(t("mangaplay-studio.picker.openButton"))}</button>
                                </div>
                                <div class="pkr-divider"></div>
                                <div class="pkr-row pkr-row-lang">
                                    <div class="pkr-row-label">
                                        <div class="pkr-row-title">${escapeHtml(t("mangaplay-studio.picker.languageLabel"))}</div>
                                    </div>
                                    <mps-lang-select></mps-lang-select>
                                </div>
                            </div>
                        </div>
                        <div class="pkr-shell-page pkr-shell-page-create" data-role="create">
                            ${this._renderCreatePageHtml()}
                        </div>
                    </div>
                </section>
            </div>
        `;

        // Populate recent list
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

        // Wire actions
        this.querySelector(".pkr-btn[data-action='new']")?.addEventListener("click", () => this._emit("mps-picker-new"));
        this.querySelector(".pkr-btn[data-action='open']")?.addEventListener("click", () => this._emit("mps-picker-open"));

        // Wire create-form actions
        this._wireCreateForm();

        // Window controls — call Tauri's window API directly. The picker
        // shell sits over any native titlebar overlay, so without these
        // buttons there's no way to minimise or close from the picker.
        this.querySelector(".pkr-tb-btn[data-tb-action='minimize']")?.addEventListener("click", async () =>
        {
            try
            {
                const w = await import("@tauri-apps/api/window");
                await w.getCurrentWindow().minimize();
            }
            catch (e) { console.warn("[picker] minimize failed:", e); }
        });
        this.querySelector(".pkr-tb-btn[data-tb-action='close']")?.addEventListener("click", async () =>
        {
            try
            {
                const w = await import("@tauri-apps/api/window");
                await w.getCurrentWindow().close();
            }
            catch (e)
            {
                console.warn("[picker] close failed:", e);
                try { window.close(); } catch {}
            }
        });
    }

    _renderCreatePageHtml()
    {
        return `
            <div class="pkr-create-form">
                <button type="button" class="pkr-create-back" data-action="create-back" aria-label="${escapeHtml(t("mangaplay-studio.picker.createPanel.back"))}">
                    <span class="pkr-create-back-arrow" aria-hidden="true">&larr;</span>
                    <span>${escapeHtml(t("mangaplay-studio.picker.createPanel.back"))}</span>
                </button>

                <div class="pkr-card">
                    <div class="pkr-row pkr-row-stack">
                        <div class="pkr-row-label">
                            <div class="pkr-row-title">${escapeHtml(t("mangaplay-studio.picker.createPanel.nameLabel"))}</div>
                            <div class="pkr-row-help">${escapeHtml(t("mangaplay-studio.picker.createPanel.nameHelp"))}</div>
                        </div>
                        <input id="pkr-create-name-input" type="text" class="pkr-create-input pkr-create-name" placeholder="${escapeHtml(t("mangaplay-studio.picker.createPanel.namePlaceholder"))}" autocomplete="off">
                        <div class="pkr-create-error" data-role="name-error" aria-live="polite"></div>
                    </div>
                    <div class="pkr-divider"></div>
                    <div class="pkr-row pkr-row-stack">
                        <div class="pkr-row-label">
                            <div class="pkr-row-title">${escapeHtml(t("mangaplay-studio.picker.createPanel.locationLabel"))}</div>
                            <div class="pkr-row-help">${escapeHtml(t("mangaplay-studio.picker.createPanel.locationHelp"))}</div>
                        </div>
                        <div class="pkr-create-location-row">
                            <button type="button" class="pkr-btn pkr-btn-secondary pkr-create-browse" data-action="create-browse">${escapeHtml(t("mangaplay-studio.picker.createPanel.browseButton"))}</button>
                            <div class="pkr-create-parent-readout" data-role="parent-readout"></div>
                        </div>
                    </div>
                    <div class="pkr-divider"></div>
                    <div class="pkr-row pkr-row-stack">
                        <div class="pkr-create-readout-row" data-role="readout-row">
                            <span class="pkr-create-readout-prefix">${escapeHtml(t("mangaplay-studio.picker.createPanel.pathReadoutPrefix"))}</span>
                            <span class="pkr-create-readout-path" data-role="target-readout"></span>
                        </div>
                    </div>
                </div>

                <div class="pkr-create-actions">
                    <button type="button" class="pkr-btn pkr-btn-primary pkr-create-submit" data-action="create-submit" disabled>${escapeHtml(t("mangaplay-studio.picker.createPanel.makeProjectButton"))}</button>
                </div>
            </div>
        `;
    }

    _wireCreateForm()
    {
        const backBtn = this.querySelector(".pkr-create-back");
        backBtn?.addEventListener("click", () =>
        {
            this._emit("mps-picker-create-back");
        });

        const browseBtn = this.querySelector(".pkr-create-browse");
        browseBtn?.addEventListener("click", () =>
        {
            this._emit("mps-picker-create-browse");
        });

        const nameInput = /** @type {HTMLInputElement|null} */ (this.querySelector(".pkr-create-name"));
        nameInput?.addEventListener("input", () =>
        {
            this._createState.name = nameInput.value;
            this._updateCreateUi();
            this._scheduleExistsCheck();
        });
        nameInput?.addEventListener("keydown", (e) =>
        {
            const ev = /** @type {KeyboardEvent} */ (e);
            if (ev.key === "Enter")
            {
                if (this._isCreateSubmittable())
                {
                    this._submitCreate();
                }
            }
            else if (ev.key === "Escape")
            {
                this._emit("mps-picker-create-back");
            }
        });

        const submitBtn = this.querySelector(".pkr-create-submit");
        submitBtn?.addEventListener("click", () =>
        {
            if (!this._isCreateSubmittable()) return;
            this._submitCreate();
        });
    }

    _submitCreate()
    {
        const name = (this._createState.name || "").trim();
        const parent = this._createState.parentPath || "";
        this._emit("mps-picker-create-submit", { parent, name });
    }

    _isCreateSubmittable()
    {
        const name = (this._createState.name || "").trim();
        if (name.length < 1) return false;
        if (!this._createState.parentPath) return false;
        if (this._createState.targetExists) return false;
        return true;
    }

    _joinPath(parent, name)
    {
        if (!parent) return "";
        const sep = parent.includes("\\") ? "\\" : "/";
        const trimmed = parent.replace(/[\\/]+$/, "");
        return trimmed + sep + name;
    }

    _scheduleExistsCheck()
    {
        if (this._createDebounce)
        {
            clearTimeout(this._createDebounce);
            this._createDebounce = null;
        }
        const name = (this._createState.name || "").trim();
        const parent = this._createState.parentPath || "";
        if (!name || !parent)
        {
            this._createState.targetExists = false;
            this._updateCreateUi();
            return;
        }
        const target = this._joinPath(parent, name);
        // Mark in-flight as "not exists" so the button can re-enable while
        // we check. A race window is acceptable per the plan.
        this._createDebounce = setTimeout(async () =>
        {
            const exists = await pathExists(target);
            // Only apply if the user hasn't changed the inputs since.
            const currentTarget = this._joinPath(this._createState.parentPath || "", (this._createState.name || "").trim());
            if (currentTarget !== target) return;
            this._createState.targetExists = !!exists;
            this._updateCreateUi();
        }, 150);
    }

    _updateCreateUi()
    {
        const name = (this._createState.name || "").trim();
        const parent = this._createState.parentPath || "";

        // Parent readout under Browse button
        const parentReadout = this.querySelector("[data-role='parent-readout']");
        if (parentReadout)
        {
            parentReadout.textContent = parent || "";
        }

        // Target readout row
        const readoutRow = /** @type {HTMLElement|null} */ (this.querySelector("[data-role='readout-row']"));
        const targetReadout = this.querySelector("[data-role='target-readout']");
        if (readoutRow && targetReadout)
        {
            if (name && parent)
            {
                targetReadout.textContent = this._joinPath(parent, name);
                readoutRow.classList.add("is-visible");
            }
            else
            {
                targetReadout.textContent = "";
                readoutRow.classList.remove("is-visible");
            }
        }

        // Validation error
        const errorEl = this.querySelector("[data-role='name-error']");
        if (errorEl)
        {
            let msg = "";
            if (parent && name && this._createState.targetExists)
            {
                msg = t("mangaplay-studio.picker.createPanel.validation.folderExists", { name });
            }
            errorEl.textContent = msg;
        }

        // Submit button enable/disable
        const submitBtn = /** @type {HTMLButtonElement|null} */ (this.querySelector(".pkr-create-submit"));
        if (submitBtn)
        {
            submitBtn.disabled = !this._isCreateSubmittable();
        }
    }

    _applyPageAttr()
    {
        const pages = this.querySelector(".pkr-shell-pages");
        if (pages)
        {
            pages.setAttribute("data-page", this._page);
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
                // Click on missing prompts removal via the same menu path —
                // the host listens for remove and the entry disappears.
                this._openMenuPath = r.path;
                this._render();
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
            this._openMenuPath = this._openMenuPath === r.path ? null : r.path;
            this._render();
        });
        card.appendChild(handle);

        // Context menu (only when open)
        if (this._openMenuPath === r.path)
        {
            const menu = this._renderMenu(r);
            card.appendChild(menu);
        }

        // Right-click also opens the menu
        card.addEventListener("contextmenu", (e) =>
        {
            e.preventDefault();
            this._openMenuPath = r.path;
            this._render();
        });

        return card;
    }

    _renderMenu(r)
    {
        const menu = document.createElement("div");
        menu.className = "pkr-menu";
        const items = [
            { label: t("mangaplay-studio.picker.menu.renameProject"),  action: "rename-project" },
            { label: t("mangaplay-studio.picker.menu.renameFolder"),   action: "rename-folder" },
            { label: t("mangaplay-studio.picker.menu.revealInExplorer"), action: "reveal" },
            { label: "──",                                              action: "divider" },
            { label: t("mangaplay-studio.picker.menu.removeFromList"),  action: "remove", danger: true },
        ];
        for (const it of items)
        {
            if (it.action === "divider")
            {
                const d = document.createElement("div");
                d.className = "pkr-menu-divider";
                menu.appendChild(d);
                continue;
            }
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "pkr-menu-item" + (it.danger ? " is-danger" : "");
            btn.textContent = it.label;
            btn.addEventListener("click", (e) =>
            {
                e.stopPropagation();
                this._handleMenu(it.action, r);
            });
            menu.appendChild(btn);
        }
        return menu;
    }

    _handleMenu(action, r)
    {
        // Close the menu and re-render BEFORE opening any modal — _render()
        // wipes children, so modals must be appended after the render pass.
        this._openMenuPath = null;
        this._render();
        switch (action)
        {
            case "copy-id":
                if (r.id) { try { navigator.clipboard?.writeText?.(r.id); } catch (_) {} }
                this._emit("mps-picker-copy-id", { id: r.id || "" });
                break;
            case "rename-project":
                this._openRenameProjectModal(r);
                break;
            case "rename-folder":
                this._openRenameFolderModal(r);
                break;
            case "move-folder":
                this._emit("mps-picker-move-folder", { path: r.path });
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
        this.appendChild(back);
    }

    _renderOpening()
    {
        const pct = Math.round(this._openingProgress * 100);
        this.innerHTML = `
            <div class="pkr-shell" data-phase="opening">
                <div class="pkr-opening-card">
                    <img class="pkr-mascot" src="./img/master-foreground.png" alt="">
                    <div class="pkr-opening-title">${escapeHtml(this._openingMsg || t("mangaplay-studio.boot.opening.openingFallback"))}</div>
                    <div class="pkr-progress" aria-hidden="true">
                        <div class="pkr-progress-bar" style="width: ${pct}%"></div>
                    </div>
                </div>
            </div>
        `;
    }
}

function escapeHtml(s)
{
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[c]));
}

if (!customElements.get("mps-picker-shell"))
{
    customElements.define("mps-picker-shell", MpsPickerShell);
}
