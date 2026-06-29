// @ts-check
/**
 * Mangaplay Studio — Full boot state machine.
 *
 * FSM: booting → probing → loading-recent → start-screen/empty → opening-project → mounting-views → ready
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// withGlobalTauri = false in tauri.conf.json, so the legacy `window.__TAURI__`
// helper object is gone. The internals marker `__TAURI_INTERNALS__` stays
// regardless — use it as the boolean "are we inside the .exe?" probe.
import { isTauri } from "./util/is-tauri.js";

import { EditorSlotManager } from "./editor-slot-manager.js";
import { mountEditorTabs } from "./editor-tabs.js";
import { mountEmptyTabCta } from "./empty-tab-cta.js";
import { mountRightPaneEmpty } from "./right-pane-empty.js";
// Side-import — registers customElements.define('mps-screenplay', MPSScreenplay).
// The website component reads from RuntimeStorage; no imperative driver needed.
import "../../websites/mangaplay.studio/src/components/mps-screenplay.js";
import { initCanvas } from "./mps-canvas.js";
import { openProject, saveScript, saveMeta, loadMangaart, saveMangaart, updateMangaartPage, clearMangaartCache, getMangaartCache, loadRecent, updateRecent, removeRecent, pickProjectFolder, createNewProject, createUntitled, debouncedSave, listProjectScripts, listProjectTree, readFile, getLastPageIndex, setLastPageIndex, getTabSnapshot, setTabSnapshot } from "./project.js";
import { getBroker } from "./active-script-broker.js";
import { showBanner } from "./toast.js";
import {
    hasFixableIssues,
    fixIssues,
    setMangaplayTargetConvention,
} from "./structural-fixer.js";
import {
    PersistentStorage as _StructuralFixerStorage,
    STORAGE_KEYS as _StructuralFixerKeys,
} from "./adapters/tauri-storage.js";

/**
 * Read the user's preferred indent convention from manga_settings and
 * push it into the fixer module. Called from both the click handler and
 * the disabled-state refresh hook so the setting takes effect immediately
 * after the user changes it without needing a relaunch.
 */
function syncStructuralFixerConvention()
{
    try
    {
        const settings = _StructuralFixerStorage.get(
            _StructuralFixerKeys.MANGA_SETTINGS, {}) || {};
        const want = settings.structuralFixTargetConvention;
        if (want === "A" || want === "B" || want === "C")
        {
            setMangaplayTargetConvention(want);
        }
    }
    catch (_) { /* fall back to module default */ }
}
import { parseScript, parseFountain, parseSuperscript } from "@mangaplay-studio/core";
import { formatForFilename } from "./lang-registry.js";
import { getRuntimeStorage } from "@mangaplay-studio/core/state";
import { icon } from "./icons.js";
import { wireDeclarativeTooltips, refreshTooltipFor } from "./tooltip.js";
import { mountFolderList } from "./folder-explorer.js";
import { openContextMenu } from "./components/mps-context-menu.js";
import { confirmModal } from "./confirm-modal.js";
import { copyFile, deleteFile, deleteFileForce, createFile, renameFile } from "./adapters/tauri-storage.js";
import {
    LEFT_PANE_MIN,
    LEFT_PANE_MAX,
    STORYBOARD_MIN,
    EDITOR_MIN,
    clampOrNull,
    applyMetaBeforeFirstPaint,
} from "./shell-restore.js";
import { openSettingsModal } from "./settings-modal.js";
import { openHelpModal } from "./help-modal.js";
import {
    mountGoogleDocsFooter,
    setActiveScript as setGoogleDocsActiveScript,
    notifyEdit as notifyGoogleDocsEdit,
    destroyGoogleDocsFooter,
    getGoogleDocsGearClickHandler,
    refreshActiveScript as refreshGoogleDocsActiveScript
} from "./google-docs-sync/footer-bootstrap.js";
import { getAccessToken, getCurrentProfile } from "./auth/google-oauth.js";
import { uuid as generateUuid } from "./google-docs-sync/uuid.js";
import { mountAppFooter } from "./app-footer.js";
import { loadUserSettings, saveUserSettings, getUserSetting, getLastProjectPathInvalid, ensureSpellcheckSeed, pathExists } from "./user-settings.js";
import { isMobileLike, isStandalone, isMobile, getUxMode, setActivePane } from "./ux-mode.js";
import { transition as fsmTransition, STATES, subscribe as fsmSubscribe } from "./state-machine.js";
import { reportError } from "./error-router.js";
import { initIap, initAnalytics, initAccount } from "./boot-placeholders.js";
import { hasWindowChrome } from "./adapters/platform-capabilities.js";
import { wireWindowControls } from "./window-controls.js";
import { setSpellcheckState } from "./spellcheck-state.js";
import { normalizePath, initPathHelpers } from "./util/paths.js";
import { basename } from "./util/basename.js";
import { applyColorScheme } from "./theme.js";
import { applyScreenplayFont, applyEditorFont } from "./font-prefs.js";
import { initialise as initI18n, getLanguage, t, subscribe as subscribeI18n } from "./adapters/tauri-i18n.js";
import { ensureFontsFor, releaseFontsFor } from "./font-loader.js";
import { wireTooltipI18nLiveUpdates } from "./tooltip-i18n.js";
import { shouldAutoResume, renameProject, renameFolder, moveFolder, revealInExplorer } from "./project.js";
// Side-effect imports: register web components.
import "./components/mps-lang-select.js";
// `mps-picker-shell` is lazy-imported inside the standalone branch of boot()
// — review item #1. Phase 2 DCE can then drop the picker bundle entirely
// from mobile builds. The picker-shell DOM element is NOT in index.html
// anymore; standalone boot() creates it via document.createElement after
// the dynamic import resolves.
// Register `<mps-visual-editor>` and the three-state mode toggle. Both are
// side-effect imports — the files self-register via `customElements.define`.
import "./components/mps-visual-editor.js";
import "./components/mps-editor-mode-toggle.js";
import { setEditorViewMode, setEditorMode } from "./mps-editor.js";
import { formatScript as visualFormatScript } from "./services/format-script.js";
import { EditorView } from "@codemirror/view";
import { mountOutline } from "./left-pane-outline.js";
import { mountStatistics } from "./left-pane-statistics.js";

/** @type {string|null} */
let _cachedClientId = null;

/**
 * Per-install UUID stored in user-settings.json. Used as `mpsClientId` on
 * Google Docs sync locks so concurrent writers can be distinguished.
 * @returns {string}
 */
function getOrCreateClientId()
{
    if (_cachedClientId) return _cachedClientId;
    let id = getUserSetting("mpsClientId", null);
    if (!id || typeof id !== "string")
    {
        id = generateUuid();
        try { saveUserSettings({ mpsClientId: id }); } catch (_) { /* best-effort */ }
    }
    _cachedClientId = id;
    return id;
}

