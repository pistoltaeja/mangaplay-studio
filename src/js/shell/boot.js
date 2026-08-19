import { state } from "./state.js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri, basename } from "../util/index.js";
import { t, initialise as initI18n, getLanguage, setLanguage, subscribe as subscribeI18n } from "../adapters/tauri-i18n.js";
import { icon } from "../panes/icons.js";
import { getBroker } from "../project/active-script-broker.js";
import { createNewProject, loadRecent, shouldAutoResume, shouldForceOnboarding, eraseMangaart } from "../project/project.js";
import { loadUserSettings, saveUserSettings, getUserSetting, ensureSpellcheckSeed, pathExists } from "../project/user-settings.js";
import { ensureUserDataVersion } from "../project/user-data-version.js";
import { initPathHelpers } from "../util/paths.js";
import { applySkin } from "../boot/skins.js";
import { transition, STATES } from "../boot/state-machine.js";
import { reportError } from "../boot/error-router.js";
import { initIap, initAnalytics, initAccount, initAds } from "../boot/boot-placeholders.js";
import { hasWindowChrome } from "../adapters/platform-capabilities.js";
import { wireWindowControls } from "../boot/window-controls.js";
import { isMobileLike } from "../boot/ux-mode.js";
import { wireDeclarativeTooltips } from "../tooltip/tooltip.js";
import { wireQuickToggleTooltipMirror } from "../tooltip/quick-toggle-tooltip-mirror.js";
import { wireTooltipI18nLiveUpdates } from "../tooltip/tooltip-i18n.js";
import { warmupHarper, disposeHarper, loadPersistedDictionary } from "../spellcheck/harper-linter.js";
import { resolveTier } from "../spellcheck/spellcheck-tier.js";
import { setSpellcheckState } from "../spellcheck/spellcheck-state.js";
import { ensureFontsFor, releaseFontsFor } from "../font/font-loader.js";
import { applyScreenplayFont, applyEditorFont } from "../font/font-prefs.js";
import { applySmoothMotion, applySmoothScrolling } from "../adapters/motion-prefs.js";
import { confirmModal } from "../modals/confirm-modal.js";
import { installSplashComponent } from "../components/mps-splash.js";
import { openContextMenu } from "../components/mps-context-menu.js";
import { destroyGoogleDocsFooter } from "../google-docs-sync/footer-bootstrap.js";
import { renderStartScreen } from "./start-screen.js";
import { routeContextMenu, replaceActiveTab } from "./explorer.js";
import { wireLeftSubviews, switchSubview } from "./subviews.js";
import { wireLeftPaneResize, wireSeamResize, wireStoryboardCollapse, wireLeftPaneToggle } from "./layout.js";
import { openProjectSwitcherMenu } from "./project-switcher.js";
import { wireTopbarPagination, wirePageIndexSessionWriteThrough } from "./topbar-pagination.js";
import { openAndMountProject } from "./open-and-mount-project.js";
import { createOnboardingProject } from "../onboarding/create-onboarding-project.js";
// Onboarding modules — statically imported to keep the iOS boot path free of
// any runtime module resolution. Onboarding fires on first launch of every
// platform, and mobile bundles single-file with no chunk fetches.
import "../components/mps-picker-shell.js";
import "../components/mps-mobile-fab.js";
import { getAppMascot } from "../components/mps-mascot-app.js";
import "../components/mps-dialogue.js";
import "../components/mps-card-tray.js";
import { runOnboardingScript } from "../onboarding/onboarding-engine.js";
import {
    setAppState,
    showError,
    queueAppSettingsSave,
    loadAppSettings,
    flushAppSettings,
    probePlatform,
    refreshStateMessage,
    markBench,
    wireEmptyState,
    wireHelpButton,
    wireRailAccount,
    wireSettingsButton,
    wireMobileFabActions,
    wireStoryboardSwitcher,
} from "../app.js";

/** @type {{ os: string, mode: string }} */
let platform = { os: "browser", mode: "browser" };

/**
 * Wire every static-shell listener exactly once per app lifetime. Called from
 * `boot()` before either the auto-resume or picker branch diverges. MUST NOT
 * be called again on project switches — re-wiring stacks pointer/click/event
 * handlers on the static DOM and produces "snappy / multi-jump drags",
 * N-times page-index jumps, etc.
 */
