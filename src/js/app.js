console.log("[boot:app] app.js module top-level executing");
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
import { isTauri } from "./util/index.js";
import { isMobileLike } from "./boot/ux-mode.js";
import { isEasyEditorEnabled } from "./boot/editor-features.js";

// Side-import — registers customElements.define('mps-screenplay', MPSScreenplay).
// The website component reads from RuntimeStorage; no imperative driver needed.
import "../../../websites/mangaplay.studio/src/components/mps-screenplay.js";
import { openProject, updateRecent, createUntitled, setTabSnapshot, migrateLegacySyncEntries, listProjectTree, getFolderType } from "./project/project.js";
import { getBroker } from "./project/active-script-broker.js";
import {
    setMangaplayTargetConvention,
} from "./editor/structural-fixer.js";
import {
    PersistentStorage as _StructuralFixerStorage,
    STORAGE_KEYS as _StructuralFixerKeys,
    slidesLinkGet,
} from "./adapters/tauri-storage.js";

/**
 * Read the user's preferred indent convention from manga_settings and
 * push it into the fixer module. Called from both the click handler and
 * the disabled-state refresh hook so the setting takes effect immediately
 * after the user changes it without needing a relaunch.
 */
export function syncStructuralFixerConvention()
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
// Static imports (not dynamic import()) — macOS WKWebView is strict about
// dynamic module fetches; keeping these top-level lets us expose the raw
// Docs/Drive primitives on window.__mpsGoogleDebug.docs for the CDP-driven
// diagnostic (tests/driver/diagnose-collab-flow.js) without any runtime
// import().
import {
    documentsCreate as _docsCreate,
    documentsGet as _docsGet,
    documentsBatchUpdate as _docsBatchUpdate,
    filesUpdate as _filesUpdate,
    filesGet as _filesGet
} from "../../../core/google-docs/index.js";
import { formatForFilename } from "./editor/lang-registry.js";
import { getActiveAggregate } from "./editor/aggregate-view.js";
import { getRuntimeStorage } from "@mangaplay-studio/core/state";
import {
    LEFT_PANE_MIN,
    LEFT_PANE_MAX,
    STORYBOARD_MIN,
    EDITOR_MIN,
    clampOrNull,
} from "./boot/shell-restore.js";
import {
    setActiveScript as setGoogleDocsActiveScript,
    notifyEdit as notifyGoogleDocsEdit,
} from "./google-docs-sync/footer-bootstrap.js";
// Always-hit boot path: `onAuthChanged` / `ensureRehydrated` were previously
// pulled via `await import()` at wireRailAccount + boot. Static import here so
// mobile doesn't pay a chunk fetch on every launch.
import { getAccessToken, getCurrentProfile, onAuthChanged, ensureRehydrated } from "./auth/google-oauth.js";
import { uuid as generateUuid } from "./google-docs-sync/uuid.js";
import { saveUserSettings, getUserSetting } from "./project/user-settings.js";
import { basename } from "./util/index.js";
import { t } from "./adapters/tauri-i18n.js";
// Side-effect imports: register web components.
import "./components/mps-lang-select.js";
// `mps-picker-shell` is lazy-imported inside the standalone branch of boot()
// so DCE can drop the picker bundle from mobile builds. The picker-shell DOM
// element is NOT in index.html; standalone boot() creates it via
// document.createElement after the dynamic import resolves.
// Register `<mps-easy-editor>` and the three-state mode toggle. Both are
// side-effect imports — the files self-register via `customElements.define`.
import "./components/mps-easy-editor.js";
import "./components/mps-editor-mode-toggle.js";
import "./components/mps-find-widget.js";
import { installFindShortcut } from "./shell/find-controller.js";

import { applySubview } from "./shell/subviews.js";
import { renderStartScreen } from "./shell/start-screen.js";
import { state } from "./shell/state.js";
import {
    syncNarrowTopbar,
    applyStoryboardCollapseState,
    applyLeftPaneCollapsedState,
} from "./shell/layout.js";
import {
    getPaginationState,
} from "./shell/topbar-pagination.js";
import {
    mountFolderExplorer,
} from "./shell/explorer.js";
import { mountProjectViews } from "./shell/mount-project-views.js";
import { boot } from "./shell/boot.js";

/** @type {string|null} */
let _cachedClientId = null;

/**
 * Per-install UUID stored in user-settings.json. Used as `mpsClientId` on
 * Google Docs sync locks so concurrent writers can be distinguished.
 * @returns {string}
 */
