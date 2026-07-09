// @ts-check
/**
 * right-pane-empty.js — manages the centred light-grey messages that cover
 * the right pane (storyboard + screenplay) in three states:
 *
 *   1. No document open               — slot.path === null
 *                                       → "There is no document open"
 *   2. Document open, no parseable    — empty buffer
 *      screenplay content              → "Please begin writing in the Text
 *                                         Editor to see the screenplay."
 *   3. Format doesn't support         — active file is .txt (general-text)
 *      Screenplay Preview              and the user is on the Screenplay
 *                                       slider side
 *                                       → "Text files do not support
 *                                         Screenplay Preview, try Fountain
 *                                         or Mangaplay"
 *
 * Also flips a `data-no-doc` attribute on #app-chrome so the floating paint
 * widget's tools can be dimmed + made inert via CSS (see app.css).
 *
 * Three divs are pre-wired in index.html under `.right-pane-slider`:
 *   #right-pane-no-doc,
 *   #right-pane-no-screenplay,
 *   #right-pane-screenplay-unsupported
 */

import { t, subscribe as subscribeI18n } from "../adapters/tauri-i18n.js";

/**
 * @typedef {Object} RightPaneEmptyState
 * @property {boolean} noDoc
 * @property {boolean} noScreenplay
 * @property {boolean} [unsupportedScreenplayForFormat]
 */

/**
 * @returns {{ update: (state: RightPaneEmptyState) => void, destroy: () => void }}
 */
export function mountRightPaneEmpty()
{
    const noDocEl     = /** @type {HTMLElement|null} */ (document.getElementById("right-pane-no-doc"));
    const noScreenEl  = /** @type {HTMLElement|null} */ (document.getElementById("right-pane-no-screenplay"));
    const unsupportedEl = /** @type {HTMLElement|null} */ (document.getElementById("right-pane-screenplay-unsupported"));
    const chromeEl    = /** @type {HTMLElement|null} */ (document.getElementById("app-chrome"));
    const sliderEl    = /** @type {HTMLElement|null} */ (document.querySelector(".right-pane-slider"));

    /** @type {RightPaneEmptyState} */
    let lastState = { noDoc: false, noScreenplay: false, unsupportedScreenplayForFormat: false };

    function applyTranslations()
    {
        if (noDocEl)
        {
            noDocEl.textContent = t("mangaplay-studio.rightPane.noDocumentOpen", "There is no document open");
        }
        if (noScreenEl)
        {
            noScreenEl.textContent = t(
                "mangaplay-studio.rightPane.noScreenplayContent",
                "Please begin writing in the Text Editor to see the screenplay."
            );
        }
        if (unsupportedEl)
        {
            unsupportedEl.textContent = t(
                "mangaplay-studio.rightPane.screenplayUnsupportedForFormat",
                "Text files do not support Screenplay Preview, try Fountain or Mangaplay"
            );
        }
    }

    applyTranslations();
    const unsubscribeI18n = subscribeI18n(applyTranslations);

    /**
     * Render the overlays for the given state + current slider position.
     * Reads the slider's `data-active` attribute so the unsupported message
     * only shows when the user is on the Screenplay side (storyboard still
     * renders a drawable blank page for .txt and needs no overlay there).
     */
    function render()
    {
        const screenplayShowing = sliderEl?.getAttribute("data-active") === "screenplay";
        if (noDocEl) noDocEl.hidden = !lastState.noDoc;
        // Unsupported-format overlay shows only when the screenplay side is
        // visible. Storyboard side gets a normal drawable page so no overlay
        // there.
        const showUnsupported = !lastState.noDoc
            && lastState.unsupportedScreenplayForFormat === true
            && screenplayShowing;
        if (unsupportedEl) unsupportedEl.hidden = !showUnsupported;
        // Show the "no screenplay text" overlay only when a document IS open
        // AND the format actually supports screenplay (otherwise the
        // unsupported-format overlay covers the pane instead).
        if (noScreenEl) noScreenEl.hidden =
            lastState.noDoc
            || lastState.unsupportedScreenplayForFormat === true
            || !lastState.noScreenplay;
        if (chromeEl)
        {
            if (lastState.noDoc) chromeEl.dataset.noDoc = "";
            else delete chromeEl.dataset.noDoc;
        }
    }

    /**
     * Observe slider `data-active` changes so the unsupported-format overlay
     * appears / hides as the user toggles between Storyboard and Screenplay
     * without `update` being called again.
     */
    let sliderObserver = /** @type {MutationObserver|null} */ (null);
    if (sliderEl)
    {
        sliderObserver = new MutationObserver(() => render());
        sliderObserver.observe(sliderEl, { attributes: true, attributeFilter: ["data-active"] });
    }

    /**
     * @param {RightPaneEmptyState} state
     */
    function update(state)
    {
        lastState = {
            noDoc: !!state.noDoc,
            noScreenplay: !!state.noScreenplay,
            unsupportedScreenplayForFormat: !!state.unsupportedScreenplayForFormat
        };
        render();
    }

    function destroy()
    {
        try { unsubscribeI18n?.(); } catch {}
        try { sliderObserver?.disconnect(); } catch {}
    }

    return { update, destroy };
}
