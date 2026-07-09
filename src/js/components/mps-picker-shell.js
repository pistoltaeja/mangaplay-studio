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
 *   - mps-picker-reveal         { detail: { path } }
 *
 * Animation is owned by CSS — switching phases is a single attribute write
 * and CSS cross-fades the .picker-body vs .opening-body containers.
 */

import "./mps-lang-select.js";
import "./mps-mascot.js";
import "./mps-pkr-file-explorer.js";
import { SUPPORTED_LANGUAGES_LIST } from "../adapters/languages.js";
import { t, subscribe } from "../adapters/tauri-i18n.js";
import { hasWindowChrome } from "../adapters/platform-capabilities.js";
import { pathExists } from "../project/user-settings.js";
import { escapeHtml } from "../util/index.js";

class MpsPickerShell extends HTMLElement
{
    constructor()
    {
        super();
        /** @type {Array<{id?:string, path:string, name?:string, resolvedName?:string, exists?:boolean}>} */
        this._recent = [];
        this._phase = "bootstrap";
        this._onboardingState = "init";
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
        // Persistent-scaffold state. `_ensureScaffold()` mounts titlebar +
        // <mps-pkr-file-explorer> + right-pane container once and reuses them
        // across phase/locale changes, so the file-explorer isn't torn down
        // on every render.
        this._scaffoldMounted = false;
    }

    static get observedAttributes()
    {
        return ["data-phase", "data-onboarding-state"];
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
        this._langUnsub = subscribe(() => this._render());
    }

    disconnectedCallback()
    {
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
        else if (name === "data-onboarding-state")
        {
            this._onboardingState = val || "init";
            this._render();
        }
    }

    /** Public API */
    setRecent(list)
    {
        this._recent = list || [];
        // Forward to the live file-explorer (survives phase changes) rather
        // than re-rendering the whole shell.
        const explorer = this.querySelector("mps-pkr-file-explorer");
        if (explorer && typeof explorer.setRecent === "function")
        {
            explorer.setRecent(this._recent);
        }
        else
        {
            this._render();
        }
    }
    setLastPathInvalid(flag)
    {
        this._lastPathInvalid = !!flag;
        const explorer = this.querySelector("mps-pkr-file-explorer");
        if (explorer && typeof explorer.setLastPathInvalid === "function")
        {
            explorer.setLastPathInvalid(this._lastPathInvalid);
        }
        else
        {
            this._render();
        }
    }
    setPhase(p) { this.setAttribute("data-phase", p); }
    setOnboardingState(name) { this.setAttribute("data-onboarding-state", String(name || "init")); }

    // NOTE: setOpening() intentionally removed — the opening card moved to
    // <mps-splash>. A throwing getter is installed on the prototype below
    // (see the block after the class) to catch dynamic accessors that the
    // build-time grep gate on the literal token can't see. Whitelisted in
    // scripts/build-bundle.js because the token appears twice in this file
    // (the removal note above + the defineProperty call).

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

    _render()
    {
        const phase = this._phase;
        if (phase === "bootstrap" || phase === "opening")
        {
            // "opening" phase is now owned by <mps-splash>. Callers that
            // previously ran shell.setPhase("opening") must instead call
            // window.__mpsSplash.show()/update()/setProgress(). If a stale
            // caller flips the attribute, treat it as bootstrap so the picker
            // rows don't reappear over the splash.
            this.innerHTML = `<div class="pkr-bootstrap"></div>`;
            this._scaffoldMounted = false;
            return;
        }
        // picker + onboarding both need the file-explorer scaffold. Ensure
        // it exists (persistent across phase/locale changes), then update
        // just the right-pane content and phase attributes on .pkr-shell.
        this._ensureScaffold();
        if (phase === "onboarding")
        {
            this._updateOnboardingSlot();
        }
        else
        {
            this._updatePickerSlot();
        }
    }

    _ensureScaffold()
    {
        if (this._scaffoldMounted && this.querySelector("mps-pkr-file-explorer")) return;
        this.innerHTML = `
            <div class="pkr-shell" data-phase="${escapeHtml(this._phase)}">
                <div class="pkr-titlebar" data-tauri-drag-region aria-hidden="false">
                    <button type="button" class="pkr-tb-btn" data-tb-action="minimize" title="${escapeHtml(t("mangaplay-studio.picker.titlebar.minimise"))}" aria-label="${escapeHtml(t("mangaplay-studio.picker.titlebar.minimise"))}">
                        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" stroke-width="1.4"/></svg>
                    </button>
                    <button type="button" class="pkr-tb-btn" data-tb-action="maximize" title="${escapeHtml(t("mangaplay-studio.picker.titlebar.maximise"))}" aria-label="${escapeHtml(t("mangaplay-studio.picker.titlebar.maximise"))}">
                        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="2.5" y="2.5" width="5" height="5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
                    </button>
                    <button type="button" class="pkr-tb-btn pkr-tb-close" data-tb-action="close" title="${escapeHtml(t("mangaplay-studio.picker.titlebar.close"))}" aria-label="${escapeHtml(t("mangaplay-studio.picker.titlebar.close"))}">
                        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                            <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.4"/>
                            <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.4"/>
                        </svg>
                    </button>
                </div>
                <mps-pkr-file-explorer class="pkr-left mps-scrollbar"></mps-pkr-file-explorer>
                <section class="pkr-right">
                    <div class="pkr-right-content"></div>
                </section>
            </div>
        `;
        this._scaffoldMounted = true;
        // Forward current recent-list + invalid-path state to the newly-mounted
        // file-explorer.
        const explorer = this.querySelector("mps-pkr-file-explorer");
        if (explorer)
        {
            explorer.setRecent?.(this._recent);
            explorer.setLastPathInvalid?.(this._lastPathInvalid);
        }

        // Wire the titlebar buttons once per scaffold lifetime.
        this._wireTitlebar();
    }