export async function wireShellOnce()
{
    if (state.shellWired) return;
    state.shellWired = true;

    // One-shot boot pass: replace every <span data-icon="…"> inside #app-chrome
    // with inline SVG. Scoped so the loading/start screens are untouched.
    for (const el of document.querySelectorAll("#app-chrome [data-icon]"))
    {
        el.outerHTML = icon(el.dataset.icon, { size: 16, class: "icon" });
    }

    // Tooltip system — registers a single delegated handler for [data-tooltip] elements.
    wireDeclarativeTooltips();
    // Mirror the quick-toggle sidebar's data-tooltip-text onto data-tooltip so
    // the global delegator above catches it. Its native tooltip is CSS-hidden.
    wireQuickToggleTooltipMirror();

    wireLeftPaneResize();
    wireSeamResize();
    wireStoryboardCollapse();
    wireStoryboardSwitcher();
    wireTopbarPagination();
    wirePageIndexSessionWriteThrough();
    wireLeftPaneToggle();
    wireLeftSubviews();
    wireEmptyState();
    wireSettingsButton();
    wireMobileFabActions();
    wireHelpButton();
    wireRailAccount();

    // Left-click on a folder-list-row opens that file in the editor. Skipped
    // when the click target is inside the inline-rename input (the input
    // belongs to the row but interactions there must not trigger a swap).
    document.addEventListener("click", (ev) =>
    {
        const t = /** @type {Element|null} */ (ev.target);
        if (!t || typeof t.closest !== "function") return;
        // Ignore clicks that are part of a rename input or a context menu.
        if (t.closest(".folder-list-rename-input")) return;
        if (t.closest(".ctx-menu")) return;
        const row = /** @type {HTMLElement|null} */ (t.closest(".folder-list-row"));
        if (!row || !row.dataset.path) return;
        if (row.classList.contains("is-renaming")) return;
        // Fire-and-forget; replaceActiveTab handles its own errors.
        const rowUuid = row.dataset.uuid || null;
        replaceActiveTab(row.dataset.path, rowUuid).catch((e) =>
        {
            console.warn("[swap] open failed:", e);
        });
    });

    document.querySelectorAll(".top-bar-subview").forEach((b) =>
    {
        const btn = /** @type {HTMLElement} */ (b);
        btn.addEventListener("click", () =>
        {
            const name = btn.dataset.subview;
            if (name) switchSubview(name);
        });
    });

    const projectSwitcherBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("project-switcher-btn"));
    if (projectSwitcherBtn)
    {
        projectSwitcherBtn.addEventListener("click", () =>
        {
            if (projectSwitcherBtn.disabled) return;
            openProjectSwitcherMenu();
        });
    }

    // When the window is maximized / restored / resized, force the canvas
    // to re-fit. ResizeObserver inside the website canvas can sample a stale
    // measurement mid-transition; the Tauri-side onResized fires post-settle.
    // Mobile / tablet windows are fixed-size — skip the listener (no resize
    // can happen, and the persist-size code below would try to save bogus
    // mobile geometry into settings.json).
    try
    {
        if (!hasWindowChrome()) throw new Error("skip-no-chrome");
        const winMod = await import("@tauri-apps/api/window");
        const w = winMod.getCurrentWindow();
        await w.onResized(() =>
        {
            requestAnimationFrame(() =>
            {
                const c = document.querySelector("mps-canvas");
                if (c)
                {
                    try { c.fitToContainer?.(true); } catch {}
                    try { c.resizeDrawingCanvas?.(); } catch {}
                }
            });
            // Persist window size + maximized state. Read inside the listener
            // so we capture the post-event geometry. When maximized we don't
            // overwrite width/height so the "remembered non-maximized size"
            // stays the user's last hand-sized geometry. innerSize() returns
            // PhysicalSize; the Rust builder takes logical px, so divide by
            // scaleFactor() to avoid growth/shrink loops on HiDPI displays.
            void (async () =>
            {
                try
                {
                    if (window.__mps_picker_active) return;
                    const isMax = await w.isMaximized();
                    if (isMax)
                    {
                        queueAppSettingsSave({ windowMaximized: true });
                    }
                    else
                    {
                        const phys = await w.innerSize();
                        const scale = await w.scaleFactor();
                        const logicalW = Math.round(phys.width / scale);
                        const logicalH = Math.round(phys.height / scale);
                        // Floor what we persist. Mirror of the Rust-side
                        // min_inner_size in src-tauri/src/lib.rs so a
                        // transient tiny inner-size can't poison
                        // settings.json.
                        if (logicalW < 1080 || logicalH < 640) return;
                        queueAppSettingsSave({
                            windowMaximized: false,
                            windowWidth: logicalW,
                            windowHeight: logicalH,
                        });
                    }
                }
                catch {}
            })();
        });
    }
    catch (e)
    {
        // "skip-no-chrome" — expected on mobile/tablet (fixed-size window,
        // no resize listener to install).
        if (e?.message !== "skip-no-chrome")
        {
            console.warn("[wireShellOnce] tauri window.onResized unavailable:", e?.message);
        }
    }

    // Mount the hand-rolled #window-controls (min / max / close) — replaces
    // tauri-plugin-frame's eval-injected buttons. Gated internally on
    // hasWindowChrome() so mobile / tablet skip.
    try { await wireWindowControls(); }
    catch (e) { console.warn("[wireShellOnce] wireWindowControls failed:", e?.message); }

    // Double-click on empty regions of #top-bar toggles window maximize, matching
    // the native titlebar behaviour above it. Skip clicks that originate on
    // interactive descendants so buttons and labels stay clickable. Mobile /
    // tablet windows have no maximize concept — guard with hasWindowChrome().
    const topBarEl = document.getElementById("top-bar");
    if (topBarEl && hasWindowChrome())
    {
        topBarEl.addEventListener("dblclick", async (e) =>
        {
            const t = /** @type {HTMLElement} */ (e.target);
            if (t.closest("button, a, input, [role='button']")) return;
            try
            {
                const winMod = await import("@tauri-apps/api/window");
                await winMod.getCurrentWindow().toggleMaximize();
            }
            catch (err) { console.warn("[top-bar dblclick] toggleMaximize failed:", err?.message); }
        });
    }
}

// ── Mobile auto-create helper ──
/**
 * Create (or pick a numbered-suffix variant of) the default mobile project
 * under the user-data dir. Reviewed item #5: the Rust `project_create_new`
 * impl unconditionally overwrites meta.json + seed file, so the JS pre-check
 * + numbered suffix is load-bearing — not optional.
 *
 * @param {{forceNew?: boolean}} [opts]
 * @returns {Promise<string>} canonical project path
 */
async function ensureMobileDefaultProject(opts = {})
{
    const userDataDir = await invoke("user_data_dir");
    const name = await pickDefaultProjectName(userDataDir, opts);
    const path = await createNewProject(userDataDir, name, true,
        { displayName: "My Documents", description: "My Documents", locked: true });
    await saveUserSettings({ lastProjectPath: path });
    return path;
}

/**
 * Pick an unused default project name under `userDataDir`: `my-documents`, or
 * `my-documents (N)` when the base name is taken or `forceNew` is set. The
 * 9999 cap mirrors the pathological fallback in fs_helpers.rs.
 * @param {string} userDataDir
 * @param {{forceNew?: boolean}} [opts]
 * @returns {Promise<string>} the bare project name (no parent prefix)
 */
export async function pickDefaultProjectName(userDataDir, opts = {})
{
    let candidate = `${userDataDir}/my-documents`;
    if (opts.forceNew || (await pathExists(candidate)))
    {
        let n = 2;
        while ((await pathExists(`${userDataDir}/my-documents (${n})`)) && n < 9999) n++;
        candidate = `${userDataDir}/my-documents (${n})`;
    }
    // Strip the parent prefix to get just the name for project_create_new.
    return candidate.substring(userDataDir.length + 1);
}

