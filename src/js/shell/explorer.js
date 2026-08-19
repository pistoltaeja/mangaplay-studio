import { state } from "./state.js";
import { invoke } from "@tauri-apps/api/core";
import { isTauri, basename } from "../util/index.js";
import { t } from "../adapters/tauri-i18n.js";
import { showBanner } from "../boot/toast.js";
import { confirmModal } from "../modals/confirm-modal.js";
import { mountFolderList } from "../panes/folder-explorer.js";
import { getBroker } from "../project/active-script-broker.js";
import {
    listProjectScripts,
    listProjectTree,
    loadRecent,
    readFile,
    clearMangaartCache,
    loadMangaart,
    loadMangaartByUuid,
    setLastPageIndex,
    getLastPageIndex,
    revealInExplorer,
    getFolderType,
    setFolderType,
} from "../project/project.js";
import {
    getActiveAggregate,
    renderGroupsAsOne,
} from "../editor/aggregate-view.js";
import { getLastProjectPathInvalid, getProjectSession, saveProjectSession } from "../project/user-settings.js";
import {
    registryCopy,
    registryRename,
    registryDelete,
    registryDeleteForce,
    registryMove,
    registryCreateFile,
    registryListTree,
} from "../adapters/tauri-storage.js";
import { scriptRelPathOf } from "../util/paths.js";
import { formatForFilename } from "../editor/lang-registry.js";
import { isMobileLike } from "../boot/ux-mode.js";
import {
    setActiveScript as setGoogleDocsActiveScript,
} from "../google-docs-sync/footer-bootstrap.js";
import {
    setAppState,
    updateEmptyState,
    _setCurrentDoc,
} from "../app.js";
import {
    flushCurrentProjectMeta,
    destroyCurrentProjectViews,
} from "./boot.js";
import { renderStartScreen } from "./start-screen.js";
import { switchProject } from "./project-switcher.js";
import { markSelfChange, consumeSelfChange, peekSelfChange } from "./explorer-self-change.js";

// Re-export self-mutation tracking so importers (fs-listeners.js,
// mount-project-views.js) keep resolving these from explorer.js.
export { markSelfChange, consumeSelfChange, peekSelfChange };

/**
 * "Manage Projects" menu action: tear down the current project (without
 * destroying user data) and route the user back to the picker shell. When
 * they pick a project, mount it via the normal switchProject pipeline.
 */
export async function enterManageProjects()
{
    // Guard against re-entry — multiple concurrent enterManageProjects calls
    // would stack picker-shell listeners (renderStartScreen attaches a fresh
    // set every time) and leave dangling pending Promises.
    if (state.manageProjectsActive) return;
    state.manageProjectsActive = true;
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
    state.currentProject = null;
    /** @type {any} */ (window).__mpsCurrentProjectDir = null;
    // Hide the app chrome.
    const chrome = document.getElementById("app-chrome");
    if (chrome) chrome.hidden = true;
    // Refresh recents and show the picker shell.
    try { state.recentProjects = await loadRecent(); }
    catch (e) { console.warn("[manage] loadRecent failed:", e); state.recentProjects = []; }
    const shell = /** @type {any} */ (document.getElementById("picker-shell"));
    if (shell)
    {
        shell.style.display = "";
        shell.classList.remove("fade-out");
        shell.setRecent(state.recentProjects);
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
        if (!path) { state.manageProjectsActive = false; return; } // user closed window without picking; stay on picker
        // Show an opening card while switchProject mounts the new project so
        // the click feels responsive (otherwise the picker stays painted with
        // no visible reaction). Matches the boot flow at the top of the
        // post-pick branch.
        try
        {
            const topName = (state.recentProjects.find((r) => r.path === path)?.resolvedName)
                || basename(path)
                || path;
            const splash = /** @type {any} */ (window).__mpsSplash;
            if (splash)
            {
                if (typeof splash.show === "function") splash.show();
                splash.update("opening", t("mangaplay-studio.boot.opening.openingNamed", { name: topName }));
                splash.setProgress(0.2);
            }
        }
        catch { /* opening overlay is cosmetic — proceed */ }
        // Fade the picker so the splash mascot isn't stacked over it.
        if (shell)
        {
            shell.classList.add("fade-out");
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
    finally { state.manageProjectsActive = false; }
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

export function enrichScripts(scripts, projectRoot)
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
        // registry_list_tree entries carry a relPath but not an absolute
        // path — synthesise <projectRoot>/<relPath> so folder-explorer's
        // absPathFor / data-path stays populated during the transition.
        const relPath = typeof s.relPath === "string" && s.relPath !== ""
            ? s.relPath
            : name;
        const path = s.path
            ? String(s.path)
            : (projectRoot ? `${projectRoot}/${relPath}` : "");
        const out = {
            name,
            kind,
            path,
            modifiedAt: s.modifiedAt ?? 0,
            createdAt: s.createdAt ?? 0,
        };
        // Pass UUID + parentUuid + relPath through untouched when present so
        // folder-explorer's UUID-keyed maps work end-to-end.
        if (typeof s.uuid === "string") out.uuid = s.uuid;
        if (s.parentUuid !== undefined) out.parentUuid = s.parentUuid;
        if (typeof s.relPath === "string") out.relPath = s.relPath;
        if (typeof s.rev === "number") out.rev = s.rev;
        return out;
    });
}

