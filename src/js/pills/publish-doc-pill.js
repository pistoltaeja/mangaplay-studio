// @ts-check
/**
 * publish-doc-pill.js — Footer pill reflecting the publish/sync state of
 * the *currently active script*.
 *
 * Renders the official Google Docs logo (img/Google_Docs_logo_(2014-2020).svg)
 * regardless of state. State is conveyed via opacity + tooltip/aria strings:
 *   - no-account → dim opacity — not signed in to Google
 *   - not-sync   → normal      — signed in, doc not linked
 *   - sync       → normal      — signed in, doc linked
 *
 * Resolution rule:
 *   1. isAuthenticated() === false                              → no-account
 *   2. SyncStateMachine state === "unsynced" OR no machine yet  → not-sync
 *   3. otherwise                                                → sync
 *
 * The pill is always visible whenever the footer is. The bootstrap
 * (footer-bootstrap.js) drives `setSyncState(state)` on each
 * SyncStateMachine transition, and resets to "unsynced" when no script is
 * open so the colour reflects "no doc".
 *
 * Click contract:
 *   - no-account → openSettingsModal("account")
 *   - not-sync / sync → invoke the click handler installed via
 *     setClickHandler() (the bootstrap wires this to its
 *     getGoogleDocsGearClickHandler() so the pill and footer gear stay in
 *     lock-step).
 */

import { isAuthenticated, onAuthChanged } from "../auth/google-oauth.js";
import { openSettingsModal } from "../modals/settings-modal.js";
import { t, subscribe as i18nSubscribe } from "../adapters/tauri-i18n.js";

/** @typedef {"unsynced"|"idle"|"checking"|"local-ahead"|"remote-ahead"|"error"} SyncState */
/** @typedef {"unsynced"|"unlocked"|"locked-by-me"|"locked-by-other"|"stale"} LockState */
/** @typedef {"no-account"|"not-sync"|"sync"|"sync-dirty"} PublishDocPillState */

const GOOGLE_DOCS_ICON_SRC = "./img/Google_Docs_logo_(2014-2020).svg";

/**
 * @typedef {Object} PublishDocPillController
 * @property {(state: SyncState) => void} setSyncState
 * @property {(state: LockState) => void} setLockState
 * @property {(fn: (ev?: MouseEvent) => void) => void} setClickHandler
 * @property {() => HTMLElement} getHostEl
 * @property {() => void} destroy
 */

/**
 * Mount the Publish Doc pill into an existing host button element.
 *
 * @param {{ host: HTMLElement }} opts
 * @returns {PublishDocPillController}
 */
export function mountPublishDocPill({ host })
{
    if (!host)
    {
        return {
            setSyncState: () => {},
            setLockState: () => {},
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

    /** @type {SyncState} */
    let syncState = "unsynced";
    /** @type {((ev?: MouseEvent) => void) | null} */
    let clickHandler = null;

    /** @returns {PublishDocPillState} */
    function evaluate()
    {
        if (!isAuthenticated()) return "no-account";
        if (syncState === "unsynced") return "not-sync";
        // local-ahead = user has changes that need pushing → blue.
        // Everything else synced (idle / checking / remote-ahead / error)
        // → green ("connected and ready").
        if (syncState === "local-ahead") return "sync-dirty";
        return "sync";
    }

    function render()
    {
        const state = evaluate();
        host.dataset.state = state;
        host.innerHTML = `<img class="footer-pill-img" src="${GOOGLE_DOCS_ICON_SRC}" alt="" width="16" height="16" draggable="false">`;

        /** @type {Record<PublishDocPillState, string>} */
        const keyByState = {
            "no-account": "noAccount",
            "not-sync": "notSync",
            "sync": "sync",
            "sync-dirty": "syncDirty"
        };
        const key = keyByState[state];
        host.setAttribute(
            "data-tooltip",
            t(`mangaplay-studio.chrome.pills.publishDoc.tooltip.${key}`));
        host.setAttribute(
            "aria-label",
            t(`mangaplay-studio.chrome.pills.publishDoc.ariaLabel.${key}`));
    }

    function onClick(ev)
    {
        const state = evaluate();
        if (state === "no-account")
        {
            try { openSettingsModal("account"); }
            catch (e) { console.warn("[publish-doc-pill] openSettings failed:", e?.message); }
            return;
        }
        if (clickHandler)
        {
            try { clickHandler(ev); }
            catch (e) { console.warn("[publish-doc-pill] click handler threw:", e?.message); }
        }
    }

    host.addEventListener("click", onClick);
    const unsubAuth = onAuthChanged(render);
    const unsubI18n = i18nSubscribe(render);

    render();

    return {
        setSyncState(state)
        {
            syncState = state;
            render();
        },
        setLockState(state)
        {
            // The sync popover reads `anchor.dataset.lock` when it opens
            // (see footer-bootstrap.js `_openPopoverForCurrentState`). No
            // visual rule consumes it; this is pure bookkeeping on the
            // anchor element.
            host.dataset.lock = state;
        },
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
