// @ts-check
/**
 * app-footer.js — App Footer (200×30, bottom-right of the editor pane).
 *
 * Children, left-to-right:
 *   1. Mode Button — icon mirrors current editor mode. Click opens the
 *      3-row sub-menu above. Rows call applyEditorMode() and close.
 *   2. Word / char counts for the active editor slot.
 *   3. Publish Doc pill host (#pill-publish-doc) — populated by
 *      pills/publish-doc-pill.js; mirrors the SyncStateMachine state and
 *      absorbs the click-target / popover-anchor role the sync gear used
 *      to play. Hidden until a script is active.
 *   4. Google Account pill host (#pill-google-account) — populated by
 *      pills/google-account-pill.js; mirrors auth + navigator.onLine.
 *
 * Mode sync contract — see TODO/app-footer-and-platform-window-controls.md.
 * The footer NEVER tracks editor-mode state internally; it only reflects
 * what `setMode()` is called with.
 */

import { icon } from "./icons.js";
import { t, subscribe } from "../adapters/tauri-i18n.js";
import { createModeMenu } from "./app-footer-mode-menu.js";

/** @typedef {"source"|"text"|"visual"} EditorMode */
const ICON_FOR_MODE = {
    source: "code",
    text:   "book-open",
    visual: "wand-sparkles"
};

const COUNTS_DEBOUNCE_MS = 150;

/**
 * @typedef {Object} MountOpts
 * @property {HTMLElement} host
 * @property {() => any} getActiveSlot
 * @property {(mode: EditorMode) => void|Promise<void>} applyEditorMode
 * @property {() => EditorMode} getEditorMode
 * @property {() => string} [getDocumentText] — optional override that returns the
 *   serialised document for the active surface. Used for Visual mode where
 *   the source-of-truth is the AST in RuntimeStorage, not the active CM slot.
 */

/**
 * @typedef {Object} AppFooterController
 * @property {() => void} show
 * @property {() => void} hide
 * @property {(mode: EditorMode) => void} setMode
 * @property {(words: number) => void} setCounts
 * @property {() => void} recountNow
 * @property {() => void} notifyDocChanged
 * @property {HTMLElement} root
 * @property {HTMLElement} publishDocPillEl
 * @property {HTMLElement} accountPillEl
 * @property {() => void} destroy
 */

/**
 * @param {MountOpts} opts
 * @returns {AppFooterController}
 */