// ── Boot sequence ──
export async function boot() {
    try {
        // Promote inline #boot-screen shell to <mps-splash> and drain the
        // pre-parse shim queue. Must run BEFORE any FSM transitions so the
        // upgraded component owns every subsequent update() / setProgress().
        try { installSplashComponent(); }
        catch (e) { console.warn("[boot] installSplashComponent failed:", e); }

        // Single capture-phase contextmenu router. Owns BOTH suppressing the
        // native WebView2/WKWebView menu AND showing our custom menu. One
        // listener instead of guard+consumer to avoid the Chromium quirk
        // where preventDefault on contextmenu halts DOM propagation past the
        // suppressor — local listeners below the guard never fire.
        document.addEventListener("contextmenu", (e) =>
        {
            const result = routeContextMenu(e.target, e);
            if (result === "native") return;           // opt-in — let native menu through
            e.preventDefault();                          // suppress native everywhere else
            if (result && result.items)
            {
                openContextMenu({ x: e.clientX, y: e.clientY, items: result.items });
            }
        }, { capture: true });

        // JS → Rust log forwarder. Release builds have no DevTools, so a JS
        // console.error is invisible to users and to us when triaging support
        // tickets. We forward every error / warn / unhandled rejection through
        // the `app_log_message` Tauri command so it lands in `app.log` next to
        // the Rust-side messages. Best-effort: a failing log itself can't be
        // re-logged (would loop), so we swallow its rejection.
        const forwardToRustLog = (level, tag, msg) => {
            try {
                if (isTauri())
                {
                    invoke("app_log_message", {
                        level,
                        tag: String(tag || "").slice(0, 64),
                        message: String(msg || "").slice(0, 4096),
                    }).catch(() => {});
                }
            }
            catch { /* swallow */ }
        };
        // Patch console.error / console.warn to also forward. Keep the
        // originals so DevTools (when present in dev) still shows them.
        const origErr = console.error.bind(console);
        const origWarn = console.warn.bind(console);
        console.error = (...args) => {
            origErr(...args);
            forwardToRustLog("error", "console", args.map(String).join(" "));
        };
        console.warn = (...args) => {
            origWarn(...args);
            forwardToRustLog("warn", "console", args.map(String).join(" "));
        };

        // Debug: viewport diagnostics for iOS sizing investigation.
        // Runs after the Tauri bridge is ready so it appears in Xcode console.
        forwardToRustLog("info", "viewport",
            `innerW=${window.innerWidth} innerH=${window.innerHeight}` +
            ` clientW=${document.documentElement.clientWidth}` +
            ` clientH=${document.documentElement.clientHeight}` +
            ` scrollW=${document.documentElement.scrollWidth}` +
            ` scrollH=${document.documentElement.scrollHeight}` +
            ` screenW=${screen.width} screenH=${screen.height}` +
            ` dpr=${window.devicePixelRatio}` +
            ` uxMode=${document.documentElement.getAttribute("data-ux-mode")}`);

        // NOTE: window.addEventListener("error" | "unhandledrejection") is
        // installed once at module-load by error-router.js. error-router's
        // reportError() calls console.error("[error-router] ..."), which
        // hits the patched console.error above and forwards to Rust. So
        // there's only ONE installer for global error capture, with the
        // taxonomy + surface routing applied uniformly.

        // Expose a tagged logger for explicit telemetry from critical paths
        // (onCopy/onDelete/handleRename/onCreate). The handlers call this
        // when they enter, when an IPC succeeds, and on error.
        /** @type {any} */ (window).__mpsLog = (level, tag, msg) => forwardToRustLog(level, tag, msg);

        setAppState("booting");

        // i18n init — auto-detect OS locale via navigator.language /
        // navigator.languages so the picker shows the right language on
        // first boot. Setting language for downstream t() calls.
        // Awaited because the active locale's dictionary is now lazy-loaded;
        // every downstream `t()` callsite depends on it being resident.
        await initI18n();

        // Tooltip i18n bootstrap — walks [data-i18n-tooltip] now and on
        // every mps-lang-change, mapping localised strings into the
        // canonical data-tooltip attr the tooltip subsystem reads.
        wireTooltipI18nLiveUpdates();

        // Storyboard erase — mps-canvas dispatches this when the user hits
        // the paint-widget trash button and confirms the "erase entire
        // storyboard" prompt. The canvas has already wiped local memory
        // (engine strokes + RuntimeDrawingCache + undo history); we still
        // need to nuke the on-disk `.mangaart` file and drop the artMap
        // entry so the next scaffold mints a fresh UUID.
        document.addEventListener("mps-erase-storyboard", async () =>
        {
            if (!state.currentProject?.path) return;
            const uuid = state.slotManager?.getActive()?.fileUuid || null;
            if (!uuid) return;

            const ok = await confirmModal({
                title: t("ui.canvas.eraseStoryboardTitle"),
                body: t("ui.canvas.eraseStoryboardConfirm"),
                confirm: t("ui.canvas.eraseStoryboardConfirmButton"),
                danger: true,
            });
            if (!ok) return;

            try
            {
                await eraseMangaart(state.currentProject.path, uuid);
                document.dispatchEvent(new CustomEvent("mps-erase-storyboard-committed"));
            }
            catch (err)
            {
                console.error("[erase-storyboard] failed:", err);
            }
        });

        // Re-paint the currently-displayed state message on language
        // change. setAppState is idempotent for the same state (only
        // toggles classes/text), so re-invoking it here is cheap; we
        // gate on state values that actually surface a message.
        subscribeI18n(() => refreshStateMessage());

        // Persist language changes to app_settings whenever the user picks
        // a new locale (from the picker or the Settings General row).
        document.addEventListener("mps-lang-change", async (ev) =>
        {
            const code = ev?.detail?.code;
            if (!code) return;
            try
            {
                if (isTauri())
                {
                    await invoke("app_settings_set", {
                        value: { language: code },
                    });
                }
            }
            catch (e)
            {
                console.warn("[lang] persist failed:", e?.message || e);
            }
        });

        // Fetch app-wide settings AND apply the skin BEFORE the chrome
        // unhides (FOUC prevention). loadingScreen + chrome both honour
        // [data-skin], so this needs to happen before either paints.
        const appSettings = await loadAppSettings();
        applySkin(appSettings.skin);
        applyScreenplayFont(appSettings.screenplayFont);
        applyEditorFont(appSettings.editorFont);
        applySmoothMotion(appSettings.smoothMotion);
        applySmoothScrolling(appSettings.smoothScrolling);

        // If app_settings stored an explicit language, it wins over the
        // OS-locale auto-detect from initI18n() above.
        if (appSettings.language)
        {
            await setLanguage(appSettings.language);
        }
        // Stash for later use (mountViews reads from currentProject + here).
        globalThis.__MPS_APP_SETTINGS__ = appSettings;

        // First-paint font load. Mounts the shards the active locale needs
        // and pre-warms the FontFaceSet so the picker shell paints with
        // the right glyphs (not the system fallback) on first reveal.
        const initialLocale = getLanguage();
        let lastFontLocale = initialLocale;
        await ensureFontsFor(initialLocale);

        // Live language switch — load the new locale's shards, swap CSS
        // vars, then evict the previous locale's shards after the
        // GRACE_MS window inside the loader.
        document.addEventListener("mps-lang-change", async (ev) =>
        {
            const next = ev?.detail?.code;
            if (!next) return;
            await ensureFontsFor(next);
            if (lastFontLocale && lastFontLocale !== next)
            {
                releaseFontsFor(lastFontLocale);
            }
            lastFontLocale = next;
        });

        // Probe platform
        setAppState("probing");
        platform = await probePlatform();
        console.log("Platform:", platform);
        // Wire shared path helpers with the detected platform so
        // pathEqCaseless() picks the right case-sensitivity branch.
        initPathHelpers({ platform: platform.os });

        // Load recent projects
        setAppState("loading-recent");
        try {
            state.recentProjects = await loadRecent();
        } catch {
            state.recentProjects = [];
        }

        // Warm the user-settings cache so downstream code can read
        // defaultLanguage / lastProjectPath / lastSettingsTab synchronously.
        // Tolerant of failure: the wrapper falls back to defaults so the
        // boot path keeps working even if the Rust command misbehaves.
        try { await loadUserSettings(); }
        catch (e) { console.debug("loadUserSettings failed:", e); }
        markBench("userSettingsLoaded");

        // User-data schema migration gate. Compares the packaged
        // userDataVersion against the on-disk currentVersion (or
        // appVersionCreated for legacy installs) and walks the
        // migration ladder if needed. Holds the user-settings mutex
        // on the Rust side so two windows can't race. Failures
        // route through reportError → ERROR state; the mobile-auto-
        // create path below has a guard for that.
        setAppState("user-data");
        try
        {
            const res = await ensureUserDataVersion();
            console.debug("[user-data] migration result:", res);
            markBench("userDataMigrated");
        }
        catch (e)
        {
            // Failure already recorded via user_data_record_failure in
            // ensureUserDataVersion. Route through the error router so
            // the user gets a recoverable banner with retry + (after
            // 2nd consecutive failure) skip-and-continue.
            reportError(e, { origin: "user-data-migration" });
            return;  // stop boot — ERROR state owns the screen
        }

        // Google OAuth rehydrate deferred — ensureRehydrated() is called
        // lazily on first auth interaction (sign-in, getAccessToken, etc.)
        // to avoid triggering a macOS Keychain prompt at boot. The auth
        // module's idempotent promise ensures it runs exactly once.

        // Seed spellcheckLanguage once from the OS locale, then push the
        // resolved values into the runtime spellcheck-state module so the
        // CM6 linter has a live config the first time it runs.
        try
        {
            const seeded = await ensureSpellcheckSeed();
            const enabled = getUserSetting("spellcheckEnabled", true);
            setSpellcheckState({ enabled, language: seeded });

            // Warm Harper's WorkerLinter in the background so the first lint
            // after the user types isn't blocked on WASM compilation. Only
            // when the resolved tier is A (English) — other tiers don't use
            // Harper. Fire-and-forget; the actual lint path tolerates a
            // not-yet-ready worker via Harper's internal queue.
            if (enabled)
            {
                try
                {
                    const cfg = resolveTier(seeded);
                    if (cfg.tier === "A")
                    {
                        warmupHarper(cfg.dialect).then(() => loadPersistedDictionary()).catch(() => {});
                    }
                }
                catch (e) { console.debug("Harper warmup skipped:", e); }
            }
        }
        catch (e) { console.debug("ensureSpellcheckSeed failed:", e); }

        // Boot substages — IAP / Analytics are still placeholders and
        // fire-and-forget so they can never block first paint. Account
        // restore, however, DOES block: if a cached Google profile exists
        // and the machine is online, we await ensureRehydrated() so the
        // workspace opens with a warm access token instead of flickering
        // through IDLE → AUTHENTICATED after mount. initAccount() is a
        // no-op when no cached profile is present, so cold-first-run users
        // pay nothing.
        queueMicrotask(() => {
            initAnalytics().catch((e) => console.debug("initAnalytics:", e));
            initIap()
                .catch((e) => console.debug("initIap:", e))
                .finally(() => { initAds().catch((e) => console.debug("initAds:", e)); });
        });
        try
        {
            await initAccount();
        }
        catch (e) { console.debug("initAccount:", e); }
        markBench("placeholdersScheduled");

        // Pre-warm pdf-lib so the first PDF export doesn't have to download the
        // ~400KB chunk inline, and (more importantly) so every export consumer
        // shares ONE pdf-lib instance — multiple dynamic-import sites would
        // otherwise each get their own copy, which fails with
        // "Cannot assign to read only property 'toString'" on PDFHeader.
        import("@mangaplay-studio/core/export").then(m => m.preloadPdfLib()).catch(() => {});

        let chosenPath = "";
        /** @type {any} */
        let shell = null;

        // FSM: leave APP_INIT before the onboarding gate can transition
        // to ONBOARDING. Boot-screen is already showing, so LOADING is
        // the semantically correct intermediate state.
        await transition(STATES.LOADING, { stage: "bundle" });

        // Onboarding gate. Runs before ANY project auto-resume path on both
        // mobile and standalone. Overrides:
        //   - forceOnboarding: --onboarding CLI flag OR MPS_FORCE_ONBOARDING=1 env
        //   - user-settings.onboardingCompleted === false
        // If neither, fall through to the existing auto-resume flow.
        const forceOnboarding = await shouldForceOnboarding();
        const onboardingCompleted = getUserSetting("onboardingCompleted", false) === true;
        if (forceOnboarding || !onboardingCompleted)
        {
            // Kill the loading-splash mascot INSTANTLY (no fade on the img)
            // the moment we know we're going to onboarding. Otherwise it
            // lingers for the 250ms opacity-fade of the whole boot-screen
            // container and the user sees the splash mascot for a few
            // frames before the onboarding mascot arrives — visible as a
            // "wrong icon flash" per user report. The dark boot-screen
            // background continues to fade for smoothness, but the mascot
            // artwork itself is gone from paint by the next frame.
            try
            {
                const bootImg = document.querySelector("#boot-screen .boot-splash");
                if (bootImg instanceof HTMLElement)
                {
                    bootImg.style.display = "none";
                }
            }
            catch { /* boot-screen may already be gone if done() ran earlier */ }

            // Dismiss the boot-screen FIRST, before mounting the picker-shell.
            // Awaiting done()'s Promise means the 250ms fade-out completes
            // before we mount anything under it — so the onboarding surface
            // starts from a fully-blank dark background. The boot-screen +
            // picker-shell backgrounds are the same #1a1a1a, so the fade is
            // visually a no-op for the user, but awaiting keeps the paint
            // order deterministic.
            const splash = /** @type {any} */ (window).__mpsSplash;
            if (splash && typeof splash.done === "function")
            {
                await splash.done();
            }

            // Even on mobile — mount the picker-shell for the onboarding surface.
            // Statically imported at the top of this file; the element is
            // defined by the time this branch runs.
            let pkr = /** @type {any} */ (document.getElementById("picker-shell"));
            if (!pkr)
            {
                pkr = document.createElement("mps-picker-shell");
                pkr.id = "picker-shell";
                // Set attributes BEFORE appending so connectedCallback's first
                // render lands on the final phase — avoids double/triple render
                // via attributeChangedCallback re-entry.
                pkr.setAttribute("data-onboarding-state", "init");
                pkr.setAttribute("data-phase", "onboarding");
                document.body.appendChild(pkr);
            }
            else
            {
                pkr.setAttribute("data-onboarding-state", "init");
                pkr.setAttribute("data-phase", "onboarding");
            }
            await transition(STATES.ONBOARDING);

            // App-level mascot lives on <body> as a singleton — position:
            // fixed so its off-screen base state doesn't extend picker-shell
            // ancestor overflow. Mount it BEFORE scheduling the entrance so
            // the first paint has the element in place. Entrance is
            // deferred ~1s via requestIdleCallback so any late paints (font
            // swaps, i18n hydration) settle before the animation starts.
            const mascot = getAppMascot();
            const kickEntrance = async () =>
            {
                try
                {
                    if (!mascot?.enter) return;
                    await mascot.enter("right");
                    mascot.setBadge?.("Pistol Taeja");
                    // mps-dialogue, mps-card-tray, and onboarding-engine are
                    // statically imported at the top of this file.
                    const dialogue = document.createElement("mps-dialogue");
                    document.body.appendChild(dialogue);
                    const cardTray = document.createElement("mps-card-tray");
                    document.body.appendChild(cardTray);
                    const ctx = { mascot, dialogue, cardTray, results: {} };

                    // Step 1 — welcome + category chooser.
                    await runOnboardingScript([
                        { type: "bobble" },
                        { type: "speak", text: t("mangaplay-studio.onboarding.init.welcome"), tail: "above" },
                        { type: "waitForClick", graceMs: 200 },
                        { type: "hideDialogue" },
                        { type: "speak", text: t("mangaplay-studio.onboarding.init.askStoryType"), tail: "above" },
                        { type: "showCards", stagger: 60, layout: "row", cards: [
                            { id: "screenplay", title: t("mangaplay-studio.onboarding.init.catScreenplayTitle"), description: t("mangaplay-studio.onboarding.init.catScreenplayDesc") },
                            { id: "comic-manga", title: t("mangaplay-studio.onboarding.init.catComicMangaTitle"), description: t("mangaplay-studio.onboarding.init.catComicMangaDesc") },
                            { id: "other", title: t("mangaplay-studio.onboarding.init.catOtherTitle"), description: t("mangaplay-studio.onboarding.init.catOtherDesc") },
                        ] },
                        { type: "waitForCardSelected", buttonLabel: t("mangaplay-studio.onboarding.init.nextButton"), storeAs: "category" },
                        { type: "hideButton", slideLeft: true },
                        { type: "dismissCards", direction: "rightToLeft", stagger: 80 },
                        { type: "hideDialogue" },
                        { type: "bobble" },
                    ], ctx);

                    // Step 2 — templates gated by chosen category. Each
                    // branch reuses existing storyCard* locale keys so no
                    // new strings are needed; only which subset appears
                    // differs.
                    const STORY_CARDS = {
                        realComic: { id: "real-comic", title: t("mangaplay-studio.onboarding.init.storyCard1Title"), description: t("mangaplay-studio.onboarding.init.storyCard1Desc") },
                        blank12:   { id: "blank-12-page", title: t("mangaplay-studio.onboarding.init.storyCard2Title"), description: t("mangaplay-studio.onboarding.init.storyCard2Desc") },
                        freshScreenplay: { id: "fresh-screenplay", title: t("mangaplay-studio.onboarding.init.storyCard3Title"), description: t("mangaplay-studio.onboarding.init.storyCard3Desc") },
                        emptyProject: { id: "empty-project", title: t("mangaplay-studio.onboarding.init.storyCard4Title"), description: t("mangaplay-studio.onboarding.init.storyCard4Desc") },
                    };
                    let step2Cards;
                    switch (ctx.results.category)
                    {
                        case "screenplay":
                            step2Cards = [STORY_CARDS.freshScreenplay, STORY_CARDS.emptyProject];
                            break;
                        case "comic-manga":
                            step2Cards = [STORY_CARDS.realComic, STORY_CARDS.blank12, STORY_CARDS.emptyProject];
                            break;
                        case "other":
                        default:
                            step2Cards = [STORY_CARDS.emptyProject];
                            break;
                    }
                    await runOnboardingScript([
                        { type: "showCards", stagger: 60, layout: "row", cards: step2Cards },
                        { type: "waitForCardSelected", buttonLabel: t("mangaplay-studio.onboarding.init.readyButton"), storeAs: "template" },
                        { type: "hideButton", slideLeft: true },
                        { type: "dismissCards", direction: "rightToLeft", stagger: 80 },
                        { type: "bobble" },
                        { type: "face", direction: "left" },
                        { type: "exit", direction: "left" },
                    ], ctx);

                    // Mascot has exited. Create the onboarding project, save
                    // settings, transition to workspace. This owns everything
                    // from here.
                    await createOnboardingProject({
                        category: ctx.results.category,
                        template: ctx.results.template,
                    });
                }
                catch (e)
                {
                    console.warn("[onboarding] script failed:", e);
                }
            };
            if ("requestIdleCallback" in window)
            {
                requestIdleCallback(kickEntrance, { timeout: 1000 });
            }
            else
            {
                setTimeout(kickEntrance, 1000);
            }

            // Onboarding stops here — no completion trigger yet. Return so
            // the auto-resume / picker paths below don't fire.
            return;
        }

        if (isMobileLike())
        {
            // If the user-data migration ERRORed out, the early return
            // above ALREADY bailed boot — but defensive double-guard:
            // never auto-create a project on un-migrated settings.
            if (state.currentState === "error") return;

            // Mobile / tablet UX: never show the picker. Auto-open the
            // user's last project if it's still there, else auto-create
            // a "my-documents" inside the user-data dir.
            chosenPath = getUserSetting("lastProjectPath", null);
            const looksValid = chosenPath
                && (await pathExists(`${chosenPath}/_mangaplaystudio/project.json`));
            if (!looksValid)
            {
                try { chosenPath = await ensureMobileDefaultProject(); }
                catch (e)
                {
                    reportError(e, { origin: "project-create" });
                    return;
                }
            }
            // Render an "opening project" caption via the inline boot
            // screen; no picker-shell to update in mobile.
            setAppState("opening-project");
        }
        else
        {
            // Standalone UX: picker-shell is statically imported at the top
            // of this file. Create the `<mps-picker-shell>` element at runtime
            // — index.html no longer hardcodes it.
            let pkr = /** @type {any} */ (document.getElementById("picker-shell"));
            if (!pkr)
            {
                pkr = document.createElement("mps-picker-shell");
                pkr.id = "picker-shell";
                pkr.setAttribute("data-phase", "bootstrap");
                document.body.appendChild(pkr);
            }
            shell = pkr;

            // Auto-resume gate. If a top recent entry exists AND its
            // folder is present AND the user did not hold Shift / set
            // MPS_NO_AUTO_RESUME, skip the picker and go straight to
            // opening that project.
            const autoResume = await shouldAutoResume();
            const topRecent = state.recentProjects[0];
            const canAutoResumeBase = autoResume
                && topRecent
                && topRecent.exists !== false
                && !!topRecent.path;
            const hasProjectJson = canAutoResumeBase
                ? await pathExists(`${topRecent.path}/_mangaplaystudio/project.json`)
                : false;
            const canAutoResume = canAutoResumeBase && hasProjectJson;

            if (canAutoResume)
            {
                chosenPath = topRecent.path;
                const splash = /** @type {any} */ (window).__mpsSplash;
                if (splash)
                {
                    if (typeof splash.show === "function") splash.show();
                    splash.update("opening", topRecent.resolvedName || topRecent.name || chosenPath);
                    splash.setProgress(0.1);
                }
                setAppState("start-screen"); // paint briefly; opening-project transition follows
            }
            else if (state.recentProjects.length === 0 && isTauri())
            {
                // First launch with zero recents — auto-create the locked
                // my-documents default and open it directly (no picker).
                setAppState("opening-project");
                try
                {
                    chosenPath = await ensureMobileDefaultProject();
                }
                catch (e)
                {
                    reportError(e, { origin: "project-create" });
                    return;
                }
            }
            else
            {
                if (state.recentProjects.length > 0) {
                    setAppState("start-screen");
                } else {
                    setAppState("empty");
                }

                chosenPath = isTauri()
                    ? await renderStartScreen()
                    : await Promise.race([
                        renderStartScreen(),
                        new Promise((resolve) => setTimeout(() => resolve(""), 500)),
                    ]);

                if (!chosenPath) {
                    setAppState(state.recentProjects.length > 0 ? "start-screen" : "empty");
                    return;
                }
            }
        }

        // Transition to the opening card — same <mps-splash> surface, so no
        // FOUC / mascot jump. Fade the picker shell (if present) so its card
        // doesn't stack visually behind the splash.
        if (chosenPath)
        {
            const topName = (state.recentProjects.find((r) => r.path === chosenPath)?.resolvedName)
                || basename(chosenPath)
                || chosenPath;
            const splash = /** @type {any} */ (window).__mpsSplash;
            if (splash)
            {
                if (typeof splash.show === "function") splash.show();
                splash.update("opening", t("mangaplay-studio.boot.opening.openingNamed", { name: topName }));
                splash.setProgress(0.2);
            }
            if (shell) shell.classList.add("fade-out");
        }

        try
        {
            await openAndMountProject(chosenPath, {
                shell,
                isMobileRecovery: true,
                showSplash: true,
                mobileRecovery: ensureMobileDefaultProject,
            });
        }
        catch (err)
        {
            console.error("openAndMountProject failed:", err);
            showError(err instanceof Error ? err.message : String(err), "permissions.doc_access_revoked");
            return;
        }

        // Register shutdown + menu listeners using Tauri 2's canonical
        // per-window APIs.
        //
        // Why not the global `__TAURI__.event.listen("app:close-requested")`
        // we tried before:
        //   1. `event.listen` requires the `core:event:default` capability
        //      grant. Without it (which we didn't have before), the call
        //      silently no-ops in release builds.
        //   2. Even with the capability, listening at the global level for a
        //      per-window event like CloseRequested is unreliable —
        //      tauri-apps/tauri Discussion #5334 documents that it has to
        //      be listened on the WebviewWindow instance.
        //
        // The fix: use `getCurrentWindow().onCloseRequested()` for the X
        // button, which calls the right per-window register internally.
        // Same for the app menu — listen via __TAURI__.event.listen with
        // the now-granted capability.
        if (isTauri()) {
            try {
                const wnd = getCurrentWindow();
                await wnd.onCloseRequested(async (evt) => {
                    // Forensic log — funnels to app.log via console_capture.
                    // Used to diagnose "app closes right after sign-in":
                    // this line proves the close was OS/WM-driven (X button,
                    // taskbar close, Alt-F4, external signal) rather than
                    // a JS-side .close() call. The stack pins down the
                    // JS-side origin if there is one.
                    const trace = new Error("onCloseRequested trace").stack || "";
                    console.warn("[app] onCloseRequested fired\n" + trace);
                    // Prevent the OS-driven close so we can flush first.
                    // After flush, destroy the window to actually exit.
                    evt.preventDefault?.();
                    await flushAndShutdown(wnd);
                });
            } catch (e) {
                console.error("onCloseRequested wiring failed:", e);
            }
        }

        // Ctrl+Q fallback: on Windows the WebView2 captures keys before they
        // reach the Tauri menu accelerator, so the Quit shortcut never fires
        // through the native menu path. Catch it here and route to the same
        // close path the X button uses.
        window.addEventListener("keydown", async (e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            if (e.key.toLowerCase() !== "q") return;
            e.preventDefault();
            console.warn("[app] Ctrl+Q intercepted — closing window");
            const w = isTauri() ? getCurrentWindow() : null;
            if (w) await w.close();
        });

    } catch (err) {
        console.error("Boot failed:", err);
        showError(err instanceof Error ? err.message : "Boot sequence failed");
    }
}

