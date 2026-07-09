// @ts-check
/**
 * error-router.js — central error router with classifier + 4 surfaces.
 *
 * Replaces the ad-hoc try/catch { console.warn(...) } pattern. Every
 * caller does:
 *
 *     import { reportError } from "./error-router.js";
 *     try { ... }
 *     catch (e) { reportError(e, { origin: "fs-watcher", context }); }
 *
 * The router:
 *   1. Classifies the raw error into a taxonomy key.
 *   2. Picks one of four surfaces: toast / modal / inline-retry / fatal-overlay.
 *   3. Renders mode-aware (mobile shifts toasts above the bottom tabbar,
 *      mobile modals go full-bleed).
 *
 * Modelled on `extension-mangaplay-studio/adapters/ext-error-classifier.js`
 * — same class shapes so a future shared classifier can serve both
 * surfaces.
 */

import { isMobileLike } from "./ux-mode.js";
import { transition, STATES } from "./state-machine.js";
import { showBanner } from "./toast.js";
import { t } from "../adapters/tauri-i18n.js";

/**
 * @typedef {object} ErrorRouting
 * @property {string}  class
 * @property {"inline-retry"|"toast"|"modal"|"fatal-overlay"} surface
 * @property {boolean} recoverable
 * @property {(()=>void)|undefined} [retry]
 * @property {string}  diagnostic
 * @property {any}     [context]
 * @property {{from:string,to:string,name:string,consecutiveFailures:number}|undefined} [migration]
 */

const TAXONOMY = {
    // ── File system ──
    "fs.read_failed":       { surface: "toast",         recoverable: true,  fatal: false },
    "fs.write_failed":      { surface: "modal",         recoverable: true,  fatal: false },
    "fs.watch_failed":      { surface: "toast",         recoverable: true,  fatal: false },
    "fs.project_corrupt":   { surface: "fatal-overlay", recoverable: true,  fatal: true  },
    // ── Project lifecycle ──
    "project.open_failed":  { surface: "fatal-overlay", recoverable: true,  fatal: true  },
    "project.create_failed":{ surface: "modal",         recoverable: true,  fatal: false },
    // ── Boot ──
    "boot.parse_failed":    { surface: "fatal-overlay", recoverable: true,  fatal: true  },
    "boot.settings_failed": { surface: "toast",         recoverable: false, fatal: false },
    "boot.timeout":         { surface: "fatal-overlay", recoverable: true,  fatal: true  },
    // ── Export / save ──
    "export.failed":        { surface: "modal",         recoverable: true,  fatal: false },
    "save.conflict":        { surface: "modal",         recoverable: true,  fatal: false },
    // ── User-data migration ──
    "userdata.migration_failed": { surface: "fatal-overlay", recoverable: true,  fatal: true  },
    // ── Catch-all ──
    "fatal.unknown":        { surface: "fatal-overlay", recoverable: false, fatal: true  },
};

/**
 * Heuristic classifier. Maps raw caught errors to a taxonomy key.
 * @param {any} err
 * @param {{origin?: string}} ctx
 * @returns {string}
 */
function classify(err, ctx)
{
    const msg = err instanceof Error ? err.message : String(err || "");
    const origin = ctx?.origin || "";

    if (origin === "boot" && /parse/i.test(msg)) return "boot.parse_failed";
    if (origin === "boot-timeout") return "boot.timeout";
    if (origin === "user-data-migration") return "userdata.migration_failed";
    if (origin === "fs-watcher") return "fs.watch_failed";
    if (origin === "project-open" && /not.*found|enoent/i.test(msg)) return "project.open_failed";
    if (origin === "project-open" && /json|parse|corrupt/i.test(msg)) return "fs.project_corrupt";
    if (origin === "project-open") return "project.open_failed";
    if (origin === "project-create") return "project.create_failed";
    if (origin === "export") return "export.failed";
    if (origin === "save") return "save.conflict";
    if (origin === "settings") return "boot.settings_failed";
    if (origin === "fs-read") return "fs.read_failed";
    if (origin === "fs-write") return "fs.write_failed";

    return "fatal.unknown";
}

/**
 * Single public entry point. Use this everywhere a try/catch used to
 * `console.warn`.
 *
 * @param {unknown} err
 * @param {{origin?: string, retry?: ()=>void, context?: any}} [opts]
 */
export function reportError(err, opts = {})
{
    const klass = classify(err, opts);
    const route = TAXONOMY[klass] || TAXONOMY["fatal.unknown"];
    /** @type {any} */
    const e = err;
    const name = (e && e.name) || "Error";
    const message = (e && e.message) || String(err);
    const diagnostic = `${name}: ${message.slice(0, 200)}`;

    console.error(`[error-router] ${klass} (${opts.origin || "unknown"}): ${diagnostic}`);

    /** @type {ErrorRouting} */
    const payload = {
        class: klass,
        surface: /** @type any */ (route.surface),
        recoverable: route.recoverable,
        retry: opts.retry,
        diagnostic,
        context: opts.context,
        migration: /** @type any */ (e)?.migration || undefined,
    };

    switch (route.surface)
    {
        case "toast":         return _renderToast(payload);
        case "modal":         return _renderModal(payload);
        case "inline-retry":  return _renderInline(payload);
        case "fatal-overlay": return _renderFatal(payload);
        default:              return _renderFatal(payload);
    }
}

