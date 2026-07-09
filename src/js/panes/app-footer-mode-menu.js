// @ts-check
/**
 * app-footer-mode-menu.js — 3-row sub-menu for the App Footer's Mode Button.
 *
 * Pure builder, no module-level state aside from a singleton "currently-open"
 * reference. Opens ABOVE the anchor button (the footer sits at the bottom of
 * the window). Each row shows the mode icon on the left, localised label in
 * the centre, and a tick on the right for the currently-active row.
 *
 * The tick position is re-derived from `currentMode` every time `open()` is
 * called — never cached. This keeps the menu in sync if the user changed mode
 * via the top-bar toggle since the last open.
 */

import { icon } from "./icons.js";
import { t, subscribe } from "../adapters/tauri-i18n.js";

/** @typedef {"source"|"text"|"visual"} EditorMode */

/** @type {ReadonlyArray<EditorMode>} */
const MODES = ["source", "text", "visual"];

const ICON_FOR_MODE = {
    source: "code",
    text:   "book-open",
    visual: "wand-sparkles"
};

const LABEL_KEY_FOR_MODE = {
    source: "mangaplay-studio.chrome.tooltip.editorModeSwitchToSource",
    text:   "mangaplay-studio.chrome.tooltip.editorModeSwitchToText",
    visual: "mangaplay-studio.chrome.tooltip.editorModeSwitchToVisual"
};

const FALLBACK_LABEL_FOR_MODE = {
    source: "Source Editor",
    text:   "Text Editor",
    visual: "Visual Editor"
};

/**
 * @typedef {Object} ModeMenuController
 * @property {(anchorBtn: HTMLElement, currentMode: EditorMode) => void} open
 * @property {() => void} close
 * @property {(fn: (mode: EditorMode) => void) => void} onSelect
 * @property {() => void} destroy
 */

/**
 * Build a Mode Menu controller. The menu is created lazily on first open()
 * and re-anchored each time. Outside-click + Escape close it.
 *
 * @returns {ModeMenuController}
 */
