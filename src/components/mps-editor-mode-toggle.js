// @ts-check
/**
 * mps-editor-mode-toggle — cycling button for the editor pane.
 *
 * Full cycle: "source" → "text" → "visual" → "source".
 *
 * The active set of states is restricted by the `allowedModes` property
 * (defaults to all three). Clicking cycles to the NEXT state that is
 * present in `allowedModes`. When only one mode is allowed, the button
 * renders disabled.
 *
 * Icons (from icons.js registry):
 *   - "source"  → code
 *   - "text"    → book-open
 *   - "visual"  → wand-sparkles
 *
 * Click dispatches `mps:mode-change` with `detail = { mode }`
 * (bubbles + composed) so the host can react.
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
    source: "Source Editor",
    text:   "Text Editor",
    visual: "Visual Editor"
};

const FALLBACK_LABEL_FOR_CURRENT = {
    source: "Source Editor",
    text:   "Text Editor",
    visual: "Visual Editor"
};

/**
 * Cycle to the next mode that is present in `allowed`. If the current mode
 * is the only allowed one, returns it unchanged.
 * @param {"source"|"text"|"visual"} mode
 * @param {Array<"source"|"text"|"visual">} allowed
 * @returns {"source"|"text"|"visual"}
 */
function nextMode(mode, allowed)
{
    if (!allowed.length) return mode;
    const start = MODES.indexOf(mode);
    for (let step = 1; step <= MODES.length; step++)
    {
        const candidate = MODES[(start + step) % MODES.length];
        if (allowed.includes(candidate)) return candidate;
    }
    return mode;
}

class MPSEditorModeToggle extends HTMLElement
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
        /** @type {Array<"source"|"text"|"visual">} */
        this._allowedModes = MODES.slice();
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

    /** @returns {Array<"source"|"text"|"visual">} */
    get allowedModes()
    {
        return this._allowedModes.slice();
    }

    /** @param {Array<"source"|"text"|"visual">} list */
    set allowedModes(list)
    {
        const next = Array.isArray(list)
            ? MODES.filter((m) => list.includes(m))
            : MODES.slice();
        // Fall back to the full set if the caller passes an empty list — the
        // button must always have at least one renderable state.
        this._allowedModes = next.length ? next : MODES.slice();
        this._render();
    }

    _onClick()
    {
        const next = nextMode(this._mode, this._allowedModes);
        if (next === this._mode) return;
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
        const allowed = this._allowedModes;
        const onlyOne = allowed.length <= 1;
        this._btn.innerHTML = icon(ICON_FOR_MODE[this._mode], { size: 18 });
        let label;
        if (onlyOne)
        {
            label = FALLBACK_LABEL_FOR_CURRENT[this._mode];
        }
        else
        {
            const next = nextMode(this._mode, allowed);
            label = t(TOOLTIP_KEY_FOR_NEXT[next]) || FALLBACK_LABEL_FOR_NEXT[next];
        }
        this._btn.setAttribute("aria-label", label);
        this._btn.setAttribute("data-tooltip", label);
        this._btn.setAttribute("data-tooltip-side", "left");
        this._btn.dataset.mode = this._mode;
        this._btn.disabled = onlyOne;
        if (onlyOne)
        {
            this._btn.setAttribute("aria-disabled", "true");
        }
        else
        {
            this._btn.removeAttribute("aria-disabled");
        }
    }
}

if (!customElements.get("mps-editor-mode-toggle"))
{
    customElements.define("mps-editor-mode-toggle", MPSEditorModeToggle);
}