export function getOrCreateClientId()
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
        shellState: state,
    };
    // Diagnostic-only — exposes Google auth + Drive primitives so the CDP
    // harness can poke a live signed-in session without rebuilding. Safe
    // because all calls require the user's own access token; no scope
    // escalation. Remove when no longer needed for diagnosis.
    window.__mpsGoogleDebug = { getAccessToken, getCurrentProfile };
    // Re-export the raw Drive + Docs primitives so a CDP harness (e.g.
    // tests/driver/diagnose-collab-flow.js) can drive them directly.
    // Uses the top-level static imports above — no runtime import() —
    // because macOS WKWebView is strict about dynamic module fetches and
    // a CDP `import(...)` string cannot resolve `../../core/...` against
    // the document URL either.
    window.__mpsGoogleDebug.docs = {
        documentsCreate:      _docsCreate,
        documentsGet:         _docsGet,
        documentsBatchUpdate: _docsBatchUpdate,
        filesUpdate:          _filesUpdate,
        filesGet:             _filesGet,
    };
    // Diagnostic: re-export everything the update flow touches so a CDP
    // harness can run an actual push without driving the footer button.
    // Gated behind the compile-time `__MPS_DIAGNOSTICS__` define — dev
    // builds substitute `true` and ship the block; release builds
    // substitute `false` and the minifier DCEs the entire assignment
    // (including the three dynamic imports and their transitive graph)
    // out of the mobile / production bundle. See
    // @ts-ignore __MPS_DIAGNOSTICS__ injected by build-bundle.js define
    if (__MPS_DIAGNOSTICS__) {
    window.__mpsGoogleDebug.runDiagPush = async (opts) => {
        const { push } = await import("./google-docs-sync/push-pull.js");
        const { evaluateLockState, liftRestriction } = await import("./google-docs-sync/lock-engine.js");
        const { filesGet } = await import("../../../core/google-docs/index.js");
        const profile = getCurrentProfile();
        const token = await getAccessToken({ allowRefresh: true });
        const meta = await filesGet({ token, fileId: opts.docId, fields: "appProperties,headRevisionId" });
        const appProps = (meta && meta.appProperties) || {};
        const lockState = evaluateLockState({ appProperties: appProps, ourLockToken: opts.ourLockToken, ourSub: profile.sub });
        console.log("[diag-runtime] lockState =", lockState, "appProps =", appProps);
        const hasOwnLock = lockState === "locked-by-me";
        console.log("[diag-runtime] hasOwnLock =", hasOwnLock);
        if (!hasOwnLock) {
            return { skipped: true, reason: "no own lock; would not lift", lockState };
        }
        try {
            const result = await push({
                token,
                docId: opts.docId,
                format: opts.format,
                localSourceText: opts.sourceText,
                expectedRevisionId: opts.expectedRevisionId || null,
                localPath: opts.localPath,
                rootTabId: opts.rootTabId,
                screenplayTabId: opts.screenplayTabId || null,
                hasOwnLock: true,
                userName: profile.name || ""
            });
            return { ok: true, newRevisionId: result.newRevisionId, lockState };
        } catch (e) {
            return { ok: false, name: e.name, message: e.message, lockState };
        }
    };
    }
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

// Ctrl/Cmd+F opens the in-editor Find widget. Installed at module top so the
// capture-phase listener beats WebView2's native find popup.
installFindShortcut();

