// @ts-check
/**
 * mps-editor-mode-toggle — three-state cycling button for the editor pane.
 *
 * States cycle: "source" → "text" → "visual" → "source".
 * Icons (from icons.js registry):
 *   - "source"  → code
 *   - "text"    → book-open
 *   - "visual"  → wand-sparkles
 *
 * Click cycles to the NEXT state and dispatches `mps:mode-change` with
 * `detail = { mode }` (bubbles + composed) so the host can react.
 *
 * The `mode` attribute / property sets the current state. Defaults to "text".
 * Setting the property externally (e.g. after persisting / restoring) keeps
 * the icon + title in sync without firing the event.
 */

import { icon } from "../icons.js";
import { t, subscribe } from "../adapters/tauri-i18n.js";

/** @type {Array<"source"|"text"|"visual">} */
const MODES = ["source", "text", "visual"];

const ICON_FOR_MODE = {
    source: "code",
    text:   "book-open",
    visual: "wand-sparkles"
};

const TOOLTIP_KEY_FOR_NEXT = {
    source: "mangaplay-studio.chrome.tooltip.editorModeSwitchToSource",
    text:   "mangaplay-studio.chrome.tooltip.editorModeSwitchToText",
    visual: "mangaplay-studio.chrome.tooltip.editorModeSwitchToVisual"
};

/** English fallback labels used when a translation isn't available. */
const FALLBACK_LABEL_FOR_NEXT = {
    source: "Switch to Source",
    text:   "Switch to Text",
    visual: "Switch to Visual"
};

/**
 * @param {"source"|"text"|"visual"} mode
 * @returns {"source"|"text"|"visual"}
 */
function nextMode(mode)
{
    const i = MODES.indexOf(mode);
    return MODES[(i + 1) % MODES.length];
}

export class MPSEditorModeToggle extends HTMLElement
{
    static get observedAttributes()
    {
        return ["mode"];
    }

    constructor()
    {
        super();
        /** @type {"source"|"text"|"visual"} */
        this._mode = "text";
        this._btn = /** @type {HTMLButtonElement|null} */ (null);
        this._onClick = this._onClick.bind(this);
        /** @type {(() => void) | null} */
        this._unsubLang = null;
    }

    connectedCallback()
    {
        // Honour an initial mode attribute set before connect.
        const attr = this.getAttribute("mode");
        if (attr && MODES.includes(/** @type {any} */ (attr)))
        {
            this._mode = /** @type {any} */ (attr);
        }

        if (!this._btn)
        {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "mps-editor-mode-toggle-btn";
            btn.addEventListener("click", this._onClick);
            this.appendChild(btn);
            this._btn = btn;
        }
        // Re-render tooltip text when the user changes language at runtime.
        this._unsubLang = subscribe(() => this._render());
        this._render();
    }

    disconnectedCallback()
    {
        if (this._btn)
        {
            this._btn.removeEventListener("click", this._onClick);
        }
        if (this._unsubLang)
        {
            this._unsubLang();
            this._unsubLang = null;
        }
    }

    attributeChangedCallback(name, _old, value)
    {
        if (name === "mode" && value && MODES.includes(value))
        {
            if (value !== this._mode)
            {
                this._mode = value;
                this._render();
            }
        }
    }

    /** @returns {"source"|"text"|"visual"} */
    get mode()
    {
        return this._mode;
    }

    /** @param {"source"|"text"|"visual"} v */
    set mode(v)
    {
        if (!MODES.includes(v)) return;
        if (v === this._mode) return;
        this._mode = v;
        // Reflect to attribute so CSS hooks (if any) update too.
        if (this.getAttribute("mode") !== v)
        {
            this.setAttribute("mode", v);
        }
        this._render();
    }

    _onClick()
    {
        const next = nextMode(this._mode);
        this._mode = next;
        this.setAttribute("mode", next);
        this._render();
        this.dispatchEvent(new CustomEvent("mps:mode-change", {
            detail: { mode: next },
            bubbles: true,
            composed: true
        }));
        // Release focus so subsequent keystrokes flow to the editor rather
        // than into this button (which has no key handlers and silently
        // swallows typing). The host (app.js) is responsible for moving
        // focus into the active CM view in Text/Source modes.
        if (this._btn) this._btn.blur();
    }

    _render()
    {
        if (!this._btn) return;
        const next = nextMode(this._mode);
        this._btn.innerHTML = icon(ICON_FOR_MODE[this._mode], { size: 18 });
        const label = t(TOOLTIP_KEY_FOR_NEXT[next]) || FALLBACK_LABEL_FOR_NEXT[next];
        this._btn.setAttribute("aria-label", label);
        this._btn.setAttribute("data-tooltip", label);
        this._btn.setAttribute("data-tooltip-side", "bottom");
        this._btn.dataset.mode = this._mode;
    }
}

if (!customElements.get("mps-editor-mode-toggle"))
{
    customElements.define("mps-editor-mode-toggle", MPSEditorModeToggle);
}
