// @ts-check
/**
 * publish-slides-pill.js — Footer pill that opens the Publish Google Slides
 * modal. Mirrors the shape of publish-doc-pill.js.
 *
 * Renders the official Google Slides logo (img/Google_Slides_logo_(2014-2020).svg)
 * regardless of state. State is conveyed via opacity + tooltip/aria strings:
 *   - no-account       → dim opacity — not signed in to Google
 *   - unsupported-fmt  → dim opacity — active script isn't .mangaplay
 *   - linked           → normal + green border — a Slides deck is linked to
 *                        the active script's UUID (see slidesLinks map)
 *   - ready            → normal      — signed in, mangaplay script active
 *
 * Click contract:
 *   - no-account → openSettingsModal("account")
 *   - unsupported-fmt → no-op (pill visibly disabled)
 *   - ready → invoke clickHandler set via setClickHandler()
 *     (the mount wires this to `openPublishSlidesModal` with the current
 *     script context).
 */

import { isAuthenticated, onAuthChanged } from "../auth/google-oauth.js";
import { openSettingsModal } from "../modals/settings-modal.js";
import { t, subscribe as i18nSubscribe } from "../adapters/tauri-i18n.js";

/** @typedef {"no-account"|"unsupported-fmt"|"linked"|"ready"|"ready-group"} PublishSlidesPillState */

const GOOGLE_SLIDES_ICON_SRC = "./img/Google_Slides_logo_(2014-2020).svg";

const FORMAT_LABEL = {
    fountain: "Fountain",
    superscript: "SuperScript",
    "superscript-bin": "SuperScript"
};

/**
 * @typedef {Object} PublishSlidesPillController
 * @property {() => void} refresh
 * @property {(fn: (ev?: MouseEvent) => void) => void} setClickHandler
 * @property {() => HTMLElement} getHostEl
 * @property {() => void} destroy
 */

/**
 * Mount the Publish Slides pill into an existing host button element.
 *
 * @param {{ host: HTMLElement, getScriptFormat: () => string|null|undefined, getIsLinked?: () => boolean, getIsStoryboardFolder?: () => boolean, getSyncStatus?: () => string|null }} opts
 * @returns {PublishSlidesPillController}
 */
export function mountPublishSlidesPill({ host, getScriptFormat, getIsLinked, getIsStoryboardFolder, getSyncStatus })
{
    if (!host)
    {
        return {
            refresh: () => {},
            setClickHandler: () => {},
            getHostEl: () => /** @type {any} */ (null),
            destroy: () => {}
        };
    }

    host.type = "button";
    if (!host.hasAttribute("data-tooltip-side"))
    {
        host.setAttribute("data-tooltip-side", "top");
    }

    /** @type {((ev?: MouseEvent) => void) | null} */
    let clickHandler = null;

    /** @returns {PublishSlidesPillState} */
    function evaluate()
    {
        if (!isAuthenticated()) return "no-account";
        const fmt = getScriptFormat?.();
        if (fmt !== "mangaplay") return "unsupported-fmt";
        if (getIsLinked?.()) return "linked";
        if (getIsStoryboardFolder?.()) return "ready-group";
        return "ready";
    }

    function render()
    {
        const state = evaluate();
        host.dataset.state = state;
        host.innerHTML = `<img class="footer-pill-img" src="${GOOGLE_SLIDES_ICON_SRC}" alt="" width="16" height="16" draggable="false">`;

        // Sync-status badge — overlaid via CSS ::after pseudo-element.
        // Only meaningful when state === "linked".
        const syncStatus = state === "linked" ? (getSyncStatus?.() || null) : null;
        if (syncStatus)
        {
            host.dataset.syncStatus = syncStatus;
        }
        else
        {
            delete host.dataset.syncStatus;
        }

        /** @type {string} */
        let tooltipKey;
        /** @type {string} */
        let ariaKey;
        /** @type {string} */
        let tooltipFallback = "";
        /** @type {string} */
        let ariaFallback = "";
        /** @type {Record<string, string> | null} */
        let tooltipParams = null;
        if (state === "no-account")
        {
            tooltipKey = "mangaplay-studio.chrome.pills.publishSlides.tooltip.noAccount";
            ariaKey = "mangaplay-studio.chrome.pills.publishSlides.ariaLabel.noAccount";
        }
        else if (state === "unsupported-fmt")
        {
            const fmt = getScriptFormat?.();
            const friendly = FORMAT_LABEL[fmt] || "this file";
            tooltipKey = "mangaplay-studio.chrome.pills.publishSlides.tooltip.unsupportedFmt";
            ariaKey = "mangaplay-studio.chrome.pills.publishSlides.ariaLabel.unsupportedFmt";
            tooltipFallback = "Google Slides not available for {fmt}";
            tooltipParams = { fmt: friendly };
        }
        else if (state === "linked")
        {
            tooltipKey = "mangaplay-studio.chrome.pills.publishSlides.tooltip.linked";
            ariaKey = "mangaplay-studio.chrome.pills.publishSlides.ariaLabel.linked";
            const sync = getSyncStatus?.();
            if (sync === "remote-changed")
            {
                tooltipFallback = "Linked — remote deck has changed since last sync.";
            }
            else if (sync === "synced")
            {
                tooltipFallback = "Linked — synced and up to date.";
            }
            else
            {
                tooltipFallback = "Linked to a Google Slides\u2122 presentation.";
            }
            ariaFallback = "Sync linked Google Slides presentation";
        }
        else if (state === "ready-group")
        {
            tooltipKey = "mangaplay-studio.chrome.pills.publishSlides.tooltip.readyGroup";
            ariaKey = "mangaplay-studio.chrome.pills.publishSlides.ariaLabel.readyGroup";
            tooltipFallback = "Publish this Storyboard Folder to Google Slides™";
            ariaFallback = "Group publish to Google Slides";
        }
        else
        {
            tooltipKey = "mangaplay-studio.chrome.pills.publishSlides.tooltip.ready";
            ariaKey = "mangaplay-studio.chrome.pills.publishSlides.ariaLabel.ready";
            tooltipFallback = "Publish to Google Slides™";
        }

        if (tooltipParams)
        {
            host.setAttribute("data-tooltip", t(tooltipKey, tooltipFallback, tooltipParams));
        }
        else
        {
            host.setAttribute("data-tooltip", tooltipFallback ? t(tooltipKey, tooltipFallback) : t(tooltipKey));
        }
        host.setAttribute("aria-label", ariaFallback ? t(ariaKey, ariaFallback) : t(ariaKey));
    }

    function onClick(ev)
    {
        const state = evaluate();
        if (state === "no-account")
        {
            try { openSettingsModal("account"); }
            catch (e) { console.warn("[publish-slides-pill] openSettings failed:", e?.message); }
            return;
        }
        if (state === "unsupported-fmt") return;
        // "ready", "linked", "ready-group" all invoke the same click handler —
        // the click-side scope resolver decides what to actually publish.
        if (clickHandler)
        {
            try { clickHandler(ev); }
            catch (e) { console.warn("[publish-slides-pill] click handler threw:", e?.message); }
        }
    }

    host.addEventListener("click", onClick);
    const unsubAuth = onAuthChanged(render);
    const unsubI18n = i18nSubscribe(render);

    render();

    return {
        refresh: render,
        setClickHandler(fn)
        {
            clickHandler = fn || null;
        },
        getHostEl()
        {
            return host;
        },
        destroy()
        {
            host.removeEventListener("click", onClick);
            unsubAuth?.();
            unsubI18n?.();
        }
    };
}