export function mountAppFooter(opts)
{
    const { host, getActiveSlot, applyEditorMode, getEditorMode, getDocumentText } = opts;

    // The plan asks for the footer to live as a sibling AFTER `.app-body` —
    // index.html already carries the <footer id="app-footer"> stub; we
    // populate THAT element here so the position-stacking with #app-chrome's
    // flex column still works. If the caller passes a different host
    // (e.g. tests), append a fresh footer node.
    /** @type {HTMLElement} */
    let root;
    if (host && host.tagName === "FOOTER" && host.id === "app-footer")
    {
        root = host;
    }
    else
    {
        root = document.createElement("footer");
        root.id = "app-footer";
        host.appendChild(root);
    }
    root.replaceChildren();
    root.hidden = true;

    /** @type {EditorMode} */
    let currentMode = "text";

    // ── Mode Button ─────────────────────────────────────────────────────
    const modeBtn = document.createElement("button");
    modeBtn.type = "button";
    modeBtn.className = "footer-mode-btn";
    modeBtn.setAttribute("aria-haspopup", "menu");
    modeBtn.setAttribute("aria-expanded", "false");
    modeBtn.innerHTML = icon(ICON_FOR_MODE[currentMode], { size: 16 });
    root.appendChild(modeBtn);

    const modeMenu = createModeMenu();
    modeMenu.onSelect((mode) =>
    {
        modeBtn.setAttribute("aria-expanded", "false");
        try
        {
            const r = applyEditorMode(mode);
            if (r && typeof r.then === "function") r.catch(() => {});
        }
        catch (e) { console.warn("[app-footer] applyEditorMode threw:", e); }
    });
    let menuIsOpen = false;
    modeBtn.addEventListener("click", (ev) =>
    {
        ev.stopPropagation();
        if (menuIsOpen)
        {
            modeMenu.close();
            menuIsOpen = false;
            modeBtn.setAttribute("aria-expanded", "false");
            return;
        }
        const mode = (() => { try { return getEditorMode(); } catch { return currentMode; } })();
        modeMenu.open(modeBtn, mode);
        menuIsOpen = true;
        modeBtn.setAttribute("aria-expanded", "true");
    });
    // When something else closes the menu (outside-click, Escape), the menu
    // doesn't notify us — but the next click on modeBtn will re-open it, and
    // a stale aria-expanded won't break a11y semantics here. Reset on blur.
    modeBtn.addEventListener("blur", () =>
    {
        // Defer so the click handler can still inspect menuIsOpen.
        setTimeout(() =>
        {
            menuIsOpen = false;
            modeBtn.setAttribute("aria-expanded", "false");
        }, 0);
    });

    // ── Counts ──────────────────────────────────────────────────────────
    const countsEl = document.createElement("span");
    countsEl.className = "footer-counts";
    countsEl.textContent = "";
    root.appendChild(countsEl);

    /** @param {number} words */
    function setCounts(words)
    {
        const wordsTxt = t("mangaplay-studio.chrome.footer.words", { count: words })
            || `${words} words`;
        countsEl.textContent = wordsTxt;
    }

    /** @type {number|null} */
    let recountTimer = null;
    function _recountText(text)
    {
        const trimmed = (text || "").trim();
        const words = trimmed.length === 0
            ? 0
            : trimmed.split(/\s+/).filter(Boolean).length;
        setCounts(words);
    }

    function _readCurrentText()
    {
        try
        {
            if (typeof getDocumentText === "function")
            {
                const txt = getDocumentText();
                if (typeof txt === "string") return txt;
            }
        }
        catch (e) { console.debug("[app-footer] getDocumentText threw:", e); }
        try
        {
            const slot = getActiveSlot && getActiveSlot();
            const view = slot && slot.view;
            if (view && view.state && view.state.doc)
            {
                return view.state.doc.toString();
            }
        }
        catch (e) { console.debug("[app-footer] read slot text threw:", e); }
        return "";
    }

    function recountNow()
    {
        _recountText(_readCurrentText());
    }

    function scheduleRecount()
    {
        if (recountTimer !== null)
        {
            clearTimeout(recountTimer);
        }
        recountTimer = /** @type {any} */ (setTimeout(() =>
        {
            recountTimer = null;
            recountNow();
        }, COUNTS_DEBOUNCE_MS));
    }

    // ── Google Docs pills ───────────────────────────────────────────────
    // Hosts only — the pill modules (publish-doc-pill.js / google-account-pill.js)
    // mount themselves onto these buttons in app.js boot. They sit between the
    // counts and the right edge: per-doc pill first, then the global account
    // pill. Both pills are always visible whenever the footer is — their
    // internal states already encode "no account" / "no doc" cases.
    const publishDocPillEl = document.createElement("button");
    publishDocPillEl.type = "button";
    publishDocPillEl.id = "pill-publish-doc";
    publishDocPillEl.className = "footer-pill footer-pill-publish-doc";
    publishDocPillEl.setAttribute("data-tooltip-side", "top");
    root.appendChild(publishDocPillEl);

    const accountPillEl = document.createElement("button");
    accountPillEl.type = "button";
    accountPillEl.id = "pill-google-account";
    accountPillEl.className = "footer-pill footer-pill-account";
    accountPillEl.setAttribute("data-tooltip-side", "top");
    root.appendChild(accountPillEl);

    // ── Mode setter ─────────────────────────────────────────────────────
    /** @param {EditorMode} mode */
    function setMode(mode)
    {
        if (mode !== "source" && mode !== "text" && mode !== "visual") return;
        currentMode = mode;
        modeBtn.innerHTML = icon(ICON_FOR_MODE[mode], { size: 16 });
        modeBtn.dataset.mode = mode;
        // Mode changed → text source likely changed (visual ↔ CM), recount.
        scheduleRecount();
    }

    // ── Slot change subscription ────────────────────────────────────────
    // The plan describes a CM6 updateListener subscription; in this codebase
    // the slot manager already routes doc changes through
    // `onMpsChangeFromSlot` in app.js, which now calls notifyDocChanged on
    // the footer. We expose the recount as a public method so app.js can
    // drive both slot-activated AND doc-changed paths through the same
    // debounced sink.
    /** @type {(() => void) | null} */
    let _docChangeUnsub = null;
    // Re-render the counts string template when language changes (e.g. the
    // "{N} words" template token order can shift between locales).
    const langUnsub = subscribe(() =>
    {
        recountNow();
    });

    // ── Public API ──────────────────────────────────────────────────────
    function show() { root.hidden = false; }
    function hide() { root.hidden = true; }
    function destroy()
    {
        try { modeMenu.destroy(); } catch {}
        if (recountTimer !== null) { clearTimeout(recountTimer); recountTimer = null; }
        try { langUnsub && langUnsub(); } catch {}
        if (_docChangeUnsub) { try { _docChangeUnsub(); } catch {} _docChangeUnsub = null; }
        try { root.remove(); } catch {}
    }

    return {
        show,
        hide,
        setMode,
        setCounts,
        recountNow,
        // Debounced recount — call on every doc change event from app.js.
        notifyDocChanged: scheduleRecount,
        root,
        publishDocPillEl,
        accountPillEl,
        destroy
    };
}