// Tests need a way to drive Tauri APIs from the CDP eval context, where
// bare module specifiers ("@tauri-apps/api/window") don't resolve and
// withGlobalTauri=false means window.__TAURI__ is undefined. Expose the
// pieces the smoke suite actually uses.
if (typeof window !== "undefined")
{
    window.__mpsTest = {
        getCurrentWindow,
        invoke: (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    };
}

// ── Release-only browser-shortcut guard ──
//
// `__MPS_RELEASE_KEY_GUARD__` is a compile-time constant substituted by
// `scripts/build-bundle.js`'s Bun.build `define` map: `true` for the
// minified release bundle, `false` for the dev bundle. The minifier
// dead-code-eliminates the entire block in release when the substitution
// folds the condition; in dev the substituted `false` skips the listener
// at runtime so caveman keeps F5 reload, F7 caret browsing, etc.
//
// Block list intentionally OMITS F12 / Ctrl+Shift+I / Ctrl+Shift+J — those
// are handled at the WebView2 layer by the cargo `devtools` feature gate
// (DevTools is physically unavailable in release builds).
//
// Threat model: "user accidentally hits F5 mid-edit and loses unsaved
// work", NOT adversarial. The JS handler is bypassable by anyone with the
// .exe; that's an acknowledged tradeoff documented in the release-
// hardening plan. Real upstream fix requires Tauri to expose
// `browser_accelerator_keys` on `WebviewWindowBuilder` (tracked as a
// follow-up).
//
// Capture phase + early install (top of boot path, before any user
// interaction) so other listeners can't preventDefault first and let the
// browser default fire.
//
// `__MPS_RELEASE_KEY_GUARD__` is a bare-identifier compile-time constant
// injected by Bun.build's `define`. The ts-check pragma at the top of the
// file doesn't know about it; silence with a one-line ignore.
// @ts-ignore __MPS_RELEASE_KEY_GUARD__ injected by build-bundle.js define
if (__MPS_RELEASE_KEY_GUARD__)
{
    window.addEventListener('keydown', (e) =>
    {
        const k = e.key;
        const ctrl = e.ctrlKey || e.metaKey;
        const blocked =
            k === 'F5' || k === 'F7' || k === 'F11' ||
            (ctrl && (k === 'r' || k === 'R' || k === 'u' || k === 'U'));
        if (blocked)
        {
            e.preventDefault();
            e.stopPropagation();
        }
    }, { capture: true });
}

// export-screenplay-modal pulls in @mangaplay-studio/core/export (jszip,
// pdf-lib font resolvers, etc.). Lazy-imported on first menu open so the
// boot chunk stays free of export-only deps. Cached as a module-level
// promise so repeat opens reuse the chunk.
/** @type {Promise<typeof import("./export-screenplay-modal.js")>|null} */
let exportScreenplayModalPromise = null;
async function openExportScreenplayModal(opts)
{
    if (!exportScreenplayModalPromise)
    {
        exportScreenplayModalPromise = import("./export-screenplay-modal.js");
    }
    const mod = await exportScreenplayModalPromise;
    return mod.openExportScreenplayModal(opts);
}

// ── State messages ──
/**
 * Resolve a boot-state's user-visible message via the i18n dictionary.
 * Empty string for states with no surfaced message (start-screen, empty,
 * opening-project, ready). When the key is missing the resolver returns
 * the key path itself (tauri-i18n fallback), which we treat as empty so
 * a partial dictionary never leaks raw keys into the loading screen.
 *
 * @param {string} state
 * @returns {string}
 */
function stateMessage(state)
{
    // States that intentionally have no boot caption.
    if (state === "start-screen" || state === "empty"
        || state === "opening-project" || state === "ready")
    {
        return "";
    }
    const key = `mangaplay-studio.boot.state.${state}`;
    const v = t(key);
    return (v == null || v === key) ? "" : v;
}

// ── Runtime state ──
let currentState = "booting";
let bootStartedAt = performance.now();
const MIN_DISPLAY_MS = 400;

// Benchmark instrumentation — populated by markBench() at key boot/init points.
// Read by tests/driver/benchmark-smoke.js via Runtime.evaluate. No-op outside
// dev tests (the ledger is tiny and writes are O(1)).
/** @type {Record<string, number>} */
const bench = { bootStartedAt };
/** @type {any} */ (window).__mpsBenchmark = bench;
function markBench(label) { bench[label] = performance.now(); }
markBench("scriptParsed");

/** @type {import("./editor-slot-manager.js").EditorSlotManager | null} */
let slotManager = null;

/** @type {ReturnType<typeof import("./editor-tabs.js").mountEditorTabs> | null} */
let editorTabs = null;

/** @type {ReturnType<typeof import("./empty-tab-cta.js").mountEmptyTabCta> | null} */
let emptyTabCta = null;

/** @type {ReturnType<typeof import("./right-pane-empty.js").mountRightPaneEmpty> | null} */
let rightPaneEmpty = null;

/**
 * Track whether the current active slot is the path-null placeholder.
 * Updated by onSlotActivated; consumed by recomputeRightPaneEmpty() so the
 * parse-time hook (publishParsedScript) doesn't have to reach into the slot
 * manager itself.
 */
let activeSlotIsPlaceholder = true;

/**
 * Format of the active slot. Drives the "screenplay not supported" overlay
 * and the right-pane toggle guard. Updated by onSlotActivated.
 * @type {import("./lang-registry.js").EditorFormat}
 */
let activeFormat = "mangaplay";

/**
 * True when `format` has a screenplay surface (mangaplay / fountain /
 * superscript). Plain text and binary .sup don't.
 * @param {import("./lang-registry.js").EditorFormat} format
 */
function formatSupportsScreenplay(format)
{
    return format === "mangaplay" || format === "fountain" || format === "superscript";
}

/**
 * Recompute the right-pane empty-state overlays + paint-widget dim state.
 * Called from onSlotActivated (when the active tab changes) and from
 * publishParsedScript (when the parsed AST changes — i.e. text edits).
 * @param {{ scenesCount?: number } | null} parsedHint
 */
function recomputeRightPaneEmpty(parsedHint)
{
    if (!rightPaneEmpty) return;
    const noDoc = activeSlotIsPlaceholder === true;
    let noScreenplay = false;
    let unsupportedScreenplayForFormat = false;
    if (!noDoc)
    {
        // Plain text / binary .sup have no screenplay surface — show a
        // dedicated message when the user is on the screenplay side of the
        // slider for one of these formats.
        unsupportedScreenplayForFormat = !formatSupportsScreenplay(activeFormat);
        if (!unsupportedScreenplayForFormat)
        {
            // Use the parsed scenes count if the caller passed one; otherwise
            // derive an emptiness heuristic from currentDoc directly. The hint
            // path is preferred because the parser already knows about boneyards
            // and title-page noise that would otherwise mark the doc as non-empty.
            if (parsedHint && typeof parsedHint.scenesCount === "number")
            {
                noScreenplay = parsedHint.scenesCount === 0;
            }
            else
            {
                noScreenplay = currentDoc.trim().length === 0;
            }
        }
    }
    rightPaneEmpty.update({ noDoc, noScreenplay, unsupportedScreenplayForFormat });
}

/**
 * Backward-compat accessor: returns the active slot's CodeMirror view, or
 * null when no slot is active. Replaces the old module-level `editorView`.
 * @returns {import("@codemirror/view").EditorView | null}
 */
function getActiveView()
{
    return slotManager?.getActive()?.view ?? null;
}

// Debug-only global so the CDP driver tests can inspect the active CM view
// (cursor line, doc length, scroll). The hot path doesn't read this — it's a
// pure debugging hook. The getter is updated lazily because slotManager
// initialises after this module-level block runs.
/** @type {any} */ (window).__mpsActiveView = () => getActiveView();

/** @type {any} */
let canvasApi = null;
/** @type {HTMLElement | null} */
let modeToggleEl = null;
/**
 * App Footer controller — owns the bottom-right 200×30 panel (mode button,
 * word/char counts, Google Docs sync gear). Set when the shell first builds
 * #app-footer; survives project switches (no destroy on project teardown,
 * unlike modeToggleEl which lives inside the editor-area top bar).
 * @type {import("./app-footer.js").AppFooterController|null}
 */
let appFooter = null;
/**
 * Bridge to the project-scoped `applyEditorMode(mode, opts)` closure. Set by
 * the editor boot block so `applyAllowedModesForFormat` can request a
 * one-shot downgrade when the active slot's format doesn't support the
 * persisted mode.
 * @type {((mode: "source"|"text"|"visual", opts?: { persist?: boolean }) => Promise<void>) | null}
 */
let applyEditorModeRef = null;
/** @type {HTMLElement|null} */
let editorAreaTopBarEl = null;
/** @type {HTMLButtonElement|null} */
let editorBarPagePrevBtn = null;
/** @type {HTMLButtonElement|null} */
let editorBarPageNextBtn = null;
/** @type {HTMLButtonElement|null} */
let editorBarFixIssuesBtn = null;
/**
 * The <mps-visual-editor> element appended to <mps-editor-host> while the
 * user is in Visual mode. Module-scope so `destroyCurrentProjectViews` can
 * detach the previous project's instance before the next mount appends a
 * fresh one (without this guard each project switch stacked another
 * visual-editor inside the host).
 * @type {HTMLElement | null}
 */
let visualEditorEl = null;
/** @type {ReturnType<typeof mountOutline> | null} */
let outlineView = null;
/** @type {ReturnType<typeof mountStatistics> | null} */
let statisticsView = null;
/** One-shot guard for `wireShellOnce()` — static-DOM listeners must NEVER stack. */
let shellWired = false;
/** Cached current document text — single source for screenplay/canvas/save fan-out. */
let currentDoc = "";

/** Debounce window for screenplay re-render. */
const SCREENPLAY_DEBOUNCE_MS = 80;
/** @type {((text: string) => void) | null} */
let debouncedScreenplayUpdate = null;
/** @type {((text: string) => void) | null} */
let debouncedScriptSave = null;

/** @type {'dual' | 'solo-mangaplay' | 'solo-storyboard' | 'solo-screenplay'} */
let viewMode = "dual";
let lastSoloMode = "solo-storyboard";

/** @type {Awaited<ReturnType<typeof openProject>> | null} */
let currentProject = null;
/** @type {ReturnType<typeof mountFolderList> | null} */
let folderList = null;
/** @type {{ os: string, mode: string }} */
let platform = { os: "browser", mode: "browser" };
/** @type {any[]} */
let recentProjects = [];

/**
 * Route a meta.json save through the broker so destructive ops can drain.
 * The actual on-disk write is deferred 1.5 s; immediate flush callers go
 * through `broker.withLock` instead.
 * @param {string} projectPath
 * @param {any} meta
 */
function queueMetaSave(projectPath, meta)
{
    if (!projectPath) return;
    getBroker().scheduleMetaSave(meta, async (latest) =>
    {
        try { await saveMeta(projectPath, latest); }
        catch (e) { console.warn("queueMetaSave failed:", e); }
    });
}

let _appSettingsTimer = null;
let _appSettingsPending = {};
function queueAppSettingsSave(partial)
{
    Object.assign(_appSettingsPending, partial);
    // Mirror into the cached in-memory copy so subsequent reads in the
    // same session see the live value.
    if (globalThis.__MPS_APP_SETTINGS__)
    {
        Object.assign(globalThis.__MPS_APP_SETTINGS__, partial);
    }
    if (_appSettingsTimer) clearTimeout(_appSettingsTimer);
    _appSettingsTimer = setTimeout(async () =>
    {
        const value = _appSettingsPending;
        _appSettingsPending = {};
        _appSettingsTimer = null;
        try { await invoke("app_settings_set", { value }); }
        catch (e) { console.warn("queueAppSettingsSave failed:", e); }
    }, 500);
}
async function flushAppSettings()
{
    if (!_appSettingsTimer) return;
    clearTimeout(_appSettingsTimer);
    _appSettingsTimer = null;
    const value = _appSettingsPending;
    _appSettingsPending = {};
    try { await invoke("app_settings_set", { value }); }
    catch (e) { console.warn("flushAppSettings failed:", e); }
}

// ── Save state ──
let saveState = "saved";
const SCRIPT_DEBOUNCE_MS = 1500;
const ART_DEBOUNCE_MS = 1000;

// Sticky guard so a single save failure shows the banner once. Cleared on
// the next save-success transition; the toast itself auto-dismisses after
// 4 s (toast.js has no public dismiss API).
let saveFailureBannerShown = false;

// ── Tauri platform probe ──
async function probePlatform() {
    if (isTauri()) {
        try {
            /** @type {any} */
            const p = await invoke("app_platform");
            return { os: p.os, mode: "tauri" };
        } catch {
            return { os: "unknown", mode: "tauri" };
        }
    }
    return { os: navigator.platform || "browser", mode: "browser" };
}

/**
 * Fetch app-wide settings from Tauri. Falls back to defaults if not in Tauri
 * (browser dev) or if the call fails.
 * @returns {Promise<{colorScheme: string, hardwareAcceleration: boolean, automaticUpdates: boolean, windowMaximized: boolean, windowWidth: number|null, windowHeight: number|null}>}
 */
async function loadAppSettings()
{
    const DEFAULTS = {
        colorScheme: "light",
        hardwareAcceleration: true,
        automaticUpdates: true,
        language: null,
        screenplayFont: "default",
        editorFont: "default",
        leftPaneWidth: null,
        storyboardWidth: null,
        leftPaneCollapsed: false,
        storyboardCollapsed: false,
        viewMode: "dual",
        lastSoloMode: "solo-storyboard",
        activeSubview: "folder",
        windowMaximized: false,
        windowWidth: null,
        windowHeight: null,
    };
    if (!isTauri()) return DEFAULTS;
    try
    {
        /** @type {any} */
        const v = await invoke("app_settings_get");
        const viewModeOk = (v?.viewMode === "dual"
            || v?.viewMode === "solo-mangaplay"
            || v?.viewMode === "solo-storyboard"
            || v?.viewMode === "solo-screenplay") ? v.viewMode : "dual";
        const lastSoloOk = (v?.lastSoloMode === "solo-storyboard"
            || v?.lastSoloMode === "solo-screenplay") ? v.lastSoloMode : "solo-storyboard";
        const activeSubviewOk = (v?.activeSubview === "folder"
            || v?.activeSubview === "bookmarks") ? v.activeSubview : "folder";
        return {
            colorScheme: v?.colorScheme === "dark" ? "dark" : "light",
            hardwareAcceleration: v?.hardwareAcceleration !== false,
            automaticUpdates: v?.automaticUpdates !== false,
            language: typeof v?.language === "string" ? v.language : null,
            screenplayFont: typeof v?.screenplayFont === "string" ? v.screenplayFont : "default",
            editorFont: typeof v?.editorFont === "string" ? v.editorFont : "default",
            leftPaneWidth: Number.isFinite(v?.leftPaneWidth) ? v.leftPaneWidth : null,
            storyboardWidth: Number.isFinite(v?.storyboardWidth) ? v.storyboardWidth : null,
            leftPaneCollapsed: v?.leftPaneCollapsed === true,
            storyboardCollapsed: v?.storyboardCollapsed === true,
            viewMode: viewModeOk,
            lastSoloMode: lastSoloOk,
            activeSubview: activeSubviewOk,
            windowMaximized: v?.windowMaximized === true,
            windowWidth: Number.isFinite(v?.windowWidth) ? v.windowWidth : null,
            windowHeight: Number.isFinite(v?.windowHeight) ? v.windowHeight : null,
        };
    }
    catch (e)
    {
        console.warn("[boot] app_settings_get failed, using defaults:", e?.message);
        return DEFAULTS;
    }
}

// ── DOM helpers ──
/**
 * Apply a top-level app state: write `[data-app-state]`, tick the inline
 * boot screen, fade in chrome on `"ready"`. The FSM in `state-machine.js`
 * owns the policy (allowed transitions per mode); this function owns the
 * side effects every state change must run.
 *
 * @param {string} state
 */
export function setAppState(state) {
    currentState = state;
    document.documentElement.setAttribute("data-app-state", state);
    markBench(`state:${state}`);

    // Tick the inline boot screen for stages the user sees during cold
    // boot. The boot screen is the canvas we paint on between paint and
    // PROJECT; once chrome is revealed the boot screen is faded.
    const boot = /** @type {any} */ (window).__mpsBoot;
    if (boot && typeof boot.update === "function")
    {
        switch (state)
        {
            case "booting":
                boot.update("bundle", t("mangaplay-studio.boot.stage.loadingApp") || "Loading app…");
                break;
            case "probing":
            case "loading-recent":
                // Fold into the settings stage — Rust-IPC heavy step.
                boot.update("settings", t("mangaplay-studio.boot.stage.loadingSettings") || "Restoring preferences…");
                break;
            case "opening-project":
            {
                const name = currentProject?.name || "";
                const tpl = t("mangaplay-studio.boot.stage.openingProject");
                const msg = (tpl && tpl !== "mangaplay-studio.boot.stage.openingProject")
                    ? tpl.replace("{name}", name)
                    : `Opening ${name || "project"}…`;
                boot.update("project", msg);
                break;
            }
            default: break;
        }
    }

    // Legacy DOM hooks for any code still attaching to [data-state-message].
    const msgEl = document.querySelector("[data-state-message]");
    if (msgEl) {
        let msg = stateMessage(state);
        if (state === "opening-project" && currentProject?.name) {
            msg = t("mangaplay-studio.boot.opening.openingNamed", { name: currentProject.name });
        }
        msgEl.textContent = msg;
    }

    if (state === "ready") {
        const elapsed = performance.now() - bootStartedAt;
        const delay = Math.max(0, MIN_DISPLAY_MS - elapsed);
        setTimeout(() => {
            const chrome = document.getElementById("app-chrome");
            if (chrome) {
                chrome.hidden = false;
                chrome.classList.add("fade-in");
                requestAnimationFrame(() => chrome.classList.remove("fade-in"));
            }
            // Fade out the inline boot screen.
            if (boot && typeof boot.done === "function") boot.done();
        }, delay);
    }
}

/**
 * Re-paint the visible boot-state caption against the active i18n
 * dictionary, without re-running setAppState's FSM transition side
 * effects (class toggles, fade timers, chrome reveal). Called from the
 * `mps-lang-change` subscriber so the loading screen tracks language
 * changes mid-boot.
 */
function refreshStateMessage()
{
    const msgEl = document.querySelector("[data-state-message]");
    if (!msgEl) return;
    let msg = stateMessage(currentState);
    if (currentState === "opening-project" && currentProject?.name)
    {
        msg = t("mangaplay-studio.boot.opening.openingNamed", { name: currentProject.name });
    }
    msgEl.textContent = msg;
}

/**
 * Render a single recent-project card into the list. Missing folders
 * (exists === false from Rust) get muted styling + a "Not found" caption;
 * clicking a missing entry opens a lean confirm-popup to remove it. Every
 * entry has a hover-revealed ✕ button that removes it after inline confirm.
 *
 * @param {HTMLElement} list      — the #recent-list container
 * @param {any} r                  — entry from app_recent: { name, path, exists }
 * @param {(path: string) => void} resolve — resolves the renderStartScreen promise
 */
function renderRecentItem(list, r, resolve)
{
    const missing = r.exists === false;
    const btn = document.createElement("button");
    btn.className = "recent-item" + (missing ? " is-missing" : "");
    btn.dataset.path = r.path;

    const main = document.createElement("div");
    main.className = "recent-main";
    const name = document.createElement("div");
    name.className = "recent-name";
    name.textContent = r.name || r.path;
    const path = document.createElement("div");
    path.className = "recent-path";
    path.textContent = r.path;
    main.appendChild(name);
    main.appendChild(path);
    if (missing)
    {
        const tag = document.createElement("div");
        tag.className = "recent-not-found";
        tag.textContent = "Folder not found";
        main.appendChild(tag);
    }
    btn.appendChild(main);

    // Hover-revealed remove (✕). Lives in the DOM always — CSS reveals on hover.
    const removeBtn = document.createElement("span");
    removeBtn.className = "recent-remove";
    removeBtn.setAttribute("role", "button");
    removeBtn.setAttribute("aria-label", "Remove from recent");
    removeBtn.textContent = "✕"; // ✕
    removeBtn.addEventListener("click", (e) =>
    {
        e.stopPropagation();
        showRecentConfirm(btn, "Remove from recent?", async () =>
        {
            await removeRecent(r.path).catch(() => {});
            btn.remove();
        });
    });
    btn.appendChild(removeBtn);

    btn.addEventListener("click", () =>
    {
        if (missing)
        {
            showRecentConfirm(btn, "Project not found. Remove from list?", async () =>
            {
                await removeRecent(r.path).catch(() => {});
                btn.remove();
            });
            return;
        }
        resolve(r.path);
    });

    list.appendChild(btn);
}

/**
 * Lean inline confirm anchored to a recent-item card. Replaces the card's
 * content with a "<message> [Remove] [Cancel]" row until the user picks.
 * Cancel restores the original card.
 *
 * @param {HTMLElement} card
 * @param {string} message
 * @param {() => (void | Promise<void>)} onConfirm
 */
function showRecentConfirm(card, message, onConfirm)
{
    if (card.querySelector(".recent-confirm")) return; // already prompting
    card.classList.add("is-confirming");

    const confirm = document.createElement("div");
    confirm.className = "recent-confirm";

    const msg = document.createElement("div");
    msg.className = "recent-confirm-msg";
    msg.textContent = message;

    const actions = document.createElement("div");
    actions.className = "recent-confirm-actions";

    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "recent-confirm-yes";
    yes.textContent = "Remove";

    const no = document.createElement("button");
    no.type = "button";
    no.className = "recent-confirm-no";
    no.textContent = "Cancel";

    actions.appendChild(yes);
    actions.appendChild(no);
    confirm.appendChild(msg);
    confirm.appendChild(actions);
    card.appendChild(confirm);

    yes.addEventListener("click", async (e) =>
    {
        e.stopPropagation();
        await onConfirm();
    });
    no.addEventListener("click", (e) =>
    {
        e.stopPropagation();
        confirm.remove();
        card.classList.remove("is-confirming");
    });
}

/**
 * Render the picker shell and wait for the user to pick a project.
 * Resolves with the chosen project path (string) or "" if the user took an
 * action that doesn't pick anything (eg. cancelled the OS folder picker).
 *
 * The shell is the single dark surface that replaces the old loading +
 * start-screen pair. It handles its own context menu, modals, missing-folder
 * states, and the language drop-down internally.
 *
 * Right-pane lifecycle events surface via CustomEvents on the host:
 *   mps-picker-pick           → resolve with the path
 *   mps-picker-new            → run new-project flow, resolve with new path
 *   mps-picker-open           → run open-folder flow, resolve with the path
 *   mps-picker-remove         → removeRecent + refresh list
 *   mps-picker-rename-project → renameProject + refresh list
 *   mps-picker-rename-folder  → renameFolder (refuses if open here) + refresh
 *   mps-picker-move-folder    → ask for new parent → moveFolder + refresh
 *   mps-picker-reveal         → app_reveal_in_explorer
 */
function renderStartScreen() {
    return new Promise((resolve) => {
        const shell = /** @type {any} */ (document.getElementById("picker-shell"));
        if (!shell) {
            console.error("[picker] #picker-shell not in DOM");
            resolve("");
            return;
        }
        shell.setRecent(recentProjects || []);
        shell.setLastPathInvalid(getLastProjectPathInvalid());
        shell.setPhase("picker");
        // Tooltip wiring — picker uses its own affordances; tooltips for
        // the close button still need this.
        wireDeclarativeTooltips();

        const refreshRecent = async () =>
        {
            try
            {
                recentProjects = await loadRecent();
                shell.setRecent(recentProjects);
            }
            catch { /* ignore */ }
        };

        shell.addEventListener("mps-picker-pick", (e) =>
        {
            resolve(e.detail?.path || "");
        });

        shell.addEventListener("mps-picker-new", () =>
        {
            shell.showCreatePanel();
        });

        shell.addEventListener("mps-picker-create-back", () =>
        {
            shell.hideCreatePanel();
        });

        shell.addEventListener("mps-picker-create-browse", async () =>
        {
            try
            {
                const parent = await pickProjectFolder();
                if (!parent) return;
                shell.setCreatePanel({ parentPath: parent });
            }
            catch (err) { console.error("Browse parent folder failed:", err); }
        });

        shell.addEventListener("mps-picker-create-submit", async (e) =>
        {
            const { parent, name } = e.detail || {};
            if (!parent || !name) return;
            try
            {
                const created = await createNewProject(parent, name);
                resolve(created);
            }
            catch (err)
            {
                console.error("New project failed:", err);
                const msg = String(err?.message || err);
                await confirmModal({ title: t("mangaplay-studio.picker.error.title"), body: msg, confirm: "OK" });
            }
        });

        shell.addEventListener("mps-picker-open", async () =>
        {
            try
            {
                const path = await pickProjectFolder();
                if (!path) return;
                resolve(path);
            }
            catch (err) { console.error("Open folder failed:", err); }
        });

        shell.addEventListener("mps-picker-remove", async (e) =>
        {
            const path = e.detail?.path;
            if (!path) return;
            try { await removeRecent(path); }
            catch (err) { console.warn("removeRecent failed:", err); }
            await refreshRecent();
        });

        shell.addEventListener("mps-picker-rename-project", async (e) =>
        {
            const { path, displayName, scope } = e.detail || {};
            if (!path) return;
            try { await renameProject(path, displayName, scope); }
            catch (err) { console.warn("renameProject failed:", err); }
            await refreshRecent();
        });

        shell.addEventListener("mps-picker-rename-folder", async (e) =>
        {
            const { path, newBasename } = e.detail || {};
            if (!path || !newBasename) return;
            // currentlyOpen is false here — we're on the picker, no project
            // is mounted in this window.
            try
            {
                await renameFolder(path, newBasename, false);
            }
            catch (err)
            {
                const msg = String(err?.message || err);
                console.warn("renameFolder failed:", msg);
                await confirmModal({ title: t("mangaplay-studio.picker.error.title"), body: msg, confirm: "OK" });
            }
            await refreshRecent();
        });

        shell.addEventListener("mps-picker-move-folder", async (e) =>
        {
            const path = e.detail?.path;
            if (!path) return;
            try
            {
                const newParent = await pickProjectFolder();
                if (!newParent) return;
                await moveFolder(path, newParent, false);
            }
            catch (err)
            {
                const msg = String(err?.message || err);
                console.warn("moveFolder failed:", msg);
                await confirmModal({ title: t("mangaplay-studio.picker.error.title"), body: msg, confirm: "OK" });
            }
            await refreshRecent();
        });

        shell.addEventListener("mps-picker-reveal", async (e) =>
        {
            const path = e.detail?.path;
            if (!path) return;
            try { await revealInExplorer(path); }
            catch (err) { console.warn("reveal failed:", err); }
        });
    });
}

/** @param {string} s */
function setSaveState(s) {
    saveState = s;
    document.documentElement.setAttribute("data-save-state", s);
    const indicator = document.querySelector(".save-indicator");
    if (indicator) {
        const labels = { saved: "Saved", dirty: "Unsaved", saving: "Saving…" };
        indicator.textContent = labels[s] || s;
    }
}

/**
 * Set the workspace view mode and update DOM.
 * @param {'dual' | 'solo-mangaplay' | 'solo-storyboard' | 'solo-screenplay'} mode
 */
function setViewMode(mode) {
    viewMode = mode;
    const ws = document.querySelector(".workspace");
    if (ws) ws.setAttribute("data-view-mode", mode);

    // Show / hide the individual view children. The CSS view-mode rules
    // also enforce visibility, but the HTML `hidden` attribute beats CSS
    // and must be cleared explicitly for the child to render at all.
    const editorEl = document.querySelector("mps-editor-host");

    // View 1 (editor) is visible in dual + solo-mangaplay
    if (editorEl) editorEl.hidden = !(mode === "dual" || mode === "solo-mangaplay");

    // View 2 children (mps-canvas / mps-screenplay) live inside
    // .right-pane-slider and their visibility is driven entirely by the
    // slider's [data-active] + CSS transforms — we no longer toggle
    // `hidden` on them here. Sync the slider's data-active based on which
    // solo mode is current.
    const showScreenplay =
        mode === "solo-screenplay" ||
        (mode === "dual" && lastSoloMode === "solo-screenplay");
    const slider = document.querySelector(".right-pane-slider");
    if (slider)
    {
        slider.setAttribute("data-active", showScreenplay ? "screenplay" : "storyboard");
        _renderTopbarPagination?.();
    }

    // Track lastSoloMode for restore
    if (mode === "solo-storyboard" || mode === "solo-screenplay") {
        lastSoloMode = mode;
    }

    // Persist to app settings (shell layout is app-wide).
    queueAppSettingsSave({ viewMode: mode, lastSoloMode });
}

/** Toggle between dual and solo-mangaplay */
function flipView() {
    // Add animation class
    document.documentElement.classList.add("view-flipping");

    if (viewMode === "dual") {
        setViewMode("solo-mangaplay");
    } else {
        // Restore last View 2 mode
        setViewMode(lastSoloMode);
    }

    // Remove animation class after transition
    setTimeout(() => {
        document.documentElement.classList.remove("view-flipping");
    }, 420);
}

/** Set View 2 solo mode */
/**
 * Storyboard / Screenplay toggle. Only swaps which View 2 child is active.
 * - If we're in `dual` mode, keep `dual` and just update lastSoloMode so the
 *   right child shows on the right pane.
 * - If we're in a solo View 2 mode, jump to the other solo View 2 mode.
 * - If we're in solo-mangaplay (editor only), switch to the chosen View 2.
 */
function switchSolo(mode) {
    if (mode !== "solo-storyboard" && mode !== "solo-screenplay") return;
    document.documentElement.classList.add("view-flipping");
    lastSoloMode = mode;
    if (viewMode === "dual") {
        // Stay in dual; setViewMode("dual") will re-evaluate which child shows.
        setViewMode("dual");
    } else {
        setViewMode(mode);
    }
    setTimeout(() => {
        document.documentElement.classList.remove("view-flipping");
    }, 420);
}

/** @param {string} msg @param {string} [errorClass="fatal.config"] */
export function showError(msg, errorClass = "fatal.config") {
    setAppState("error");
    document.documentElement.setAttribute("data-error-class", errorClass);
    const overlay = document.getElementById("error-overlay");
    const body = overlay?.querySelector(".error-body");
    const retry = overlay?.querySelector(".error-retry");
    if (overlay) overlay.hidden = false;
    if (body) body.textContent = msg;
    if (retry && !retry._wired) {
        retry.addEventListener("click", () => {
            if (overlay) overlay.hidden = true;
            document.documentElement.removeAttribute("data-error-class");
            // Re-enter the start screen so the user can pick again.
            setAppState("start-screen");
            renderStartScreen().then(async (chosenPath) => {
                if (!chosenPath) {
                    // User dismissed without picking — stay on start screen.
                    return;
                }
                try {
                    setAppState("opening-project");
                    currentProject = await openProject(chosenPath);
                    // Expose project dir to editor extensions (page-fold persistence).
                    /** @type {any} */ (window).__mpsCurrentProjectDir = currentProject?.path || null;
                    // Start the FS watcher for the new project root so
                    // external edits flow through project-fs-changed.
                    try
                    {
                        if (isTauri() && currentProject?.path)
                        {
                            await invoke("fs_watch_start", { path: currentProject.path });
                        }
                    }
                    catch (e) { console.warn("[fs_watch_start] failed:", e); }
                    try { await mountFolderExplorer(); }
                    catch (e) { console.debug("folder list mount failed:", e); }
                    await updateRecent(chosenPath).catch(() => {});
                    await saveUserSettings({ lastProjectPath: chosenPath }).catch(() => {});
                    await wireShellOnce();
                    setAppState("mounting-views");
                    await mountProjectViews();
                    setAppState("ready");
                    setSaveState("saved");
                } catch (err) {
                    showError(err instanceof Error ? err.message : String(err), "permissions.doc_access_revoked");
                }
            });
        });
        retry._wired = true;
    }
}

// ── Shell wiring ──
function wireLeftPaneResize()
{
    const handle = /** @type {HTMLElement|null} */ (document.querySelector(".left-pane-resize-handle"));
    const pane = document.getElementById("left-pane");
    if (!handle || !pane) return;

    let dragging = false;

    handle.addEventListener("pointerdown", (e) =>
    {
        dragging = true;
        handle.setPointerCapture(e.pointerId);
        // Suppress the .left-pane flex-basis transition during the drag so the
        // pane tracks the cursor instantly (mirrors the seam-resize behaviour).
        document.getElementById("app-chrome")?.setAttribute("data-resizing-left", "");
        e.preventDefault();
    });

    handle.addEventListener("pointermove", (e) =>
    {
        if (!dragging) return;
        const rect = pane.getBoundingClientRect();
        const next = Math.min(LEFT_PANE_MAX, Math.max(LEFT_PANE_MIN, e.clientX - rect.left));
        document.documentElement.style.setProperty("--left-pane-width", next + "px");
    });

    handle.addEventListener("pointerup", (e) =>
    {
        if (!dragging) return;
        dragging = false;
        handle.releasePointerCapture(e.pointerId);
        document.getElementById("app-chrome")?.removeAttribute("data-resizing-left");
        const px = parseInt(
            getComputedStyle(document.documentElement)
                .getPropertyValue("--left-pane-width"),
            10
        );
        if (Number.isFinite(px))
        {
            queueAppSettingsSave({ leftPaneWidth: px });
        }
    });
}

/**
 * Toggle `data-narrow-topbar` on #app-chrome when the storyboard pane is
 * narrow enough that the absolute-positioned [C]/[D] action buttons would
 * crowd against #topbar-storyboard-pagination's natural in-flow position. CSS reacts
 * by fading pagination + divider out so they don't half-overlap the buttons.
 *
 * Threshold derived empirically from button positions: at 280px storyboard
 * width, [C].right just clears pagination.left in the topbar.
 * @param {number} storyboardWidth
 */
function syncNarrowTopbar(storyboardWidth)
{
    const chrome = document.getElementById("app-chrome");
    if (!chrome) return;
    if (storyboardWidth < 280)
    {
        chrome.setAttribute("data-narrow-topbar", "");
    }
    else
    {
        chrome.removeAttribute("data-narrow-topbar");
    }
}

function wireSeamResize()
{
    const seam = /** @type {HTMLElement|null} */ (document.querySelector(".workspace-seam"));
    const workspace = document.querySelector(".workspace");
    if (!seam || !workspace) return;

    // Sync the narrow-topbar attribute against the current storyboard width
    // on boot, before the user drags anything.
    const chromeEl = document.getElementById("app-chrome");
    if (chromeEl)
    {
        const initialWidth = parseInt(
            getComputedStyle(chromeEl).getPropertyValue("--storyboard-width"),
            10
        );
        if (Number.isFinite(initialWidth)) syncNarrowTopbar(initialWidth);
    }

    let dragging = false;

    seam.addEventListener("pointerdown", (e) =>
    {
        dragging = true;
        seam.setPointerCapture(e.pointerId);
        // Tell CSS to suppress the 220ms flex-basis transition on the column
        // (and the right-offset transition on anchored buttons) so the seam
        // tracks the cursor in real time.
        document.getElementById("app-chrome")?.setAttribute("data-resizing", "");
        e.preventDefault();
    });

    seam.addEventListener("pointermove", (e) =>
    {
        if (!dragging) return;
        const rect = workspace.getBoundingClientRect();
        // Right pane (storyboard/screenplay) grows up to workspace.width - EDITOR_MIN
        // so the editor side keeps at least EDITOR_MIN px. The right pane itself
        // still respects STORYBOARD_MIN as its own floor.
        const max = Math.max(STORYBOARD_MIN, rect.width - EDITOR_MIN);
        const next = Math.min(max, Math.max(STORYBOARD_MIN, rect.right - e.clientX));
        document.getElementById("app-chrome")
            .style.setProperty("--storyboard-width", next + "px");
        syncNarrowTopbar(next);
    });

    seam.addEventListener("pointerup", (e) =>
    {
        if (!dragging) return;
        dragging = false;
        seam.releasePointerCapture(e.pointerId);
        document.getElementById("app-chrome")?.removeAttribute("data-resizing");
        const chrome = document.getElementById("app-chrome");
        const px = parseInt(
            getComputedStyle(chrome).getPropertyValue("--storyboard-width"),
            10
        );
        if (Number.isFinite(px))
        {
            queueAppSettingsSave({ storyboardWidth: px });
        }
    });
}

/**
 * Module-scope mirror of the storyboard-collapse button's visual state.
 * Both the click handler (in `wireStoryboardCollapse`) and `restoreShellMeta`
 * call this so the DOM and the persisted setting stay in lock-step.
 * @param {boolean} collapsed
 */
function applyStoryboardCollapseState(collapsed)
{
    const btn = /** @type {HTMLElement|null} */ (document.getElementById("btn-storyboard-collapse"));
    const chrome = document.getElementById("app-chrome");
    if (!btn || !chrome) return;
    if (collapsed)
    {
        chrome.setAttribute("data-storyboard-collapsed", "");
        btn.setAttribute("data-state", "collapsed");
        btn.setAttribute("aria-pressed", "true");
        btn.setAttribute("aria-label", "Expand Storyboard/Screenplay");
        btn.setAttribute("data-tooltip", "Expand");
        btn.innerHTML = icon("panel-left-close", { size: 16, class: "icon" });
    }
    else
    {
        chrome.removeAttribute("data-storyboard-collapsed");
        btn.setAttribute("data-state", "expanded");
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", "Collapse Storyboard/Screenplay");
        btn.setAttribute("data-tooltip", "Collapse");
        btn.innerHTML = icon("columns-2", { size: 16, class: "icon" });
    }
    // If the tooltip is currently visible for this button, refresh in place
    // so the new label appears without a 350ms re-show delay.
    refreshTooltipFor(btn);
}

function wireStoryboardCollapse()
{
    const btn = /** @type {HTMLElement|null} */ (document.getElementById("btn-storyboard-collapse"));
    const chrome = document.getElementById("app-chrome");
    if (!btn || !chrome) return;

    btn.addEventListener("click", () =>
    {
        // "View 2 visible" now means viewMode is NOT solo-mangaplay
        // (children always present in DOM; visibility driven by view-mode CSS).
        const anyVisible = viewMode !== "solo-mangaplay";

        if (!anyVisible)
        {
            // First click on a project with no View 2 visible: open it.
            // setViewMode("dual") respects lastSoloMode so the user's previous
            // choice (or the default solo-storyboard) determines which child shows.
            setViewMode("dual");
            // We just made it visible — make sure it's NOT in the collapsed state.
            applyStoryboardCollapseState(false);
            queueAppSettingsSave({ storyboardCollapsed: false });
            return;
        }

        // Normal toggle path — column is visible, so this click collapses or
        // un-collapses it.
        const next = !chrome.hasAttribute("data-storyboard-collapsed");
        applyStoryboardCollapseState(next);
        queueAppSettingsSave({ storyboardCollapsed: next });
    });
}

/**
 * Module-scope mirror of the left-pane-toggle button's visual state.
 * @param {boolean} collapsed
 */
function applyLeftPaneCollapsedState(collapsed)
{
    const btn = /** @type {HTMLElement|null} */ (document.getElementById("btn-left-pane-toggle"));
    const chrome = document.getElementById("app-chrome");
    if (!btn || !chrome) return;
    if (collapsed)
    {
        chrome.setAttribute("data-left-pane-collapsed", "");
        btn.setAttribute("aria-pressed", "true");
        btn.setAttribute("aria-label", "Expand left pane");
        btn.setAttribute("data-tooltip", "Expand");
        btn.innerHTML = icon("panel-left-open", { size: 16, class: "icon" });
    }
    else
    {
        chrome.removeAttribute("data-left-pane-collapsed");
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", "Collapse left pane");
        btn.setAttribute("data-tooltip", "Collapse");
        btn.innerHTML = icon("panel-left-close", { size: 16, class: "icon" });
    }
    refreshTooltipFor(btn);
}

function wireLeftPaneToggle()
{
    const btn = /** @type {HTMLElement|null} */ (document.getElementById("btn-left-pane-toggle"));
    const chrome = document.getElementById("app-chrome");
    if (!btn || !chrome) return;

    btn.addEventListener("click", () =>
    {
        const next = !chrome.hasAttribute("data-left-pane-collapsed");
        applyLeftPaneCollapsedState(next);
        queueAppSettingsSave({ leftPaneCollapsed: next });
    });
}

/**
 * Mount the Outline + Statistics subviews. Called once on first project mount;
 * idempotent (re-mounts are skipped because the modules subscribe to the
 * runtime store, which persists across project swaps).
 */
function wireLeftSubviews()
{
    if (!outlineView)
    {
        try { outlineView = mountOutline({ onJump: jumpToScene }); }
        catch (e) { console.warn("[outline] mount failed:", e); }
    }
    if (!statisticsView)
    {
        try { statisticsView = mountStatistics(); }
        catch (e) { console.warn("[statistics] mount failed:", e); }
    }
}

/**
 * Scroll the active editor (or canvas) to a scene's source line.
 * Branches on the current editor mode — Source / Text scroll the CM view;
 * Visual jumps to the page that contains the scene's line.
 *
 * @param {{ line: number, sceneIdx: number }} info
 */
function jumpToScene(info)
{
    const slot = slotManager?.getActive();
    if (!slot) return;
    /** @type {string} */
    const mode = /** @type {any} */ (modeToggleEl)?.mode || "text";
    if (mode === "visual")
    {
        const canvasEl = /** @type {any} */ (document.querySelector("mps-canvas"));
        let pageIndex = 0;
        if (canvasEl && typeof canvasEl.findPageIndexByLine === "function")
        {
            try { pageIndex = canvasEl.findPageIndexByLine(info.line) || 0; }
            catch (e) { console.warn("[jumpToScene] findPageIndexByLine threw:", e); }
        }
        document.dispatchEvent(new CustomEvent("page-change", {
            detail: { pageIndex, direction: 0 }
        }));
        document.dispatchEvent(new CustomEvent("screenplay-scroll-to-page", {
            detail: { pageIndex }
        }));
        return;
    }
    const view = slot.view;
    if (!view) return;
    try
    {
        const totalLines = view.state.doc.lines;
        const target = Math.min(Math.max(info.line + 1, 1), totalLines);
        const lineObj = view.state.doc.line(target);
        view.dispatch({
            selection: { anchor: lineObj.from },
            effects: EditorView.scrollIntoView(lineObj.from, { y: "start", yMargin: 8 })
        });
        view.focus();
    }
    catch (e)
    {
        console.warn("[jumpToScene] dispatch failed:", e);
    }
}

async function switchSubview(name)
{
    const pane = document.getElementById("left-pane");
    if (!pane) return;
    if (pane.dataset.subview === name) return;

    // Stick the click instantly — flip aria-pressed before any await so the button
    // highlight responds immediately rather than waiting for the 300ms cross-fade.
    document.querySelectorAll(".top-bar-subview").forEach(b =>
    {
        b.setAttribute("aria-pressed",
            b.dataset.subview === name ? "true" : "false");
    });

    const outgoingName = pane.dataset.subview;
    const outgoingEl = document.getElementById(`subview-${outgoingName}`);
    const incomingEl = document.getElementById(`subview-${name}`);
    if (!incomingEl) return;

    // Fade outgoing
    if (outgoingEl)
    {
        outgoingEl.style.opacity = "0";
        await new Promise(r => setTimeout(r, 150));
        outgoingEl.style.display = "none";
        outgoingEl.style.opacity = "";
    }

    // Reveal incoming. Clear the inline display so the stylesheet drives
    // (some subviews need `display: flex` for internal scroll-host sizing;
    // hard-coding "block" here would override that and break their layout).
    incomingEl.style.display = "";
    incomingEl.style.opacity = "0";
    void incomingEl.offsetHeight;               // force reflow
    incomingEl.style.opacity = "1";
    await new Promise(r => setTimeout(r, 150));
    incomingEl.style.opacity = "";

    pane.dataset.subview = name;

    queueAppSettingsSave({ activeSubview: name });
}

// Instantaneous variant — used on restore so there's no 150ms flash.
function applySubview(name)
{
    const pane = document.getElementById("left-pane");
    if (!pane) return;
    pane.dataset.subview = name;

    for (const sub of ["folder", "bookmarks", "outline", "statistics"])
    {
        const el = document.getElementById(`subview-${sub}`);
        if (!el) continue;
        el.style.display = (sub === name) ? "" : "none";
        el.style.opacity = "";
    }

    document.querySelectorAll(".top-bar-subview").forEach(b =>
    {
        b.setAttribute("aria-pressed",
            b.dataset.subview === name ? "true" : "false");
    });
}

function restoreShellMeta()
{
    const settings = globalThis.__MPS_APP_SETTINGS__ || {};

    const lp = clampOrNull(settings.leftPaneWidth, LEFT_PANE_MIN, LEFT_PANE_MAX);
    if (lp !== null)
    {
        document.documentElement.style.setProperty("--left-pane-width", lp + "px");
    }

    const workspace = document.querySelector(".workspace");
    if (workspace)
    {
        const max = Math.max(STORYBOARD_MIN, workspace.getBoundingClientRect().width - EDITOR_MIN);
        const sw = clampOrNull(settings.storyboardWidth, STORYBOARD_MIN, max);
        if (sw !== null)
        {
            document.getElementById("app-chrome").style.setProperty("--storyboard-width", sw + "px");
            syncNarrowTopbar(sw);
        }
    }

    if (settings.storyboardCollapsed === true)
    {
        applyStoryboardCollapseState(true);
    }

    if (settings.leftPaneCollapsed === true)
    {
        applyLeftPaneCollapsedState(true);
    }
    const validSubviews = ["folder", "bookmarks", "outline", "statistics"];
    const bootSubview = (typeof settings.activeSubview === "string"
        && validSubviews.includes(settings.activeSubview))
        ? settings.activeSubview
        : "folder";
    applySubview(bootSubview);
}

let swappingProject = false;

/**
 * Update the project-switcher button's visible label + disabled state.
 * The recents list now lives in a popup that is rebuilt on each open
 * (see openProjectSwitcherMenu), so this function no longer touches
 * any list DOM — it just keeps the button in sync.
 */
function refreshProjectSwitcher()
{
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById("project-switcher-btn"));
    if (!btn) return;
    const label = currentProject?.meta?.title
        || (basename(currentProject?.path) || "(no project)");
    const labelEl = btn.querySelector(".project-switcher-label");
    if (labelEl) labelEl.textContent = label;
    btn.disabled = swappingProject;
    if (swappingProject) closeProjectSwitcherMenu();
}

