// @ts-check
/**
 * <mps-card-tray> — Light-DOM card grid component for onboarding.
 *
 * Positions itself under the mascot via CSS custom properties
 * `--ob-mascot-x/y/size` published on `document.documentElement` by
 * <mps-mascot>. Supports two layouts: a 2x2 grid (default) and a
 * single-row 3-across layout via `data-layout="row"`.
 *
 * Public API:
 *   show(cards, {stagger, layout}) → renders cards with staggered fade+
 *                                    slide-up. `layout: "row" | "grid"`
 *                                    (grid default). Returns Promise.
 *   hide()                         → fade out + remove. Resets selection
 *                                    + removes any mounted button.
 *   getSelected()                  → current selected card id, or null.
 *   showButton(label)              → mounts a bottom-right button that
 *                                    fades + slides up. Idempotent —
 *                                    updates label if already visible.
 *   hideButton({slideLeft})        → fades button out; if slideLeft,
 *                                    also translates -40px. Returns
 *                                    Promise.
 *   dismissCards({direction, stagger})
 *                                  → animates cards out. direction
 *                                    `"rightToLeft"` staggers from last
 *                                    card first. Returns Promise.
 *
 * Card click sets `.selected` on the clicked card (removed from siblings)
 * and dispatches `card-selected` CustomEvent on `document`, detail
 * `{ id }`. Legacy `card-picked` event still fires for back-compat.
 *
 * Button click dispatches `card-button-clicked` CustomEvent on
 * `document`, detail `{ id: selectedId, label }`.
 */

const ENTER_DURATION_MS = 220;
const BUTTON_ANIM_MS = 220;
const DISMISS_ANIM_MS = 220;

class MpsCardTray extends HTMLElement
{
    constructor()
    {
        super();
        this._cards = [];
        this._selectedId = null;
        this._buttonEl = null;
    }

    connectedCallback()
    {
        if (!this.querySelector(".mps-card-tray-grid"))
        {
            this._renderShell();
        }
    }

    _renderShell()
    {
        this.innerHTML = `<div class="mps-card-tray-grid"></div>`;
    }

    /**
     * Render cards with a staggered entrance animation.
     * @param {Array<{id: string, title: string, description: string}>} cards
     * @param {{stagger?: number, layout?: "row" | "grid", columns?: number}} [opts]
     * @returns {Promise<void>}
     */
    async show(cards, opts = {})
    {
        const stagger = Number(opts.stagger) || 60;
        const layout = opts.layout === "row" ? "row" : "grid";
        const list = Array.isArray(cards) ? cards : [];
        this._cards = list;
        this._selectedId = null;

        // Set layout attribute so CSS can switch grid columns / width.
        this.setAttribute("data-layout", layout);

        if (!this.querySelector(".mps-card-tray-grid")) this._renderShell();
        const grid = this.querySelector(".mps-card-tray-grid");
        if (!grid) return;

        // Column count — row layout uses this to render N columns via the
        // `--card-count` CSS custom prop. Grid layout ignores it.
        // Default: use the card list length so branched step-2 sets
        // (1/2/3 cards) render at the correct width without callers
        // having to pass `columns` explicitly.
        const columns = Number(opts.columns) || list.length || 3;
        /** @type {HTMLElement} */ (grid).style.setProperty("--card-count", String(columns));

        grid.innerHTML = list.map((c) =>
        {
            const id = String(c?.id || "");
            return `<button type="button" class="mps-card" data-card-id="${escapeAttr(id)}">
                <div class="mps-card-title"></div>
                <div class="mps-card-desc"></div>
            </button>`;
        }).join("");

        // Fill text content safely (avoids HTML injection).
        const buttons = /** @type {NodeListOf<HTMLElement>} */ (grid.querySelectorAll(".mps-card"));
        buttons.forEach((btn, i) =>
        {
            const c = list[i] || {};
            const titleEl = btn.querySelector(".mps-card-title");
            const descEl = btn.querySelector(".mps-card-desc");
            if (titleEl) titleEl.textContent = String(c.title || "");
            if (descEl) descEl.textContent = String(c.description || "");
            btn.addEventListener("click", () =>
            {
                const id = btn.getAttribute("data-card-id") || "";
                this._selectedId = id;
                // Move .selected class to the clicked card.
                buttons.forEach(b => b.classList.remove("selected"));
                btn.classList.add("selected");
                document.dispatchEvent(new CustomEvent("card-selected", { detail: { id } }));
                // Legacy back-compat event — kept so any older listener
                // still works. New code should use card-selected.
                document.dispatchEvent(new CustomEvent("card-picked", { detail: { id } }));
            });
        });

        this.classList.add("mounted");

        // Double-rAF so initial (opacity 0) state paints before we stagger .visible.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        buttons.forEach((btn, i) =>
        {
            setTimeout(() => btn.classList.add("visible"), i * stagger);
        });