// export-screenplay-modal pulls in @mangaplay-studio/core/export (jszip,
// pdf-lib font resolvers, etc.). Lazy-imported on first menu open so the
// boot chunk stays free of export-only deps. Cached as a module-level
// promise so repeat opens reuse the chunk.
/** @type {Promise<typeof import("./modals/export-screenplay-modal.js")>|null} */
let exportScreenplayModalPromise = null;
export async function openExportScreenplayModal(opts)
{
    if (isMobileLike()) return;
    if (!exportScreenplayModalPromise)
    {
        exportScreenplayModalPromise = import("./modals/export-screenplay-modal.js");
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
let bootStartedAt = performance.now();
const MIN_DISPLAY_MS = 400;

// Benchmark instrumentation — populated by markBench() at key boot/init points.
// Read by tests/driver/benchmark-smoke.js via Runtime.evaluate. No-op outside
// dev tests (the ledger is tiny and writes are O(1)).
//
// Merges any pre-existing __mpsBenchmark set by the inline boot script in
// index.html (e.g. `firstPaintAt`) so early markers survive this
// reassignment.
/** @type {Record<string, number>} */
const bench = { bootStartedAt, .../** @type {any} */ (window).__mpsBenchmark || {} };
/** @type {any} */ (window).__mpsBenchmark = bench;
export function markBench(label) { bench[label] = performance.now(); }
markBench("scriptParsed");

/**
 * True when `format` has a screenplay surface (mangaplay / fountain /
 * superscript). Plain text and binary .sup don't.
 * @param {import("./editor/lang-registry.js").EditorFormat} format
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
    if (!state.rightPaneEmpty) return;
    const noDoc = state.activeSlotIsPlaceholder === true;
    let noScreenplay = false;
    let unsupportedScreenplayForFormat = false;
    if (!noDoc)
    {
        // Plain text / binary .sup have no screenplay surface — show a
        // dedicated message when the user is on the screenplay side of the
        // slider for one of these formats.
        unsupportedScreenplayForFormat = !formatSupportsScreenplay(state.activeFormat);
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
    state.rightPaneEmpty.update({ noDoc, noScreenplay, unsupportedScreenplayForFormat });
}

/**
 * Backward-compat accessor: returns the active slot's CodeMirror view, or
 * null when no slot is active. Replaces the old module-level `editorView`.
 * @returns {import("@codemirror/view").EditorView | null}
 */
function getActiveView()
{
    return state.slotManager?.getActive()?.view ?? null;
}

// Debug-only global so the CDP driver tests can inspect the active CM view
// (cursor line, doc length, scroll). The hot path doesn't read this — it's a
// pure debugging hook. The getter is updated lazily because slotManager
// initialises after this module-level block runs.
/** @type {any} */ (window).__mpsActiveView = () => getActiveView();

/** Cached current document text — single source for screenplay/canvas/save fan-out. */
export let currentDoc = "";
/** Setter used by shell modules (explorer.js clearEditorAfterActiveDelete). */
export function _setCurrentDoc(v) { currentDoc = v; }

/** Debounce window for screenplay re-render. */
const SCREENPLAY_DEBOUNCE_MS = 80;

state.viewMode = "dual";
state.lastSoloMode = "solo-storyboard";

// ── App settings + meta.json persistence ─────────────────────────────────
// Extracted to shell/app-settings-io.js. Re-exported so importers (boot.js,
// layout.js, subviews.js, project-switcher.js, mount-project-views.js,
// open-and-mount-project.js, explorer.js) keep resolving them from app.js.
export {
    queueMetaSave,
    queueAppSettingsSave,
    flushAppSettings,
    probePlatform,
    loadAppSettings,
} from "./shell/app-settings-io.js";


// ── DOM helpers ──
/**
 * Apply a top-level app state: write `[data-app-state]`, tick the inline
 * boot screen, fade in chrome on `"ready"`. The FSM in `state-machine.js`
 * owns the policy (allowed transitions per mode); this function owns the
 * side effects every state change must run.
 *
 * @param {string} next
 */
export function setAppState(next) {
    // Debug-only pause point (MPS_PAUSE_AFTER_LOADING=1). Halt the moment
    // the app leaves any loading-phase substate. Splash NOT dismissed,
    // chrome NOT unhidden (debug-only pause — MPS_PAUSE_AFTER_LOADING=1).
    const LOADING_PHASE = new Set(["app-init", "booting", "probing", "loading-recent", "user-data"]);
    if (typeof window !== "undefined"
        && /** @type {any} */ (window).__MPS_PAUSE_AFTER_LOADING
        && LOADING_PHASE.has(state.currentState)
        && !LOADING_PHASE.has(next)
        && next !== "error")
    {
        if (!/** @type {any} */ (window).__mpsPausedAfterLoading)
        {
            /** @type {any} */ (window).__mpsPausedAfterLoading = true;
            console.warn(`[mps:pause] Halting: setAppState("${next}") from "${state.currentState}". Splash NOT dismissed.`);
            try
            {
                const overlay = document.createElement("div");
                overlay.setAttribute("style", "position:fixed;top:8px;right:8px;padding:6px 10px;background:#000;color:#0f0;font:12px monospace;z-index:2147483647;border:1px solid #0f0");
                overlay.textContent = `PAUSED: ${state.currentState} → ${next}`;
                document.body.appendChild(overlay);
            }
            catch (_) {}
        }
        return; // do not apply the state; freeze here
    }

    state.currentState = next;
    document.documentElement.setAttribute("data-app-state", next);
    markBench(`state:${next}`);

    // Tick the inline boot screen for stages the user sees during cold
    // boot. The boot screen is the canvas we paint on between paint and
    // PROJECT; once chrome is revealed the boot screen is faded.
    const splash = /** @type {any} */ (window).__mpsSplash;
    if (splash && typeof splash.update === "function")
    {
        switch (next)
        {
            case "booting":
                splash.update("bundle", t("mangaplay-studio.boot.stage.loadingApp") || "Loading app…");
                break;
            case "probing":
            case "loading-recent":
                // Fold into the settings stage — Rust-IPC heavy step.
                splash.update("settings", t("mangaplay-studio.boot.stage.loadingSettings") || "Restoring preferences…");
                break;
            case "user-data":
                splash.update("userData", t("mangaplay-studio.boot.stage.userData") || "Updating user data…");
                break;
            case "opening-project":
            {
                const name = state.currentProject?.name || "";
                const tpl = t("mangaplay-studio.boot.stage.openingProject");
                const msg = (tpl && tpl !== "mangaplay-studio.boot.stage.openingProject")
                    ? tpl.replace("{name}", name)
                    : `Opening ${name || "project"}…`;
                splash.update("project", msg);
                break;
            }
            case "start-screen":
            case "empty":
                // The picker (RECENT PROJECTS + Create/Open) is the surface
                // the user needs to interact with now — fade the splash out
                // so the "Restoring account…" (or any other in-flight stage)
                // caption doesn't hang over the top of it. Without this the
                // splash (z:9999) covers the picker forever unless a project
                // is auto-mounted through to "ready".
                if (typeof splash.done === "function") splash.done();
                break;
            default: break;
        }
    }

    // Legacy DOM hooks for any code still attaching to [data-state-message].
    const msgEl = document.querySelector("[data-state-message]");
    if (msgEl) {
        let msg = stateMessage(next);
        if (next === "opening-project" && state.currentProject?.name) {
            msg = t("mangaplay-studio.boot.opening.openingNamed", { name: state.currentProject.name });
        }
        msgEl.textContent = msg;
    }

    if (next === "ready") {
        const elapsed = performance.now() - bootStartedAt;
        const delay = Math.max(0, MIN_DISPLAY_MS - elapsed);
        setTimeout(async () => {
            // Sequence: fade splash to completion (element removed from DOM),
            // THEN unhide chrome. Without this the splash and chrome cross-
            // fade opacity on the same frame band and body bg peeks through
            // for ~50ms → white flash on the light theme. See the boot-flash
            if (splash && typeof splash.done === "function") {
                try { await splash.done(); }
                catch (_) {}
            }
            const chrome = document.getElementById("app-chrome");
            if (chrome) {
                chrome.hidden = false;
                chrome.classList.add("fade-in");
                requestAnimationFrame(() => chrome.classList.remove("fade-in"));
                // Flip body bg to workspace theme only AFTER chrome finishes
                // fading in — otherwise the light workspace bg leaks through
                // the 300ms opacity fade of #app-chrome as a white wipe.
                setTimeout(() =>
                {
                    document.documentElement.setAttribute("data-chrome-visible", "true");
                }, 320);
            }
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
export function refreshStateMessage()
{
    const msgEl = document.querySelector("[data-state-message]");
    if (!msgEl) return;
    let msg = stateMessage(state.currentState);
    if (state.currentState === "opening-project" && state.currentProject?.name)
    {
        msg = t("mangaplay-studio.boot.opening.openingNamed", { name: state.currentProject.name });
    }
    msgEl.textContent = msg;
}

/** @param {string} s */
export function setSaveState(s) {
    state.saveState = s;
    document.documentElement.setAttribute("data-save-state", s);
    const indicator = document.querySelector(".save-indicator");
    if (indicator) {
        const labels = { saved: "Saved", dirty: "Unsaved", saving: "Saving…" };
        indicator.textContent = labels[s] || s;
    }
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
                    state.currentProject = await openProject(chosenPath);
                    // Expose project dir to editor extensions (page-fold persistence).
                    /** @type {any} */ (window).__mpsCurrentProjectDir = state.currentProject?.path || null;
                    // One-shot migration of legacy relpath-keyed googleDocsSync
                    // entries → UUID-keyed. Runs before any SyncStateMachine
                    // boots so the gear-icon lookup at activation sees clean
                    // state. Safe to call repeatedly — no-ops on a clean map.
                    try { await migrateLegacySyncEntries(state.currentProject.path); }
                    catch (e) { console.warn("[scriptmap:migrate] failed:", e); }
                    // Start the FS watcher for the new project root so
                    // external edits flow through project-fs-changed.
                    try
                    {
                        if (isTauri() && state.currentProject?.path)
                        {
                            await invoke("fs_watch_start", { path: state.currentProject.path });
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

export function restoreShellMeta()
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

    // Mobile/tablet: FAB view-toggle owns storyboard visibility now — a
    // persisted `storyboardCollapsed:true` from a prior desktop session
    // must NOT flip the pane off-screen (see shell-restore.js for the same
    // guard on boot).
    const _uxMode = document.documentElement.getAttribute("data-ux-mode");
    const _mobileLike = _uxMode === "mobile" || _uxMode === "tablet";
    if (settings.storyboardCollapsed === true && !_mobileLike)
    {
        applyStoryboardCollapseState(true);
    }

    if (settings.leftPaneCollapsed === true)
    {
        applyLeftPaneCollapsedState(true);
    }
    const validSubviews = ["folder", "outline", "statistics"];
    const bootSubview = (typeof settings.activeSubview === "string"
        && validSubviews.includes(settings.activeSubview))
        ? settings.activeSubview
        : "folder";
    applySubview(bootSubview);
}

// ── Empty-state + doc-change pipeline ──

export function updateEmptyState()
{
    const overlay = document.getElementById("empty-state");
    if (!overlay) return;
    const hasFile = !!(state.currentProject?.scriptPath);
    overlay.hidden = hasFile;
}

export function wireEmptyState()
{
    const overlay = /** @type {HTMLElement|null} */ (document.getElementById("empty-state"));
    if (!overlay) return;

    async function trigger()
    {
        if (overlay.hidden) return;
        if (!state.currentProject) return;
        try
        {
            await createUntitled(state.currentProject.path);
            const reopened = await openProject(state.currentProject.path);
            if (!reopened) return;
            state.currentProject = reopened;
            getBroker().setActive(state.currentProject.scriptPath);
            try { await mountFolderExplorer(); }
            catch (e) { console.debug("folder list mount failed:", e); }
            updateEmptyState();
            // Replace the active slot's content with the newly-created
            // Untitled file. If no slot exists yet, replaceActive falls
            // through to openNew per the slot manager contract.
            if (state.slotManager && state.currentProject?.scriptPath)
            {
                state.slotManager.replaceActive(
                    state.currentProject.scriptPath,
                    state.currentProject.script || "",
                    /** @type {any} */ (formatForFilename(state.currentProject.scriptBasename || ""))
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
 * @param {import("./editor/editor-slot-manager.js").EditorSlot} slot
 * @param {string} text
 */
export function onMpsChangeFromSlot(slot, text)
{
    currentDoc = text;
    setSaveState("dirty");
    if (state.debouncedScreenplayUpdate) state.debouncedScreenplayUpdate(text);
    if (state.canvasApi && typeof state.canvasApi.setScript === "function")
    {
        state.canvasApi.setScript(text);
    }
    if (state.debouncedScriptSave) state.debouncedScriptSave(text);
    // Fix Structural Issues button tracks the source buffer — refresh
    // whenever the doc changes so the icon reflects current state.
    try { window.__mpsRefreshFixIssuesBtn?.(); } catch (_) {}
    // Google Docs sync state machine — notify of local edits so the gear
    // moves from idle → local-ahead without any network call.
    try { if (slot?.path) notifyGoogleDocsEdit(); }
    catch (e) { console.warn("[google-docs] notifyEdit threw:", e); }
    // App Footer word / char counts — debounced recount (150ms).
    try { state.appFooter?.notifyDocChanged(); }
    catch (e) { console.debug("[app-footer] notifyDocChanged threw:", e); }
}

/**
 * Slot-manager onActivate hook — invoked when the user switches tabs (or on
 * the initial mount). Mirrors the activated slot's path/basename/doc onto
 * `currentProject` for compatibility with the rest of app.js, pushes the
 * tab's saved pageIndex into the canvas store, and re-publishes the parsed
 * AST so the right pane + canvas re-render against the new doc.
 *
 * @param {import("./editor/editor-slot-manager.js").EditorSlot} slot
 */
export function onSlotActivated(slot)
{
    currentDoc = slot.view.state.doc.toString();
    if (state.currentProject && slot.path)
    {
        state.currentProject.scriptPath = slot.path;
        state.currentProject.scriptBasename = slot.basename;
        state.currentProject.script = currentDoc;
    }
    const canvasEl = /** @type {any} */ (document.querySelector("mps-canvas"));
    if (canvasEl?.store && typeof slot.pageIndex === "number")
    {
        canvasEl.store.update(
            { currentPageIndex: slot.pageIndex },
            "tab-activated"
        );
    }
    state.activeSlotIsPlaceholder = slot.path === null;
    state.activeFormat = slot.format;
    // Sync the folder-explorer highlight to the active tab. Cheap DOM
    // attribute flip — no fs hit, no re-mount. Pass the project-relative
    // path (not basename) so that same-named files in different
    // subfolders don't both light up as active.
    try
    {
        let key = null;
        if (slot.path)
        {
            const proj = state.currentProject && state.currentProject.path;
            if (proj)
            {
                const projNorm = proj.replace(/\\/g, "/");
                const slotNorm = slot.path.replace(/\\/g, "/");
                key = slotNorm.startsWith(projNorm + "/")
                    ? slotNorm.slice(projNorm.length + 1)
                    : basename(slot.path);
            }
            else
            {
                key = basename(slot.path);
            }
        }
        state.folderList?.setActive(key);
    }
    catch (_e) { /* explorer may not be mounted yet during boot */ }
    publishParsedScript(currentDoc);
    // Empty-tab CTA visible only when the active slot is the placeholder
    // ("Create New file" tab — no path on disk).
    state.emptyTabCta?.setVisible(slot.path === null);
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
        if (state.currentProject && slot.path)
        {
            const proj = state.currentProject.path;
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
    try { state.appFooter?.recountNow(); }
    catch (e) { console.debug("[app-footer] recountNow threw:", e); }
    // Slides pill's greyed-out state depends on state.activeFormat, which
    // was just updated a few lines above. Nudge it to re-evaluate.
    //
    // Slides pill linked state — driven by project.json's slidesLinks map.
    // Resolved via slides_link_get; short-circuits on non-mangaplay formats
    // to avoid a Rust hop + project.json read on every slot activation for
    // .fountain / .txt files. Wrapped in an async IIFE because
    // onSlotActivated is a sync function and we don't want to widen its
    // signature just for this seam.
    (async () =>
    {
        try
        {
            if (state.activeFormat !== "mangaplay")
            {
                state.slidesLinkedForActive = false;
                state.slidesSyncStatus = null;
            }
            else
            {
                const activeSlot = state.slotManager?.getActive();
                const localPath  = activeSlot?.path || "";
                if (state.currentProject && localPath)
                {
                    const projNorm = state.currentProject.path.replace(/\\/g, "/");
                    const slotNorm = String(localPath).replace(/\\/g, "/");
                    const rel = slotNorm.startsWith(projNorm + "/")
                        ? slotNorm.slice(projNorm.length + 1)
                        : (activeSlot?.basename || "");
                    // Resolve the active file's parent-folder uuid when
                    // that folder is a Storyboard Folder — folder-scoped
                    // links are keyed by `folder:<folderUuid>` in
                    // project.json.slidesLinks. Without this the pill's
                    // linked indicator can never see folder-scoped links.
                    /** @type {string|null} */
                    let folderUuid = null;
                    try
                    {
                        const fileUuid = /** @type {any} */ (activeSlot)?.fileUuid || null;
                        if (fileUuid)
                        {
                            const entries = await listProjectTree(state.currentProject.path);
                            const target = entries.find((en) => en && en.uuid === fileUuid);
                            const parentUuid = target && target.parentUuid ? target.parentUuid : null;
                            if (parentUuid)
                            {
                                const folderType = await getFolderType(state.currentProject.path, parentUuid);
                                if (folderType === "storyboard") folderUuid = parentUuid;
                            }
                        }
                    }
                    catch (e)
                    {
                        console.debug("[publish-slides-pill] folder-uuid resolve failed:", e?.message || e);
                    }
                    const link = await slidesLinkGet({
                        projectPath:   state.currentProject.path,
                        scriptRelPath: rel,
                        folderUuid,
                    });
                    state.slidesLinkedForActive = !!link;
                    // Background sync-status check — fire-and-forget.
                    // Compares the remote headRevisionId against the
                    // stored lastKnownRevisionId. Degrades silently on
                    // any failure (pill stays in plain "linked" state).
                    // Generation counter guards against a stale check
                    // painting the wrong file's badge after a fast switch.
                    state.slidesSyncStatus = null;
                    if (link && link.presentationId)
                    {
                        const gen = ++state.slidesSyncCheckGen;
                        (async () =>
                        {
                            try
                            {
                                const { isAuthenticated, getAccessToken } =
                                    await import("./auth/google-oauth.js");
                                if (!isAuthenticated()) return;
                                if (gen !== state.slidesSyncCheckGen) return;
                                const token = await getAccessToken({ allowRefresh: true });
                                if (!token) return;
                                if (gen !== state.slidesSyncCheckGen) return;
                                const { getHeadRevisionId } =
                                    await import("./google-slides-sync/slides-api.js");
                                const headRev = await getHeadRevisionId(
                                    link.presentationId, token);
                                if (gen !== state.slidesSyncCheckGen) return;
                                if (!headRev)
                                {
                                    state.slidesSyncStatus = null;
                                    return;
                                }
                                if (!link.lastKnownRevisionId)
                                {
                                    state.slidesSyncStatus = "unknown";
                                }
                                else if (headRev === link.lastKnownRevisionId)
                                {
                                    state.slidesSyncStatus = "synced";
                                }
                                else
                                {
                                    state.slidesSyncStatus = "remote-changed";
                                }
                            }
                            catch (e)
                            {
                                if (gen !== state.slidesSyncCheckGen) return;
                                console.debug(
                                    "[slides-sync-status] background check failed:",
                                    e?.message || e);
                                state.slidesSyncStatus = null;
                            }
                            try { state.publishSlidesPillCtrl?.refresh(); }
                            catch (_) { /* best-effort */ }
                        })();
                    }
                }
                else
                {
                    state.slidesLinkedForActive = false;
                    state.slidesSyncStatus = null;
                }
            }
        }
        catch (e)
        {
            console.debug("[publish-slides-pill] slides_link_get failed:", e?.message || e);
            state.slidesLinkedForActive = false;
            state.slidesSyncStatus = null;
        }
        try { state.publishSlidesPillCtrl?.refresh(); }
        catch (e) { console.debug("[publish-slides-pill] refresh threw:", e); }
    })();
    // Publish-scope resolution — is the active file inside a Storyboard
    // Folder? Drives the pill's "ready-group" tooltip variant + the editor
    // menu's "Group Google Slides™" label. Same async IIFE pattern as
    // slidesLinkedForActive above; short-circuits on non-mangaplay.
    (async () =>
    {
        try
        {
            state.publishScopeIsFolder = false;
            if (state.activeFormat !== "mangaplay") return;
            const activeSlot = state.slotManager?.getActive();
            const fileUuid = /** @type {any} */ (activeSlot)?.fileUuid || null;
            const projectPath = state.currentProject?.path || "";
            if (!projectPath || !fileUuid) return;
            const entries = await listProjectTree(projectPath);
            const target = entries.find((e) => e && e.uuid === fileUuid);
            const parentUuid = target && target.parentUuid ? target.parentUuid : null;
            if (!parentUuid) return;
            const folderType = await getFolderType(projectPath, parentUuid);
            state.publishScopeIsFolder = folderType === "storyboard";
        }
        catch (e)
        {
            console.debug("[publish-scope] scope refresh failed:", e?.message || e);
            state.publishScopeIsFolder = false;
        }
        try { state.publishSlidesPillCtrl?.refresh(); }
        catch (e) { console.debug("[publish-slides-pill] refresh threw:", e); }
    })();
    // Right-pane storyboard-display mode — swap <mps-canvas> for <mps-display>
    // when the active .mangaplay file (or containing storyboard folder) has a
    // linked Slides deck with cached PNGs. Same-group file switches re-target
    // activeIndex without unmount; unlinked / non-mangaplay restores canvas.
    (async () =>
    {
        try
        {
            const mod = await import("./shell/right-pane-storyboard-mode.js");
            const activeSlot = state.slotManager?.getActive();
            const fileUuid = /** @type {any} */ (activeSlot)?.fileUuid || null;
            const projectPath = state.currentProject?.path || "";
            const localPath  = activeSlot?.path || "";
            if (state.activeFormat !== "mangaplay" || !projectPath || !localPath)
            {
                mod.unmountDisplay();
                return;
            }
            const projNorm = projectPath.replace(/\\/g, "/");
            const slotNorm = String(localPath).replace(/\\/g, "/");
            const scriptRelPath = slotNorm.startsWith(projNorm + "/")
                ? slotNorm.slice(projNorm.length + 1)
                : (activeSlot?.basename || "");
            // Resolve parent-folder uuid + type.
            /** @type {string|null} */
            let parentFolderUuid = null;
            /** @type {"storyboard"|"screenplay"|null} */
            let folderType = null;
            if (fileUuid)
            {
                try
                {
                    const entries = await listProjectTree(projectPath);
                    const target = entries.find((en) => en && en.uuid === fileUuid);
                    parentFolderUuid = target?.parentUuid || null;
                    if (parentFolderUuid)
                    {
                        const ft = await getFolderType(projectPath, parentFolderUuid);
                        folderType = ft === "storyboard" || ft === "screenplay" ? ft : null;
                    }
                }
                catch (e) { console.debug("[display-mode] folder resolve:", e?.message || e); }
            }
            // Page-id enumerator from the runtime AST (already parsed for
            // active file). For group scope we fall back to per-file parse.
            const activePages = getRuntimeStorage().state?.script?.pages || [];
            const pageIdsForFile = async (/** @type {string} */ uuid) =>
            {
                if (fileUuid && uuid === fileUuid)
                {
                    return activePages.map((/** @type {any} */ p) => String(p?.id ?? "")).filter(Boolean);
                }
                // Group scope: read + parse the sibling file. Best-effort; on
                // any failure return empty (renders placeholders for that file's slice).
                try
                {
                    const { registryReadFile } = await import("./adapters/tauri-storage.js");
                    const { contents } = await registryReadFile(uuid);
                    const ast = parseScript(contents || "");
                    return (ast.pages || []).map((/** @type {any} */ p) => String(p?.id ?? "")).filter(Boolean);
                }
                catch (e)
                {
                    console.debug("[display-mode] pageIdsForFile fallback:", e?.message || e);
                    return [];
                }
            };
            const groupResolver = async () =>
            {
                if (folderType !== "storyboard" || !parentFolderUuid) return null;
                const entries = await listProjectTree(projectPath);
                const siblings = entries
                    .filter((en) => en.parentUuid === parentFolderUuid && en.kind === "file")
                    .filter((en) => formatForFilename(en.name) === "mangaplay")
                    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
                return {
                    files: siblings.map((en) => en.uuid),
                    basenameFor: (/** @type {string} */ u) =>
                        siblings.find((en) => en.uuid === u)?.name || "",
                };
            };
            await mod.evaluateStoryboardMode({
                projectPath,
                scriptRelPath,
                fileUuid,
                parentFolderUuid,
                folderType,
                activeFormat: state.activeFormat,
                pageIdsForFile,
                groupResolver,
            });
        }
        catch (e)
        {
            console.debug("[display-mode] evaluate failed:", /** @type {any} */ (e)?.message || e);
        }
    })();
}

/**
 * Map an EditorFormat to the editor modes it supports.
 *
 *   mangaplay         → [source, wysiwyg, easy]
 *   fountain          → [source, wysiwyg]
 *   superscript       → [source] (+ alpha warning shown in the top bar)
 *   superscript-bin   → [source] (+ alpha warning shown in the top bar)
 *   general-text      → [source]
 *
 * When the Easy Editor is build-gated off (EASY_EDITOR_ENABLED === false),
 * "easy" is dropped from every set so the mode is unreachable from the cycle
 * toggle + footer menu. The component itself stays mounted-on-demand.
 *
 * @param {import("./editor/lang-registry.js").EditorFormat} format
 * @returns {Array<"source"|"wysiwyg"|"easy">}
 */
function allowedModesForFormat(format)
{
    let modes;
    switch (format)
    {
        case "mangaplay":        modes = ["source", "wysiwyg", "easy"]; break;
        case "fountain":         modes = ["source", "wysiwyg"]; break;
        case "superscript":      modes = ["source"]; break;
        case "superscript-bin":  modes = ["source"]; break;
        default:                 modes = ["source"]; break; // general-text / .txt
    }
    if (!isEasyEditorEnabled()) modes = modes.filter((m) => m !== "easy");
    return /** @type {Array<"source"|"wysiwyg"|"easy">} */ (modes);
}

/**
 * Sync the mode-toggle's allowed set + the top bar's `data-format` (drives the
 * SuperScript alpha warning pill) for the given format. If the current editor
 * mode isn't in the allowed set, request a one-shot downgrade through the
 * project-scoped `applyEditorMode` (persists, so the new lower mode sticks).
 *
 * @param {import("./editor/lang-registry.js").EditorFormat} format
 */
export function applyAllowedModesForFormat(format)
{
    let allowed = allowedModesForFormat(format);
    // Aggregate override: the folder is guaranteed homogeneous by the
    // explorer.js compatibility gate (a Storyboard folder only mounts
    // mangaplay children; a Screenplay folder only mounts fountain).
    // So the intersection across all valid children equals the format
    // of the focused file — which the caller already passed. Nothing to
    // narrow here. We keep the hook so future mixed-format folders can
    // downgrade to `["source","wysiwyg"]` cheaply without touching call sites.
    const activeAgg = getActiveAggregate();
    if (activeAgg)
    {
        // Intersection is homogeneous; keep the format-driven default.
        allowed = allowedModesForFormat(format);
    }
    if (state.editorAreaTopBarEl)
    {
        state.editorAreaTopBarEl.setAttribute("data-format", format);
    }
    if (state.modeToggleEl)
    {
        /** @type {any} */ (state.modeToggleEl).allowedModes = allowed;
    }
    if (state.applyEditorModeRef && state.modeToggleEl)
    {
        const current = /** @type {any} */ (state.modeToggleEl).mode;
        if (!allowed.includes(current))
        {
            // Walk Easy Editor → WYSIWYG → Source for the highest allowed downgrade.
            const order = ["easy", "wysiwyg", "source"];
            const downgrade = /** @type {any} */ (
                order.find((m) => allowed.includes(/** @type {any} */ (m)))
            ) || "source";
            void state.applyEditorModeRef(downgrade);
        }
    }
    // Format change → re-evaluate pagination chevron enable/disable on both
    // the global topbar cluster and the editor-area bar. Pagination gates
    // on format ("mangaplay" enables, others disable), so the chevron state
    // must refresh whenever the active slot's format flips even if the
    // editor mode itself didn't change.
    if (state.renderTopbarPagination)
    {
        try { state.renderTopbarPagination(); }
        catch (e) { console.debug("[pagination] render after format change failed:", e); }
    }
    if (state.editorBarPagePrevBtn && state.editorBarPageNextBtn)
    {
        if (format === "mangaplay")
        {
            const prevLabel = t("ui.paint.prevPage") || "Previous page";
            const nextLabel = t("ui.paint.nextPage") || "Next page";
            state.editorBarPagePrevBtn.setAttribute("data-tooltip", prevLabel);
            state.editorBarPagePrevBtn.setAttribute("data-tooltip-side", "bottom");
            state.editorBarPageNextBtn.setAttribute("data-tooltip", nextLabel);
            state.editorBarPageNextBtn.setAttribute("data-tooltip-side", "bottom");
            const { pageIndex: _pi, totalPages: _tp } = getPaginationState();
            state.editorBarPagePrevBtn.disabled = _pi <= 0;
            state.editorBarPageNextBtn.disabled = _pi >= _tp - 1;
        }
        else
        {
            state.editorBarPagePrevBtn.disabled = true;
            state.editorBarPageNextBtn.disabled = true;
            state.editorBarPagePrevBtn.removeAttribute("data-tooltip");
            state.editorBarPageNextBtn.removeAttribute("data-tooltip");
        }
    }
}

/**
 * Debounced session-persistence. Writes the serialized tab snapshot to
 * `<project>/_mangaplaystudio/settings/session.json` via the existing FS commands.
 * 250 ms debounce matches the fold-state persistence cadence; safe to spam
 * from `onTabsChanged`.
 */
export const debouncedWriteSession = (() =>
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
                const snap = state.slotManager?.serialize();
                if (!snap || !state.currentProject) return;
                /** @type {any} */ (window).__mpsLastTabSnap = snap;
                await setTabSnapshot(state.currentProject.path, snap);
            }
            catch (e) { console.warn("[session] write failed:", e); }
        }, 250);
    };
})();

// ── Top-bar / rail button wiring ─────────────────────────────────────────
// Extracted to shell/app-toolbar-wiring.js. Re-exported so boot.js keeps
// resolving the wire* helpers from app.js.
export {
    wireStoryboardSwitcher,
    wireSettingsButton,
    wireMobileFabActions,
    wireRailAccount,
    wireHelpButton,
    wireQuickToggleRelocation,
} from "./shell/app-toolbar-wiring.js";


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
export function publishParsedScript(text)
{
    try
    {
        const format = formatForFilename(state.currentProject?.scriptBasename);
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
            const stem = (state.currentProject?.scriptBasename || "untitled")
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
                scriptSourceText: text,
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
            scriptSourceText: null,
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





// ── Start ──
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
} else {
    boot();
}