    _wireTitlebar()
    {
        // Window controls — call Tauri's window API directly. The picker
        // shell sits over any native titlebar overlay, so without these
        // buttons there's no way to minimise or close from the picker.
        // Mobile / tablet windows have no chrome to control; guard with
        // hasWindowChrome() (defence in depth — the picker isn't rendered
        // in mobile mode anyway).
        this.querySelector(".pkr-tb-btn[data-tb-action='minimize']")?.addEventListener("click", async () =>
        {
            if (!hasWindowChrome()) return;
            try
            {
                const w = await import("@tauri-apps/api/window");
                await w.getCurrentWindow().minimize();
            }
            catch (e) { console.warn("[picker] minimize failed:", e); }
        });
        this.querySelector(".pkr-tb-btn[data-tb-action='close']")?.addEventListener("click", async () =>
        {
            if (!hasWindowChrome()) return;
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
        this.querySelector(".pkr-tb-btn[data-tb-action='maximize']")?.addEventListener("click", async () =>
        {
            if (!hasWindowChrome()) return;
            try
            {
                const w = await import("@tauri-apps/api/window");
                await w.getCurrentWindow().toggleMaximize();
                await this._syncPickerMaxState();
            }
            catch (e) { console.warn("[picker] toggleMaximize failed:", e); }
        });

        void this._syncPickerMaxState();
    }

    _updateOnboardingSlot()
    {
        const shell = this.querySelector(".pkr-shell");
        const content = this.querySelector(".pkr-right-content");
        if (shell)
        {
            shell.setAttribute("data-phase", "onboarding");
            shell.setAttribute("data-onboarding-state", this._onboardingState);
        }
        if (!content) return;

        // Onboarding slot is intentionally empty in Phase 1 init — the
        // mascot lives on document.body as an app-level singleton (see
        // mps-mascot-app.js) so it can persist across views and animate
        // without contributing to any picker-shell ancestor's scrollable
        // overflow. Picker-shell no longer owns the mascot's DOM or its
        // entrance trigger; that lives in shell/boot.js next to the
        // onboarding gate.
        if (!content.querySelector(".pkr-shell-page-onboarding"))
        {
            content.innerHTML = `
                <div class="pkr-shell-pages">
                    <div class="pkr-shell-page pkr-shell-page-onboarding" data-role="onboarding" data-onboarding-state="${escapeHtml(this._onboardingState)}"></div>
                </div>
            `;
        }
        else
        {
            const page = content.querySelector(".pkr-shell-page-onboarding");
            if (page) page.setAttribute("data-onboarding-state", this._onboardingState);
        }
    }

    _updatePickerSlot()
    {
        const shell = this.querySelector(".pkr-shell");
        const content = this.querySelector(".pkr-right-content");
        if (shell)
        {
            shell.setAttribute("data-phase", "picker");
            shell.removeAttribute("data-onboarding-state");
        }
        if (!content) return;

        content.innerHTML = `
            <div class="pkr-right-header">
                <mps-mascot class="pkr-mascot"></mps-mascot>
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
        `;

        // Wire actions
        this.querySelector(".pkr-btn[data-action='new']")?.addEventListener("click", () => this._emit("mps-picker-new"));
        this.querySelector(".pkr-btn[data-action='open']")?.addEventListener("click", () => this._emit("mps-picker-open"));

        // Wire create-form actions
        this._wireCreateForm();
    }

    async _syncPickerMaxState()
    {
        if (!hasWindowChrome()) return;
        try
        {
            const w = await import("@tauri-apps/api/window");
            const isMax = await w.getCurrentWindow().isMaximized();
            const btn = this.querySelector(".pkr-tb-btn[data-tb-action='maximize']");
            if (!btn) return;
            const key = isMax ? "mangaplay-studio.picker.titlebar.restore" : "mangaplay-studio.picker.titlebar.maximise";
            const label = t(key);
            btn.setAttribute("title", label);
            btn.setAttribute("aria-label", label);
        }
        catch (e) { console.warn("[picker] syncMaxState failed:", e); }
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

    // NOTE: _renderRecentRow / _buildMenuItems / _handleMenu /
    // _openRenameProjectModal / _openRenameFolderModal / _modal moved into
    // <mps-pkr-file-explorer>. The parent app listeners still receive the
    // same mps-picker-* events via bubbling.

}

// Defensive throwing getter for the removed setOpening method. Catches
// dynamic accessors (`shell[method]` where method is a string variable) that
// the source-level grep gate can't see. See TODO/unify-splash-component.md.
// This file is whitelisted in scripts/build-bundle.js so the banned tokens
// in this block don't trip the build gate.
Object.defineProperty(MpsPickerShell.prototype, "setOpening", {
    configurable: true,
    get()
    {
        throw new Error("mps-picker-shell.setOpening removed — use window.__mpsSplash");
    },
});

if (!customElements.get("mps-picker-shell"))
{
    customElements.define("mps-picker-shell", MpsPickerShell);
}
