// @ts-check
/**
 * google-account-pill.js — Footer pill reflecting the user's Google
 * sign-in + connectivity state.
 *
 * Three resolved states, each rendering a tinted lucide cloud icon:
 *   - no-account → cloud-off (red)        — not signed in
 *   - offline    → cloud-alert (blue)     — signed in but no network
 *   - online     → cloud-lightning (green)— signed in + online
 *
 * Resolution rule (cheap):
 *   1. isAuthenticated() === false → no-account
 *   2. navigator.onLine === false  → offline
 *   3. otherwise                   → online
 *
 * Re-evaluates on: onAuthChanged, window online/offline events, and
 * i18n subscribe (tooltip refresh on language change).
 *
 * Click in any state opens Settings → Account tab.
 */

import { icon } from "../panes/icons.js";
import { isAuthenticated, onAuthChanged } from "../auth/google-oauth.js";
import { openSettingsModal } from "../modals/settings-modal.js";
import { t, subscribe as i18nSubscribe } from "../adapters/tauri-i18n.js";

/** @typedef {"no-account"|"offline"|"online"} AccountPillState */

/** @type {Record<AccountPillState, string>} */
const ICON_FOR = {
    "no-account": "cloud-off",
    "offline":    "cloud-alert",
    "online":     "cloud-lightning"
};

/**
 * Mount the Google Account pill into an existing host button element.
 *
 * @param {{ host: HTMLElement }} opts
 * @returns {() => void} teardown — removes every listener registered here.
 */
export function mountGoogleAccountPill({ host })
{
    if (!host) return () => {};

    host.hidden = false;
    host.type = "button";
    if (!host.hasAttribute("data-tooltip-side"))
    {
        host.setAttribute("data-tooltip-side", "top");
    }

    /** @returns {AccountPillState} */
    function evaluate()
    {
        if (!isAuthenticated()) return "no-account";
        if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
        return "online";
    }

    function render()
    {
        const state = evaluate();
        host.dataset.state = state;
        host.innerHTML = icon(ICON_FOR[state], { size: 16 });
        host.setAttribute("aria-label", t("mangaplay-studio.chrome.pills.account.ariaLabel"));
        const tipKey = state === "no-account" ? "noAccount" : state;
        host.setAttribute("data-tooltip", t(`mangaplay-studio.chrome.pills.account.tooltip.${tipKey}`));
    }

    function onClick()
    {
        try { openSettingsModal("account"); }
        catch (e) { console.warn("[google-account-pill] openSettings failed:", e?.message); }
    }

    function onConnectivityChange()
    {
        render();
    }

    host.addEventListener("click", onClick);
    const unsubAuth = onAuthChanged(render);
    window.addEventListener("online",  onConnectivityChange);
    window.addEventListener("offline", onConnectivityChange);
    const unsubI18n = i18nSubscribe(render);

    render();

    return () =>
    {
        host.removeEventListener("click", onClick);
        unsubAuth?.();
        unsubI18n?.();
        window.removeEventListener("online",  onConnectivityChange);
        window.removeEventListener("offline", onConnectivityChange);
    };
}
