import { state } from "./state.js";
import { invoke } from "@tauri-apps/api/core";
import { basename, isTauri } from "../util/index.js";
import { icon } from "../panes/icons.js";
import { t } from "../adapters/tauri-i18n.js";
import { loadRecent, openProject, updateRecent, clearMangaartCache, loadMangaart, loadMangaartByUuid, migrateLegacySyncEntries } from "../project/project.js";
import { saveUserSettings } from "../project/user-settings.js";
import { scriptRelPathOf } from "../util/paths.js";
import { getBroker } from "../project/active-script-broker.js";
import { applyMetaBeforeFirstPaint } from "../boot/shell-restore.js";
import {
    queueAppSettingsSave,
    setAppState,
    setSaveState,
} from "../app.js";
import {
    flushCurrentProjectMeta,
    destroyCurrentProjectViews,
} from "./boot.js";
import { mountProjectViews } from "./mount-project-views.js";
import { mountFolderExplorer, enterManageProjects } from "./explorer.js";
import { wireProjectFsChangedListener, wireRegistryFsChangedListener } from "./fs-listeners.js";

/**
 * Update the project-switcher button's visible label + disabled state.
 * The recents list now lives in a popup that is rebuilt on each open
 * (see openProjectSwitcherMenu), so this function no longer touches
 * any list DOM — it just keeps the button in sync.
 */
export function refreshProjectSwitcher()
{
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById("project-switcher-btn"));
    if (!btn) return;
    const label = state.currentProject?.meta?.title
        || (basename(state.currentProject?.path) || "(no project)");
    const labelEl = btn.querySelector(".project-switcher-label");
    if (labelEl) labelEl.textContent = label;
    btn.disabled = state.swappingProject;
    if (state.swappingProject) closeProjectSwitcherMenu();
}

export function closeProjectSwitcherMenu()
{
    if (!state.projectSwitcherMenuEl) return;
    state.projectSwitcherMenuEl.remove();
    state.projectSwitcherMenuEl = null;
    const btn = document.getElementById("project-switcher-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onProjectSwitcherDocMouseDown, true);
    document.removeEventListener("keydown", onProjectSwitcherDocKeyDown, true);
}

/** @param {MouseEvent} ev */
function onProjectSwitcherDocMouseDown(ev)
{
    if (!state.projectSwitcherMenuEl) return;
    const target = /** @type {Node} */ (ev.target);
    const btn = document.getElementById("project-switcher-btn");
    if (state.projectSwitcherMenuEl.contains(target)) return;
    if (btn && btn.contains(target)) return;
    closeProjectSwitcherMenu();
}

/** @param {KeyboardEvent} ev */
function onProjectSwitcherDocKeyDown(ev)
{
    if (ev.key === "Escape" && state.projectSwitcherMenuEl)
    {
        ev.stopPropagation();
        closeProjectSwitcherMenu();
        const btn = document.getElementById("project-switcher-btn");
        if (btn) /** @type {HTMLButtonElement} */ (btn).focus();
    }
}

export async function openProjectSwitcherMenu()
{
    if (state.swappingProject) return;
    if (state.projectSwitcherMenuEl)
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

    const currentPath = state.currentProject?.path ?? "";
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
    state.projectSwitcherMenuEl = menu;

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
export async function switchProject(path)
{
    if (state.swappingProject) return;
    if (!path) return;
    if (path === state.currentProject?.path) return;
    state.swappingProject = true;
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

        state.currentProject = opened;
        /** @type {any} */ (window).__mpsCurrentProjectDir = state.currentProject?.path || null;

        // One-shot migration of legacy relpath-keyed googleDocsSync
        // entries → UUID-keyed. Runs before any SyncStateMachine boots so
        // the gear-icon lookup at activation sees clean state.
        try { await migrateLegacySyncEntries(state.currentProject.path); }
        catch (e) { console.warn("[scriptmap:migrate] failed:", e); }

        // Start the FS watcher for the new project root. Rust's
        // fs_watch_start stops the previous watcher first, so back-to-back
        // project swaps don't leak threads.
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
        // Wipe the outgoing project's mangaart state before hydrating the
        // new one. destroyCurrentProjectViews tears down slots but leaves
        // the module-level `mangaartCache` and the canvas drawing engine's
        // strokes populated — without this the old project's storyboard
        // paints through into the new project's canvas until the user
        // switches tabs.
        clearMangaartCache();
        document.dispatchEvent(new CustomEvent("mps-erase-storyboard-committed"));
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
        catch (e) { console.error("loadMangaart failed:", e); }
        await updateRecent(path).catch(() => {});
        await saveUserSettings({ lastProjectPath: path }).catch(() => {});

        // Mirror the boot SHELL_FIELDS seed + applyMetaBeforeFirstPaint so
        // per-project viewMode / lastSoloMode / pane widths restore.
        {
            const appSettings = globalThis.__MPS_APP_SETTINGS__ || {};
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

        setAppState("mounting-views");
        await mountProjectViews();

        // Route the broker's autosaves to the new project's active script.
        try { getBroker().setActive(state.currentProject?.scriptPath ?? null); }
        catch (e) { console.warn("[switchProject] broker.setActive failed:", e); }

        // setAppState("ready") re-runs the boot fade-in path; skip it on
        // post-boot swaps (we're already in "ready") to avoid flicker against
        // the .project-swapping fade.
        if (state.currentState !== "ready") setAppState("ready");
        setSaveState("saved");

        // wireProjectFsChangedListener has its own one-shot guard (see fn) so
        // calling it again here is a no-op when already wired.
        wireProjectFsChangedListener();
        wireRegistryFsChangedListener();
    }
    catch (err)
    {
        console.error("[switchProject] failed", err);
    }
    finally
    {
        if (chrome) chrome.classList.remove("project-swapping");
        state.swappingProject = false;
        await refreshProjectSwitcher();
    }
}