/** @type {HTMLElement|null} */
let projectSwitcherMenuEl = null;

function closeProjectSwitcherMenu()
{
    if (!projectSwitcherMenuEl) return;
    projectSwitcherMenuEl.remove();
    projectSwitcherMenuEl = null;
    const btn = document.getElementById("project-switcher-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onProjectSwitcherDocMouseDown, true);
    document.removeEventListener("keydown", onProjectSwitcherDocKeyDown, true);
}

/** @param {MouseEvent} ev */
function onProjectSwitcherDocMouseDown(ev)
{
    if (!projectSwitcherMenuEl) return;
    const target = /** @type {Node} */ (ev.target);
    const btn = document.getElementById("project-switcher-btn");
    if (projectSwitcherMenuEl.contains(target)) return;
    if (btn && btn.contains(target)) return;
    closeProjectSwitcherMenu();
}

/** @param {KeyboardEvent} ev */
function onProjectSwitcherDocKeyDown(ev)
{
    if (ev.key === "Escape" && projectSwitcherMenuEl)
    {
        ev.stopPropagation();
        closeProjectSwitcherMenu();
        const btn = document.getElementById("project-switcher-btn");
        if (btn) /** @type {HTMLButtonElement} */ (btn).focus();
    }
}

async function openProjectSwitcherMenu()
{
    if (swappingProject) return;
    if (projectSwitcherMenuEl)
    {
        closeProjectSwitcherMenu();
        return;
    }
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById("project-switcher-btn"));
    if (!btn) return;

    /** @type {Array<any>} */
    let entries = [];
    try
    {
        entries = await loadRecent();
    }
    catch (e)
    {
        console.warn("[projectSwitcherMenu] loadRecent failed:", e);
        entries = [];
    }
    if (!Array.isArray(entries)) entries = [];

    const menu = document.createElement("div");
    menu.className = "project-switcher-menu";
    menu.setAttribute("role", "menu");

    const currentPath = currentProject?.path ?? "";
    for (const entry of entries)
    {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "psw-menu-row";
        row.setAttribute("role", "menuitem");

        const baseLabel = entry.resolvedName || entry.name || entry.path;
        const isCurrent = entry.path === currentPath;
        const missing = entry.exists === false;
        if (missing && !isCurrent) row.setAttribute("disabled", "");

        const labelText = missing ? `${baseLabel} (missing)` : baseLabel;
        const labelSpan = document.createElement("span");
        labelSpan.className = "psw-menu-label";
        labelSpan.textContent = labelText;
        row.append(labelSpan);

        if (isCurrent)
        {
            const trailing = document.createElement("span");
            trailing.className = "psw-menu-trailing";
            trailing.innerHTML = icon("check", { size: 16, class: "icon" });
            row.append(trailing);
        }

        row.addEventListener("click", () =>
        {
            closeProjectSwitcherMenu();
            if (isCurrent) return;
            if (missing) return;
            switchProject(entry.path);
        });

        menu.append(row);
    }

    const divider = document.createElement("div");
    divider.className = "psw-menu-divider";
    menu.append(divider);

    const manageRow = document.createElement("button");
    manageRow.type = "button";
    manageRow.className = "psw-menu-row";
    manageRow.setAttribute("role", "menuitem");
    const manageIcon = document.createElement("span");
    manageIcon.className = "psw-menu-icon";
    manageIcon.innerHTML = icon("monitor-cog", { size: 16, class: "icon" });
    const manageLabel = document.createElement("span");
    manageLabel.className = "psw-menu-label";
    manageLabel.textContent = t("mangaplay-studio.chrome.projectSwitcher.manageProjects");
    manageRow.append(manageIcon, manageLabel);
    manageRow.addEventListener("click", () =>
    {
        closeProjectSwitcherMenu();
        enterManageProjects();
    });
    menu.append(manageRow);

    document.body.append(menu);
    projectSwitcherMenuEl = menu;

    // Position: anchored above the button, flush-left, 4px gap.
    const rect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const minWidth = Math.max(rect.width, menuRect.width);
    menu.style.minWidth = `${minWidth}px`;
    const finalRect = menu.getBoundingClientRect();
    let left = rect.left;
    const maxLeft = window.innerWidth - finalRect.width - 4;
    if (left > maxLeft) left = Math.max(4, maxLeft);
    menu.style.left = `${left}px`;
    menu.style.bottom = `${Math.max(4, window.innerHeight - rect.top + 4)}px`;

    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onProjectSwitcherDocMouseDown, true);
    document.addEventListener("keydown", onProjectSwitcherDocKeyDown, true);
}

/**
 * Hot-swap to a different project without tearing down the app.
 *
 * Pre-flight policy: we attempt the open BEFORE destroying any views, so a
 * `cancelled`/`error` outcome leaves the previously-open project intact (no
 * zombie UI). Only after a confirmed-success open do we destroy the old
 * views and mount the incoming project.
 *
 * Mirrors the boot-open pipeline at app.js:~3552 — SHELL_FIELDS seed,
 * `applyMetaBeforeFirstPaint`, `broker.setActive`, and the
 * `wireProjectFsChangedListener` one-time wire — so per-project layout,
 * autosave routing, and FS-change watching all rebind to the new project.
 *
 * @param {string} path Absolute project folder path (the dropdown option's value).
 */
async function switchProject(path)
{
    if (swappingProject) return;
    if (!path) return;
    if (path === currentProject?.path) return;
    swappingProject = true;
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById("project-switcher-btn"));
    if (btn) btn.disabled = true;
    closeProjectSwitcherMenu();
    const chrome = document.getElementById("app-chrome");
    if (chrome) chrome.classList.add("project-swapping");
    try
    {
        await new Promise(r => setTimeout(r, 260));
        // Flush the OLD project's pending writes first — safe / non-destructive.
        await flushCurrentProjectMeta();

        // Pre-flight the open. If it fails, the old project is still fully
        // mounted and we just bail.
        let opened;
        try
        {
            opened = await openProject(path);
        }
        catch (err)
        {
            console.error("[switchProject] open failed", err);
            return;
        }
        if (!opened) return;

        // Open succeeded — NOW it's safe to tear down the previous project's views.
        destroyCurrentProjectViews();

        currentProject = opened;
        /** @type {any} */ (window).__mpsCurrentProjectDir = currentProject?.path || null;

        // Start the FS watcher for the new project root. Rust's
        // fs_watch_start stops the previous watcher first, so back-to-back
        // project swaps don't leak threads.
        try
        {
            if (isTauri() && currentProject?.path)
            {
                await invoke("fs_watch_start", { path: currentProject.path });
            }
        }
        catch (e) { console.warn("[fs_watch_start] failed:", e); }

        try { await mountFolderExplorer(); }
        catch (e) { console.debug("folder list mount failed:", e); }
        try { await loadMangaart(currentProject.path, currentProject.scriptBasename); }
        catch (e) { console.error("loadMangaart failed:", e); }
        await updateRecent(path).catch(() => {});
        await saveUserSettings({ lastProjectPath: path }).catch(() => {});

        // Mirror the boot SHELL_FIELDS seed + applyMetaBeforeFirstPaint so
        // per-project viewMode / lastSoloMode / pane widths restore.
        {
            const appSettings = globalThis.__MPS_APP_SETTINGS__ || {};
            const meta = currentProject?.meta || {};
            const seed = {};
            const SHELL_FIELDS = [
                "leftPaneWidth", "storyboardWidth",
                "leftPaneCollapsed", "storyboardCollapsed",
                "viewMode", "lastSoloMode", "activeSubview",
            ];
            for (const k of SHELL_FIELDS)
            {
                const current = appSettings[k];
                const isUnset =
                    (k === "leftPaneWidth" || k === "storyboardWidth") ? current === null :
                    (k === "leftPaneCollapsed" || k === "storyboardCollapsed") ? current === false :
                    (k === "viewMode") ? current === "dual" :
                    (k === "lastSoloMode") ? current === "solo-storyboard" :
                    (k === "activeSubview") ? current === "folder" :
                    false;
                if (isUnset && meta[k] !== undefined)
                {
                    seed[k] = meta[k];
                    appSettings[k] = meta[k];
                }
            }
            if (Object.keys(seed).length > 0)
            {
                queueAppSettingsSave(seed);
            }

            const restored = applyMetaBeforeFirstPaint(currentProject.meta, { settings: appSettings });
            if (restored.viewMode) viewMode = /** @type {any} */ (restored.viewMode);
            if (restored.lastSoloMode) lastSoloMode = restored.lastSoloMode;
        }

        setAppState("mounting-views");
        await mountProjectViews();

        // Route the broker's autosaves to the new project's active script.
        try { getBroker().setActive(currentProject?.scriptPath ?? null); }
        catch (e) { console.warn("[switchProject] broker.setActive failed:", e); }

        // setAppState("ready") re-runs the boot fade-in path; skip it on
        // post-boot swaps (we're already in "ready") to avoid flicker against
        // the .project-swapping fade.
        if (currentState !== "ready") setAppState("ready");
        setSaveState("saved");

        // wireProjectFsChangedListener has its own one-shot guard (see fn) so
        // calling it again here is a no-op when already wired.
        wireProjectFsChangedListener();
    }
    catch (err)
    {
        console.error("[switchProject] failed", err);
    }
    finally
    {
        if (chrome) chrome.classList.remove("project-swapping");
        swappingProject = false;
        await refreshProjectSwitcher();
    }
}

// ── Empty-state + doc-change pipeline ──

function updateEmptyState()
{
    const overlay = document.getElementById("empty-state");
    if (!overlay) return;
    const hasFile = !!(currentProject?.scriptPath);
    overlay.hidden = hasFile;
}

function wireEmptyState()
{
    const overlay = /** @type {HTMLElement|null} */ (document.getElementById("empty-state"));
    if (!overlay) return;

    async function trigger()
    {
        if (overlay.hidden) return;
        if (!currentProject) return;
        try
        {
            await createUntitled(currentProject.path);
            const reopened = await openProject(currentProject.path);
            if (!reopened) return;
            currentProject = reopened;
            getBroker().setActive(currentProject.scriptPath);
            try { await mountFolderExplorer(); }
            catch (e) { console.debug("folder list mount failed:", e); }
            updateEmptyState();
            // Replace the active slot's content with the newly-created
            // Untitled file. If no slot exists yet, replaceActive falls
            // through to openNew per the slot manager contract.
            if (slotManager && currentProject?.scriptPath)
            {
                slotManager.replaceActive(
                    currentProject.scriptPath,
                    currentProject.script || "",
                    /** @type {any} */ (formatForFilename(currentProject.scriptBasename || ""))
                );
            }
        }
        catch (e)
        {
            console.error("Failed to create Untitled.mangaplay.md:", e);
        }
    }

    overlay.addEventListener("click", trigger);
    document.addEventListener("keydown", (e) =>
    {
        if (e.key === "Enter" && !overlay.hidden)
        {
            e.preventDefault();
            trigger();
        }
    });
}

/**
 * Slot-manager onChange hook — invoked for every CM6 doc change in any slot.
 * Same body as the old `onMpsChange` listener, just takes the slot + text
 * directly instead of unpacking from a CustomEvent.
 *
 * @param {import("./editor-slot-manager.js").EditorSlot} slot
 * @param {string} text
 */
function onMpsChangeFromSlot(slot, text)
{
    currentDoc = text;
    setSaveState("dirty");
    if (debouncedScreenplayUpdate) debouncedScreenplayUpdate(text);
    if (canvasApi && typeof canvasApi.setScript === "function")
    {
        canvasApi.setScript(text);
    }
    if (debouncedScriptSave) debouncedScriptSave(text);
    // Fix Structural Issues button tracks the source buffer — refresh
    // whenever the doc changes so the icon reflects current state.
    try { window.__mpsRefreshFixIssuesBtn?.(); } catch (_) {}
    // Google Docs sync state machine — notify of local edits so the gear
    // moves from idle → local-ahead without any network call.
    try { if (slot?.path) notifyGoogleDocsEdit(); }
    catch (e) { console.warn("[google-docs] notifyEdit threw:", e); }
    // App Footer word / char counts — debounced recount (150ms).
    try { appFooter?.notifyDocChanged(); }
    catch (e) { console.debug("[app-footer] notifyDocChanged threw:", e); }
}

/**
 * Slot-manager onActivate hook — invoked when the user switches tabs (or on
 * the initial mount). Mirrors the activated slot's path/basename/doc onto
 * `currentProject` for compatibility with the rest of app.js, pushes the
 * tab's saved pageIndex into the canvas store, and re-publishes the parsed
 * AST so the right pane + canvas re-render against the new doc.
 *
 * @param {import("./editor-slot-manager.js").EditorSlot} slot
 */
function onSlotActivated(slot)
{
    currentDoc = slot.view.state.doc.toString();
    if (currentProject && slot.path)
    {
        currentProject.scriptPath = slot.path;
        currentProject.scriptBasename = slot.basename;
        currentProject.script = currentDoc;
    }
    const canvasEl = /** @type {any} */ (document.querySelector("mps-canvas"));
    if (canvasEl?.store && typeof slot.pageIndex === "number")
    {
        canvasEl.store.update(
            { currentPageIndex: slot.pageIndex },
            "tab-activated"
        );
    }
    activeSlotIsPlaceholder = slot.path === null;
    activeFormat = slot.format;
    // Sync the folder-explorer highlight to the active tab. Cheap DOM
    // attribute flip — no fs hit, no re-mount.
    try { folderList?.setActive(slot.path ? basename(slot.path) : null); }
    catch (_e) { /* explorer may not be mounted yet during boot */ }
    publishParsedScript(currentDoc);
    // Empty-tab CTA visible only when the active slot is the placeholder
    // ("Create New file" tab — no path on disk).
    emptyTabCta?.setVisible(slot.path === null);
    // Right-pane empty-state overlays follow the same signal. publishParsedScript
    // already recomputes the no-screenplay branch, so this call only needs to
    // handle the "no doc" toggle — but invoking it once here keeps the wiring
    // simple even if publishParsedScript bails early on unknown formats.
    recomputeRightPaneEmpty(null);
    // Sync the editor-mode toggle to what this file's format supports.
    // .txt → Source only; .fountain → Source + Text; .sup* → Source only
    // (Text grammar is the mangaplay highlighter for now; binary .sup has no
    // editable surface). Mangaplay supports all three. If the persisted /
    // current editor mode isn't in the allowed set, downgrade to the highest
    // allowed mode (Visual > Text > Source).
    applyAllowedModesForFormat(slot.format);
    try { window.__mpsRefreshFixIssuesBtn?.(); } catch (_) {}
    // Hand the activated slot to the Google Docs sync state machine.
    // forwardSlashPath is the canonical project-relative key shape used by
    // the sync entry store. When the slot has no on-disk path (the empty
    // placeholder tab), detach so the footer hides.
    try
    {
        if (currentProject && slot.path)
        {
            const proj = currentProject.path;
            const projNorm = proj.replace(/\\/g, "/");
            const slotNorm = slot.path.replace(/\\/g, "/");
            let rel = slotNorm.startsWith(projNorm + "/")
                ? slotNorm.slice(projNorm.length + 1)
                : slot.basename;
            void setGoogleDocsActiveScript({
                projectPath: proj,
                scriptRelPath: rel,
                basename: slot.basename
            });
        }
        else
        {
            void setGoogleDocsActiveScript(null);
        }
    }
    catch (e) { console.warn("[google-docs] setActiveScript threw:", e); }
    // App Footer counts follow the active slot.
    try { appFooter?.recountNow(); }
    catch (e) { console.debug("[app-footer] recountNow threw:", e); }
}

/**
 * Map an EditorFormat to the editor modes it supports.
 *
 *   mangaplay         → [source, text, visual]
 *   fountain          → [source, text]
 *   superscript       → [source] (+ alpha warning shown in the top bar)
 *   superscript-bin   → [source] (+ alpha warning shown in the top bar)
 *   general-text      → [source]
 *
 * @param {import("./lang-registry.js").EditorFormat} format
 * @returns {Array<"source"|"text"|"visual">}
 */
function allowedModesForFormat(format)
{
    switch (format)
    {
        case "mangaplay":        return ["source", "text", "visual"];
        case "fountain":         return ["source", "text"];
        case "superscript":      return ["source"];
        case "superscript-bin":  return ["source"];
        default:                 return ["source"]; // general-text / .txt
    }
}