export function createModeMenu()
{
    /** @type {HTMLElement|null} */
    let rootEl = null;
    /** @type {((mode: EditorMode) => void) | null} */
    let selectCb = null;
    /** @type {(() => void) | null} */
    let unsubLang = null;
    /** @type {((ev: MouseEvent) => void) | null} */
    let docClickHandler = null;
    /** @type {((ev: KeyboardEvent) => void) | null} */
    let keyHandler = null;
    /** @type {HTMLElement|null} */
    let currentAnchor = null;

    function _labelFor(mode)
    {
        // Plan §"Mode sub-menu localisation": reuse the existing
        // editorModeSwitchTo* tooltip strings ("Switch to Source Editor" /
        // etc). We strip the "Switch to " prefix — but i18n strings don't
        // carry a guaranteed prefix in every locale, so prefer the more
        // direct fallback ("Source Editor") when the user is in English; for
        // other locales the localised "switch to X" reads cleanly as a row
        // label too. Conservative compromise: use the localised string when
        // present (it always names the mode in the row's language), else the
        // English fallback.
        return t(LABEL_KEY_FOR_MODE[mode]) || FALLBACK_LABEL_FOR_MODE[mode];
    }

    function _buildDom()
    {
        const root = document.createElement("div");
        root.className = "footer-mode-menu";
        root.setAttribute("role", "menu");
        root.hidden = true;

        for (const mode of MODES)
        {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "footer-mode-menu-row";
            row.dataset.mode = mode;
            row.setAttribute("role", "menuitem");

            const iconEl = document.createElement("span");
            iconEl.className = "footer-mode-menu-icon";
            iconEl.innerHTML = icon(ICON_FOR_MODE[mode], { size: 16 });

            const labelEl = document.createElement("span");
            labelEl.className = "footer-mode-menu-label";
            labelEl.textContent = _labelFor(mode);

            const tickEl = document.createElement("span");
            tickEl.className = "footer-mode-menu-tick";
            tickEl.innerHTML = icon("check", { size: 14 });

            row.appendChild(iconEl);
            row.appendChild(labelEl);
            row.appendChild(tickEl);

            row.addEventListener("click", (ev) =>
            {
                ev.stopPropagation();
                const picked = /** @type {EditorMode} */ (row.dataset.mode);
                if (selectCb) selectCb(picked);
                close();
            });

            root.appendChild(row);
        }

        document.body.appendChild(root);
        // Re-render row labels when language changes at runtime.
        unsubLang = subscribe(() =>
        {
            if (!rootEl) return;
            for (const r of rootEl.querySelectorAll(".footer-mode-menu-row"))
            {
                const m = /** @type {EditorMode|null} */ (
                    /** @type {HTMLElement} */ (r).dataset.mode || null);
                if (!m) continue;
                const lbl = r.querySelector(".footer-mode-menu-label");
                if (lbl) lbl.textContent = _labelFor(m);
            }
        });
        return root;
    }

    function _setTick(currentMode)
    {
        if (!rootEl) return;
        for (const r of rootEl.querySelectorAll(".footer-mode-menu-row"))
        {
            const el = /** @type {HTMLElement} */ (r);
            if (el.dataset.mode === currentMode)
            {
                el.dataset.active = "1";
            }
            else
            {
                delete el.dataset.active;
            }
        }
    }

    function _anchorAbove(anchor)
    {
        if (!rootEl) return;
        const rect = anchor.getBoundingClientRect();
        // The footer is 200px wide and sits at the screen bottom-right; the
        // menu should align with the footer's right edge so the visual chrome
        // reads as one column.
        rootEl.style.position = "fixed";
        rootEl.style.zIndex = "10000";
        // Make the menu visible briefly to measure, then position.
        rootEl.style.visibility = "hidden";
        rootEl.hidden = false;
        const menuRect = rootEl.getBoundingClientRect();
        const right = Math.max(8, window.innerWidth - (rect.left + 200));
        // Position above the footer's top edge minus a small gap.
        // Footer is anchored at bottom: rect.top is the button's top.
        const top = Math.max(8, rect.top - menuRect.height - 6);
        rootEl.style.right = `${right}px`;
        rootEl.style.left = "auto";
        rootEl.style.top = `${top}px`;
        rootEl.style.visibility = "";
    }

    function open(anchorBtn, currentMode)
    {
        if (!rootEl) rootEl = _buildDom();
        currentAnchor = anchorBtn;
        _setTick(currentMode);
        _anchorAbove(anchorBtn);

        if (!docClickHandler)
        {
            docClickHandler = (ev) =>
            {
                if (!rootEl) return;
                const target = /** @type {Node|null} */ (ev.target);
                if (!target) return;
                if (rootEl.contains(target)) return;
                if (currentAnchor && currentAnchor.contains(target)) return;
                close();
            };
            keyHandler = (ev) =>
            {
                if (ev.key === "Escape") close();
            };
            // Defer doc-click binding one frame so the opening click doesn't
            // immediately close.
            requestAnimationFrame(() =>
            {
                if (docClickHandler)
                {
                    document.addEventListener("click", docClickHandler, true);
                }
            });
            document.addEventListener("keydown", keyHandler, true);
        }
    }

    function close()
    {
        if (rootEl) rootEl.hidden = true;
        currentAnchor = null;
        if (docClickHandler)
        {
            try { document.removeEventListener("click", docClickHandler, true); } catch {}
            docClickHandler = null;
        }
        if (keyHandler)
        {
            try { document.removeEventListener("keydown", keyHandler, true); } catch {}
            keyHandler = null;
        }
    }

    function onSelect(fn)
    {
        selectCb = fn;
    }

    function destroy()
    {
        close();
        if (unsubLang) { try { unsubLang(); } catch {} unsubLang = null; }
        if (rootEl) { try { rootEl.remove(); } catch {} rootEl = null; }
        selectCb = null;
    }

    return { open, close, onSelect, destroy };
}