/**
 * Flush the current project's editor doc, app settings, and meta. Tears down
 * editor/screenplay/slot views. Does NOT touch the window — safe to call from
 * an in-app project hot-swap.
 */
/**
 * Persist any dirty editor doc + app settings + per-project meta. Safe and
 * non-destructive — does NOT tear down editor views. Callable mid-session
 * when we need a clean checkpoint before risking a destructive operation.
 */
export async function flushCurrentProjectMeta()
{
    // Drain all broker-queued writes (script + meta + mangaart) in one Promise.all.
    // This is the source of truth for "pending writes are durable" — bypassing it
    // (as the previous direct saveScript/saveMeta path did) drops queued mangaart
    // strokes on swap and shutdown.
    try { await getBroker().drainAllPending(); }
    catch (e) { console.error("flush: drainAllPending failed:", e); }

    // The aggregate view mounts per-file factory brokers that live outside
    // the singleton, so their pending writes are missed by the drain above.
    // Dynamic import keeps boot.js free of a static edge to aggregate-view.js
    // (an unused module in single-file paths).
    // No-op when no aggregate is mounted.
    try
    {
        const { drainActiveAggregate, getActiveAggregate } = await import("../editor/aggregate-view.js");
        // Snapshot session BEFORE drain — the scrollTop reflects the
        // user's last visible position. Drain touches broker state only,
        // not scroll.
        try
        {
            const active = getActiveAggregate();
            if (active && state.currentProject)
            {
                const { setAggregateSession } = await import("../project/project.js");
                const scrollTop = active.getScrollTop() ?? 0;
                const focusedUuid = active.currentFocusedFileUuid();
                if (focusedUuid)
                {
                    await setAggregateSession(state.currentProject.path, {
                        folderUuid: active.folderUuid,
                        focusedFileUuid: focusedUuid,
                        scrollTop,
                    });
                }
            }
        }
        catch (e) { console.warn("flush: snapshot aggregateSession failed:", e); }
        await drainActiveAggregate();
    }
    catch (e) { console.error("flush: drainActiveAggregate failed:", e); }

    // App-wide settings are NOT broker-owned; flush them separately.
    try { await flushAppSettings(); }
    catch (e) { console.error("flush: flushAppSettings failed:", e); }
}

