// @ts-check
/**
 * boot-placeholders.js — placeholders for future IAP / Analytics / OAuth.
 *
 * Three boot substates exist so the FSM shape is right NOW for when real
 * implementations land. Each future plan (tauri-plugin-iap,
 * tauri-plugin-aptabase, tauri-plugin-oauth) replaces the body of one
 * helper. The FSM call sites and i18n keys stay put.
 *
 * IAP + Analytics: no real work, no wait duration. Each helper ticks the
 * boot caption and returns immediately.
 *
 * Account: real. If a cached Google profile exists on disk AND the machine
 * is online, we await ensureRehydrated() so the workspace boots with a
 * warm access token. Skipped silently when no cached profile is present or
 * the machine is offline (the auth module already schedules an online-retry
 * for the offline case).
 */

import { t } from "../adapters/tauri-i18n.js";
import { loadProfile } from "../auth/storage.js";
import { ensureRehydrated } from "../auth/google-oauth.js";
import { track, setAnalyticsAllowed, registerSink } from "../analytics/mps-analytics.js";
import { firebaseSink } from "../analytics/sink-firebase.js";
import { installCrashReporter } from "../analytics/js-crash-reporter.js";
import { loadAppSettings } from "../shell/app-settings-io.js";
import { getUxMode, isMobileLike } from "./ux-mode.js";
import { getPlatformKey, isIapPlatform } from "../adapters/platform-key.js";
import { setEntitlements, initEntitlementsPlatform } from "../iap/entitlements.js";

/**
 * Initialise In-App Purchases. Mobile-only: warms the plugin and does a SILENT
 * entitlement read (currentEntitlements — no popup) so Pro is unlocked at
 * launch, then installs the out-of-band purchase listener. Desktop is a pure
 * no-op (no store). Fire-and-forget — must never block first paint or throw.
 */
export async function initIap()
{
    /** @type {any} */ (window).__mpsSplash?.update?.("iapInit", t("mangaplay-studio.boot.stage.iapInit"));
    try { await initEntitlementsPlatform(); } catch (_) {}
    if (!(await isIapPlatform()))
    {
        // No store on this OS (any UX mode) — nothing to warm.
        return;
    }
    try
    {
        const iap = await import("../iap/iap-service.js");
        await iap.initIap();
        // Silent entitlement read at launch — unlocks Pro with zero UI.
        const entitlements = await iap.getEntitlements();
        applyEntitlements(entitlements);
        // Persist the ad-free flag from the fresh entitlement snapshot so
        // initAds()'s gate trips before any ad download this session.
        try { const ads = await import("../ads/ad-service.js"); await ads._syncAdsDisabled(); } catch (_) {}
        // Reconcile out-of-band purchases (renewals, Ask-to-Buy approvals).
        await iap.onPurchaseUpdated(() =>
        {
            iap.getEntitlements().then((e) =>
            {
                applyEntitlements(e);
                import("../ads/ad-service.js").then((ads) => ads._syncAdsDisabled()).catch(() => {});
            }).catch(() => {});
        });
    }
    catch (e)
    {
        console.debug("[initIap]", e);
    }
}

/**
 * Apply resolved entitlements to app state. Placeholder hook — the Pro-gating
 * surface (feature flags / UI) is wired by a follow-up ticket. For now this
 * exposes the latest snapshot on window for consumers and logs at debug level.
 * @param {Record<string, any>} entitlements
 */
function applyEntitlements(entitlements)
{
    try
    {
        /** @type {any} */ (window).__mpsEntitlements = entitlements || {};
    }
    catch (_)
    {
        // window unavailable (headless) — nothing to expose.
    }
    try
    {
        setEntitlements(entitlements || {});
    }
    catch (_)
    {
        // entitlements store unavailable — non-fatal.
    }
}

/**
 * Initialise ads. Mobile-only, gated: ad-service itself OS-gates and returns
 * early when the user holds any entitlement (adsDisabled). Lazy-imported so the
 * ad path never loads on desktop-first-paint. Fire-and-forget — never throws.
 */
export async function initAds()
{
    try
    {
        const ads = await import("../ads/ad-service.js");
        await ads.initAds();
    }
    catch (e)
    {
        console.debug("[initAds]", e);
    }
}

/** Initialise analytics. Desktop: AbsolutelySkint sink only. Fire-and-forget — must never block first paint or throw. */
export async function initAnalytics()
{
    /** @type {any} */ (window).__mpsSplash?.update?.("analyticsInit", t("mangaplay-studio.boot.stage.analyticsInit"));
    try
    {
        const settings = await loadAppSettings();
        setAnalyticsAllowed(settings.analyticsEnabled !== false);
        const platform = await getPlatformKey();
        const uxMode = getUxMode();
        // Mobile-only Firebase sink is registered in the mobile init substage; desktop uses only the AbsolutelySkint sink.
        track("app.boot", { platform, uxMode });
        if (isMobileLike())
        {
            // Firebase is configured natively FIRST (google-services.json / GoogleService-Info.plist) before any JS runs.
            registerSink(firebaseSink);
            installCrashReporter();
        }
    }
    catch (e)
    {
        console.debug("[initAnalytics]", e);
    }
}

/**
 * Restore the Google OAuth session at boot when a cached profile exists
 * and the machine is online. Blocks the boot flow so the splash caption
 * stays visible until restore completes.
 */
export async function initAccount()
{
    const profile = loadProfile();
    if (!profile || !profile.sub)
    {
        // No cached login — nothing to restore, don't spend a splash frame on it.
        return;
    }

    /** @type {any} */ (window).__mpsSplash?.update?.("accountInit", t("mangaplay-studio.boot.stage.accountInit"));

    if (typeof navigator !== "undefined" && navigator.onLine === false)
    {
        // Offline — preserve cached session; ensureRehydrated's own online
        // retry hook will run when connectivity returns.
        return;
    }

    try
    {
        await ensureRehydrated();
    }
    catch (e)
    {
        console.debug("[initAccount] ensureRehydrated failed:", e);
    }
}
