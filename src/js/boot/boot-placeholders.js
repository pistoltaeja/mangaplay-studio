// @ts-check
/**
 * boot-placeholders.js — placeholders for future IAP / Analytics / OAuth.
 *
 * Three boot substates exist so the FSM shape is right NOW for when real
 * implementations land. Each future plan (tauri-plugin-iap,
 * tauri-plugin-aptabase, tauri-plugin-oauth) replaces the body of one
 * helper. The FSM call sites and i18n keys stay put.
 *
 * Today: no real work, no wait duration. Each helper ticks the boot
 * caption and returns immediately.
 */

import { t } from "../adapters/tauri-i18n.js";

/** Placeholder — wired when in-app purchases ship. */
export async function initIap()
{
    /** @type {any} */ (window).__mpsSplash?.update?.("iapInit", t("mangaplay-studio.boot.stage.iapInit"));
    // TODO: when IAP lands, await iapPlugin.warmup(); await iapPlugin.refreshEntitlements();
    //       see TODO/iap/iap-future.md (placeholder)
}

/** Placeholder — wired when analytics ships. */
export async function initAnalytics()
{
    /** @type {any} */ (window).__mpsSplash?.update?.("analyticsInit", t("mangaplay-studio.boot.stage.analyticsInit"));
    // TODO: when analytics lands, await analytics.init(APP_KEY); analytics.event("boot");
    //       see TODO/analytics/analytics-future.md (placeholder)
}

/** Placeholder — wired when OAuth account flow ships. */
export async function initAccount()
{
    /** @type {any} */ (window).__mpsSplash?.update?.("accountInit", t("mangaplay-studio.boot.stage.accountInit"));
    // TODO: when accounts land, await refreshAccessToken(); applyEntitlements();
    //       see TODO/mangaplay-studio-google-oauth.md
}