/**
 * Destroy the current project's editor views (slot manager + editor tabs +
 * screenplay view). Pure teardown — does not save. Pair with
 * `flushCurrentProjectMeta()` for the full shutdown half.
 */
export function destroyCurrentProjectViews()
{
    // Google Docs footer owns its own state machine + DOM — tear them down
    // first so the project's slotManager teardown doesn't race the footer's
    // setActiveScript(null) call.
    try { destroyGoogleDocsFooter(); }
    catch (e) { console.warn("[google-docs] destroyGoogleDocsFooter threw:", e); }

    if (state.slotManager)
    {
        for (const slot of state.slotManager.list())
        {
            try { slot.view.destroy(); } catch {}
            // Detach the .editor-slot container too. EditorSlotManager.openNew
            // appends a fresh container per slot to <mps-editor-host>; if we
            // leave the old ones attached, the next mountViews stacks new
            // slots after stale ones and CodeMirror's layout measurements run
            // against the wrong DOM (visible as content offset down the pane
            // after a project switch).
            try { slot.container.parentNode?.removeChild(slot.container); } catch {}
        }
        state.slotManager = null;
    }
    try { state.editorTabs?.destroy(); } catch {}
    state.editorTabs = null;
    // emptyTabCta mounts a fresh .empty-tab-cta overlay into <mps-editor-host>
    // on every mount; without explicit teardown the overlays stack.
    if (state.emptyTabCta) { try { state.emptyTabCta.destroy(); } catch {} state.emptyTabCta = null; }
    // rightPaneEmpty owns an i18n subscription; release it before re-mount.
    if (state.rightPaneEmpty) { try { state.rightPaneEmpty.destroy(); } catch {} state.rightPaneEmpty = null; }
    // initCanvas attaches a document-level `drawing-save-complete` listener
    // and tracks the host element via a module-level ref; destroy() removes
    // the listener and clears the ref so the next mount starts clean.
    if (state.canvasApi) { try { state.canvasApi.destroy?.(); } catch {} state.canvasApi = null; }
    // mountProjectViews appends a fresh <mps-editor-mode-toggle> to the
    // editor host every mount; without removal the toggles stack on top of
    // each other (visible as a thicker pill after each project switch).
    if (state.modeToggleEl)
    {
        try { state.modeToggleEl.parentNode?.removeChild(state.modeToggleEl); } catch {}
        state.modeToggleEl = null;
    }
    // The bridge to the project-scoped applyEditorMode closure dies with the
    // mount it captured — clear it so format-driven downgrades don't reach
    // into a torn-down view between project swaps.
    state.applyEditorModeRef = null;
    // mountProjectViews appends a fresh <mps-editor-toolbar> every mount.
    // Removing it fires disconnectedCallback, which detaches its document-
    // level selectionchange/pointerdown/keydown listeners and clears the
    // style preview — without this the orphans (and their capture-phase
    // listeners) stack N× after N project switches.
    if (state.editorToolbarEl)
    {
        try { state.editorToolbarEl.parentNode?.removeChild(state.editorToolbarEl); } catch {}
        state.editorToolbarEl = null;
    }
    // mountProjectViews appends a fresh `.editor-area-top-bar` div (carrying
    // the pagination chevrons, fix-issues button, mode toggle, find + more-
    // options buttons) to <mps-editor-host> every mount. Without removing the
    // old node here it stacks a second full top bar on every project switch —
    // duplicated buttons with stale click handlers (visible on mobile via the
    // Projects-tab "Create Empty Project" → switchProject path). Mirror the
    // modeToggle / visualEditor teardown below.
    if (state.editorAreaTopBarEl)
    {
        try { state.editorAreaTopBarEl.parentNode?.removeChild(state.editorAreaTopBarEl); } catch {}
        state.editorAreaTopBarEl = null;
    }
    // When the user was in Easy Editor mode, applyEditorMode lazily appended a
    // <mps-easy-editor> to <mps-editor-host>. Without removal here, the
    // next project's first switch into Easy Editor mode appends ANOTHER one (the
    // module-level ref is dropped on the next mount path that overwrites
    // it, but the orphan DOM stays and renders the previous project's
    // pages stacked above the new one).
    if (state.easyEditorEl)
    {
        try { state.easyEditorEl.parentNode?.removeChild(state.easyEditorEl); } catch {}
        state.easyEditorEl = null;
    }
}