/**
 * Sync the mode-toggle's allowed set + the top bar's `data-format` (drives the
 * SuperScript alpha warning pill) for the given format. If the current editor
 * mode isn't in the allowed set, request a one-shot downgrade through the
 * project-scoped `applyEditorMode` (persists, so the new lower mode sticks).
 *
 * @param {import("./lang-registry.js").EditorFormat} format
 */
function applyAllowedModesForFormat(format)
{
    const allowed = allowedModesForFormat(format);
    if (editorAreaTopBarEl)
    {
        editorAreaTopBarEl.setAttribute("data-format", format);
    }
    if (modeToggleEl)
    {
        /** @type {any} */ (modeToggleEl).allowedModes = allowed;
    }
    if (applyEditorModeRef && modeToggleEl)
    {
        const current = /** @type {any} */ (modeToggleEl).mode;
        if (!allowed.includes(current))
        {
            // Walk Visual → Text → Source for the highest allowed downgrade.
            const order = ["visual", "text", "source"];
            const downgrade = /** @type {any} */ (
                order.find((m) => allowed.includes(/** @type {any} */ (m)))
            ) || "source";
            void applyEditorModeRef(downgrade);
        }
    }
    // Format change → re-evaluate pagination chevron enable/disable on both
    // the global topbar cluster and the editor-area bar. Pagination gates
    // on format ("mangaplay" enables, others disable), so the chevron state
    // must refresh whenever the active slot's format flips even if the
    // editor mode itself didn't change.
    if (_renderTopbarPagination)
    {
        try { _renderTopbarPagination(); }
        catch (e) { console.debug("[pagination] render after format change failed:", e); }
    }
    if (editorBarPagePrevBtn && editorBarPageNextBtn)
    {
        if (format === "mangaplay")
        {
            const prevLabel = t("ui.paint.prevPage") || "Previous page";
            const nextLabel = t("ui.paint.nextPage") || "Next page";
            editorBarPagePrevBtn.setAttribute("data-tooltip", prevLabel);
            editorBarPagePrevBtn.setAttribute("data-tooltip-side", "bottom");
            editorBarPageNextBtn.setAttribute("data-tooltip", nextLabel);
            editorBarPageNextBtn.setAttribute("data-tooltip-side", "bottom");
            editorBarPagePrevBtn.disabled = _paginationPageIndex <= 0;
            editorBarPageNextBtn.disabled = _paginationPageIndex >= _paginationTotalPages - 1;
        }
        else
        {
            editorBarPagePrevBtn.disabled = true;
            editorBarPageNextBtn.disabled = true;
            editorBarPagePrevBtn.removeAttribute("data-tooltip");
            editorBarPageNextBtn.removeAttribute("data-tooltip");
        }
    }
}

/**
 * Debounced session-persistence. Writes the serialized tab snapshot to
 * `<project>/_mangaplaystudio/settings/session.json` via the existing FS commands.
 * 250 ms debounce matches the fold-state persistence cadence; safe to spam
 * from `onTabsChanged`.
 */
const debouncedWriteSession = (() =>
{
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    return () =>
    {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () =>
        {
            timer = null;
            try
            {
                const snap = slotManager?.serialize();
                if (!snap || !currentProject) return;
                /** @type {any} */ (window).__mpsLastTabSnap = snap;
                await setTabSnapshot(currentProject.path, snap);
            }
            catch (e) { console.warn("[session] write failed:", e); }
        }, 250);
    };
})();

/**
 * Animate the right pane from storyboard ↔ screenplay. The slider container
 * stays in place; its two children translateX between 0 and +100%.
 * @param {"solo-storyboard" | "solo-screenplay"} nextMode
 */
function slideToRightPaneView(nextMode)
{
    const slider = document.querySelector(".right-pane-slider");
    const targetActive = nextMode === "solo-screenplay" ? "screenplay" : "storyboard";

    if (slider)
    {
        slider.setAttribute("data-view-sliding", "");
        slider.setAttribute("data-active", targetActive);
        _renderTopbarPagination?.();

        const onEnd = () =>
        {
            slider.removeAttribute("data-view-sliding");
            slider.removeEventListener("transitionend", onEnd);
            // Force the website canvas to re-measure now that its slot is settled.
            // Without this, the drawing engine may have bound pointer listeners to
            // a 0×0 .drawing-canvas before the slider's translateX transition resolved.
            const c = document.querySelector("mps-canvas");
            if (c && typeof c.resizeDrawingCanvas === "function")
            {
                try { c.resizeDrawingCanvas(); } catch {}
            }
            if (c && typeof c.fitToContainer === "function")
            {
                try { c.fitToContainer(true); } catch {}
            }
        };
        slider.addEventListener("transitionend", onEnd);
        // Safety: in case transitionend doesn't fire (no transform change), tear down.
        setTimeout(onEnd, 600);
    }

    // Drive the existing viewMode machinery so meta.viewMode + lastSoloMode persist.
    switchSolo(nextMode);
}

function wireStoryboardSwitcher()
{
    const btn = /** @type {HTMLElement|null} */ (document.getElementById("btn-storyboard-action"));
    if (!btn) return;

    btn.addEventListener("click", () =>
    {
        // Decide which mode to switch TO.
        // - solo-storyboard → solo-screenplay
        // - solo-screenplay → solo-storyboard
        // - dual or solo-mangaplay → use the OPPOSITE of lastSoloMode (so the
        //   button toggles even when both are visible).
        let next;
        if (viewMode === "solo-storyboard") next = "solo-screenplay";
        else if (viewMode === "solo-screenplay") next = "solo-storyboard";
        else next = (lastSoloMode === "solo-screenplay") ? "solo-storyboard" : "solo-screenplay";

        // Update tooltip + aria for the NEXT click (which would swap back).
        const willShowNext = next === "solo-storyboard" ? "Screenplay" : "Storyboard";
        btn.setAttribute("data-tooltip", `Show ${willShowNext}`);
        btn.setAttribute("aria-label", `Switch to ${willShowNext}`);
        try { refreshTooltipFor(btn); } catch {}

        // When the active file's format has no screenplay surface (plain
        // text / binary .sup), the slider still slides to Screenplay so
        // the toggle feels responsive — but the inline "not supported"
        // overlay covers the screenplay area instead of the empty/broken
        // panel. The overlay is driven by recomputeRightPaneEmpty +
        // the slider's data-active attribute (see right-pane-empty.js).
        slideToRightPaneView(next);
    });
}

function wireSettingsButton()
{
    const btn = /** @type {HTMLElement|null} */ (document.getElementById("btn-app-settings"));
    if (!btn) return;
    btn.addEventListener("click", () =>
    {
        try { openSettingsModal("general"); }
        catch (e) { console.error("openSettingsModal failed:", e); }
    });
}

/**
 * Bottom-of-sidebar account button. Visible only while signed in; click
 * opens the Settings modal on the Account tab. Avatar src + visibility
 * are driven by `mps:authChanged`.
 */
async function wireRailAccount()
{
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById("btn-rail-account"));
    if (!btn) return;
    const avatar = /** @type {HTMLImageElement|null} */ (btn.querySelector(".rail-account-avatar"));

    const apply = (detail) =>
    {
        const picture = detail && detail.picture;
        if (picture && avatar)
        {
            avatar.src = picture;
            avatar.alt = detail.name || "";
            btn.hidden = false;
        }
        else
        {
            btn.hidden = true;
            if (avatar) avatar.removeAttribute("src");
        }
    };

    try
    {
        const { onAuthChanged, getCurrentProfile } = await import("./auth/google-oauth.js");
        apply(getCurrentProfile());
        onAuthChanged(apply);
    }
    catch (e) { console.warn("[wireRailAccount] auth import failed:", e); }

    btn.addEventListener("click", () =>
    {
        try { openSettingsModal("account"); }
        catch (e) { console.error("openSettingsModal(account) failed:", e); }
    });
}

function wireHelpButton()
{
    const btn = /** @type {HTMLElement|null} */ (document.getElementById("btn-app-help"));
    if (!btn) return;
    btn.addEventListener("click", () =>
    {
        try { openHelpModal(); }
        catch (e) { console.error("openHelpModal failed:", e); }
    });
}

// Home button — opens the same Help / About modal as `#btn-app-help` (the
// circle-help icon in the left-pane footer). The Home button is otherwise
// passive: it doesn't switch subviews, it just surfaces the application
// info popup so the brand icon doubles as a "what is this app" entry point.
function wireHomeButton()
{
    const btn = /** @type {HTMLElement|null} */ (document.getElementById("btn-subview-folder"));
    if (!btn) return;
    btn.addEventListener("click", () =>
    {
        try { openHelpModal(); }
        catch (e) { console.error("openHelpModal failed:", e); }
    });
}

// Storyboard pagination state. Drives only the Storyboard canvas page
// (mps-canvas). The Visual Editor scrolls independently and does NOT follow
// these chevrons. Shared between the global #topbar-storyboard-pagination
// cluster and the editor-area top bar's chevron buttons so both surfaces stay
// in sync without a second event subscription chain.
let _paginationPageIndex = 0;
let _paginationTotalPages = 1;
/** Optional label override sourced from the parsed `# Page X` id. */
let _paginationPageLabel = null;
/** @type {Array<(state: { pageIndex: number, totalPages: number }) => void>} */
const _paginationSubscribers = [];
/** @type {(() => void) | null} Stashed by wireTopbarPagination so slider sites can re-invoke. */
let _renderTopbarPagination = null;

/**
 * Dispatch `page-change` + `screenplay-scroll-to-page` events. mps-canvas
 * listens for the former and advances `store.currentPageIndex`; the
 * screenplay component scrolls on the latter.
 * @param {number} dir
 */
function paginationNavigate(dir)
{
    const newIndex = _paginationPageIndex + dir;
    if (newIndex < 0 || newIndex >= _paginationTotalPages) return;
    document.dispatchEvent(new CustomEvent("page-change", {
        detail: { pageIndex: newIndex, direction: dir }
    }));
    document.dispatchEvent(new CustomEvent("screenplay-scroll-to-page", {
        detail: { pageIndex: newIndex }
    }));
}

/**
 * Register a callback fired with `{ pageIndex, totalPages }` whenever
 * pagination state changes. The callback is invoked immediately with the
 * current state so subscribers can hydrate their UI without waiting for
 * the next change.
 * @param {(state: { pageIndex: number, totalPages: number }) => void} cb
 */
function subscribePaginationState(cb)
{
    if (typeof cb !== "function") return;
    _paginationSubscribers.push(cb);
    try { cb({ pageIndex: _paginationPageIndex, totalPages: _paginationTotalPages }); }
    catch (e) { console.debug("[pagination] subscriber seed failed:", e); }
}

function _notifyPaginationSubscribers()
{
    const snap = { pageIndex: _paginationPageIndex, totalPages: _paginationTotalPages };
    for (const cb of _paginationSubscribers)
    {
        try { cb(snap); }
        catch (e) { console.debug("[pagination] subscriber failed:", e); }
    }
}

/**
 * Resolve the active slot's file format ("mangaplay", "fountain", ...) for
 * pagination chevron gating. Storyboard pagination is only meaningful for
 * `.mangaplay` sources — other formats keep the chevrons visible but disabled.
 * Prefer `slotManager.getActive().format`; fall back to the `data-format`
 * attribute stamped on the editor-area top bar by `syncFormatToTopBar` so the
 * helper is robust during early-boot ordering.
 * @returns {string | null}
 */
function getActivePaginationFormat()
{
    const fromSlot = slotManager?.getActive()?.format;
    if (fromSlot) return fromSlot;
    const bar = document.querySelector(".editor-area-top-bar");
    return bar?.getAttribute("data-format") ?? null;
}

/**
 * Wire the top-bar pagination cluster (#topbar-storyboard-pagination). Mirrors the
 * paint widget's pw-pagination-group: click dispatches `page-change`,
 * `page-state-update` updates the label + disabled state. Hidden until
 * the first state-update arrives so the row stays clean before the canvas
 * has fired.
 */
function wireTopbarPagination()
{
    const wrap = document.getElementById("topbar-storyboard-pagination");
    const prev = document.getElementById("btn-page-prev");
    const next = document.getElementById("btn-page-next");
    const label = document.getElementById("topbar-page-label");
    if (!wrap || !prev || !next || !label) return;

    prev.addEventListener("click", () => paginationNavigate(-1));
    next.addEventListener("click", () => paginationNavigate(1));

    const render = () =>
    {
        const numeric = _paginationPageLabel != null ? _paginationPageLabel : String(_paginationPageIndex + 1);
        try
        {
            label.textContent = `${t("ui.paint.page") || "Page"} ${numeric}`;
        }
        catch
        {
            label.textContent = `Page ${numeric}`;
        }
        const slider = document.querySelector(".right-pane-slider");
        const screenplayActive = slider?.getAttribute("data-active") === "screenplay";
        const format = getActivePaginationFormat();
        const formatPaginates = format === "mangaplay";
        if (screenplayActive || !formatPaginates)
        {
            /** @type {HTMLButtonElement} */ (prev).disabled = true;
            /** @type {HTMLButtonElement} */ (next).disabled = true;
            label.setAttribute("data-disabled", "");
        }
        else
        {
            /** @type {HTMLButtonElement} */ (prev).disabled = _paginationPageIndex <= 0;
            /** @type {HTMLButtonElement} */ (next).disabled = _paginationPageIndex >= _paginationTotalPages - 1;
            label.removeAttribute("data-disabled");
        }
        _notifyPaginationSubscribers();
    };
    _renderTopbarPagination = render;

    document.addEventListener("page-state-update", (e) =>
    {
        const d = /** @type {CustomEvent} */ (e).detail;
        if (!d) return;
        if (Number.isFinite(d.pageIndex)) _paginationPageIndex = d.pageIndex;
        if (Number.isFinite(d.totalPages)) _paginationTotalPages = d.totalPages;
        _paginationPageLabel = d.pageLabel != null ? String(d.pageLabel) : null;
        if (wrap.hasAttribute("hidden")) wrap.removeAttribute("hidden");
        render();
    });

    // mps-canvas dispatches `page-state-update` once during its initial
    // render — that fires before project-mount completes wireTopbarPagination,
    // so the boot event is lost. Pull from the canvas store directly until
    // pages are loaded. Project mount can take several seconds on debug
    // builds, so poll on a slow interval until pages exist (no upper cap —
    // a long-running poll is cheap; we clear it once pages land).
    const tryPullFromCanvas = () =>
    {
        const canvas = /** @type {any} */ (document.querySelector("mps-canvas"));
        const state = canvas?.store?.state;
        if (!state) return false;
        const pages = state.script?.pages ?? [];
        const total = pages.length;
        if (total <= 0) return false;
        _paginationPageIndex = state.currentPageIndex ?? 0;
        _paginationTotalPages = total;
        const cur = pages[_paginationPageIndex];
        _paginationPageLabel = cur?.id != null ? String(cur.id) : null;
        if (wrap.hasAttribute("hidden")) wrap.removeAttribute("hidden");
        render();
        return true;
    };
    if (!tryPullFromCanvas())
    {
        const intervalId = setInterval(() =>
        {
            if (tryPullFromCanvas()) clearInterval(intervalId);
        }, 250);
    }

    render();
}

/**
 * Persist `currentPageIndex` per script basename into the project's
 * session.json. Debounced 500ms so a rapid 200-cycle page-switch (or a
 * cursor-driven page-sync) issues at most one disk write per quiet window.
 * Suppressed while a file-swap is in flight (data-canvas-state="swapping")
 * to avoid clobbering the incoming file's restored index with whatever
 * the outgoing file last reported.
 */
function wirePageIndexSessionWriteThrough()
{
    /** @type {ReturnType<typeof setTimeout>|null} */
    let pending = null;
    /** @type {number|null} */
    let lastIndex = null;

    const flush = () =>
    {
        pending = null;
        if (lastIndex == null || !currentProject?.path || !currentProject?.scriptBasename) return;
        const canvas = /** @type {any} */ (document.querySelector("mps-canvas"));
        if (canvas?.getAttribute("data-canvas-state") === "swapping") return;
        const idx = lastIndex;
        const base = currentProject.scriptBasename;
        const proj = currentProject.path;
        setLastPageIndex(proj, base, idx).catch((e) =>
        {
            console.warn("[session] write-through failed:", e);
        });
    };

    document.addEventListener("page-state-update", (e) =>
    {
        const d = /** @type {any} */ (e).detail || {};
        if (!Number.isFinite(d.pageIndex)) return;
        lastIndex = Number(d.pageIndex);
        // Back-write the index onto the active slot so a later tab activate
        // restores the user to the page they were last viewing.
        const activeSlot = slotManager?.getActive();
        if (activeSlot) activeSlot.pageIndex = lastIndex;
        if (pending) clearTimeout(pending);
        pending = setTimeout(flush, 500);
    });
}

/**
 * Relocate the single <mps-quick-toggle-sidebar> rendered inside <mps-canvas>
 * into the #quick-toggle-strip sibling above the canvas. Re-parenting via
 * appendChild fires disconnectedCallback + connectedCallback on the
 * component — its document/window listeners re-bind cleanly. A
 * `data-relocated="true"` attr lets CSS target the horizontal layout.
 */
