// @ts-check
/**
 * <mps-dialogue> — Light-DOM speech bubble component.
 *
 * Positions itself against the mascot via CSS custom properties
 * `--ob-mascot-x/y/size` published on `document.documentElement` by
 * <mps-mascot>. Zero JS coupling — mascot and bubble both animate top/left
 * at the same duration and stay glued together.
 *
 * Public API (all methods return Promises where async):
 *   show(text, {tail}) → resolves after fade-in
 *   hide()             → resolves after fade-out
 *   setTail(direction) → synchronous; updates `data-tail`
 */

class MpsDialogue extends HTMLElement
{
    constructor()
    {
        super();
        this._tail = "above";
    }

    connectedCallback()
    {
        if (!this.querySelector(".mps-dialogue-body"))
        {
            this._render();
        }
        this.setAttribute("data-tail", this._tail);
    }

    _render()
    {
        this.innerHTML = `
            <div class="mps-dialogue-body">
                <div class="mps-dialogue-text"></div>
            </div>
        `;
    }

    setTail(dir)
    {
        this._tail = String(dir || "above");
        this.setAttribute("data-tail", this._tail);
    }

    /**
     * Show bubble with text. Resolves after fade-in transition completes.
     * @param {string} text
     * @param {{tail?: string}} [opts]
     * @returns {Promise<void>}
     */
    async show(text, opts = {})
    {
        if (!this.querySelector(".mps-dialogue-body")) this._render();
        const textEl = this.querySelector(".mps-dialogue-text");
        if (textEl) textEl.textContent = String(text || "");
        if (opts && opts.tail) this.setTail(opts.tail);

        // Double-rAF so the browser commits the initial (opacity 0) state
        // before we add .visible — guarantees a real transition, not a snap.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        this.classList.add("visible");
        await new Promise(r => setTimeout(r, 200));
    }

    /**
     * Fade out and resolve.
     * @returns {Promise<void>}
     */
    hide()
    {
        this.classList.remove("visible");
        return new Promise(r => setTimeout(r, 200));
    }
}

if (!customElements.get("mps-dialogue"))
{
    customElements.define("mps-dialogue", MpsDialogue);
}

export { MpsDialogue };