/**
 * Fetch the tree-shape entry list for the current project. Falls back to
 * the flat scripts list when the tree command is unavailable (older
 * binaries, test environment) so callers always get a usable shape.
 * @param {string} projectRoot
 */
export async function listTreeForProject(projectRoot)
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
export async function mountFolderExplorer()
{
    if (!state.currentProject) return;
    const scripts = await listTreeForProject(state.currentProject.path);
    const enriched = enrichScripts(scripts, state.currentProject.path);
    // Prefer the active slot's fileUuid (authoritative — Rust mints one per file
    // regardless of basename). Fall back to the project-relative path, which
    // remains unique across subfolders. Passing bare basename here would light
    // up the wrong row when two files share a name across folders (e.g. a
    // root-level Foo.mangaplay.md and a nested Chapter1/Foo.mangaplay.md).
    const activeSlot = state.slotManager?.getActive();
    let active = activeSlot?.fileUuid ?? null;
    if (!active && state.currentProject.scriptPath)
    {
        const projNorm = state.currentProject.path.replace(/\\/g, "/");
        const slotNorm = state.currentProject.scriptPath.replace(/\\/g, "/");
        active = slotNorm.startsWith(projNorm + "/")
            ? slotNorm.slice(projNorm.length + 1)
            : basename(state.currentProject.scriptPath);
    }
    const listEl = document.querySelector("#subview-folder .folder-list");
    if (!listEl) return;
    // Prefer in-place update when a folderList already exists. `update()`
    // keeps the live `expanded` Set intact so folders the user expanded stay
    // open across refreshes triggered by rename / file-swap / fs-events. The
    // destroy/remount branch below re-seeds `expanded` from persisted state,
    // which loses runtime expansions that haven't been persisted yet (the
    // onToggleExpand persist is fire-and-forget).
    if (state.folderList)
    {
        /** @type {any} */ (state.folderList).update(enriched);
        /** @type {any} */ (state.folderList).setActive(active);
        return;
    }
    const meta = state.currentProject.meta || {};
    // expandedFolders now lives in per-user projectSessions[uuid]. Fall back
    // to the legacy meta value so the current session survives across the
    // migration boundary if the user boots mid-migration.
    const sessUuid = state.currentProject.id || null;
    const sessInitial = sessUuid ? getProjectSession(sessUuid) : {};
    const initialExpanded = Array.isArray(sessInitial.expandedFolders)
        ? sessInitial.expandedFolders
        : (Array.isArray(meta.expandedFolders) ? meta.expandedFolders : []);
    state.folderList = mountFolderList(listEl, enriched, {
        activeFile: active,
        initialExpanded,
        projectRoot: state.currentProject.path,
        onRename: handleRename,
        onRenameByUuid: async (uuid, newBasename, relPath) =>
        {
            const projRoot = state.currentProject
                ? state.currentProject.path.replace(/[\\/]+$/, "")
                : "";
            const oldPath = relPath && projRoot ? `${projRoot}/${relPath}` : "";
            return handleRename(oldPath, newBasename, uuid);
        },
        onToggleExpand: (relPath, isExpanded) =>
        {
            if (!state.currentProject) return;
            const uuid = state.currentProject.id;
            if (!uuid) return;
            const current = getProjectSession(uuid);
            const set = new Set(Array.isArray(current.expandedFolders) ? current.expandedFolders : []);
            if (isExpanded) set.add(relPath);
            else set.delete(relPath);
            const next = [...set].sort();
            saveProjectSession(uuid, { expandedFolders: next })
                .catch((e) => console.warn("[explorer] expand persist failed:", e));
        },
        onMoveByUuid: async (srcUuid, newParentUuid, srcRel, dstParentRel) =>
        {
            const projRoot = state.currentProject
                ? state.currentProject.path.replace(/[\\/]+$/, "")
                : "";
            const baseName = srcRel ? (srcRel.split(/[\\/]/).pop() || "") : "";
            const oldAbs = projRoot && srcRel ? `${projRoot}/${srcRel}` : "";
            const newAbs = projRoot && baseName
                ? `${projRoot}/${dstParentRel ? dstParentRel + "/" : ""}${baseName}`
                : "";
            try
            {
                if (oldAbs) markSelfChange(oldAbs);
                if (newAbs) markSelfChange(newAbs);
                await registryMove(srcUuid, newParentUuid);
                await refreshExplorer();
            }
            catch (err)
            {
                const code = String((err && err.message) || err || "unknown");
                const bn = baseName || "file";
                const dstName = (dstParentRel && dstParentRel.split(/[\\/]/).pop()) || "destination";
                if (code.includes("target-exists"))
                {
                    showBanner(`${bn} already exists in ${dstName}`);
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

export async function refreshExplorer()
{
    if (!state.currentProject) return;
    try { await mountFolderExplorer(); }
    catch (e) { console.debug("refreshExplorer failed:", e); }
}

// ── Explorer + editor context-menu routing ───────────────────────────────
// Extracted to explorer-context-menu.js. The menu builders call the file-op
// actions (onCreate/onDelete/onCopy/parentForCreation/refreshExplorer) that
// stay here; re-exported below so other shell modules keep resolving the
// router + navigator helpers from explorer.js.
import {
    setSheetContextMenuHandler,
    routeContextMenu,
    openEditorMoreOptionsMenu,
    showNavigator,
    openRenameFileFlow,
} from "./explorer-context-menu.js";
export {
    setSheetContextMenuHandler,
    routeContextMenu,
    openEditorMoreOptionsMenu,
    showNavigator,
    openRenameFileFlow,
};

/**

/**
 * Resolve the parent folder for a `New …` action. Returns null when no
 * project is open — the menu items render in a disabled state so the user
 * discovers the affordance.
 * @returns {string | null}
 */
export function parentForCreation()
{
    if (!state.currentProject) return null;
    if (state.lastRightClickedFolder) return state.lastRightClickedFolder;
    return state.currentProject.path;
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
 * @param {string} uuid  registry UUID of the source file
 */
export async function onCopy(path, uuid)
{
    const log = /** @type {any} */ (window).__mpsLog;
    if (log) log("info", "onCopy", `start path=${path} uuid=${uuid}`);
    if (!uuid)
    {
        if (log) log("warn", "onCopy", "missing uuid — bailing");
        return;
    }
    try
    {
        await getBroker().withLock(async () =>
        {
            markSelfChange(path);
            const dto = await registryCopy(uuid);
            if (log) log("info", "onCopy", `ipc-ok(registry) new=${dto?.relPath}`);
            if (dto && state.currentProject && dto.relPath)
            {
                const projRoot = state.currentProject.path.replace(/[\\/]+$/, "");
                markSelfChange(`${projRoot}/${dto.relPath}`);
            }
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
 * Route an `app_rename_file` call through the broker so the autosave queue
 * is drained before the file moves. When the renamed file is the currently
 * open script, the broker is also updated to point at the new path so the
 * next save lands in the right place.
 * @param {string} oldPath
 * @param {string} newBasename
 * @returns {Promise<string | undefined>}
 */
// ── aggregate-view mount plumbing ────────────────────────────────────────
// Extracted to explorer-aggregate-mount.js. The folder-type-changed listener
// is wired at that module's load (side-effect import below). replaceActiveTab
// imports the routing helpers from there.
import {
    aggregateCompatible,
    resolveAggregateContext,
    openAggregateForFile,
    closeActiveAggregate,
} from "./explorer-aggregate-mount.js";


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
 * @param {string | null} [newUuid]  registry UUID for the file, if known
 * @returns {Promise<void>}
 */
export async function replaceActiveTab(newPath, newUuid = null)
{
    if (!newPath || !state.currentProject) return;
    // Normalise separator style before comparing — paths from row.dataset
    // can mix separators with what we set after a Rust-side rename.
    const norm = (p) => (p || "").replace(/\\/g, "/");
    const active = state.slotManager?.getActive();
    const outgoingPath = active?.path || null;
    const outgoingBase = active?.basename || "";
    if (norm(outgoingPath) === norm(newPath)) return;

    // ── aggregate-view routing ─────────────────────────────────────────
    // Storyboard/Screenplay folder-type folders trigger the 3-view
    // aggregate when the clicked file's format matches the folder mode.
    // Text-type + Default fall through to the single-file open path
    // below. If the clicked file is already inside the active aggregate,
    // just jumpToFile (no destroy/remount). If the aggregate is on a
    // different folder, close it and mount a fresh one.
    try
    {
        if (newUuid && renderGroupsAsOne)
        {
            const activeAgg = getActiveAggregate();
            // Locate parent folder + resolve type. When the file has no
            // folder parent (project-root file) parent lookup fails and
            // we drop straight to single-file open.
            const projectPath = state.currentProject.path;
            const entries = await listProjectTree(projectPath);
            const targetEntry = entries.find((e) => e.uuid === newUuid);
            const parentUuid = targetEntry?.parentUuid || null;
            const folderType = parentUuid
                ? await getFolderType(projectPath, parentUuid)
                : "default";
            if (folderType === "storyboard" || folderType === "screenplay")
            {
                const fileFormat = formatForFilename(basename(newPath));
                if (aggregateCompatible(folderType, fileFormat) && parentUuid)
                {
                    // Same folder + already mounted? Just jump.
                    if (activeAgg && activeAgg.folderUuid === parentUuid)
                    {
                        try { await activeAgg.jumpToFile(newUuid); }
                        catch (e) { console.warn("[explorer] jumpToFile failed:", e); }
                        return;
                    }
                    // Different folder — tear down previous.
                    if (activeAgg) await closeActiveAggregate();
                    const ctx = await resolveAggregateContext(newUuid, folderType);
                    if (ctx && ctx.files.length > 0)
                    {
                        // Drain the singleton editor's broker before we
                        // hide it. The aggregate uses its own per-file
                        // brokers; the singleton might still hold a
                        // pending write for the previously active tab.
                        try { await getBroker().drainAllPending(); }
                        catch (e) { console.warn("[explorer] singleton drain failed pre-aggregate:", e); }
                        // Best-effort initial mode = last user preference
                        // via the toggle. Aggregate view will re-validate.
                        const modeAttr = /** @type {any} */ (state.modeToggleEl)?.mode || "source";
                        const initialMode = (modeAttr === "easy" || modeAttr === "wysiwyg" || modeAttr === "source") ? modeAttr : "source";
                        await openAggregateForFile({
                            fileUuid: newUuid,
                            parentUuid,
                            folderName: ctx.folderName,
                            files: ctx.files,
                            basenameFor: ctx.basenameFor,
                            absPathFor: ctx.absPathFor,
                            mode: initialMode,
                        });
                        return;
                    }
                    // Fall through to single-file when we couldn't resolve
                    // a sibling list (e.g. registry hasn't caught up).
                }
            }
            // Format doesn't match folder type → fall through as single-file.
            // Any other folder type (default / text / null) also drops through.
            // If an aggregate is live for a different folder we DON'T close it
            // here — the click might be for a tab from the explorer that
            // opens alongside; but by contract we route through a single-file
            // tab so it's safer to close.
            if (activeAgg)
            {
                await closeActiveAggregate();
            }
        }
    }
    catch (e) { console.warn("[explorer] aggregate routing threw:", e); }
    // ────────────────────────────────────────────────────────────────────

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
        const outgoingRel = scriptRelPathOf(state.currentProject.path, outgoingPath);
        if (outgoingRel)
        {
            try
            {
                await setLastPageIndex(state.currentProject.path, outgoingRel, outgoingPageIndex);
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
        if (state.slotManager)
        {
            state.slotManager.replaceActive(newPath, newText, format, newUuid);
        }
        // Legacy mirror onto currentProject for the rest of app.js that still
        // reads `scriptPath` / `scriptBasename` / `script` directly.
        state.currentProject.scriptPath = newPath;
        state.currentProject.scriptBasename = newBase;
        state.currentProject.script = newText;

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
        broker.unlock(newPath, newUuid);

        // 5. Swap the mangaart cache so the storyboard side reflects the
        //    new script's drawings. Prefer the file's registry UUID — the
        //    path can go stale mid-rename/move but the UUID stays put.
        const newRel = scriptRelPathOf(state.currentProject.path, newPath);
        try
        {
            clearMangaartCache();
            if (newUuid)
            {
                const displayName = newBase.replace(/\.md$/i, "");
                await loadMangaartByUuid(state.currentProject.path, newUuid, displayName);
            }
            else
            {
                await loadMangaart(state.currentProject.path, newRel || newBase);
            }
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
            const incomingPageIndex = await getLastPageIndex(state.currentProject.path, newRel || newBase);
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
 * @param {string} oldPath
 * @param {string} newBasename
 * @param {string} uuid  registry UUID of the file being renamed
 * @returns {Promise<string | undefined>}
 */
export async function handleRename(oldPath, newBasename, uuid)
{
    const log = /** @type {any} */ (window).__mpsLog;
    if (log) log("info", "handleRename", `start oldPath=${oldPath} newBasename=${newBasename} uuid=${uuid}`);
    if (!uuid)
    {
        if (log) log("warn", "handleRename", "missing uuid — bailing");
        return undefined;
    }
    const broker = getBroker();
    const isActive = broker.isActiveUuid(uuid) || broker.isActivePath(oldPath);
    /** @type {string | undefined} */
    let newPath;
    try
    {
        await broker.withLock(async () =>
        {
            // withLock drained any in-flight saves before running this block, so
            // by the time we reach the rename there is no pending write to the
            // old path.
            markSelfChange(oldPath);
            const projectRoot = state.currentProject?.path;
            /** @type {string | undefined} */
            let result;
            const dto = await registryRename(uuid, newBasename);
            if (log) log("info", "handleRename", `ipc-ok(registry) rel=${dto?.relPath}`);
            if (dto && projectRoot && dto.relPath)
            {
                const rootNorm = projectRoot.replace(/[\\/]+$/, "");
                result = `${rootNorm}/${dto.relPath}`;
            }
            if (typeof result === "string")
            {
                newPath = result;
                markSelfChange(result);
            }
            if (isActive && typeof result === "string")
            {
                broker.unlock(result, uuid ?? broker.getActiveUuid());
                // Update the active slot so its tab label + dataset.path
                // reflect the new name, and mirror the new path/basename
                // onto currentProject (other modules read it directly).
                const activeSlot = state.slotManager?.getActive();
                if (activeSlot) state.slotManager.renamePath(activeSlot.tabId, result);
                if (state.currentProject)
                {
                    state.currentProject.scriptPath = result;
                    const base = basename(result);
                    if (base) state.currentProject.scriptBasename = base;
                }
                // Re-emit the Google Docs active-script signal so the footer's
                // internal activeScript cache reflects the new basename +
                // scriptRelPath. Without this the next pill click opens the
                // publish modal with the pre-rename localPath and preflightFile
                // throws fatal.config "local file not found".
                try
                {
                    if (state.currentProject && activeSlot && activeSlot.path)
                    {
                        const proj = state.currentProject.path;
                        const projNorm = proj.replace(/\\/g, "/");
                        const slotNorm = activeSlot.path.replace(/\\/g, "/");
                        const rel = slotNorm.startsWith(projNorm + "/")
                            ? slotNorm.slice(projNorm.length + 1)
                            : activeSlot.basename;
                        void setGoogleDocsActiveScript({
                            projectPath: proj,
                            scriptRelPath: rel,
                            basename: activeSlot.basename
                        });
                    }
                }
                catch (e) { console.warn("[google-docs] rename setActiveScript threw:", e); }
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
 * @param {string} uuid  registry UUID of the file being deleted
 */
export async function onDelete(path, uuid)
{
    const log = /** @type {any} */ (window).__mpsLog;
    if (log) log("info", "onDelete", `start path=${path} uuid=${uuid}`);
    if (!uuid)
    {
        if (log) log("warn", "onDelete", "missing uuid — bailing");
        return;
    }
    const broker = getBroker();
    const isActive = broker.isActiveUuid(uuid) || broker.isActivePath(path);
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
    await deleteFileByUuid(path, uuid);
}

/**
 * Trash-delete core: withLock + markSelfChange + registryDelete
 * (trash-unavailable → confirm + force), active-file slot-swap tail,
 * refreshExplorer. No leading open-file confirm — caller (onDelete for
 * desktop) owns that.
 *
 * @param {string} path
 * @param {string} uuid
 */
export async function deleteFileByUuid(path, uuid)
{
    const log = /** @type {any} */ (window).__mpsLog;
    const broker = getBroker();
    const isActive = broker.isActiveUuid(uuid) || broker.isActivePath(path);
    try
    {
        await broker.withLock(async () =>
        {
            try
            {
                markSelfChange(path);
                await registryDelete(uuid);
                if (log) log("info", "onDelete", "ipc-ok via trash");
            }
            catch (err)
            {
                const code = String((err && err.message) || err || "");
                if (log) log("warn", "onDelete", `registryDelete threw: ${code}`);
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
                    await registryDeleteForce(uuid);
                    if (log) log("info", "onDelete", "ipc-ok via force-delete");
                }
                else
                {
                    throw err;
                }
            }
            if (isActive)
            {
                broker.unlock(null, null);
                if (state.currentProject) state.currentProject.scriptPath = null;
            }
        });
        // Slot teardown + canvas wipe run OUTSIDE `withLock`.
        // `slotManager.close()` invokes `onCloseRequest`, which itself takes
        // `broker.withLock` to flush any pending autosave — the outer lock
        // must be released first or it deadlocks (queue never advances).
        // The canvas wipe reuses the erase-committed pathway so all pages'
        // strokes / cache / undo history are cleared, otherwise the just-
        // deleted file's storyboard lingers on screen.
        if (isActive)
        {
            const activeSlot = state.slotManager?.getActive();
            if (activeSlot) await state.slotManager.close(activeSlot.tabId);
            clearEditorAfterActiveDelete();
            document.dispatchEvent(new CustomEvent("mps-erase-storyboard-committed"));
        }
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
 * Kind → next-free-basename seed. Mirrors the Rust `create_file_impl`
 * mapping. Fake-fs stubs and the Rust `next_free_name` helper use the
 * same "Untitled" / "Untitled folder" seed.
 * @type {Record<string, { base: string, ext: string }>}
 */
const CREATE_KIND_SEED = {
    folder:      { base: "Untitled", ext: "" },
    mangaplay:   { base: "Untitled", ext: ".mangaplay.md" },
    fountain:    { base: "Untitled", ext: ".fountain.md" },
    superscript: { base: "Untitled", ext: ".sup.md" },
    text:        { base: "Untitled", ext: ".txt" },
};

/**
 * Compute the next-free basename under `parentUuid` matching the OLD
 * `next_free_name` sequence: `Untitled<ext>`, `Untitled 2<ext>`,
 * `Untitled 3<ext>`, ... Case-sensitive comparison — mirrors the fakefs stub
 * and the Rust implementation.
 * @param {string | null} parentUuid
 * @param {"folder"|"mangaplay"|"fountain"|"superscript"|"text"} kind
 * @returns {Promise<string>}
 */
async function computeNextFreeBasename(parentUuid, kind)
{
    const seed = CREATE_KIND_SEED[kind];
    if (!seed) throw new Error("invalid-kind");
    const tree = await registryListTree();
    const siblings = new Set(
        tree.filter((e) => (e.parentUuid ?? null) === parentUuid).map((e) => e.name)
    );
    const first = `${seed.base}${seed.ext}`;
    if (!siblings.has(first)) return first;
    for (let n = 2; n < 10000; n++)
    {
        const candidate = `${seed.base} ${n}${seed.ext}`;
        if (!siblings.has(candidate)) return candidate;
    }
    return `${seed.base} ${Date.now()}${seed.ext}`;
}

/**
 * Resolve `parent` (abs path) to a registry parentUuid. Returns `null` for
 * the project root; returns the tree entry's uuid otherwise. When no
 * matching entry is found (parent absent from the registry), returns
 * `undefined` so the caller can distinguish "root" from "not found".
 * @param {string} parent  absolute path to the parent directory
 * @returns {Promise<string | null | undefined>}
 */
async function resolveParentUuid(parent)
{
    if (!state.currentProject) return undefined;
    const rootNorm = state.currentProject.path.replace(/[\\/]+$/, "");
    if (parent === state.currentProject.path || parent === rootNorm) return null;
    const parentNorm = parent.replace(/\\/g, "/");
    const prefix = rootNorm.replace(/\\/g, "/") + "/";
    if (!parentNorm.startsWith(prefix)) return undefined;
    const rel = parentNorm.slice(prefix.length);
    if (!rel) return null;
    const tree = await registryListTree();
    const match = tree.find((e) => e.relPath === rel);
    return match ? match.uuid : undefined;
}

/**
 * Route a `New Folder / New Storyboard / New Screenplay` action through the
 * broker so any in-flight autosave flushes before the create. `parent` is
 * already null-checked by the disabled state in `buildExplorerMenu`; the
 * extra guard here is defensive in case the menu items are activated by a
 * keyboard path that bypasses `disabled`.
 *
 * The optional `target` opens a seam for the mobile explorer popup: it owns a
 * second mountFolderList instance (never `state.folderList`) and its own
 * refresh. When omitted, behaviour is byte-equivalent to the desktop path —
 * `refreshExplorer()` reseeds `state.folderList`, and no rename is auto-begun
 * (the desktop context menu does not chain into rename). When `target` is
 * given, after a successful create we `await target.refresh()` then begin
 * inline rename on `target.list`, mirroring the relPath-preferred identifier
 * that `openRenameFileFlow` / `onBeginRename` pass to `beginRename`
 * (uuid → relPath → basename cascade in folder-explorer.beginRename).
 *
 * @param {string | null} parent
 * @param {"folder"|"mangaplay"|"fountain"|"superscript"|"text"} kind
 * @param {{ list: any, refresh: () => Promise<void> } | null} [target]
 * @returns {Promise<string | undefined>} absolute path of the created entry.
 */
export async function onCreate(parent, kind, target = null)
{
    const log = /** @type {any} */ (window).__mpsLog;
    if (log) log("info", "onCreate", `start parent=${parent} kind=${kind} target=${!!target}`);
    if (!parent)
    {
        if (log) log("warn", "onCreate", "parent is null/empty — bailing");
        return undefined;
    }
    /** @type {string | undefined} */
    let createdPath;
    /**
     * Identifier for the post-create inline rename. Prefers the project-
     * relative path (disambiguates same-basename in other subfolders), same
     * preference as openRenameFileFlow; falls back to the basename.
     * @type {string | undefined}
     */
    let renameKey;
    try
    {
        // Prefer the tracked lastRightClickedFolderUuid when the parent
        // matches — saves a registryListTree round-trip. The abs-path
        // fallback covers keyboard-driven paths where no right-click set
        // the UUID (e.g. ctaCreateAndAdopt calling parentForCreation()).
        /** @type {string | null | undefined} */
        let parentUuid;
        if (state.lastRightClickedFolder && parent === state.lastRightClickedFolder && state.lastRightClickedFolderUuid)
        {
            parentUuid = state.lastRightClickedFolderUuid;
        }
        else
        {
            parentUuid = await resolveParentUuid(parent);
        }
        if (parentUuid === undefined)
        {
            if (log) log("warn", "onCreate", `no registry entry for parent=${parent} — bailing`);
            return undefined;
        }
        await getBroker().withLock(async () =>
        {
            const basename = await computeNextFreeBasename(parentUuid, kind);
            const dto = await registryCreateFile(parentUuid, basename, kind);
            if (log) log("info", "onCreate", `ipc-ok(registry) name=${dto?.name} rel=${dto?.relPath}`);
            const rootNorm = state.currentProject
                ? state.currentProject.path.replace(/[\\/]+$/, "")
                : "";
            if (dto && rootNorm && dto.relPath)
            {
                createdPath = `${rootNorm}/${dto.relPath}`;
                markSelfChange(createdPath);
            }
            // relPath preferred (project-relative, disambiguates), basename
            // fallback — mirrors openRenameFileFlow's key preference.
            if (dto) renameKey = dto.relPath || dto.name || undefined;
        });
        if (target)
        {
            await target.refresh();
            if (renameKey && target.list && typeof target.list.beginRename === "function")
            {
                try
                {
                    target.list.beginRename(renameKey);
                    if (log) log("info", "onCreate", `target.beginRename key=${renameKey}`);
                }
                catch (err)
                {
                    console.error("[explorer] target beginRename threw:", err);
                    if (log) log("error", "onCreate", `target beginRename threw: ${String((err && err.message) || err)}`);
                }
            }
        }
        else
        {
            await refreshExplorer();
        }
        if (log) log("info", "onCreate", `done created=${createdPath}`);
        return createdPath;
    }
    catch (err)
    {
        const msg = String((err && err.message) || err);
        console.error("[explorer] create failed:", err);
        if (log) log("error", "onCreate", `failed: ${msg}`);
        showBanner(t("mangaplay-studio.banner.createFailed", { error: msg }));
        return undefined;
    }
}

/**
 * Reset the cached document text after the active file is deleted. The
 * slot lifecycle is now owned by the slot manager — `slotManager.close()`
 * destroys the CM6 view and auto-spawns a fresh empty tab so the strip is
 * never empty. This helper only resets module-level state that lives
 * outside the slot record.
 */
export function clearEditorAfterActiveDelete()
{
    _setCurrentDoc("");
}
