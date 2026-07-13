// @ts-check
/**
 * mps-find-widget — floating in-editor Find pill.
 *
 * Structure:
 *   <mps-find-widget hidden>
 *     🔍 <input class="find-input" />  <span class="find-count">N/M</span>
 *     [↑] [↓] [✕]
 *   </mps-find-widget>
 *
 * The controller (`find-controller.js`) owns the search state. This
 * component is a dumb view: it fires `find:query`, `find:next`, `find:prev`,
 * and `find:close` events; the controller updates the visual count via
 * `setMatches(current, total)`.
 */

import { icon } from "../panes/icons.js";
import { t, subscribe as subscribeI18n } from "../adapters/tauri-i18n.js";

class MpsFindWidget extends HTMLElement
{
    constructor()
    {
        super();
        /** @type {HTMLInputElement | null} */ this._input = null;
        /** @type {HTMLElement | null} */ this._countEl = null;
        /** @type {HTMLButtonElement | null} */ this._prevBtn = null;
        /** @type {HTMLButtonElement | null} */ this._nextBtn = null;
        /** @type {HTMLButtonElement | null} */ this._closeBtn = null;
        /** @type {(() => void) | null} */ this._unsubscribeI18n = null;
        this._built = false;
    }

    connectedCallback()
    {
        if (this._built) return;
        this._build();
        this._built = true;
        this._unsubscribeI18n = subscribeI18n(() => this._applyTranslations());
    }

    disconnectedCallback()
    {
        try { this._unsubscribeI18n?.(); }
        catch (_) { /* ignore */ }
        this._unsubscribeI18n = null;
    }

    /** Refresh visible i18n strings without rebuilding the DOM. */
    _applyTranslations()
    {
        if (!this._built) return;
        const placeholder = t("mangaplay-studio.menu.editor.findWidget.placeholder") || "Find";
        const nextLbl = t("mangaplay-studio.menu.editor.findWidget.next") || "Next match";
        const prevLbl = t("mangaplay-studio.menu.editor.findWidget.prev") || "Previous match";
        const closeLbl = t("mangaplay-studio.menu.editor.findWidget.close") || "Close";
        if (this._input)
        {
            this._input.placeholder = placeholder;
            this._input.setAttribute("aria-label", placeholder);
        }
        if (this._nextBtn)
        {
            this._nextBtn.setAttribute("aria-label", nextLbl);
            this._nextBtn.title = nextLbl;
        }
        if (this._prevBtn)
        {
            this._prevBtn.setAttribute("aria-label", prevLbl);
            this._prevBtn.title = prevLbl;
        }
        if (this._closeBtn)
        {
            this._closeBtn.setAttribute("aria-label", closeLbl);
            this._closeBtn.title = closeLbl;
        }
    }

    _build()
    {
        const placeholder = t("mangaplay-studio.menu.editor.findWidget.placeholder") || "Find";
        const nextLbl = t("mangaplay-studio.menu.editor.findWidget.next") || "Next match";
        const prevLbl = t("mangaplay-studio.menu.editor.findWidget.prev") || "Previous match";
        const closeLbl = t("mangaplay-studio.menu.editor.findWidget.close") || "Close";

        this.innerHTML = `
            <div class="find-frame">
                <span class="find-lead-icon" aria-hidden="true">${icon("search", { size: 16, class: "icon" })}</span>
                <input class="find-input" type="text" placeholder="${placeholder}"
                       aria-label="${placeholder}" spellcheck="false" autocomplete="off" />
                <span class="find-count" aria-live="polite"></span>
            </div>
            <button class="find-btn find-prev" type="button" aria-label="${prevLbl}" title="${prevLbl}">
                ${icon("chevron-up", { size: 18, class: "icon" })}
            </button>
            <button class="find-btn find-next" type="button" aria-label="${nextLbl}" title="${nextLbl}">
                ${icon("chevron-down", { size: 18, class: "icon" })}
            </button>
            <button class="find-btn find-close" type="button" aria-label="${closeLbl}" title="${closeLbl}">
                ${icon("x", { size: 18, class: "icon" })}
            </button>
        `;

        this._input = /** @type {HTMLInputElement} */ (this.querySelector(".find-input"));
        this._countEl = /** @type {HTMLElement} */ (this.querySelector(".find-count"));
        this._prevBtn = /** @type {HTMLButtonElement} */ (this.querySelector(".find-prev"));
        this._nextBtn = /** @type {HTMLButtonElement} */ (this.querySelector(".find-next"));
        this._closeBtn = /** @type {HTMLButtonElement} */ (this.querySelector(".find-close"));
        const closeBtn = this._closeBtn;

        // Input → debounced query
        /** @type {number | null} */
        let debounceTimer = null;
        this._input?.addEventListener("input", () =>
        {
            if (debounceTimer !== null) clearTimeout(debounceTimer);
            debounceTimer = /** @type {any} */ (setTimeout(() =>
            {
                debounceTimer = null;
                this.dispatchEvent(new CustomEvent("find:query", {
                    detail: { query: this._input?.value ?? "" }
                }));
            }, 100));
        });

        // Keyboard
        this._input?.addEventListener("keydown", (e) =>
        {
            if (e.key === "Enter")
            {
                e.preventDefault();
                this.dispatchEvent(new CustomEvent(e.shiftKey ? "find:prev" : "find:next"));
            }
            else if (e.key === "Escape")
            {
                e.preventDefault();
                this.dispatchEvent(new CustomEvent("find:close"));
            }
        });

        this._prevBtn?.addEventListener("click", () =>
            this.dispatchEvent(new CustomEvent("find:prev")));
        this._nextBtn?.addEventListener("click", () =>
            this.dispatchEvent(new CustomEvent("find:next")));
        closeBtn.addEventListener("click", () =>
            this.dispatchEvent(new CustomEvent("find:close")));
    }

    /**
     * Show + focus the input. Optionally pre-fill with `seed`.
     * @param {string} [seed]
     */
    open(seed)
    {
        if (!this._built) { this._build(); this._built = true; }
        this.hidden = false;
        this.removeAttribute("hidden");
        if (typeof seed === "string" && this._input) this._input.value = seed;
        // Defer focus to next frame — visibility change needs to flush.
        requestAnimationFrame(() =>
        {
            this._input?.focus();
            this._input?.select();
        });
    }

    close()
    {
        this.hidden = true;
        this.setAttribute("hidden", "");
    }

    isOpen()
    {
        return !this.hidden;
    }

    /** @returns {string} */
    getQuery()
    {
        return this._input?.value ?? "";
    }

    /**
     * @param {number} current  - 1-based; 0 when no matches
     * @param {number} total
     */
    setMatches(current, total)
    {
        if (!this._countEl) return;
        if (!this.getQuery())
        {
            this._countEl.textContent = "";
            this.removeAttribute("data-no-results");
            this._setDisabled(true);
            return;
        }
        if (total === 0)
        {
            this._countEl.textContent = "0/0";
            this.setAttribute("data-no-results", "");
            this._setDisabled(true);
            return;
        }
        this._countEl.textContent = `${current}/${total}`;
        this.removeAttribute("data-no-results");
        this._setDisabled(false);
    }

    /** @param {boolean} disabled */
    _setDisabled(disabled)
    {
        if (this._prevBtn) this._prevBtn.disabled = disabled;
        if (this._nextBtn) this._nextBtn.disabled = disabled;
    }
}

if (typeof customElements !== "undefined" && !customElements.get("mps-find-widget"))
{
    customElements.define("mps-find-widget", MpsFindWidget);
}