function wireQuickToggleRelocation()
{
    const strip = document.getElementById("quick-toggle-strip");
    if (!strip) return;
    const canvas = document.querySelector("mps-canvas");
    if (!canvas) return;

    // mps-canvas re-creates its child <mps-quick-toggle-sidebar> on each
    // project mount; the previously-relocated sidebar would stack inside the
    // static strip. Drain the strip before the new sidebar lands.
    while (strip.firstChild) strip.removeChild(strip.firstChild);

    let attempts = 0;
    const MAX_ATTEMPTS = 60;

    const tryRelocate = () =>
    {
        const el = canvas.querySelector("mps-quick-toggle-sidebar");
        if (el)
        {
            el.setAttribute("data-relocated", "true");
            strip.appendChild(el);
            return true;
        }
        return false;
    };

    if (tryRelocate()) return;

    const pump = () =>
    {
        if (tryRelocate()) return;
        if (++attempts >= MAX_ATTEMPTS) return;
        requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
}

// ── Live parse pipeline (§1+§2) ──
/**
 * Inspect the title-page Format value and return reading direction.
 * Manga (case-insensitive) → RTL, anything else → LTR.
 * @param {any} ast
 * @returns {"LTR" | "RTL"}
 */
function detectReadingDirection(ast)
{
    // The parser already populates ast.readingDirection from ast.metadata.format.
    // (See Fountain-Plus/.../fountain-plus-mangaplay-parser.js deriveReadingDirection.)
    // Prefer that; fall back to a manual title-page sniff only if missing.
    if (ast?.readingDirection === "RTL" || ast?.readingDirection === "LTR")
    {
        return ast.readingDirection;
    }
    const metaFmt = ast?.metadata?.format;
    if (typeof metaFmt === "string" && /^manga$/i.test(metaFmt.trim()))
    {
        return "RTL";
    }
    const titlePage = ast?.titlePage;
    if (!titlePage) return "LTR";
    let fmt = null;
    if (titlePage instanceof Map) fmt = titlePage.get("Format");
    else if (typeof titlePage === "object") fmt = titlePage.Format || titlePage.format;
    if (typeof fmt !== "string") return "LTR";
    return /^manga$/i.test(fmt.trim()) ? "RTL" : "LTR";
}

/**
 * Parse the current document and publish to RuntimeStorage so mps-canvas can
 * paginate. Swallows parser errors — bad input shouldn't crash the keystroke
 * pipeline.
 * @param {string} text
 */
function publishParsedScript(text)
{
    try
    {
        const format = formatForFilename(currentProject?.scriptBasename);
        if (format === "superscript-bin")
        {
            // Binary .sup files have no editable text surface — skip.
            return;
        }
        if (format === "general-text")
        {
            // Plain text files don't have a script grammar, but the user still
            // gets a single blank canvas page they can draw on. Publish a
            // minimal one-page AST so mps-canvas mounts a drawable page. The
            // page id is stable per-file (via the basename) so per-page
            // drawing persistence keys cleanly.
            const stem = (currentProject?.scriptBasename || "untitled")
                .replace(/\.[^.]+$/, "");
            getRuntimeStorage().update({
                script: {
                    pages: [{ id: "1", panels: [] }],
                    pagesById: { "1": { id: "1", panels: [] } },
                    metadata: { format: "text", title: stem },
                    titlePage: {},
                    readingDirection: "LTR"
                },
                scriptFormat: "text",
                readingDirection: "LTR"
            });
            document.dispatchEvent(new CustomEvent("paint-state-request"));
            document.dispatchEvent(new CustomEvent("mangaplay:settingsChanged"));
            recomputeRightPaneEmpty(null);
            return;
        }
        let ast;
        let scriptFormat;
        if (format === "fountain")
        {
            // parseFountain returns a Screenplay object, not a ScriptAST. The
            // downstream consumers (mps-canvas, mps-screenplay) accept either
            // shape via the `scriptFormat` discriminator.
            ast = parseFountain(text);
            scriptFormat = "fountain";
        }
        else if (format === "superscript")
        {
            ast = parseSuperscript(text);
            scriptFormat = "superscript";
        }
        else
        {
            ast = parseScript(text);
            scriptFormat = "mangaplay";
        }
        const readingDirection = detectReadingDirection(ast);
        getRuntimeStorage().update({
            script: ast,
            scriptFormat,
            readingDirection
        });
        // Nudge widgets that listen for paint-state. The widgets destructure
        // `e.detail.{canUndo,canRedo,...}` so dispatching an empty event
        // crashes them (TypeError: destructure of null). Use the request
        // event instead — the canvas responds by dispatching a properly-
        // populated paint-state-update.
        document.dispatchEvent(new CustomEvent("paint-state-request"));
        // Nudge mps-quick-toggle-sidebar to re-sync. Its connectedCallback
        // populates innerHTML, but the canvas's render() can wipe it via
        // innerHTML reassignment — dispatching the settings-changed event
        // forces a clean _sync() pass so the sidebar always has content.
        document.dispatchEvent(new CustomEvent("mangaplay:settingsChanged"));
    }
    catch (e)
    {
        console.warn("[live-parse] parseScript failed (probably bad input):", e?.message);
    }
    // Refresh the right-pane empty-state after every parse so the
    // "Please begin writing in the Text Editor…" overlay clears as soon as
    // the user types real content.
    recomputeRightPaneEmpty(null);
}

/**
 * "Manage Projects" menu action: tear down the current project (without
 * destroying user data) and route the user back to the picker shell. When
 * they pick a project, mount it via the normal switchProject pipeline.
 */
let manageProjectsActive = false;
async function enterManageProjects()
{
    // Guard against re-entry — multiple concurrent enterManageProjects calls
    // would stack picker-shell listeners (renderStartScreen attaches a fresh
    // set every time) and leave dangling pending Promises.
    if (manageProjectsActive) return;
    manageProjectsActive = true;
    // Flush pending writes for the current project (non-destructive).
    try { await flushCurrentProjectMeta(); } catch (e) { console.warn("[manage] flush failed:", e); }
    // Tear down current project's editor views — same path switchProject uses.
    destroyCurrentProjectViews();
    // Stop the FS watcher (best-effort).
    try
    {
        if (isTauri())
        {
            await invoke("fs_watch_stop");
        }
    }
    catch (e) { console.debug("[manage] fs_watch_stop failed:", e); }
    // Clear current project state so the picker isn't biased.
    currentProject = null;
    /** @type {any} */ (window).__mpsCurrentProjectDir = null;
    // Hide the app chrome.
    const chrome = document.getElementById("app-chrome");
    if (chrome) chrome.hidden = true;
    // Refresh recents and show the picker shell.
    try { recentProjects = await loadRecent(); }
    catch (e) { console.warn("[manage] loadRecent failed:", e); recentProjects = []; }
    const shell = /** @type {any} */ (document.getElementById("picker-shell"));
    if (shell)
    {
        shell.style.display = "";
        shell.classList.remove("fade-out");
        shell.setRecent(recentProjects);
        shell.setLastPathInvalid(getLastProjectPathInvalid());
        shell.setPhase("picker");
    }
    setAppState("start-screen");
    // Re-enter the picker promise loop. renderStartScreen resolves with a
    // chosen project path; route the result through switchProject so the
    // mount pipeline runs identically to a normal dropdown switch.
    try
    {
        const path = await renderStartScreen();
        if (!path) { manageProjectsActive = false; return; } // user closed window without picking; stay on picker
        // Show an opening card while switchProject mounts the new project so
        // the click feels responsive (otherwise the picker stays painted with
        // no visible reaction). Matches the boot flow at the top of the
        // post-pick branch.
        if (shell)
        {
            try
            {
                const topName = (recentProjects.find((r) => r.path === path)?.resolvedName)
                    || basename(path)
                    || path;
                shell.setOpening(t("mangaplay-studio.boot.opening.openingNamed", { name: topName }), 0.2);
                shell.setPhase("opening");
            }
            catch { /* opening overlay is cosmetic — proceed */ }
        }
        // Bring the chrome back; switchProject will mount everything.
        if (chrome) chrome.hidden = false;
        await switchProject(path);
        // Fade the picker shell out so the workspace underneath is visible.
        // Mirror the boot post-mount sequence at app.js:4068-4073.
        if (shell)
        {
            shell.classList.add("fade-out");
            setTimeout(() =>
            {
                try
                {
                    shell.setPhase("bootstrap");
                    shell.classList.remove("fade-out");
                    shell.style.display = "none";
                }
                catch {}
            }, 360);
        }
    }
    catch (e) { console.error("[manage] renderStartScreen failed:", e); }
    finally { manageProjectsActive = false; }
}

/**
 * Enrich script entries from `list_project_scripts` with `kind` + absolute
 * `path` so the folder-explorer rows carry data-kind / data-path attributes.
 *
 * The Rust shape is `{ name, modifiedAt, createdAt }` where `name` is the
 * forward-slash relative path from `<projectRoot>/`. Every entry is a file.
 *
 * @param {Array<any>} scripts
 * @param {string} projectRoot
 * @returns {Array<{name:string,kind:"file",path:string,modifiedAt:number,createdAt:number}>}
 */
/**
 * Flat v2 layout: scripts live at `<projectRoot>/`. The walker emits names
 * relative to that, so passing the root produces bare basenames or
 * `subfolder/file.mangaplay.md` style rel-paths.
 *
 * @param {string} projectRoot
 * @returns {Promise<Array<any>>}
 */
async function listScriptsForProject(projectRoot)
{
    return listProjectScripts(projectRoot);
}

function enrichScripts(scripts, projectRoot)
{
    if (!Array.isArray(scripts)) return [];
    return scripts.map((s) =>
    {
        if (typeof s === "string")
        {
            return { name: s, kind: "file", path: `${projectRoot}/${s}`, modifiedAt: 0, createdAt: 0 };
        }
        const name = String(s.name || "");
        // Tree entries carry their own `path` + `kind`; pass through when
        // present so folder rows render with the correct absolute path.
        const kind = s.kind === "folder" ? "folder" : "file";
        const path = s.path ? String(s.path) : `${projectRoot}/${name}`;
        return {
            name,
            kind,
            path,
            modifiedAt: Number(s.modifiedAt || 0),
            createdAt: Number(s.createdAt || 0),
        };
    });
}

/**
 * Fetch the tree-shape entry list for the current project. Falls back to
 * the flat scripts list when the tree command is unavailable (older
 * binaries, test environment) so callers always get a usable shape.
 * @param {string} projectRoot
 */
async function listTreeForProject(projectRoot)
{
    try { return await listProjectTree(projectRoot); }
    catch (e)
    {
        console.debug("listProjectTree failed, falling back to flat list:", e);
        return await listScriptsForProject(projectRoot);
    }
}

/**
 * Mount the folder-explorer for the current project. Centralises the
 * `listProjectTree + enrich + mount` triple so all three call sites
 * (empty-state Enter, open-project, refreshExplorer) share the same opts
 * including expand persistence and drag-drop move wiring.
 */
async function mountFolderExplorer()
{
    if (!currentProject) return;
    const scripts = await listTreeForProject(currentProject.path);
    const enriched = enrichScripts(scripts, currentProject.path);
    const active = currentProject.scriptPath
        ? basename(currentProject.scriptPath)
        : null;
    const listEl = document.querySelector("#subview-folder .folder-list");
    if (!listEl) return;
    if (folderList) { folderList.destroy(); folderList = null; }
    const meta = currentProject.meta || {};
    folderList = mountFolderList(listEl, enriched, {
        activeFile: active,
        initialExpanded: Array.isArray(meta.expandedFolders) ? meta.expandedFolders : [],
        projectRoot: currentProject.path,
        onRename: handleRename,
        onToggleExpand: (relPath, isExpanded) =>
        {
            if (!currentProject) return;
            const m = currentProject.meta || (currentProject.meta = {});
            const set = new Set(Array.isArray(m.expandedFolders) ? m.expandedFolders : []);
            if (isExpanded) set.add(relPath);
            else set.delete(relPath);
            m.expandedFolders = [...set].sort();
            queueMetaSave(currentProject.path, m);
        },
        onMove: async (srcAbs, newParentAbs) =>
        {
            try
            {
                // Mark BOTH old and new paths as self-changes BEFORE the
                // IPC so the fs-changed listener (which may fire before
                // app_move_path returns) suppresses the "renamed
                // externally" banner. The destination basename is the same
                // as the source's; the new path is parent/basename.
                const baseName = basename(srcAbs);
                const dstAbs = newParentAbs.replace(/[\\/]+$/, "") + "/" + baseName;
                markSelfChange(srcAbs);
                markSelfChange(dstAbs);
                await invoke("app_move_path", {
                    srcPath: srcAbs,
                    newParent: newParentAbs,
                    projectRoot: currentProject?.path,
                });
                // Refresh the explorer so the user sees the new layout
                // immediately. The project-fs-changed listener will also
                // fire but its remount is delayed; this avoids a stale row.
                await refreshExplorer();
            }
            catch (err)
            {
                const code = String((err && err.message) || err || "unknown");
                const baseName = basename(srcAbs) || "file";
                const dstName = basename(newParentAbs) || "destination";
                if (code.includes("target-exists"))
                {
                    showBanner(`${baseName} already exists in ${dstName}`);
                }
                else if (code.includes("move-into-descendant"))
                {
                    // Silent — JS already short-circuits, but defence in depth.
                }
                else
                {
                    showBanner(`Move failed: ${code}`);
                }
            }
        },
    });
}

async function refreshExplorer()
{
    if (!currentProject) return;
    try { await mountFolderExplorer(); }
    catch (e) { console.debug("refreshExplorer failed:", e); }
}

// ── Explorer context menu wiring ──────────────────────────────────────────
//
// All contextmenu handling lives in a SINGLE capture-phase listener on
// document (installed in boot()). Capture-phase + single-listener avoids
// the WebView2/Chromium quirk where a delegated listener at the consumer
// element never fires when a separate guard suppresses the native menu —
// the event is consumed by the suppression and propagation halts. With one
// listener owning both jobs (route to ctx-menu OR preventDefault native),
// there is no race.
//
// wireExplorerContextMenu / wireEditorContextMenu are gone. Routing is
// dispatched from buildItemsForTarget(e.target) below.

/**
 * Last folder the user right-clicked on (for `parentForCreation`). For v1
 * this is always null because folder rows aren't rendered yet — the schema
 * is in place for when they're added.
 * @type {string | null}
 */
let lastRightClickedFolder = null;
/**
 * The single contextmenu router. Walks from the event target up the DOM
 * looking for a known consumer root. Returns the menu items to show, or
 * null to mean "no custom menu — suppress native and bail" (or, for the
 * opt-in case, "let the native menu through").
 *
 * @param {EventTarget | null} target
 * @returns {{ items: Array<any> } | "native" | null}
 */
function routeContextMenu(target)
{
    const t = /** @type {Element | null} */ (target);
    if (!t || typeof t.closest !== "function") return null;

    // Opt-in zones (rename input) — let native menu through.
    if (t.closest("[data-allow-native-menu='true']")) return "native";

    // File / folder explorer
    const list = t.closest(".folder-list");
    if (list)
    {
        const row = /** @type {HTMLElement|null} */ (t.closest(".folder-list-row"));
        if (row)
        {
            const path = row.dataset.path || "";
            const kind = row.dataset.kind || "file";
            const filename = row.dataset.filename || "";
            // Track the right-clicked folder so subsequent "New …" menu
            // items create inside it. ANY non-folder right-click clears
            // this, otherwise a stale folder pin persists across clicks
            // on files / empty area and "New Storyboard" ends up creating
            // inside the previously-clicked folder.
            lastRightClickedFolder = kind === "folder" ? path : null;
            return { items: kind === "folder"
                ? buildFolderMenu({ path, filename })
                : buildFileMenu({ path, filename }) };
        }
        // Empty-area right-click: clear the folder pin so "New …" creates
        // at the project root.
        lastRightClickedFolder = null;
        return { items: buildExplorerMenu() };
    }

    // CodeMirror editable area — mps-editor.js exposes a builder on window
    // because buildEditorMenu is private to that module.
    const cmContent = t.closest(".cm-content");
    if (cmContent)
    {
        const builder = /** @type {any} */ (window).__mpsBuildEditorMenu;
        if (typeof builder === "function") return { items: builder() };
    }

    return null;
}

/**
 * @param {{ path: string, filename: string }} ctx
 * @returns {Array<any>}
 */
function buildFileMenu(ctx)
{
    const log = /** @type {any} */ (window).__mpsLog;
    const tap = (item, fn) => () => {
        if (log) log("info", "menuItem", `clicked=${item} ctx.path=${ctx.path} ctx.filename=${ctx.filename}`);
        return fn();
    };
    return [
        { id: "reveal", label: t("mangaplay-studio.menu.file.showInExplorer"), icon: "move-up-right", onSelect: tap("file-reveal", () => { revealInExplorer(ctx.path).catch((e) => console.warn("reveal failed:", e)); }) },
        { kind: "divider" },
        { id: "rename", label: t("mangaplay-studio.menu.file.rename"), icon: "pencil",   onSelect: tap("file-rename", () => onBeginRename(ctx.filename)) },
        { kind: "divider" },
        { id: "delete", label: t("mangaplay-studio.menu.file.delete"), icon: "trash-2",  danger: true, onSelect: tap("file-delete", () => onDelete(ctx.path)) },
    ];
}

/**
 * @param {{ path: string, filename: string }} ctx
 * @returns {Array<any>}
 */
function buildFolderMenu(ctx)
{
    return [
        { id: "reveal", label: t("mangaplay-studio.menu.folder.showInExplorer"), icon: "move-up-right", onSelect: () => { revealInExplorer(ctx.path).catch((e) => console.warn("reveal failed:", e)); } },
        { kind: "divider" },
        { id: "rename", label: t("mangaplay-studio.menu.folder.rename"), icon: "pencil",   onSelect: () => onBeginRename(ctx.filename) },
        { kind: "divider" },
        { id: "delete", label: t("mangaplay-studio.menu.folder.delete"), icon: "trash-2",  danger: true, onSelect: () => onDelete(ctx.path) },
    ];
}

function buildExplorerMenu()
{
    const parent = parentForCreation();
    const disabled = parent === null;
    const root = currentProject?.path || null;
    return [
        { id: "new-folder",      label: t("mangaplay-studio.menu.explorer.newFolder"),      icon: "folder-plus", disabled, onSelect: () => onCreate(parent, "folder") },
        { id: "new-storyboard",  label: t("mangaplay-studio.menu.explorer.newStoryboard"),  icon: "file-plus",   disabled, onSelect: () => onCreate(parent, "mangaplay") },
        { id: "new-screenplay",  label: t("mangaplay-studio.menu.explorer.newScreenplay"),  icon: "file-plus",   disabled, onSelect: () => onCreate(parent, "fountain") },
        { id: "new-text-file",   label: t("mangaplay-studio.menu.explorer.newTextFile"),    icon: "file-plus",   disabled, onSelect: () => onCreate(parent, "text") },
        { kind: "divider" },
        { id: "reveal-root",     label: t("mangaplay-studio.menu.explorer.showProjectRootInExplorer"), icon: "move-up-right", disabled: !root, onSelect: () => { if (root) revealInExplorer(root).catch((e) => console.warn("reveal failed:", e)); } },
    ];
}

/**
 * Build the editor's "More Options" menu. Reads the active slot state to
 * decide which items are disabled. The labels reuse the existing right-click
 * menu locale keys where possible so the two surfaces stay in sync (rename /
 * delete / show-in-explorer).
 *
 * Items: Rename · Export Screenplay (placeholder — full export ships next) ·
 * Find (placeholder) · Show in System Explorer · Reveal Navigator · Delete.
 * @returns {Array<any>}
 */
function buildEditorMoreOptionsMenu()
{
    const slot = slotManager?.getActive();
    const path = slot?.path || null;
    const basename = slot?.basename || "";
    const format = /** @type {any} */ (slot)?.format || "general-text";
    const isPlaceholder = !path;
    const baseDisabled = isPlaceholder;
    const exportDisabled = baseDisabled
        || format === "general-text"
        || format === "superscript-bin";
    return [
        { id: "rename", label: t("mangaplay-studio.menu.file.rename"), icon: "pencil",
          disabled: baseDisabled,
          onSelect: () => { if (path) openRenameFileFlow(path, basename); } },
        { id: "export", label: t("mangaplay-studio.menu.editor.exportScreenplay") || "Export Screenplay",
          icon: "file-text",
          disabled: exportDisabled,
          onSelect: () =>
          {
              const state = getRuntimeStorage().state || {};
              void openExportScreenplayModal({
                  script: state.script,
                  scriptFormat: state.scriptFormat,
                  sourceText: currentDoc,
                  basename: slotManager?.getActive()?.basename || basename || "Untitled",
                  localPath: path || "",
              });
          } },
        { id: "publish-google-doc",
          label: t("mangaplay-studio.menu.editor.publishGoogleDoc") || "Publish Google Doc",
          icon: "cloud-upload",
          disabled: exportDisabled,
          onSelect: async () =>
          {
              const state = getRuntimeStorage().state || {};
              // Derive scriptRelPath from project root + slot's absolute
              // path so BUG-001 cache write has the keys it needs. Mirrors
              // the derivation in setGoogleDocsActiveScript above.
              let projectPath = "";
              let scriptRelPath = "";
              if (currentProject && path)
              {
                  projectPath = currentProject.path || "";
                  const projNorm = projectPath.replace(/\\/g, "/");
                  const slotNorm = String(path).replace(/\\/g, "/");
                  scriptRelPath = slotNorm.startsWith(projNorm + "/")
                      ? slotNorm.slice(projNorm.length + 1)
                      : (slotManager?.getActive()?.basename || basename || "");
              }
              try
              {
                  const [mod, authMod] = await Promise.all([
                      import("./google-docs-sync/publish-modal.js"),
                      import("./auth/google-oauth.js"),
                  ]);
                  await mod.openPublishModal({
                      script: state.script,
                      scriptFormat: state.scriptFormat,
                      sourceText: currentDoc,
                      basename: slotManager?.getActive()?.basename || basename || "Untitled",
                      localPath: path || "",
                      projectPath,
                      scriptRelPath,
                      authClient: {
                          getAccessToken: (opts) => authMod.getAccessToken(opts),
                      },
                  });
                  // Refresh footer's SyncStateMachine so the gear flips
                  // Grey → Blue immediately. See BUG-001.
                  await refreshGoogleDocsActiveScript();
              }
              catch (e) { console.warn("[publish-google-doc] open failed:", e); }
          } },
        { kind: "divider" },
        { id: "find", label: t("mangaplay-studio.menu.editor.find") || "Find",
          icon: "search",
          disabled: baseDisabled,
          onSelect: () => {
              showBanner(t("mangaplay-studio.menu.editor.findComingSoon")
                  || "Find is on the next sprint — coming soon.");
          } },
        { kind: "divider" },
        { id: "reveal", label: t("mangaplay-studio.menu.file.showInExplorer"),
          icon: "move-up-right",
          disabled: isPlaceholder,
          onSelect: () => { if (path) { revealInExplorer(path).catch((e) => console.warn("reveal failed:", e)); } } },
        { id: "reveal-navigator", label: t("mangaplay-studio.menu.editor.revealNavigator") || "Reveal Navigator",
          icon: "panel-left-open",
          disabled: isPlaceholder,
          onSelect: () => { showNavigator(); } },
        { kind: "divider" },
        { id: "delete", label: t("mangaplay-studio.menu.file.delete"), icon: "trash-2",
          danger: true,
          disabled: baseDisabled,
          onSelect: () => { if (path) onDelete(path); } },
    ];
}

/**
 * Open the More Options context menu anchored to the button.
 * @param {HTMLElement} anchor
 */
function openEditorMoreOptionsMenu(anchor)
{
    if (!anchor) return;
    try
    {
        const rect = anchor.getBoundingClientRect();
        const items = buildEditorMoreOptionsMenu();
        openContextMenu({
            x: Math.round(rect.left),
            y: Math.round(rect.bottom + 2),
            items,
        });
    }
    catch (e) { console.warn("[more-options] open failed:", e); }
}

/**
 * Ensure the left pane is expanded, switch the navigator subview to "folder",
 * and surface the active file's row (flash + scroll-into-view).
 */
function showNavigator()
{
    try { applyLeftPaneCollapsedState(false); } catch {}
    queueAppSettingsSave({ leftPaneCollapsed: false });
    void switchSubview("folder");
    requestAnimationFrame(() =>
    {
        try
        {
            if (folderList && typeof /** @type {any} */ (folderList).revealActive === "function")
            {
                /** @type {any} */ (folderList).revealActive();
            }
        }
        catch (e) { console.debug("[reveal-navigator] revealActive failed:", e); }
    });
}

/**
 * Open the Rename File flow. v1: route through the explorer's existing
 * inline-rename UX (handleRename already syncs tab + explorer + meta). A
 * dedicated modal is the next milestone.
 *
 * @param {string} _path
 * @param {string} filename
 */
function openRenameFileFlow(_path, filename)
{
    if (!filename) return;
    // Reveal the navigator first so the user sees the rename input land in
    // the explorer row.
    showNavigator();
    requestAnimationFrame(() => onBeginRename(filename));
}

/**
 * Resolve the parent folder for a `New …` action. Returns null when no
 * project is open — the menu items render in a disabled state so the user
 * discovers the affordance.
 * @returns {string | null}
 */
function parentForCreation()
{
    if (!currentProject) return null;
    if (lastRightClickedFolder) return lastRightClickedFolder;
    return currentProject.path;
}

/**
 * Naive forward-slash path join. The Rust side normalises platform-specific
 * separators on receipt; this helper just keeps the string tidy.
 * @param {...string} parts
 * @returns {string}
 */
function joinPath(...parts)
{
    return parts.join("/").replace(/\/+/g, "/");
}

/**
 * Route a `Make a copy` request through the broker so an in-flight autosave
 * for the source file flushes before the copy is created.
 * @param {string} path
 */
async function onCopy(path)
{
    const log = /** @type {any} */ (window).__mpsLog;
    if (log) log("info", "onCopy", `start path=${path}`);
    try
    {
        await getBroker().withLock(async () =>
        {
            markSelfChange(path);
            const copyResult = await copyFile(path);
            if (log) log("info", "onCopy", `ipc-ok result=${copyResult}`);
            if (typeof copyResult === "string") markSelfChange(copyResult);
        });
        await refreshExplorer();
        if (log) log("info", "onCopy", "done");
    }
    catch (err)
    {
        const msg = String((err && err.message) || err);
        console.error("[explorer] copy failed:", err);
        if (log) log("error", "onCopy", `failed: ${msg}`);
        showBanner(t("mangaplay-studio.banner.copyFailed", { error: msg }));
    }
}

/**
 * Trigger inline rename on the explorer mount. The folder-explorer module
 * owns the input DOM; we just delegate.
 * @param {string} filename
 */
function onBeginRename(filename)
{
    const log = /** @type {any} */ (window).__mpsLog;
    if (log) log("info", "onBeginRename", `start filename=${filename} folderListPresent=${!!folderList} hasBeginRename=${!!(folderList && typeof folderList.beginRename === "function")}`);
    if (folderList && typeof folderList.beginRename === "function")
    {
        try
        {
            folderList.beginRename(filename);
            if (log) log("info", "onBeginRename", "called beginRename");
        }
        catch (err)
        {
            const msg = String((err && err.message) || err);
            console.error("[explorer] beginRename threw:", err);
            if (log) log("error", "onBeginRename", `threw: ${msg}`);
            showBanner(t("mangaplay-studio.banner.renameFailed", { error: msg }));
        }
    }
    else
    {
        // User-visible feedback when the menu fires but the rename mount is
        // missing. Likely cause: explorer rebuild in-flight; advise retry.
        if (log) log("warn", "onBeginRename", "folderList null or no beginRename");
        showBanner(t("mangaplay-studio.banner.renameUnavailable"));
    }
}

/**
 * Route an `app_rename_file` call through the broker so the autosave queue
 * is drained before the file moves. When the renamed file is the currently
 * open script, the broker is also updated to point at the new path so the
 * next save lands in the right place.
 * @param {string} oldPath
 * @param {string} newBasename
 * @returns {Promise<string | undefined>}
 */
/**
 * Open a different script by replacing the content of the currently-active
 * tab. Drains the broker, reads the new file from disk, hands the content
 * to the slot manager (which swaps the CM6 doc + label in place), then
 * swaps the mangaart cache and dispatches `slot-switched` so the canvas
 * tears down its old runtime state and rehydrates the incoming page.
 *
 * No-op if the requested path is already the active script. Reuses the
 * outgoing slot's path/basename for the pagination snapshot — the slot
 * manager is the source of truth for "what's currently visible".
 *
 * @param {string} newPath  absolute path of the script to open
 * @returns {Promise<void>}
 */
async function replaceActiveTab(newPath)
{
    if (!newPath || !currentProject) return;
    // Normalise separator style before comparing — paths from row.dataset
    // can mix separators with what we set after a Rust-side rename.
    const norm = (p) => (p || "").replace(/\\/g, "/");
    const active = slotManager?.getActive();
    const outgoingPath = active?.path || null;
    const outgoingBase = active?.basename || "";
    if (norm(outgoingPath) === norm(newPath)) return;

    const broker = getBroker();
    await broker.withLock(async () =>
    {
        // 1. The lock guarantees any pending autosave for the OLD path has
        //    already flushed via drainAllPending. Now load the new file's
        //    contents from disk.
        /** @type {string} */
        let newText = "";
        try
        {
            newText = (await readFile(newPath)) ?? "";
        }
        catch (err)
        {
            console.warn("[swap] readFile failed:", err);
            showBanner(t("mangaplay-studio.banner.couldntOpen", { error: String((err && err.message) || err) }));
            return;
        }

        // 2. Snapshot outgoing pagination + mark the canvas as swapping
        //    BEFORE the project state mutates. The canvas component listens
        //    for `drawing-flush-request` and uses it to flush in-flight
        //    strokes + raise its _slotSwitching guard so the imminent
        //    script change is not treated as an in-flight edit. We also
        //    persist the OUTGOING file's currentPageIndex so re-selecting
        //    it later restores the right page.
        const canvasEl = /** @type {any} */ (document.querySelector("mps-canvas"));
        const outgoingPageIndex = canvasEl?.store?.state?.currentPageIndex ?? 0;
        if (canvasEl) canvasEl.setAttribute("data-canvas-state", "swapping");
        document.dispatchEvent(new CustomEvent("drawing-flush-request"));
        if (outgoingBase)
        {
            try
            {
                await setLastPageIndex(currentProject.path, outgoingBase, outgoingPageIndex);
            }
            catch (err)
            {
                console.warn("[swap] save outgoing page index failed:", err);
            }
        }

        // 3. Hand the new content to the slot manager. replaceActive reuses
        //    the active slot's CM6 view (same format) or rebuilds it
        //    (different format), and updates path/basename/format on the
        //    slot record. The active slot becomes the new file's slot.
        const newBase = basename(newPath);
        const format = /** @type {any} */ (formatForFilename(newBase));
        if (slotManager)
        {
            slotManager.replaceActive(newPath, newText, format);
        }
        // Legacy mirror onto currentProject for the rest of app.js that still
        // reads `scriptPath` / `scriptBasename` / `script` directly.
        currentProject.scriptPath = newPath;
        currentProject.scriptBasename = newBase;
        currentProject.script = newText;

        // Hide the project-level "Create a new mangaplay" empty-state overlay
        // now that the project has an active file. Without this, opening a
        // file via the explorer (e.g. right-click → New Storyboard → click
        // the renamed row) leaves the overlay visible on top of the editor —
        // user sees the prompt to "Press Enter or click here to create
        // Untitled.mangaplay.md" even though their file is now active behind it.
        updateEmptyState();

        // 4. Broker re-anchors to the new path. unlock(newPath) atomically
        //    drops any leftover state from the old path so the next save
        //    lands at the new path.
        broker.unlock(newPath);

        // 5. Swap the mangaart cache so the storyboard side reflects the
        //    new script's drawings. clearMangaartCache + loadMangaart is the
        //    same pattern used at project open time.
        try
        {
            clearMangaartCache();
            await loadMangaart(currentProject.path, currentProject.scriptBasename);
        }
        catch (err)
        {
            console.warn("[swap] mangaart load failed:", err);
        }

        // 6. Restore the incoming file's last page index in the canvas
        //    store BEFORE dispatching `slot-switched`. The canvas's
        //    slot-switched handler reads store.state.currentPageIndex and
        //    hydrates that page, so setting the index first means the
        //    user lands on the page they were last viewing.
        try
        {
            const incomingPageIndex = await getLastPageIndex(currentProject.path, newBase);
            if (canvasEl?.store)
            {
                canvasEl.store.update(
                    { currentPageIndex: incomingPageIndex },
                    "file-swap-restore"
                );
            }
        }
        catch (err)
        {
            console.warn("[swap] restore incoming page index failed:", err);
        }

        // 7. Dispatch `slot-switched` so the canvas tears down its old-slot
        //    runtime state (RuntimeDrawingCache, UndoManager) and hydrates
        //    the new page. Payload carries fromPath/toPath per locked
        //    decision #3 so the canvas listener can gate on path inequality.
        document.dispatchEvent(new CustomEvent("slot-switched", {
            detail: { fromPath: outgoingPath, toPath: newPath }
        }));

        // 8. Refresh the file list to repaint the .is-active row marker.
        await refreshExplorer();
    });
}

/**
 * Tracks paths this window just mutated, so the project-fs-changed listener
 * can distinguish "we did it" from "another window did it". Auto-expires
 * after 5s to handle slow event delivery (notify-based watcher coalescing
 * + cross-window IPC latency) without leaking memory.
 *
 * Keys are normalised to forward slashes via `normalizePath` so the listener
 * side can compare regardless of which separator form Rust sent. Value is
 * the timestamp at which the mark expires.
 * @type {Map<string, number>}
 */
const __mpsSelfChanges = new Map();

/**
 * Mark a path as self-mutated. Default TTL 5s — wide enough that the
 * watcher's debounce (and any atomic-write fan-out into multiple events)
 * lands inside the window. Pass `ttlMs` to shorten for high-frequency
 * mutations (e.g. autosave) so genuine external edits aren't suppressed
 * for too long.
 * @param {string} path
 * @param {number} [ttlMs] default 5000
 */
function markSelfChange(path, ttlMs = 5000)
{
    if (!path) return;
    __mpsSelfChanges.set(normalizePath(path), Date.now() + ttlMs);
}

/**
 * A single self-initiated write can fan out into multiple watcher events
 * (atomic rename → "deleted" then "modified", on some platforms). So
 * consume is a TTL window peek, NOT a single-use take — any event within
 * the window is treated as self. The map entry expires on its own; we
 * don't delete on read.
 * @param {string} path @returns {boolean}
 */
function consumeSelfChange(path)
{
    if (!path) return false;
    const key = normalizePath(path);
    const expiry = __mpsSelfChanges.get(key);
    if (expiry === undefined) return false;
    if (expiry <= Date.now())
    {
        __mpsSelfChanges.delete(key);
        return false;
    }
    return true;
}

async function handleRename(oldPath, newBasename)
{
    const log = /** @type {any} */ (window).__mpsLog;
    if (log) log("info", "handleRename", `start oldPath=${oldPath} newBasename=${newBasename}`);
    const broker = getBroker();
    const isActive = broker.isActivePath(oldPath);
    /** @type {string | undefined} */
    let newPath;
    try
    {
        await broker.withLock(async () =>
        {
            // withLock drained any in-flight saves before running this block, so
            // by the time we reach the rename there is no pending write to the
            // old path. Pass currentlyOpen: false — the Rust safety net's purpose
            // is to refuse renames when the UI forgot to drain. We did drain.
            markSelfChange(oldPath);
            const projectRoot = currentProject?.path;
            const result = await renameFile(oldPath, newBasename, /*currentlyOpen=*/ false, projectRoot);
            if (log) log("info", "handleRename", `ipc-ok result=${result}`);
            if (typeof result === "string")
            {
                newPath = result;
                markSelfChange(result);
            }
            if (isActive && typeof result === "string")
            {
                broker.unlock(result);
                // Update the active slot so its tab label + dataset.path
                // reflect the new name, and mirror the new path/basename
                // onto currentProject (other modules read it directly).
                const activeSlot = slotManager?.getActive();
                if (activeSlot) slotManager.renamePath(activeSlot.tabId, result);
                if (currentProject)
                {
                    currentProject.scriptPath = result;
                    const base = basename(result);
                    if (base) currentProject.scriptBasename = base;
                }
            }
        });
        await refreshExplorer();
        if (log) log("info", "handleRename", `done newPath=${newPath}`);
    }
    catch (err)
    {
        if (log) log("error", "handleRename", `failed: ${String((err && err.message) || err)}`);
        throw err;        // rethrow so the rename input shows the error inline
    }
    return newPath;
}

/**
 * Delete a file. When the file is currently open in the editor the user
 * sees an explicit confirm modal; on agreement the broker's pending writes
 * are DROPPED (not flushed) so the latest keystrokes do not get written
 * into a file that's about to move to the trash.
 *
 * If the OS / platform refuses the trash operation (e.g. freedesktop on
 * nosuid mount), the user is offered a hard-delete fallback.
 *
 * @param {string} path
 */
async function onDelete(path)
{
    const log = /** @type {any} */ (window).__mpsLog;
    if (log) log("info", "onDelete", `start path=${path}`);
    const broker = getBroker();
    const isActive = broker.isActivePath(path);
    if (log) log("info", "onDelete", `isActive=${isActive} brokerPath=${broker.getActivePath?.()}`);
    if (isActive)
    {
        const ok = await confirmModal({
            title: t("mangaplay-studio.dialog.delete.openFileTitle"),
            body: t("mangaplay-studio.dialog.delete.openFileBody"),
            confirm: t("mangaplay-studio.dialog.delete.openFileConfirm"),
            danger: true,
        });
        if (log) log("info", "onDelete", `confirm-modal=${ok ? "confirmed" : "cancelled"}`);
        if (!ok) return;
        broker.dropPendingWrites();
    }
    try
    {
        await broker.withLock(async () =>
        {
            try
            {
                markSelfChange(path);
                const projectRoot = currentProject?.path;
                await deleteFile(path, projectRoot);
                if (log) log("info", "onDelete", "ipc-ok via trash");
            }
            catch (err)
            {
                const code = String((err && err.message) || err || "");
                if (log) log("warn", "onDelete", `deleteFile threw: ${code}`);
                if (code.includes("trash-unavailable"))
                {
                    const force = await confirmModal({
                        title: t("mangaplay-studio.dialog.delete.trashUnavailableTitle"),
                        body: t("mangaplay-studio.dialog.delete.trashUnavailableBody"),
                        confirm: t("mangaplay-studio.dialog.delete.trashUnavailableConfirm"),
                        danger: true,
                    });
                    if (!force) return;
                    markSelfChange(path);
                    const projectRoot = currentProject?.path;
                    await deleteFileForce(path, projectRoot);
                    if (log) log("info", "onDelete", "ipc-ok via force-delete");
                }
                else
                {
                    throw err;
                }
            }
            if (isActive)
            {
                broker.unlock(null);
                if (currentProject) currentProject.scriptPath = null;
                // Close the active slot — the slot manager auto-spawns a
                // fresh empty tab so the strip is never empty (locked
                // decision #10).
                const activeSlot = slotManager?.getActive();
                if (activeSlot) await slotManager.close(activeSlot.tabId);
                // Defensive — clearEditorAfterActiveDelete just resets
                // currentDoc; harmless even if the slot was already torn
                // down by close().
                clearEditorAfterActiveDelete();
            }
        });
        await refreshExplorer();
        if (log) log("info", "onDelete", "done");
    }
    catch (err)
    {
        const msg = String((err && err.message) || err);
        console.error("[explorer] delete failed:", err);
        if (log) log("error", "onDelete", `failed: ${msg}`);
        showBanner(t("mangaplay-studio.banner.deleteFailed", { error: msg }));
    }
}

/**
 * Route a `New Folder / New Storyboard / New Screenplay` action through the
 * broker so any in-flight autosave flushes before the create. `parent` is
 * already null-checked by the disabled state in `buildExplorerMenu`; the
 * extra guard here is defensive in case the menu items are activated by a
 * keyboard path that bypasses `disabled`.
 *
 * @param {string | null} parent
 * @param {"folder"|"mangaplay"|"fountain"|"superscript"|"text"} kind
 */
async function onCreate(parent, kind)
{
    const log = /** @type {any} */ (window).__mpsLog;
    if (log) log("info", "onCreate", `start parent=${parent} kind=${kind}`);
    if (!parent)
    {
        if (log) log("warn", "onCreate", "parent is null/empty — bailing");
        return;
    }
    try
    {
        await getBroker().withLock(async () =>
        {
            const created = await createFile(parent, kind);
            if (log) log("info", "onCreate", `ipc-ok created=${created}`);
            if (typeof created === "string") markSelfChange(created);
        });
        await refreshExplorer();
        if (log) log("info", "onCreate", "done");
    }
    catch (err)
    {
        const msg = String((err && err.message) || err);
        console.error("[explorer] create failed:", err);
        if (log) log("error", "onCreate", `failed: ${msg}`);
        showBanner(t("mangaplay-studio.banner.createFailed", { error: msg }));
    }
}

/**
 * Reset the cached document text after the active file is deleted. The
 * slot lifecycle is now owned by the slot manager — `slotManager.close()`
 * destroys the CM6 view and auto-spawns a fresh empty tab so the strip is
 * never empty. This helper only resets module-level state that lives
 * outside the slot record.
 */
function clearEditorAfterActiveDelete()
{
    currentDoc = "";
}

/**
 * Wire the cross-window `project-fs-changed` listener. Each Tauri window
 * receives the event so window B reacts when window A mutates the FS.
 */
let projectFsChangedWired = false;
/**
 * Stored `UnlistenFn` returned by `w.listen("project-fs-changed", ...)`.
 * Currently unused — preserved for a future shutdown / window-close hook
 * that needs to detach the listener cleanly (see plan
 * path-portability-and-watcher-followups.md N1).
 */
async function wireProjectFsChangedListener()
{
    // One-shot: project-fs-changed handler watches `currentProject` by closure,
    // so re-wiring on each project swap would stack handlers (leak). Two-step
    // guard: set the flag BEFORE the await so concurrent callers return early
    // (prevents stacking), and reset it on failure / non-Tauri host so a failed
    // wire stays retryable on the next call.
    if (projectFsChangedWired) return;
    projectFsChangedWired = true;
    try
    {
        const w = isTauri() ? getCurrentWindow() : null;
        if (!w || typeof w.listen !== "function")
        {
            projectFsChangedWired = false;
            return;
        }
        await w.listen("project-fs-changed", async ({ payload }) =>
        {
            try
            {
                if (!currentProject) return;
                if (!payload?.path) return;
                // SEPARATOR CONTRACT: payload.path arrives from Rust as a platform-native
                // string (see lib.rs emit_fs_changed). currentProject.path also comes via
                // Tauri's dialog plugin in native form. Both should match in separator
                // style on a given host — but the verify-first watcher item (plan:
                // path-portability-and-watcher-followups.md) checks this on Windows
                // before we drop the explicit sep inference below.
                const root = currentProject.path;
                // Accept exact-match (the root itself) OR path starts with
                // root+separator. Without the separator check a sibling dir
                // like /a/bc would match /a/b.
                const sep = root.includes("\\") ? "\\" : "/";
                if (payload.path !== root && !payload.path.startsWith(root + sep)) return;

                // Tauri emits project-fs-changed to ALL windows, including the
                // one that initiated the change. To avoid showing "File deleted
                // externally" when WE just deleted it locally, the local
                // mutation entry points (onCopy / onDelete / handleRename /
                // onCreate) mark expected events in `__mpsSelfChanges`. The
                // handler consumes the mark before treating the event as
                // external.
                if (consumeSelfChange(payload.path))
                {
                    await refreshExplorer();
                    return;
                }

                const broker = getBroker();
                const change = payload.change || {};
                const type = change.type;

                if (type === "renamed" && broker.isActivePath(payload.path))
                {
                    broker.unlock(change.to ?? null);
                    // Update the slot for the active tab too so its label
                    // tracks the external rename.
                    const activeSlot = slotManager?.getActive();
                    if (activeSlot)
                    {
                        slotManager.renamePath(activeSlot.tabId, change.to ?? null);
                    }
                    if (currentProject)
                    {
                        currentProject.scriptPath = change.to ?? null;
                        const newBase = basename(change.to);
                        if (newBase) currentProject.scriptBasename = newBase;
                    }
                    showBanner(t("mangaplay-studio.banner.fileRenamedExternally"));
                }
                else if (type === "deleted" && broker.isActivePath(payload.path))
                {
                    broker.unlock(null);
                    if (currentProject) currentProject.scriptPath = null;
                    // Close the active slot; slot manager auto-spawns a
                    // fresh empty tab.
                    const activeSlot = slotManager?.getActive();
                    if (activeSlot) await slotManager.close(activeSlot.tabId);
                    showBanner(t("mangaplay-studio.banner.fileDeletedExternally"));
                }
                else if (type === "created" || type === "modified")
                {
                    // Note: self-initiated creates are consumed by consumeSelfChange() above
                    // (see the dedup call earlier in this handler), so this branch only
                    // fires for genuine external events. Don't re-flag as a bug.
                    // External create or modify. On Linux backends an
                    // atomic-write rename surfaces as Created on the final
                    // path (the .tmp is dropped by the ignore filter); on
                    // Windows/macOS the same operation collapses to Modified
                    // via map_notify_event's rename rule. Both shapes mean
                    // the same thing to the user: "the file I have open just
                    // changed under me". If it's the active script, surface a
                    // banner so the user knows the on-disk content diverged
                    // from the buffer. For other files in the explorer, the
                    // trailing refreshExplorer() picks up the mtime change.
                    if (broker.isActivePath(payload.path))
                    {
                        const base = basename(payload.path);
                        showBanner(t("mangaplay-studio.banner.fileModifiedExternally", { file: base }));
                    }
                }
                else if (type === "created-dir")
                {
                    // Directory was created externally. No file to open —
                    // the trailing refreshExplorer() surfaces the new folder.
                }
                await refreshExplorer();
            }
            catch (e) { console.warn("[fs-changed] handler failed:", e); }
        });
    }
    catch (e)
    {
        // Reaches here only when w.listen() itself throws — the non-Tauri
        // jsdom path is handled by the explicit early-return above, so this
        // catch is the real Tauri-failure case. Log at warn (a silent failure
        // here disables cross-window fs notifications) and clear the flag so
        // the next call can retry.
        projectFsChangedWired = false;
        console.warn("[fs-changed] listener wiring failed:", e?.message);
    }
}

// ── View mounting ──
/**
 * Per-project mount: builds the slot manager, canvas, screenplay, mode toggle,
 * empty-tab CTA, and restores the tab snapshot. MUST be called once per
 * project mount (boot + every project switch). The static-shell DOM is wired
 * separately by `wireShellOnce()` exactly once per app lifetime.
 */
async function mountProjectViews() {
    const editorEl = document.querySelector("mps-editor-host");
    const canvasEl = document.querySelector("mps-canvas");

    // Autosave: routed through the ActiveScriptBroker so destructive ops
    // (rename / delete / migrate) can drain pending writes before mutating.
    // The broker owns the 1500 ms debounce — we just pass the saveFn that
    // hits the right path at fire-time.
    const broker = getBroker();
    debouncedScriptSave = (text) =>
    {
        if (!currentProject || !currentProject.scriptPath) return;
        broker.scheduleScriptSave(text, async (latest) =>
        {
            setSaveState("saving");
            try
            {
                // Mark the path as a self-change so the FS watcher swallows
                // any events the atomic write emits — a single atomic write
                // can fan out into "deleted" then "modified" depending on
                // notify-rs behaviour, so consumeSelfChange is now a TTL
                // window peek (not single-take). Short TTL keeps the window
                // tight so genuine external edits aren't suppressed for
                // longer than the watcher debounce.
                markSelfChange(currentProject.scriptPath, 1500);
                await saveScript(currentProject.scriptPath, latest);
                setSaveState("saved");
                if (saveFailureBannerShown) saveFailureBannerShown = false;
            }
            catch (e)
            {
                console.error("Autosave failed:", e);
                setSaveState("dirty");
                if (!saveFailureBannerShown)
                {
                    const reason = (e && /** @type {any} */ (e).message) ? /** @type {any} */ (e).message : String(e);
                    showBanner(t("mangaplay-studio.banner.saveFailed", { reason }));
                    saveFailureBannerShown = true;
                }
            }
        });
    };

    // Debounced screenplay re-render — keeps fast typing cheap on long docs.
    // Also publish the parsed AST to RuntimeStorage so mps-canvas can paginate
    // and the right-pane screenplay re-renders from the same source of truth.
    debouncedScreenplayUpdate = debouncedSave((text) => {
        publishParsedScript(text);
    }, SCREENPLAY_DEBOUNCE_MS);

    if (editorEl)
    {
        const tabBarEl = document.querySelector(".top-bar-tabs");
        if (!tabBarEl)
        {
            console.warn("[mountViews] .top-bar-tabs not found; tab strip will not render");
        }

        // Mount the tab strip first; it back-references the slot manager via
        // setManager() once the manager exists.
        editorTabs = mountEditorTabs(
            /** @type {HTMLElement} */ (tabBarEl),
            null,
            {
                onNewTab: () =>
                {
                    // The "+" button opens a fresh empty scratch tab.
                    slotManager?.openNew(
                        null,
                        "",
                        /** @type {any} */ ("general-text")
                    );
                }
            }
        );

        slotManager = new EditorSlotManager(
            /** @type {HTMLElement} */ (editorEl),
            /** @type {HTMLElement} */ (tabBarEl),
            {
                onChange: (slot, text) =>
                {
                    currentDoc = text;
                    // Mirror onto currentProject for compatibility with the
                    // rest of app.js when the slot matches the active script.
                    if (currentProject && slot.path
                        && currentProject.scriptPath === slot.path)
                    {
                        currentProject.script = text;
                    }
                    onMpsChangeFromSlot(slot, text);
                },
                onActivate: (slot) =>
                {
                    onSlotActivated(slot);
                },
                onCloseRequest: async (slot) =>
                {
                    // Flush any pending writes for THIS path before destroying
                    // the view. withLock drains pending broker writes.
                    if (slot.path)
                    {
                        try { await getBroker().withLock(async () => {}); }
                        catch (e) { console.warn("[slot-close] flush failed:", e); }
                    }
                },
                onTabsChanged: () =>
                {
                    editorTabs?.render();
                    debouncedWriteSession();
                }
            }
        );
        editorTabs.setManager(slotManager);

        // ── Phase-2: three-state editor mode (Source / Text / Visual) ───────
        // `applyEditorMode(mode)` is the single switchboard. It —
        //   1. Flushes any pending broker writes so Visual reads the
        //      latest buffer (not a stale snapshot mid-debounce).
        //   2. For Text / Source: reconfigures EVERY slot's CM language
        //      compartment AND remembers the mode module-side so new
        //      slots built later honour it. Cursor / scroll / undo
        //      survive because it's reconfigure, not re-instantiate.
        //   3. For Visual: hides all CM slot containers and mounts a
        //      single cached `<mps-visual-editor>` element as a sibling
        //      so it never coexists with a live CM subscriber.
        //   4. Persists `editorMode` to user-settings.json AFTER the
        //      switch succeeds (never before — a thrown switch must
        //      not leave the persisted mode out of sync with reality).
        //   5. Syncs the mode-toggle button's `mode` property.
        /** @type {"source"|"text"|"visual"} */
        let editorMode = /** @type {any} */ (getUserSetting("editorMode", "text"));
        if (editorMode !== "source" && editorMode !== "text" && editorMode !== "visual")
        {
            editorMode = "text";
        }
        modeToggleEl = /** @type {any} */ (
            document.createElement("mps-editor-mode-toggle")
        );
        modeToggleEl.setAttribute("mode", editorMode);

        /**
         * Apply `mode` to the editor pane. See block comment above for the
         * full contract. Idempotent — calling with the current mode is a
         * cheap no-op aside from re-persisting.
         * @param {"source"|"text"|"visual"} mode
         * @param {{ persist?: boolean }} [opts] persist defaults to true.
         *   Set false for one-shot switches (e.g. the empty-tab CTA's
         *   auto-mode-switch when creating a new file) so the user's
         *   global editorMode setting isn't overwritten.
         */
        async function applyEditorMode(mode, opts)
        {
            if (mode !== "source" && mode !== "text" && mode !== "visual")
            {
                return;
            }
            const persist = opts?.persist !== false;

            const previousMode = editorMode;

            // Drain pending CM autosaves before swapping surfaces — Visual
            // reads `state.script` from RuntimeStorage, which is populated
            // by the existing debounced subscriber. Source / Text never
            // strictly need this, but the cost is one no-op await so we
            // run it unconditionally for a single code path.
            try { await getBroker().withLock(async () => {}); }
            catch (e) { console.warn("[mode-switch] flush failed:", e); }

            // Leaving Visual → tear down (or hide) the visual element so
            // it stops subscribing to RuntimeStorage before CM remounts.
            if (mode !== "visual" && visualEditorEl)
            {
                visualEditorEl.style.display = "none";
            }

            if (mode === "visual")
            {
                if (editorEl)
                {
                    // Hide every CM slot container so they don't paint
                    // behind the visual editor.
                    for (const child of Array.from(editorEl.children))
                    {
                        const el = /** @type {HTMLElement} */ (child);
                        if (el.classList.contains("editor-slot"))
                        {
                            el.dataset.cmHiddenForVisual = "1";
                            el.style.display = "none";
                        }
                    }
                    if (!visualEditorEl)
                    {
                        visualEditorEl = /** @type {HTMLElement} */ (
                            document.createElement("mps-visual-editor")
                        );
                        visualEditorEl.id = "mps-visual-editor-host";
                        editorEl.appendChild(visualEditorEl);
                    }
                    else
                    {
                        visualEditorEl.style.display = "";
                    }
                }
            }
            else
            {
                // If we were previously in Visual mode, the user may have
                // mutated the script via the visual editor (Insert Blank
                // Page, panel reorder, etc). Those edits live in the
                // RuntimeStorage `script` field; CodeMirror has no
                // store→buffer subscriber, so we explicitly serialise the
                // current AST and push it into the active CM view here.
                if (previousMode === "visual" && slotManager)
                {
                    try
                    {
                        const storeState = getRuntimeStorage().state;
                        const script = storeState?.script;
                        let source = null;
                        if (typeof script === "string")
                        {
                            source = script;
                        }
                        else if (script && typeof script === "object")
                        {
                            source = visualFormatScript(/** @type {any} */ (script));
                        }
                        if (typeof source === "string")
                        {
                            const active = slotManager.getActive();
                            const view = active?.view;
                            if (view && view.state.doc.toString() !== source)
                            {
                                view.dispatch({
                                    changes: {
                                        from: 0,
                                        to: view.state.doc.length,
                                        insert: source
                                    }
                                });
                            }
                        }
                    }
                    catch (e)
                    {
                        console.warn("[mode-switch] visual→CM sync failed:", e);
                    }
                }
                if (editorEl)
                {
                    for (const child of Array.from(editorEl.children))
                    {
                        const el = /** @type {HTMLElement} */ (child);
                        if (el.classList.contains("editor-slot")
                            && el.dataset.cmHiddenForVisual === "1")
                        {
                            delete el.dataset.cmHiddenForVisual;
                            // Slot manager owns `display:""` for the active
                            // slot — only the active slot will become
                            // visible; inactive slots stay hidden via the
                            // manager's own bookkeeping.
                            el.style.display = "";
                        }
                    }
                    // Re-run activate() so the active slot ends up the only
                    // visible one (mirrors the post-construction invariant).
                    const active = slotManager?.getActive();
                    if (active && slotManager)
                    {
                        slotManager.activate(active.tabId);
                    }
                }
                // Reconfigure every existing slot's CM compartment so the
                // user sees the new extension set immediately.
                if (slotManager)
                {
                    for (const slot of slotManager.list())
                    {
                        try { setEditorViewMode(slot.view, mode); }
                        catch (e)
                        {
                            console.warn("[mode-switch] setEditorViewMode failed for slot",
                                slot.tabId, e);
                        }
                    }
                }
            }

            // Show the line-number gutter only in Source mode — Text and
            // Visual hide it. CSS gate is `mps-editor-host[data-show-line-numbers]`.
            if (editorEl)
            {
                if (mode === "source")
                {
                    editorEl.setAttribute("data-show-line-numbers", "");
                }
                else
                {
                    editorEl.removeAttribute("data-show-line-numbers");
                }
            }

            // Mirror the mode onto the editor-area top bar so other
            // attribute-driven UI (e.g. format pill visibility) can react.
            // Pagination is NO LONGER gated on mode — it follows the active
            // file format instead (mangaplay → enabled, anything else →
            // visible-but-disabled), so the user can paginate the Storyboard
            // canvas from text / source / visual alike. tooltip.js keys off
            // attr presence, so we drop `data-tooltip` while disabled to
            // suppress the hover.
            if (editorAreaTopBarEl)
            {
                editorAreaTopBarEl.setAttribute("data-mode", mode);
            }
            if (editorBarPagePrevBtn && editorBarPageNextBtn)
            {
                const format = getActivePaginationFormat();
                if (format === "mangaplay")
                {
                    const prevLabel = t("ui.paint.prevPage") || "Previous page";
                    const nextLabel = t("ui.paint.nextPage") || "Next page";
                    editorBarPagePrevBtn.setAttribute("data-tooltip", prevLabel);
                    editorBarPagePrevBtn.setAttribute("data-tooltip-side", "bottom");
                    editorBarPageNextBtn.setAttribute("data-tooltip", nextLabel);
                    editorBarPageNextBtn.setAttribute("data-tooltip-side", "bottom");
                    editorBarPagePrevBtn.disabled = _paginationPageIndex <= 0;
                    editorBarPageNextBtn.disabled = _paginationPageIndex >= _paginationTotalPages - 1;
                }
                else
                {
                    editorBarPagePrevBtn.disabled = true;
                    editorBarPageNextBtn.disabled = true;
                    editorBarPagePrevBtn.removeAttribute("data-tooltip");
                    editorBarPageNextBtn.removeAttribute("data-tooltip");
                }
            }
            if (editorBarFixIssuesBtn)
            {
                const slot = slotManager?.getActive();
                const supportedFormat = slot?.format === "mangaplay"
                    || slot?.format === "fountain";
                if (supportedFormat)
                {
                    const fixLabel = t("ui.visualEditor.fixStructuralIssues",
                        "Fix Structural Issues");
                    editorBarFixIssuesBtn.setAttribute("data-tooltip", fixLabel);
                    editorBarFixIssuesBtn.setAttribute("data-tooltip-side", "bottom");
                    editorBarFixIssuesBtn.setAttribute("aria-label", fixLabel);
                    if (typeof window.__mpsRefreshFixIssuesBtn === "function")
                    {
                        try { window.__mpsRefreshFixIssuesBtn(); } catch (_) {}
                    }
                    else
                    {
                        editorBarFixIssuesBtn.disabled = true;
                    }
                }
                else
                {
                    editorBarFixIssuesBtn.disabled = true;
                    editorBarFixIssuesBtn.removeAttribute("data-tooltip");
                }
            }

            // Remember module-side so future buildEditor() calls match.
            setEditorMode(mode);
            editorMode = mode;
            modeToggleEl.mode = mode;
            // Mode sync contract — single switchboard fans out to every
            // surface that displays current mode. App Footer's Mode Button
            // reflects the new icon; never tracks its own state.
            try { appFooter?.setMode(mode); }
            catch (e) { console.debug("[mode-switch] appFooter.setMode threw:", e); }

            // Restore keyboard focus to the editor after a mode switch.
            // Without this, the toggle button (a plain <button>) keeps focus
            // and silently swallows keystrokes — the user reports "cannot type
            // after switching modes". Visual mode owns its own focus model so
            // we skip it there.
            if ((mode === "text" || mode === "source") && slotManager)
            {
                try
                {
                    const active = slotManager.getActive();
                    active?.view?.focus();
                }
                catch (e) { console.debug("[mode-switch] focus restore failed:", e); }
            }

            // Persist AFTER the switch succeeded — unless the caller asked
            // for a one-shot switch (e.g. empty-tab CTA file-create flow).
            if (persist)
            {
                try { await saveUserSettings({ editorMode: mode }); }
                catch (e) { console.debug("[mode-switch] persist failed:", e); }
            }
        }

        // 44px top bar across the editor host. Carries the pagination
        // chevrons on the left and the mode toggle on the right. The bar
        // overlays all three editor surfaces (Text / Source / Visual) so
        // a single chrome serves every mode. CSS in app.css owns the
        // positioning; we only build the shell + wire its children.
        if (editorEl)
        {
            editorAreaTopBarEl = document.createElement("div");
            editorAreaTopBarEl.className = "editor-area-top-bar";

            editorBarPagePrevBtn = /** @type {HTMLButtonElement} */ (
                document.createElement("button")
            );
            editorBarPagePrevBtn.type = "button";
            editorBarPagePrevBtn.className = "editor-bar-page-prev";
            editorBarPagePrevBtn.innerHTML = icon("arrow-left", { size: 16 });
            editorBarPagePrevBtn.addEventListener("click", () =>
            {
                if (editorBarPagePrevBtn?.disabled) return;
                paginationNavigate(-1);
            });

            editorBarPageNextBtn = /** @type {HTMLButtonElement} */ (
                document.createElement("button")
            );
            editorBarPageNextBtn.type = "button";
            editorBarPageNextBtn.className = "editor-bar-page-next";
            editorBarPageNextBtn.innerHTML = icon("arrow-right", { size: 16 });
            editorBarPageNextBtn.addEventListener("click", () =>
            {
                if (editorBarPageNextBtn?.disabled) return;
                paginationNavigate(1);
            });

            editorAreaTopBarEl.appendChild(editorBarPagePrevBtn);
            editorAreaTopBarEl.appendChild(editorBarPageNextBtn);

            // Fix Structural Issues — lucide wrench icon, sits right after
            // the page next chevron. Active only for mangaplay / fountain
            // formats (see mode-bridge above). Click rewrites the active
            // CM6 buffer via the pure source-text fixers in
            // ./structural-fixer.js. Disabled state refreshed via the
            // `window.__mpsRefreshFixIssuesBtn` window hook below.
            editorBarFixIssuesBtn = /** @type {HTMLButtonElement} */ (
                document.createElement("button")
            );
            editorBarFixIssuesBtn.type = "button";
            editorBarFixIssuesBtn.className = "editor-bar-fix-issues";
            editorBarFixIssuesBtn.innerHTML = icon("wrench", { size: 16 });
            editorBarFixIssuesBtn.addEventListener("click", () =>
            {
                if (editorBarFixIssuesBtn?.disabled) return;
                const slot = slotManager?.getActive();
                const view = slot?.view;
                if (!view) return;
                syncStructuralFixerConvention();
                const before = view.state.doc.toString();
                const after = fixIssues(slot.format, before);
                if (after === before) return;
                view.dispatch({
                    changes: { from: 0, to: view.state.doc.length, insert: after }
                });
            });
            editorAreaTopBarEl.appendChild(editorBarFixIssuesBtn);

            // Sync hook — mps-visual-editor calls this from its _render
            // wrapper after every AST round-trip so the disabled state of
            // the icon always reflects the current set of fixable issues.
            // Returns silently when no visual editor is mounted (text /
            // source mode), when the button hasn't been built yet, or
            // when the top bar is not in visual mode.
            window.__mpsRefreshFixIssuesBtn = () =>
            {
                if (!editorBarFixIssuesBtn) return;
                const slot = slotManager?.getActive();
                const view = slot?.view;
                const supported = slot
                    && (slot.format === "mangaplay" || slot.format === "fountain");
                if (!view || !supported)
                {
                    editorBarFixIssuesBtn.disabled = true;
                    editorBarFixIssuesBtn.removeAttribute("data-tooltip");
                    editorBarFixIssuesBtn.removeAttribute("aria-label");
                    return;
                }
                // Tooltip is also set in the applyEditorMode bridge, but
                // we re-stamp here so it survives a slot activation that
                // doesn't trigger a mode switch (e.g. opening a Fountain
                // file directly into its default mode).
                const fixLabel = t("ui.visualEditor.fixStructuralIssues",
                    "Fix Structural Issues");
                editorBarFixIssuesBtn.setAttribute("data-tooltip", fixLabel);
                editorBarFixIssuesBtn.setAttribute("data-tooltip-side", "bottom");
                editorBarFixIssuesBtn.setAttribute("aria-label", fixLabel);
                syncStructuralFixerConvention();
                const text = view.state.doc.toString();
                editorBarFixIssuesBtn.disabled = !hasFixableIssues(slot.format, text);
            };

            // SuperScript alpha warning pill. Visibility driven by the
            // `data-format` attribute on the top bar (set by syncFormatToTopBar
            // when the active slot changes). The element stays mounted so we
            // don't churn the DOM on every format flip.
            const superscriptWarningEl = document.createElement("span");
            superscriptWarningEl.className = "editor-bar-superscript-warning";
            superscriptWarningEl.textContent = t("mangaplay-studio.banner.superscriptAlpha")
                || "SuperScript is in alpha — expect bugs";
            editorAreaTopBarEl.appendChild(superscriptWarningEl);

            editorAreaTopBarEl.appendChild(modeToggleEl);

            // More Options button — opens a context menu (Rename, Show in
            // Explorer, Reveal Navigator, Delete File). Styled to match the
            // mode toggle button (same .mps-editor-mode-toggle-btn class) so
            // the two sit visually together.
            const moreOptionsBtn = /** @type {HTMLButtonElement} */ (
                document.createElement("button")
            );
            moreOptionsBtn.type = "button";
            moreOptionsBtn.id = "btn-editor-more-options";
            moreOptionsBtn.className = "mps-editor-mode-toggle-btn editor-bar-more-options";
            moreOptionsBtn.innerHTML = icon("ellipsis-vertical", { size: 18 });
            const moreOptionsLabel = t("mangaplay-studio.menu.editor.moreOptionsTooltip")
                || "More Options";
            moreOptionsBtn.setAttribute("aria-label", moreOptionsLabel);
            moreOptionsBtn.setAttribute("data-tooltip", moreOptionsLabel);
            moreOptionsBtn.setAttribute("data-tooltip-side", "left");
            moreOptionsBtn.addEventListener("click", () =>
            {
                openEditorMoreOptionsMenu(moreOptionsBtn);
                if (moreOptionsBtn) moreOptionsBtn.blur();
            });
            editorAreaTopBarEl.appendChild(moreOptionsBtn);

            editorEl.appendChild(editorAreaTopBarEl);

            // Reflect pagination state on the chevron buttons. Only honoured
            // when the active slot's format is `mangaplay` — other formats
            // keep the chevrons visible but disabled (gate enforced in the
            // applyEditorMode bridge above). Read `data-format` off the
            // editor-area top bar (stamped by syncFormatToTopBar) so we don't
            // need to re-resolve via slotManager on every page-state event.
            subscribePaginationState(({ pageIndex, totalPages }) =>
            {
                if (!editorBarPagePrevBtn || !editorBarPageNextBtn) return;
                if (editorAreaTopBarEl?.getAttribute("data-format") !== "mangaplay") return;
                editorBarPagePrevBtn.disabled = pageIndex <= 0;
                editorBarPageNextBtn.disabled = pageIndex >= totalPages - 1;
            });

            modeToggleEl.addEventListener("mps:mode-change", (ev) =>
            {
                const next = /** @type {any} */ (ev).detail?.mode;
                if (next) { void applyEditorMode(next); }
            });
            // Expose the closure to module-level helpers so format-driven
            // downgrades (applyAllowedModesForFormat) can re-route through
            // the same single switchboard.
            applyEditorModeRef = applyEditorMode;
            // Seed the initial mode (also reconfigures Compartments for
            // pre-existing slots, mounts Visual if needed).
            void applyEditorMode(editorMode);
            // Apply allowed-mode constraints + warning pill for the active
            // slot's format. onSlotActivated re-applies this whenever the
            // user switches tabs.
            try
            {
                const initialFormat = slotManager?.getActive()?.format
                    || /** @type {any} */ (formatForFilename(currentProject?.scriptBasename || ""));
                applyAllowedModesForFormat(initialFormat);
            }
            catch (e) { console.debug("[mode-init] allowed-modes seed failed:", e); }
        }
        // ────────────────────────────────────────────────────────────────────

        // Empty-tab CTA — overlay shown over the active slot when its path
        // is null (the "Create New file" placeholder). Handlers:
        //   onCreateStoryboard: create a new .mangaplay.md at the project
        //                       root, adopt it into the active empty tab,
        //                       switch the editor to Visual mode (one-shot,
        //                       does NOT persist the mode preference).
        //   onCreateScreenplay: same as above but creates a .fountain file
        //                       and switches to Text mode.
        //   onClose:            close the active empty tab; the slot
        //                       manager auto-spawns a fresh one.
        /**
         * Create + adopt + mode-switch helper.
         *
         * 1. createFile under project root (Rust picks next free Untitled name).
         * 2. replaceActiveTab — the canonical "swap the active tab to file X"
         *    helper. Handles broker re-anchor, mangaart cache swap, page-index
         *    restore, slot-switched dispatch, and explorer refresh in one go.
         *    Without this, the editor pane shows the new file but the
         *    right-pane storyboard stays anchored to the previous file's
         *    mangaart, and the explorer doesn't repaint its is-active marker.
         * 3. One-shot mode switch — persist:false so the user's global
         *    editorMode preference isn't overwritten.
         *
         * @param {"mangaplay"|"fountain"} kind
         * @param {"visual"|"text"} mode
         */
        async function ctaCreateAndAdopt(kind, mode)
        {
            if (!currentProject?.path || !slotManager) return;
            // parentForCreation honours the explorer's last-focused folder
            // (so the new file lands where the user is browsing), falling
            // back to <projectRoot>/project — which is where the v2 layout
            // expects scripts to live and where the explorer reads from.
            // Passing currentProject.path directly drops the file at the
            // PROJECT ROOT, outside the project/ subtree the explorer
            // walks; the file is created on disk but invisible in the UI.
            const parent = parentForCreation();
            if (!parent) return;
            let createdPath = "";
            try
            {
                await getBroker().withLock(async () =>
                {
                    createdPath = await createFile(parent, kind);
                    if (createdPath) markSelfChange(createdPath);
                });
            }
            catch (err)
            {
                const msg = String((err && /** @type {any} */ (err).message) || err);
                showBanner(t("mangaplay-studio.banner.createFailed", { error: msg }));
                return;
            }
            if (!createdPath) return;

            await replaceActiveTab(createdPath);
            await applyEditorMode(mode, { persist: false });
        }

        emptyTabCta = mountEmptyTabCta(
            /** @type {HTMLElement} */ (editorEl),
            {
                onCreateStoryboard: () => ctaCreateAndAdopt("mangaplay", "visual"),
                onCreateScreenplay: () => ctaCreateAndAdopt("fountain", "text"),
                onClose: async () =>
                {
                    const active = slotManager?.getActive();
                    if (active) await slotManager.close(active.tabId);
                }
            }
        );

        rightPaneEmpty = mountRightPaneEmpty();

        // Boot — restore prior tab snapshot if any. Each restored entry
        // either references a file path (read from disk; skipped on read
        // failure) or carries a null path (fresh "New tab" placeholder).
        // We honour the persisted tab id on each slot so activeTabId still
        // matches after restore. The slot manager uses an array (no Map
        // index), so directly patching `tabId` after openNew is safe — get()
        // walks the array.
        let bootRestored = false;
        let restoredInitialDoc = "";
        try
        {
            if (currentProject?.path)
            {
                const snap = await getTabSnapshot(currentProject.path);
                for (const entry of snap.openTabs)
                {
                    if (entry.path)
                    {
                        try
                        {
                            const text = (await readFile(entry.path)) ?? "";
                            const base = basename(entry.path);
                            slotManager.openNew(
                                entry.path,
                                text,
                                /** @type {any} */ (formatForFilename(base))
                            );
                            const newest = slotManager.list().at(-1);
                            if (newest) newest.tabId = entry.id;
                        }
                        catch (e)
                        {
                            console.warn(`[session] tab ${entry.path} failed to restore:`,
                                /** @type {any} */ (e)?.message || e);
                        }
                    }
                    else
                    {
                        slotManager.openNew(null, "", /** @type {any} */ ("general-text"));
                        const newest = slotManager.list().at(-1);
                        if (newest) newest.tabId = entry.id;
                    }
                }
                if (slotManager.list().length > 0)
                {
                    bootRestored = true;
                    const target = snap.activeTabId && slotManager.get(snap.activeTabId)
                        ? snap.activeTabId
                        : slotManager.list()[0].tabId;
                    slotManager.activate(target);
                    const active = slotManager.getActive();
                    if (active)
                    {
                        try { restoredInitialDoc = active.view.state.doc.toString(); }
                        catch (_e) { restoredInitialDoc = ""; }
                    }
                }
            }
        }
        catch (e)
        {
            console.warn("[session] restore failed:", /** @type {any} */ (e)?.message || e);
        }

        // Fallback when nothing restored — open the project's main script,
        // or a scratch tab when no project script is set (locked decision
        // #10 — the strip is never empty).
        const initialDoc = bootRestored ? restoredInitialDoc : (currentProject?.script || "");
        if (!bootRestored)
        {
            const initialPath = currentProject?.scriptPath || null;
            if (initialPath)
            {
                slotManager.openNew(
                    initialPath,
                    initialDoc,
                    /** @type {any} */ (formatForFilename(currentProject?.scriptBasename || ""))
                );
            }
            else
            {
                slotManager.openNew(
                    null,
                    "",
                    /** @type {any} */ ("general-text")
                );
            }
        }
        currentDoc = initialDoc;
        // Seed RuntimeStorage so the canvas mounts with parsed pages instead
        // of waiting for the first keystroke.
        publishParsedScript(initialDoc);
    }

    if (canvasEl) {
        const debouncedMangaartSave = (pageId) =>
        {
            if (!currentProject) return;
            const key = String(pageId ?? "_all");
            // Payload is the mangaart cache itself — we don't snapshot here
            // because saveMangaart re-reads the live cache. Pass the cache
            // reference so the broker can drain without re-querying.
            broker.scheduleMangaartSave(key, getMangaartCache(), async () =>
            {
                try
                {
                    setSaveState("saving");
                    await saveMangaart(currentProject.path, currentProject.scriptBasename);
                    setSaveState("saved");
                    if (saveFailureBannerShown) saveFailureBannerShown = false;
                }
                catch (e)
                {
                    console.error("Failed to save mangaart:", e);
                    setSaveState("dirty");
                    if (!saveFailureBannerShown)
                    {
                        const reason = (e && /** @type {any} */ (e).message) ? /** @type {any} */ (e).message : String(e);
                        showBanner(t("mangaplay-studio.banner.saveFailed", { reason }));
                        saveFailureBannerShown = true;
                    }
                }
            });
        };

        /** @type {any} */
        (globalThis).__MPS_DESKTOP__ =
        {
            // Per-file slot id so RuntimeDrawingCache, PersistentStorage
            // pending-sync buffer, and IDB drawing-store all key drawings
            // by the SCRIPT they belong to. Previously this returned only
            // `currentProject.path`, so all files in a project shared one
            // slot — swapping files left the previous file's strokes in
            // the cache, leaking them onto the new file's storyboard. The
            // basename suffix scopes the key per active script.
            getActiveSlotId: () => {
                if (!currentProject?.path) return null;
                const base = currentProject.scriptBasename || "";
                return base ? `${currentProject.path}::${base}` : currentProject.path;
            },
            getMangaart: () => getMangaartCache(),
            updatePage: (pageIndex, drawing) => updateMangaartPage(pageIndex, drawing),
            queueSave: (pageId) => debouncedMangaartSave(pageId),
            // Test hook — lets driver smoke tests exercise the same
            // switchProject code path the project-switcher dropdown uses,
            // without needing to drive the popup menu UI from CDP.
            switchProject: (path) => switchProject(path),
            currentProjectPath: () => currentProject?.path || null,
        };

        canvasApi = await initCanvas(canvasEl, {
            onSave: (pageIndex, drawing) =>
            {
                if (!currentProject) return;
                updateMangaartPage(pageIndex, drawing);
                setSaveState("dirty");
                debouncedMangaartSave(pageIndex);
            },
        });
        // Seed the canvas with the current doc so its pageCount matches
        // the initial state without waiting for the first keystroke.
        if (canvasApi && typeof canvasApi.setScript === "function") {
            canvasApi.setScript(currentDoc);
        }

        // Defer two frames so the slider has finished its initial layout, then
        // force the website canvas to re-fit. Without this, the engine attaches
        // pointer listeners to a 0×0 .drawing-canvas before the slider's initial
        // translateX transition has resolved, and draw input never registers.
        requestAnimationFrame(() =>
        {
            requestAnimationFrame(() =>
            {
                const c = document.querySelector("mps-canvas");
                if (c && typeof c.fitToContainer === "function")
                {
                    try { c.fitToContainer(true); } catch {}
                }
                if (c && typeof c.resizeDrawingCanvas === "function")
                {
                    try { c.resizeDrawingCanvas(); } catch {}
                }
                // Nudge the active tool so applyDrawingTool re-binds the pencil.
                document.dispatchEvent(new CustomEvent("paint-tool-change", { detail: { tool: "pencil" } }));
            });
        });
    }

    // Apply initial view mode from app settings (shell layout is app-wide).
    const __shellSettings = globalThis.__MPS_APP_SETTINGS__ || {};
    if (__shellSettings.viewMode) {
        setViewMode(__shellSettings.viewMode);
        if (__shellSettings.lastSoloMode) {
            lastSoloMode = __shellSettings.lastSoloMode;
        }
    }
    if (currentProject?.meta?.printPreview) {
        const sp = document.querySelector("mps-screenplay");
        if (sp) sp.setAttribute("data-screenplay-mode", "paginated");
    }

    // Per-project sidebar relocation — `mps-canvas` re-creates its child
    // <mps-quick-toggle-sidebar> on each project mount.
    wireQuickToggleRelocation();

    // Per-project meta restore (shell DOM has already been wired once by
    // `wireShellOnce()` at boot).
    restoreShellMeta();
    refreshProjectSwitcher();
    updateEmptyState();

    // ── App Footer + Google Docs sync gear (Phase 3+) ───────────────────
    // The App Footer is the 200×30 bottom-right panel owning the mode
    // button, word / char counts, and the Google Docs sync gear. It's
    // built once per app lifetime; project switches just call
    // setMode / recountNow / setSyncState on the same controller.
    //
    // mountGoogleDocsFooter no longer creates its own DOM — it accepts the
    // gear-controller adapter below so the SyncStateMachine drives the
    // shared App Footer instead of a separate full-width bar.
    try
    {
        const footerHost = /** @type {HTMLElement|null} */ (
            document.getElementById("app-footer"));
        if (footerHost && !appFooter)
        {
            appFooter = mountAppFooter({
                host: footerHost,
                getActiveSlot: () => slotManager?.getActive() || null,
                applyEditorMode: (mode) =>
                {
                    // Re-route through whatever applyEditorMode closure the
                    // current project mount installed (matches the top-bar
                    // toggle's path). Bridge ref because the closure is
                    // captured per-mount.
                    if (applyEditorModeRef) return applyEditorModeRef(mode);
                },
                getEditorMode: () =>
                {
                    // Read the live attribute on modeToggleEl — the single
                    // source of truth post-applyEditorMode. Falls back to
                    // "text" on cold boot before applyEditorMode runs.
                    return /** @type {any} */ (
                        modeToggleEl?.getAttribute("mode") || "text");
                },
                getDocumentText: () =>
                {
                    // Visual mode reads the AST in RuntimeStorage; serialise
                    // before counting. Text / Source read the active CM
                    // slot via the manager's getActiveSlot bridge.
                    try
                    {
                        const mode = modeToggleEl?.getAttribute("mode");
                        if (mode === "visual")
                        {
                            const script = getRuntimeStorage().state?.script;
                            if (typeof script === "string") return script;
                            if (script && typeof script === "object")
                            {
                                return visualFormatScript(/** @type {any} */ (script));
                            }
                            return "";
                        }
                    }
                    catch (e) { console.debug("[app-footer] visual read threw:", e); }
                    const slot = slotManager?.getActive();
                    return slot?.view?.state?.doc?.toString?.() || "";
                }
            });
            // Wire the gear's click to the bootstrap handler that opens the
            // publish modal (when unsynced) or the sync popover.
            appFooter.setGearClickHandler(getGoogleDocsGearClickHandler());
            appFooter.show();
        }

        if (appFooter)
        {
            // Mount the Google Docs sync state-machine bootstrap against the
            // App Footer's gear controller. Adapter exposes the four mutators
            // bootstrap needs (setSyncState / setLockState / show / hide /
            // getAnchorEl / setFilename).
            mountGoogleDocsFooter({
                setSyncState: (state) => appFooter?.setSyncState(state),
                setLockState: (state) => appFooter?.setLockState(state),
                show: () => appFooter?.show(),
                hide: () => { /* keep footer visible even when no GDoc */ },
                getAnchorEl: () => /** @type {HTMLElement} */ (appFooter?.gearEl),
                setFilename: (_name) => { /* shown in the sync popover header */ }
            }, {
                getAuthToken: async () =>
                {
                    try { return await getAccessToken({ allowRefresh: true }); }
                    catch (_) { return null; }
                },
                getUserProfile: () =>
                {
                    const p = getCurrentProfile();
                    return { name: p?.name || p?.email || null };
                },
                getClientId: () => getOrCreateClientId(),
                getScriptContext: () =>
                {
                    const slot = slotManager?.getActive();
                    return {
                        format: slot?.format || "text",
                        sourceText: slot?.view?.state?.doc?.toString?.() || ""
                    };
                }
            });

            // Seed the mode icon + counts now that the footer is mounted.
            try
            {
                const initialMode = /** @type {any} */ (
                    modeToggleEl?.getAttribute("mode") || "text");
                appFooter.setMode(initialMode);
            }
            catch (e) { console.debug("[app-footer] initial setMode threw:", e); }
            try { appFooter.recountNow(); }
            catch (e) { console.debug("[app-footer] initial recount threw:", e); }
        }
    }
    catch (err) { console.warn("[app-footer] mount failed:", err); }
}

/**
 * Wire every static-shell listener exactly once per app lifetime. Called from
 * `boot()` before either the auto-resume or picker branch diverges. MUST NOT
 * be called again on project switches — re-wiring stacks pointer/click/event
 * handlers on the static DOM and produces "snappy / multi-jump drags",
 * N-times page-index jumps, etc.
 */
async function wireShellOnce()
{
    if (shellWired) return;
    shellWired = true;

    // One-shot boot pass: replace every <span data-icon="…"> inside #app-chrome
    // with inline SVG. Scoped so the loading/start screens are untouched.
    for (const el of document.querySelectorAll("#app-chrome [data-icon]"))
    {
        el.outerHTML = icon(el.dataset.icon, { size: 16, class: "icon" });
    }

    // Mount the mobile / tablet bottom tabbar. Lazy-import so standalone
    // builds Phase-2-DCE drop the component module. Idempotent — the
    // component constructor guards on isMobileLike().
    if (isMobileLike())
    {
        try
        {
            await import("./components/mps-mobile-tabbar.js");
            if (!document.querySelector("mps-mobile-tabbar"))
            {
                const tabbar = document.createElement("mps-mobile-tabbar");
                tabbar.id = "mps-mobile-tabbar";
                document.body.appendChild(tabbar);
            }
        }
        catch (e) { console.warn("[wireShellOnce] tabbar mount failed:", e); }
    }

    // Tooltip system — registers a single delegated handler for [data-tooltip] elements.
    wireDeclarativeTooltips();

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
    wireHelpButton();
    wireHomeButton();
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
        replaceActiveTab(row.dataset.path).catch((e) =>
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
    let candidate = `${userDataDir}/MyFirstProject`;
    if (opts.forceNew || (await pathExists(candidate)))
    {
        let n = 2;
        // 9999 cap mirrors the pathological fallback in fs_helpers.rs.
        while ((await pathExists(`${userDataDir}/MyFirstProject (${n})`)) && n < 9999) n++;
        candidate = `${userDataDir}/MyFirstProject (${n})`;
    }
    // Strip the parent prefix to get just the name for project_create_new.
    const name = candidate.substring(userDataDir.length + 1);
    const path = await createNewProject(userDataDir, name);
    await saveUserSettings({ lastProjectPath: path });
    return path;
}

// ── Boot sequence ──
async function boot() {
    try {
        // Single capture-phase contextmenu router. Owns BOTH suppressing the
        // native WebView2/WKWebView menu AND showing our custom menu. One
        // listener instead of guard+consumer to avoid the Chromium quirk
        // where preventDefault on contextmenu halts DOM propagation past the
        // suppressor — local listeners below the guard never fire.
        document.addEventListener("contextmenu", (e) =>
        {
            const result = routeContextMenu(e.target);
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

        // Fetch app-wide settings AND apply colorScheme BEFORE the chrome
        // unhides (FOUC prevention). loadingScreen + chrome both honour
        // [data-theme], so this needs to happen before either paints.
        const appSettings = await loadAppSettings();
        applyColorScheme(appSettings.colorScheme);
        applyScreenplayFont(appSettings.screenplayFont);
        applyEditorFont(appSettings.editorFont);

        // If app_settings stored an explicit language, it wins over the
        // OS-locale auto-detect from initI18n() above.
        if (appSettings.language)
        {
            const { setLanguage } = await import("./adapters/tauri-i18n.js");
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
            recentProjects = await loadRecent();
        } catch {
            recentProjects = [];
        }

        // Warm the user-settings cache so downstream code can read
        // defaultLanguage / lastProjectPath / lastSettingsTab synchronously.
        // Tolerant of failure: the wrapper falls back to defaults so the
        // boot path keeps working even if the Rust command misbehaves.
        try { await loadUserSettings(); }
        catch (e) { console.debug("loadUserSettings failed:", e); }
        markBench("userSettingsLoaded");

        // Fire-and-forget Google OAuth rehydrate. Boot must NOT block on
        // Google reachability — ensureRehydrated() reads the local keyring
        // + user-settings cache and only fires a silent refresh in the
        // background if the cached token is expired.
        try
        {
            const { ensureRehydrated } = await import("./auth/google-oauth.js");
            ensureRehydrated().catch((e) => { console.debug("auth rehydrate failed:", e); });
        }
        catch (e) { console.debug("auth import failed:", e); }

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
                    const { resolveTier } = await import("./spellcheck-tier.js");
                    const cfg = resolveTier(seeded);
                    if (cfg.tier === "A")
                    {
                        const { warmupHarper } = await import("./harper-linter.js");
                        warmupHarper(cfg.dialect);
                    }
                }
                catch (e) { console.debug("Harper warmup skipped:", e); }
            }
        }
        catch (e) { console.debug("ensureSpellcheckSeed failed:", e); }

        // Run the placeholder boot substages — IAP / Analytics / Account.
        // Empty bodies today; future plans replace the helper bodies in
        // src/boot-placeholders.js without changing the FSM shape or
        // call-site count.
        await initIap();
        await initAnalytics();
        await initAccount();

        // Pre-warm pdf-lib so the first PDF export doesn't have to download the
        // ~400KB chunk inline, and (more importantly) so every export consumer
        // shares ONE pdf-lib instance — multiple dynamic-import sites would
        // otherwise each get their own copy, which fails with
        // "Cannot assign to read only property 'toString'" on PDFHeader.
        import("@mangaplay-studio/core/export").then(m => m.preloadPdfLib()).catch(() => {});

        let chosenPath = "";
        /** @type {any} */
        let shell = null;

        if (isMobileLike())
        {
            // Mobile / tablet UX: never show the picker. Auto-open the
            // user's last project if it's still there, else auto-create
            // a "MyFirstProject" inside the user-data dir.
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
            // Standalone UX: dynamic-import the picker-shell only here so
            // mobile/tablet builds can Phase-2-DCE drop it. Also create
            // the `<mps-picker-shell>` element at runtime — index.html
            // no longer hardcodes it.
            await import("./components/mps-picker-shell.js");
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
            const topRecent = recentProjects[0];
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
                if (shell)
                {
                    shell.setOpening(topRecent.resolvedName || topRecent.name || chosenPath, 0.1);
                    shell.setPhase("opening");
                }
                setAppState("start-screen"); // paint briefly; opening-project transition follows
            }
            else
            {
                if (recentProjects.length > 0) {
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
                    setAppState(recentProjects.length > 0 ? "start-screen" : "empty");
                    return;
                }
            }
        }

        // Transition shell to the opening card (cross-fades on the same surface).
        if (shell && chosenPath)
        {
            const topName = (recentProjects.find((r) => r.path === chosenPath)?.resolvedName)
                || basename(chosenPath)
                || chosenPath;
            shell.setOpening(t("mangaplay-studio.boot.opening.openingNamed", { name: topName }), 0.2);
            shell.setPhase("opening");
        }

        setAppState("opening-project");
        const bumpProgress = (v, msg) =>
        {
            if (shell)
            {
                shell.setOpening(msg || t("mangaplay-studio.boot.opening.openingNamed", { name: (basename(chosenPath) || chosenPath) }), v);
            }
        };

        try {
            bumpProgress(0.35, t("mangaplay-studio.boot.opening.readingProject"));
            try
            {
                currentProject = await openProject(chosenPath);
            }
            catch (openErr)
            {
                // Review item #5: corrupted project.json on mobile has no
                // picker to fall back to. Re-create the default project
                // with a numbered suffix and retry once. Standalone path
                // re-throws to fall through to the existing showError +
                // picker recovery.
                if (isMobileLike())
                {
                    console.warn("[boot] openProject failed in mobile mode, re-creating:", openErr);
                    chosenPath = await ensureMobileDefaultProject({ forceNew: true });
                    await saveUserSettings({ lastProjectPath: chosenPath }).catch(() => {});
                    currentProject = await openProject(chosenPath);
                }
                else
                {
                    throw openErr;
                }
            }
            // Expose project dir to editor extensions (page-fold persistence).
            /** @type {any} */ (window).__mpsCurrentProjectDir = currentProject?.path || null;
            // Start the FS watcher for the new project root so external
            // edits flow through project-fs-changed.
            try
            {
                if (isTauri() && currentProject?.path)
                {
                    await invoke("fs_watch_start", { path: currentProject.path });
                }
            }
            catch (e) { console.warn("[fs_watch_start] failed:", e); }
            bumpProgress(0.55, t("mangaplay-studio.boot.opening.scanningScripts"));
            try { await mountFolderExplorer(); }
            catch (e) { console.debug("folder list mount failed:", e); }
            bumpProgress(0.7, t("mangaplay-studio.boot.opening.loadingArtwork"));
            try
            {
                await loadMangaart(currentProject.path, currentProject.scriptBasename);
            }
            catch (e)
            {
                console.error("loadMangaart failed:", e);
            }
            // Record in recent.json. Non-fatal on error.
            await updateRecent(chosenPath).catch(() => {});
            // Stamp lastProjectPath in user-settings.json so a future
            // start-screen-bypass enhancement can consult it directly.
            // The existing autoResume path still owns the open-the-most-
            // recent behaviour for now.
            await saveUserSettings({ lastProjectPath: chosenPath }).catch(() => {});
        } catch (err) {
            console.error("openProject failed:", err);
            showError(err instanceof Error ? err.message : String(err), "permissions.doc_access_revoked");
            return;
        }

        {
            // One-time seed: if appSettings has no value for a shell field but the
            // project's meta.json does, copy it over so existing users don't see a
            // reset on first launch after this change.
            const meta = currentProject?.meta || {};
            const seed = {};
            const SHELL_FIELDS = [
                "leftPaneWidth", "storyboardWidth",
                "leftPaneCollapsed", "storyboardCollapsed",
                "viewMode", "lastSoloMode", "activeSubview",
            ];
            for (const k of SHELL_FIELDS)
            {
                const current = appSettings[k];
                const isUnset =
                    (k === "leftPaneWidth" || k === "storyboardWidth") ? current === null :
                    (k === "leftPaneCollapsed" || k === "storyboardCollapsed") ? current === false :
                    (k === "viewMode") ? current === "dual" :
                    (k === "lastSoloMode") ? current === "solo-storyboard" :
                    (k === "activeSubview") ? current === "folder" :
                    false;
                if (isUnset && meta[k] !== undefined)
                {
                    seed[k] = meta[k];
                    appSettings[k] = meta[k];
                }
            }
            if (Object.keys(seed).length > 0)
            {
                queueAppSettingsSave(seed);
            }

            const restored = applyMetaBeforeFirstPaint(currentProject.meta, { settings: appSettings });
            if (restored.viewMode) viewMode = /** @type {any} */ (restored.viewMode);
            if (restored.lastSoloMode) lastSoloMode = restored.lastSoloMode;
        }

        // Wire the static-shell DOM exactly once per app lifetime, BEFORE the
        // per-project mount. Idempotent — `shellWired` guards re-entry — but
        // we still funnel the call through here (not inside mountProjectViews)
        // so the "wire once" intent is visible at the call site.
        await wireShellOnce();

        // Mount views
        setAppState("mounting-views");
        bumpProgress(0.9, t("mangaplay-studio.boot.opening.mountingViews"));
        await mountProjectViews();

        // Tell the broker which script is now active so its autosave queue
        // belongs to this path.
        try { getBroker().setActive(currentProject?.scriptPath ?? null); }
        catch (e) { console.warn("[boot] broker.setActive failed:", e); }

        // Ready
        bumpProgress(1.0, t("mangaplay-studio.boot.opening.ready"));
        setAppState("ready");
        setSaveState("saved");

        // Multi-window listener — Tauri only. Fires whenever any window in
        // this app mutates the project FS. The other window's broker either
        // adopts the rename, drops state on a delete, or just refreshes.
        wireProjectFsChangedListener();

        // Fade out the picker shell so the workspace underneath is visible.
        if (shell)
        {
            shell.classList.add("fade-out");
            setTimeout(() => { try { shell.setPhase("bootstrap"); shell.classList.remove("fade-out"); shell.style.display = "none"; } catch {} }, 360);
        }

        // Smoke-test sentinel — read by Binary-Smoke-Testing-Plan.md
        // tests/binary/webview-ready.js. Asserts the bundle actually
        // executed and the FSM reached ready. Don't remove.
        // @ts-ignore
        window.__APP_BOOTED = { at: new Date().toISOString(), state: "ready" };

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
            const w = isTauri() ? getCurrentWindow() : null;
            if (w) await w.close();
        });

    } catch (err) {
        console.error("Boot failed:", err);
        showError(err instanceof Error ? err.message : "Boot sequence failed");
    }
}