        const count = buttons.length;
        const totalMs = count > 0 ? (count - 1) * stagger + ENTER_DURATION_MS : 0;
        await new Promise(r => setTimeout(r, totalMs));
    }

    /**
     * @returns {string | null}
     */
    getSelected()
    {
        return this._selectedId;
    }

    /**
     * Mount a bottom-right button and animate it in. Idempotent — a
     * second call while the button is already mounted just updates the
     * label without replaying the entrance animation.
     * @param {string} label
     * @returns {Promise<void>}
     */
    async showButton(label)
    {
        const text = String(label || "");
        if (this._buttonEl)
        {
            this._buttonEl.textContent = text;
            this._buttonEl.setAttribute("data-label", text);
            // Already visible — no re-anim.
            return;
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mps-card-tray-button";
        btn.textContent = text;
        btn.setAttribute("data-label", text);
        btn.addEventListener("click", () =>
        {
            const id = this._selectedId;
            const lbl = btn.getAttribute("data-label") || "";
            document.dispatchEvent(new CustomEvent("card-button-clicked", { detail: { id, label: lbl } }));
        });
        this.appendChild(btn);
        this._buttonEl = btn;
        // Double-rAF so initial (opacity 0, translateY 12px) state paints
        // before we add .visible.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        btn.classList.add("visible");
        await new Promise(r => setTimeout(r, BUTTON_ANIM_MS));
    }

    /**
     * Fade the button out and remove. If `slideLeft` is true, translate
     * -40px left over the fade.
     * @param {{slideLeft?: boolean}} [opts]
     * @returns {Promise<void>}
     */
    async hideButton(opts = {})
    {
        const btn = this._buttonEl;
        if (!btn) return;
        if (opts.slideLeft)
        {
            btn.classList.add("leaving");
        }
        btn.classList.remove("visible");
        await new Promise(r => setTimeout(r, BUTTON_ANIM_MS));
        if (btn.parentElement) btn.remove();
        if (this._buttonEl === btn) this._buttonEl = null;
    }

    /**
     * Animate cards out one-by-one. `direction: "rightToLeft"` starts
     * from the LAST card (highest DOM order first).
     * @param {{direction?: string, stagger?: number}} [opts]
     * @returns {Promise<void>}
     */
    async dismissCards(opts = {})
    {
        const stagger = Number(opts.stagger) || 80;
        const direction = opts.direction || "rightToLeft";
        const grid = this.querySelector(".mps-card-tray-grid");
        if (!grid) return;
        const buttons = /** @type {HTMLElement[]} */ (Array.from(grid.querySelectorAll(".mps-card")));
        if (buttons.length === 0) return;
        // Iteration order: rightToLeft = last card first.
        const ordered = direction === "rightToLeft" ? buttons.slice().reverse() : buttons.slice();
        ordered.forEach((btn, i) =>
        {
            setTimeout(() => btn.classList.add("dismissing"), i * stagger);
        });
        const totalMs = (ordered.length - 1) * stagger + DISMISS_ANIM_MS;
        await new Promise(r => setTimeout(r, totalMs));
    }

    /**
     * Fade out and clear cards. Also removes the button + resets selection.
     * @returns {Promise<void>}
     */
    async hide()
    {
        const grid = this.querySelector(".mps-card-tray-grid");
        if (grid)
        {
            const buttons = grid.querySelectorAll(".mps-card");
            buttons.forEach(b => b.classList.remove("visible"));
        }
        // Remove button in parallel (no slide-left).
        if (this._buttonEl)
        {
            this._buttonEl.classList.remove("visible");
        }
        await new Promise(r => setTimeout(r, ENTER_DURATION_MS));
        this.classList.remove("mounted");
        if (grid) grid.innerHTML = "";
        if (this._buttonEl)
        {
            if (this._buttonEl.parentElement) this._buttonEl.remove();
            this._buttonEl = null;
        }
        this._cards = [];
        this._selectedId = null;
    }
}

function escapeAttr(s)
{
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

if (!customElements.get("mps-card-tray"))
{
    customElements.define("mps-card-tray", MpsCardTray);
}

export { MpsCardTray };
