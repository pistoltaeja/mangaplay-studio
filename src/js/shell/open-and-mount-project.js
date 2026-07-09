// @ts-check
import { invoke } from "@tauri-apps/api/core";
import { state } from "./state.js";
import { isTauri, basename } from "../util/index.js";
import { t } from "../adapters/tauri-i18n.js";
import { scriptRelPathOf } from "../util/paths.js";
import { openProject, updateRecent, loadMangaart, loadMangaartByUuid } from "../project/project.js";
import { saveUserSettings } from "../project/user-settings.js";
import { mountFolderExplorer } from "./explorer.js";
import { wireProjectFsChangedListener, wireRegistryFsChangedListener } from "./fs-listeners.js";
import { mountProjectViews } from "./mount-project-views.js";
import { applyMetaBeforeFirstPaint } from "../boot/shell-restore.js";
import { getBroker } from "../project/active-script-broker.js";
import { isMobileLike } from "../boot/ux-mode.js";
import { wireShellOnce } from "./boot.js";
import {
    setAppState,
    setSaveState,
    showError,
    queueAppSettingsSave,
} from "../app.js";

/**
 * Open a project on disk and mount the workspace. Owns the full sequence
 * from setAppState("opening-project") through setAppState("ready") + picker
 * fade-out + __APP_BOOTED. Single source of truth for both the auto-resume
 * path and the onboarding-complete path.
 *
 * Assumes:
 *   - The project directory already exists on disk.
 *   - state / appSettings / broker singletons are initialised.
 *   - Any pre-open splash captions are already emitted by the caller.
 *
 * @param {string} chosenPath — canonical project path.
 * @param {{
 *   shell?: any | null,
 *   isMobileRecovery?: boolean,
 *   showSplash?: boolean,
 *   mobileRecovery?: (opts: {forceNew?: boolean}) => Promise<string>,
 * }} [opts]
 * @returns {Promise<void>}
 */
export async function openAndMountProject(chosenPath, opts = {})
{
    const {
        shell = null,
        isMobileRecovery = false,
        showSplash = true,
        mobileRecovery = null,
    } = opts;
    const appSettings = /** @type {any} */ (globalThis).__MPS_APP_SETTINGS__;

    setAppState("opening-project");
    const bumpProgress = (v, msg) =>
    {
        if (!showSplash) return;
        const splash = /** @type {any} */ (window).__mpsSplash;
        if (splash)
        {
            const caption = msg || t("mangaplay-studio.boot.opening.openingNamed", { name: (basename(chosenPath) || chosenPath) });
            splash.update("opening", caption);
            splash.setProgress(v);
        }
    };

    try {
        bumpProgress(0.35, t("mangaplay-studio.boot.opening.readingProject"));
        try
        {
            state.currentProject = await openProject(chosenPath);
        }
        catch (openErr)
        {
            // Review item #5: corrupted project.json on mobile has no
            // picker to fall back to. Re-create the default project
            // with a numbered suffix and retry once. Standalone path
            // re-throws to fall through to the existing showError +
            // picker recovery.
            if (isMobileRecovery && isMobileLike() && mobileRecovery)
            {
                console.warn("[boot] openProject failed in mobile mode, re-creating:", openErr);
                chosenPath = await mobileRecovery({ forceNew: true });
                await saveUserSettings({ lastProjectPath: chosenPath }).catch(() => {});
                state.currentProject = await openProject(chosenPath);
            }
            else
            {
                throw openErr;
            }
        }
        // Expose project dir to editor extensions (page-fold persistence).
        /** @type {any} */ (window).__mpsCurrentProjectDir = state.currentProject?.path || null;
        // Start the FS watcher for the new project root so external
        // edits flow through project-fs-changed.
        try
        {
            if (isTauri() && state.currentProject?.path)
            {
                await invoke("fs_watch_start", { path: state.currentProject.path });
            }
        }
        catch (e) { console.warn("[fs_watch_start] failed:", e); }
        bumpProgress(0.55, t("mangaplay-studio.boot.opening.scanningScripts"));
        try { await mountFolderExplorer(); }
        catch (e) { console.debug("folder list mount failed:", e); }
        bumpProgress(0.7, t("mangaplay-studio.boot.opening.loadingArtwork"));
        try
        {
            const fileUuid = state.slotManager?.getActive()?.fileUuid || null;
            if (fileUuid)
            {
                const displayName = (state.currentProject.scriptBasename || "").replace(/\.md$/i, "");
                await loadMangaartByUuid(state.currentProject.path, fileUuid, displayName);
            }
            else
            {
                const rel = scriptRelPathOf(state.currentProject.path, state.currentProject.scriptPath)
                    || state.currentProject.scriptBasename;
                await loadMangaart(state.currentProject.path, rel);
            }
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
        const meta = state.currentProject?.meta || {};
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

        const restored = applyMetaBeforeFirstPaint(state.currentProject.meta, { settings: appSettings });
        if (restored.viewMode) state.viewMode = /** @type {any} */ (restored.viewMode);
        if (restored.lastSoloMode) state.lastSoloMode = restored.lastSoloMode;
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
    try { getBroker().setActive(state.currentProject?.scriptPath ?? null); }
    catch (e) { console.warn("[boot] broker.setActive failed:", e); }

    // Ready
    bumpProgress(1.0, t("mangaplay-studio.boot.opening.ready"));
    setAppState("ready");
    setSaveState("saved");

    // Multi-window listener — Tauri only. Fires whenever any window in
    // this app mutates the project FS. The other window's broker either
    // adopts the rename, drops state on a delete, or just refreshes.
    wireProjectFsChangedListener();
    wireRegistryFsChangedListener();

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
}