/** @param {ErrorRouting} p */
function _renderToast(p)
{
    // showBanner already exists in toast.js. Mode-aware positioning lives
    // in app.css under `:root[data-ux-mode="mobile"] .mps-toast-container`.
    try { showBanner(p.diagnostic); }
    catch (_) { /* nothing more to do */ }
}

/** @param {ErrorRouting} p */
function _renderModal(p)
{
    import("../modals/confirm-modal.js").then(({ confirmModal }) =>
    {
        confirmModal({
            title: p.class,
            body: p.diagnostic,
            confirm: p.retry ? "Retry" : "OK",
            cancel: p.retry ? "Cancel" : undefined,
        }).then((ok) =>
        {
            if (ok && p.retry) try { p.retry(); } catch (_) {}
        }).catch(() => {});
    }).catch(() =>
    {
        // Fall back to a toast if the modal module is unavailable.
        try { showBanner(p.diagnostic); } catch (_) {}
    });
}

/** @param {ErrorRouting} p */
function _renderInline(p)
{
    document.dispatchEvent(new CustomEvent("mps-inline-error", { detail: p }));
}

/** @param {ErrorRouting} p */
function _renderFatal(p)
{
    // Routes through the FSM — error state owns the overlay (#error-overlay
    // markup in index.html). transition() is always allowed to ERROR as a
    // safety valve.
    const overlay = document.getElementById("error-overlay");
    if (overlay)
    {
        const isMigration = p.class === "userdata.migration_failed";

        const body = overlay.querySelector(".error-body");
        if (body)
        {
            if (isMigration)
            {
                const bodyText = t("mangaplay-studio.userData.error.migrationFailed");
                body.textContent = (bodyText && bodyText !== "mangaplay-studio.userData.error.migrationFailed")
                    ? bodyText
                    : p.diagnostic;
            }
            else
            {
                body.textContent = p.diagnostic;
            }
        }

        const retry = /** @type {HTMLButtonElement|null} */ (overlay.querySelector(".error-retry"));
        if (retry)
        {
            if (isMigration)
            {
                const retryLabel = t("mangaplay-studio.userData.error.retry");
                if (retryLabel && retryLabel !== "mangaplay-studio.userData.error.retry")
                {
                    retry.textContent = retryLabel;
                }
            }

            retry.onclick = () =>
            {
                overlay.hidden = true;
                if (isMigration)
                {
                    // Easiest way to re-run the migration gate: full reload.
                    // Boot will re-enter ensureUserDataVersion with a fresh
                    // state; the Rust side already recorded the failure so
                    // consecutiveFailures stays correct.
                    try { location.reload(); } catch (_) {}
                    return;
                }
                if (p.retry) { try { p.retry(); } catch (_) {} }
                else
                {
                    // Default retry path: drop back to the picker (desktop)
                    // or re-enter LOADING (mobile — caller is responsible
                    // for re-driving openProject from there).
                    try
                    {
                        if (isMobileLike()) transition(STATES.LOADING, { stage: "bundle" });
                        else transition(STATES.RECENT_PROJECTS);
                    }
                    catch (_) {}
                }
            };
        }

        // Skip-and-continue button: only after the 2nd consecutive failure
        // of the same rung. Removed/hidden for any non-migration error so
        // a previous migration overlay doesn't leak it into a later error.
        const existingSkip = /** @type {HTMLButtonElement|null} */ (overlay.querySelector(".error-skip"));
        if (isMigration && p.migration && p.migration.consecutiveFailures >= 2)
        {
            let skipBtn = existingSkip;
            if (!skipBtn && retry && retry.parentNode)
            {
                skipBtn = document.createElement("button");
                skipBtn.className = "error-skip";
                retry.parentNode.insertBefore(skipBtn, retry.nextSibling);
            }
            if (skipBtn)
            {
                const skipLabel = t("mangaplay-studio.userData.error.skipAndContinue");
                skipBtn.textContent = (skipLabel && skipLabel !== "mangaplay-studio.userData.error.skipAndContinue")
                    ? skipLabel
                    : "Skip and continue";
                skipBtn.hidden = false;
                skipBtn.onclick = async () =>
                {
                    try
                    {
                        const mod = await import("../project/user-data-version.js");
                        await mod.skipFailedRung({
                            from: /** @type any */ (p.migration).from,
                            to:   /** @type any */ (p.migration).to,
                        });
                    }
                    catch (err)
                    {
                        console.error("[error-router] skipFailedRung failed:", err);
                    }
                    overlay.hidden = true;
                    try { location.reload(); } catch (_) {}
                };
            }
        }
        else if (existingSkip)
        {
            existingSkip.remove();
        }

        overlay.hidden = false;
    }
    transition(STATES.ERROR, { cause: p, retry: p.retry }).catch(() => {});
}

// ── Global error capture ────────────────────────────────────────────────
// Without these, uncaught rejections during boot disappear into devtools
// (and are invisible on mobile where devtools isn't accessible). Install
// once on module load.
if (typeof window !== "undefined")
{
    window.addEventListener("error", (ev) =>
    {
        const err = /** @type {any} */ (ev).error || ev.message;
        reportError(err, { origin: "global-error" });
    });
    window.addEventListener("unhandledrejection", (ev) =>
    {
        reportError(/** @type {any} */ (ev).reason, { origin: "unhandled-rejection" });
    });
}