/** Tracks whether a shutdown is already in progress to prevent double-invocation. */
let shutdownInFlight = false;

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
async function flushCurrentProjectMeta()
{
    // Drain all broker-queued writes (script + meta + mangaart) in one Promise.all.
    // This is the source of truth for "pending writes are durable" — bypassing it
    // (as the previous direct saveScript/saveMeta path did) drops queued mangaart
    // strokes on swap and shutdown.
    try { await getBroker().drainAllPending(); }
    catch (e) { console.error("flush: drainAllPending failed:", e); }

    // App-wide settings are NOT broker-owned; flush them separately.
    try { await flushAppSettings(); }
    catch (e) { console.error("flush: flushAppSettings failed:", e); }
}

/**
 * Destroy the current project's editor views (slot manager + editor tabs +
 * screenplay view). Pure teardown — does not save. Pair with
 * `flushCurrentProjectMeta()` for the full shutdown half.
 */
function destroyCurrentProjectViews()
{
    // Google Docs footer owns its own state machine + DOM — tear them down
    // first so the project's slotManager teardown doesn't race the footer's
    // setActiveScript(null) call.
    try { destroyGoogleDocsFooter(); }
    catch (e) { console.warn("[google-docs] destroyGoogleDocsFooter threw:", e); }

    if (slotManager)
    {
        for (const slot of slotManager.list())
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
        slotManager = null;
    }
    try { editorTabs?.destroy(); } catch {}
    editorTabs = null;
    // emptyTabCta mounts a fresh .empty-tab-cta overlay into <mps-editor-host>
    // on every mount; without explicit teardown the overlays stack.
    if (emptyTabCta) { try { emptyTabCta.destroy(); } catch {} emptyTabCta = null; }
    // rightPaneEmpty owns an i18n subscription; release it before re-mount.
    if (rightPaneEmpty) { try { rightPaneEmpty.destroy(); } catch {} rightPaneEmpty = null; }
    // initCanvas attaches a document-level `drawing-save-complete` listener
    // and tracks the host element via a module-level ref; destroy() removes
    // the listener and clears the ref so the next mount starts clean.
    if (canvasApi) { try { canvasApi.destroy?.(); } catch {} canvasApi = null; }
    // mountProjectViews appends a fresh <mps-editor-mode-toggle> to the
    // editor host every mount; without removal the toggles stack on top of
    // each other (visible as a thicker pill after each project switch).
    if (modeToggleEl)
    {
        try { modeToggleEl.parentNode?.removeChild(modeToggleEl); } catch {}
        modeToggleEl = null;
    }
    // The bridge to the project-scoped applyEditorMode closure dies with the
    // mount it captured — clear it so format-driven downgrades don't reach
    // into a torn-down view between project swaps.
    applyEditorModeRef = null;
    editorAreaTopBarEl = null;
    // When the user was in Visual mode, applyEditorMode lazily appended a
    // <mps-visual-editor> to <mps-editor-host>. Without removal here, the
    // next project's first switch into Visual mode appends ANOTHER one (the
    // module-level ref is dropped on the next mount path that overwrites
    // it, but the orphan DOM stays and renders the previous project's
    // pages stacked above the new one).
    if (visualEditorEl)
    {
        try { visualEditorEl.parentNode?.removeChild(visualEditorEl); } catch {}
        visualEditorEl = null;
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
async function flushAndShutdown(wnd) {
    if (shutdownInFlight) return; // re-entrant safety
    shutdownInFlight = true;

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
        const { disposeHarper } = await import("./harper-linter.js");
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

// ── Start ──
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
} else {
    boot();
}