/**
 * Full shutdown flush: meta save + view destruction, in order. The state
 * transitions match the legacy single-function behaviour so anything
 * observing `closing-project` / `shutting-down` keeps working.
 */
async function flushCurrentProject()
{
    setAppState("closing-project");
    await flushCurrentProjectMeta();
    setAppState("shutting-down");
    destroyCurrentProjectViews();
}

/**
 * Flush pending saves, tear down editor views, then destroy the window.
 *
 * Drives the shutdown JS-side end-to-end:
 *   1. preventDefault() was already called by the onCloseRequested callback,
 *      so the window is "held open."
 *   2. We flush whatever's dirty.
 *   3. We destroy the EditorViews (free CM6 resources).
 *   4. We call window.destroy() (NOT close()) to exit. `destroy` skips the
 *      CloseRequested cycle and forces the OS-level close.
 *
 * No Rust handshake — that path proved fragile because per-window events
 * don't deliver reliably to global JS listeners in Tauri 2 release builds.
 *
 * @param {object} [wnd] — Tauri WebviewWindow handle (from getCurrentWindow()).
 *                        Falls back to looking it up if not provided.
 */
export async function flushAndShutdown(wnd) {
    if (state.shutdownInFlight) return; // re-entrant safety
    state.shutdownInFlight = true;

    // Forensic log — sets a clear "user-driven shutdown" marker in app.log.
    // If the log stops HERE and then a new "Mangaplay Studio booting" line
    // appears, the shutdown path ran cleanly. If a new boot line appears
    // WITHOUT this marker, the process died via an external signal
    // (SIGKILL / task-kill / crash) — investigate outside JS.
    console.warn("[app] flushAndShutdown entered — flushing project + tearing down");

    await flushCurrentProject();

    // Stop the FS watcher before the window dies — best-effort, the Rust
    // side is tolerant of stop-without-start and the OS reclaims threads
    // on process exit either way.
    try
    {
        if (isTauri())
        {
            await invoke("fs_watch_stop");
        }
    }
    catch (e) { console.warn("[fs_watch_stop] failed:", e); }

    try
    {
        disposeHarper();
    }
    catch (e) { console.warn("[disposeHarper] failed:", e); }

    // ALWAYS destroy the window. If the flush above threw, we still get out.
    try {
        const target = wnd || (isTauri() ? getCurrentWindow() : null);
        if (target?.destroy) {
            await target.destroy();
        } else if (target?.close) {
            await target.close();
        }
    } catch (e) {
        console.error("window destroy failed:", e);
    }
}
