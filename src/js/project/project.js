// @ts-check
/**
 * project.js — Project folder I/O + autosave.
 *
 * Project folder layout (current):
 *   <project>/
 *     _mangaplaystudio/                — reserved app-managed root (TEAM tier — checked into SVN)
 *       project.json                   — id + shared displayName + artMap
 *       registry.json + .bak           — UUID↔path registry
 *       meta.json                      — savedAt + folderTypes (slice-of-life keys moved to user-settings)
 *       storyboard/
 *         page-NNN.json                — per-page drawings
 *         <uuid>.mangaart              — script-associated drawing (root scripts)
 *         <script-rel-dir>/<uuid>.mangaart — mirrored hierarchy for nested scripts
 *     Untitled.mangaplay.md, ...       — user scripts at the root (recursive)
 *     <user folders>/                  — user-created folders at the root (recursive)
 *
 * Per-user "slice-of-life" state (open tabs, cursor positions, view mode,
 * expanded folders, canvas heights) lives OUT-of-tree in the OS user-settings
 * store under `projectSessions[<project.json.id>]`. See loadSession /
 * saveSession below. Legacy on-disk `_mangaplaystudio/settings/session.json`
 * is migrated once on project open and then deleted.
 *
 * The previous four-sibling layout (`project.json`/`meta.json`/`storyboard/`/`mangaplay_settings/`
 * at the project root) is NOT supported — projects from older builds will not open.
 */

// ── Tauri bridge ──
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isTauri } from "../util/index.js";
import { debounce } from "../util/index.js";
import { registryListTree, mangaartResolveByFolderUuid } from "../adapters/tauri-storage.js";

import {
    dispatchFakeInvoke,
    _resetFakeFsForTest,
    _resetFakeArtMapForTest,
    _resetFakeScriptMapForTest,
} from "./fake-fs.js";
import { loadSpellcheckStore } from "../spellcheck/spellcheck-store.js";

// Re-export the fake-fs test helpers so existing importers
// (tests/*.test.js) keep resolving them from project.js.
export { _resetFakeFsForTest, _resetFakeArtMapForTest, _resetFakeScriptMapForTest };

/**
 * Test helper. Direct passthrough to the private `invoke` dispatcher so
 * tests can exercise FS commands (`slides_link_get`, etc.) that don't have
 * dedicated public wrappers. Only used by tests/fakefs.test.js.
 * @param {string} cmd
 * @param {any} [args]
 * @returns {Promise<any>}
 */
export function _invokeForTest(cmd, args)
{
    return invoke(cmd, args);
}

async function invoke(cmd, args) {
    if (isTauri()) {
        return tauriInvoke(cmd, args);
    }
    // Browser/test stubs — delegated to fake-fs.js. `projectJsonCache` +
    // `stripMdSuffix` are passed through so the `scriptmap_get_or_mint`
    // stub can merge into the very same cache production reads mutate.
    return dispatchFakeInvoke(cmd, args, { stripMdSuffix, projectJsonCache });
}

/**
 * Per-artifact mangaart entry.
 *
 * @typedef MangaartCacheEntry
 * @property {object} art          The mangaart JSON blob (pages, meta, etc.).
 * @property {string} projectPath  Absolute project path this entry belongs to.
 * @property {string | null} resolvedPath  Absolute on-disk `.mangaart` path (null when never resolved).
 * @property {boolean} dirty       True if in-memory state is ahead of disk.
 * @property {number} updatedAt    `Date.now()` of last mutation.
 */

/**
 * Keyed cache of mangaart entries. Keys are namespaced strings:
 *   `"file:<script-uuid>"`   — per-file storyboards.
 *   `"folder:<folder-uuid>"` — per-folder storyboards (aggregate view).
 *
 * Grows with the number of files a user opens in a session. TODO(phase2):
 * aggregate-view can call `clearMangaartCacheEntry(key)` on close for LRU
 * bookkeeping — file counts per project are low today, so no cap yet.
 *
 * @type {Map<string, MangaartCacheEntry>}
 */
const mangaartCache = new Map();

/**
 * Key of the most recently loaded/mutated entry — the "active" artifact
 * for the purposes of the legacy `getMangaartCache()` /
 * `updateMangaartPage()` / path-based `saveMangaart()` wrappers. Set by
 * every `loadMangaart*` / `updateMangaartPage` / `saveMangaart*` call;
 * cleared when the whole cache clears.
 *
 * @type {string | null}
 */
let mangaartActiveKey = null;

/**
 * Build a cache key for a file-scoped mangaart entry.
 * @param {string} uuid
 * @returns {string}
 */
function fileKey(uuid)
{
    return "file:" + uuid;
}

/**
 * Build a cache key for a folder-scoped mangaart entry.
 * @param {string} uuid
 * @returns {string}
 */
function folderKey(uuid)
{
    return "folder:" + uuid;
}

/**
 * Store `art` under `key`, creating the entry when it doesn't exist yet.
 * Sets `mangaartActiveKey` so subsequent legacy wrappers see this entry.
 * @param {string} key
 * @param {object} art
 * @param {string} projectPath
 * @param {string | null} resolvedPath
 * @returns {MangaartCacheEntry}
 */
function putMangaartEntry(key, art, projectPath, resolvedPath)
{
    const entry = {
        art,
        projectPath,
        resolvedPath,
        dirty: false,
        updatedAt: Date.now(),
    };
    mangaartCache.set(key, entry);
    mangaartActiveKey = key;
    return entry;
}

/**
 * Strip a trailing `.md` (case-insensitive) from a filename.
 * @param {string} name
 * @returns {string}
 */
function stripMdSuffix(name)
{
    if (!name) return "Untitled";
    return name.replace(/\.md$/i, "");
}

// ── Project API ──

/**
 * Open a project from a folder path. The Rust side always returns
 * `{ status: "ok", project: {...} }`; any other shape is treated as a bug.
 *
 * @param {string} projectPath — absolute path to the project folder
 * @returns {Promise<{path: string, id: string | null, name: string, script: string, scriptPath: string | null, scriptBasename: string, drawings: Record<string, object>, meta: object}>}
 */
export async function openProject(projectPath) {
    const result = await invoke("project_open", { path: projectPath });

    if (!result || result.status !== "ok")
    {
        throw new Error("unknown-open-result");
    }

    const project = result.project || {};

    // Derive project name from folder name
    const name = projectPath.split("/").pop() || projectPath.split("\\").pop() || "Untitled";
    const scriptFile = project.scriptFile || "";
    // Consolidated layout: scripts live at <project>/<relative-name>. scriptFile
    // is already a forward-slash-joined relative path from the Rust walker.
    const scriptPath = scriptFile ? `${projectPath}/${scriptFile}` : null;
    const scriptBasename = scriptFile || "Untitled.mangaplay.md";
    const id = typeof project.id === "string" && project.id.length > 0 ? project.id : null;

    // Run the one-shot user-session migration BEFORE returning. Idempotent —
    // no-op on projects that have already migrated (legacy session.json
    // absent + meta.json already slim).
    if (id)
    {
        try { await migrateProjectSessionFromDisk(projectPath, id, project.meta || {}); }
        catch (e) { console.warn("[session] migrate failed:", e); }
    }

    try { await loadSpellcheckStore(projectPath); }
    catch (e) { console.warn("[spellcheck] store load failed:", e); }

    return {
        path: projectPath,
        id,
        name,
        script: project.script || "",
        scriptPath,
        scriptBasename,
        drawings: project.drawings || {},
        meta: project.meta || {},
        locked: project.locked === true,
    };
}

/**
 * Create a seeded Untitled.mangaplay.md at the root of the given project.
 * Mirrors the Rust project_create_new_impl seed in src-tauri/src/lib.rs so
 * both paths produce identical scaffolding.
 * @param {string} projectPath
 * @returns {Promise<string>} The full path to the new file.
 */
export async function createUntitled(projectPath)
{
    const path = `${projectPath}/Untitled.mangaplay.md`;
    await saveScript(path, "# Page 1\nPanel 1\nAction line.\n");
    return path;
}

/**
 * Save the script to the project's .mangaplay.md file.
 * Uses atomic write (tmp → fsync → rename).
 * @param {string} scriptPath — full path to the .mangaplay.md file
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function saveScript(scriptPath, text) {
    await invoke("atomic_write_project_file", {
        path: scriptPath,
        contents: text,
    });
}

/**
 * Resolve the on-disk `.mangaart` path for a script via the project.json
 * artMap. Returns null when no mapping exists (caller should scaffold).
 * @param {string} projectPath
 * @param {string} scriptBasename — e.g. "foo/bar/baz.mangaplay.md"
 * @returns {Promise<string|null>}
 */
async function resolveArtPath(projectPath, scriptBasename)
{
    const result = await invoke("mangaart_resolve_path", {
        projectPath,
        scriptFile: scriptBasename,
    });
    return result == null ? null : result;
}

/**
 * Load-only variant of the project's `.mangaart` file into the module cache.
 * Returns an in-memory empty scaffold when nothing is on disk — does NOT
 * create the `.mangaart` file. The physical file only lands on first save
 * (see {@link saveMangaartByUuid}). UUID minting into scriptMap still
 * happens on load so save has a stable target.
 * @param {string} projectPath
 * @param {string} scriptBasename — e.g. "Untitled.mangaplay.md"
 * @returns {Promise<object>}
 */
export async function loadMangaart(projectPath, scriptBasename)
{
    // Legacy path-based load. Callers today: open-and-mount-project.js,
    // explorer.js, project-switcher.js — all fallback paths for the boot
    // window before the active file's UUID has resolved. There's no UUID
    // available here, so the entry is keyed by scriptBasename under a
    // synthetic namespace so it doesn't collide with `file:<uuid>` keys.
    const key = "path:" + scriptBasename;
    const path = await resolveArtPath(projectPath, scriptBasename);
    if (path)
    {
        try
        {
            const contents = await invoke("read_project_file", { path });
            if (contents)
            {
                const art = JSON.parse(contents);
                putMangaartEntry(key, art, projectPath, path);
                return art;
            }
        }
        catch (err)
        {
            // fall through to load-only (returns in-memory scaffold when no file)
        }
    }
    const loaded = await invoke("mangaart_load", { projectPath, scriptFile: scriptBasename });
    putMangaartEntry(key, loaded, projectPath, path);
    return loaded;
}

/**
 * Persist the in-memory `.mangaart` cache via atomic write. No-op if no cache.
 * Resolves the storyboard path via the project.json artMap. If no mapping
 * exists at save time, this means saveMangaart was called for a script that
 * was never loaded/scaffolded — a call-site bug. Log + bail; do not silently
 * scaffold.
 * @param {string} projectPath
 * @param {string} scriptBasename
 * @returns {Promise<void>}
 */
export async function saveMangaart(projectPath, scriptBasename)
{
    const key = "path:" + scriptBasename;
    const entry = mangaartCache.get(key);
    if (!entry) return;
    entry.art.updatedAt = new Date().toISOString();
    entry.updatedAt = Date.now();
    const path = await resolveArtPath(projectPath, scriptBasename);
    if (!path)
    {
        console.warn(
            "saveMangaart: no artMap entry for",
            scriptBasename,
            "— skipping save (load before save)",
        );
        return;
    }
    entry.resolvedPath = path;
    await invoke("atomic_write_project_file", {
        path,
        contents: JSON.stringify(entry.art, null, 2),
    });
    entry.dirty = false;
}

/**
 * UUID-first mangaart load. Address the .mangaart file by the script's
 * registry UUID rather than by its project-relative path. Rename/move can't
 * desynchronise the mapping because the UUID never changes.
 *
 * Load-only: returns an in-memory empty scaffold when nothing is on disk —
 * does NOT create the `.mangaart` file. The physical file only lands on
 * first save via {@link saveMangaartByUuid}.
 *
 * @param {string} projectPath
 * @param {string} uuid       — script's registry UUID
 * @param {string} [displayName] — optional stem for the scaffold's `name` field
 * @returns {Promise<object>}
 */
export async function loadMangaartByUuid(projectPath, uuid, displayName)
{
    const key = fileKey(uuid);
    // Reuse the cached entry when we've already loaded this file this
    // session. Phase-1 behaviour change vs. the old scalar: switching
    // files no longer forces a re-read from disk because entries survive
    // per-key. Correct because every write path also goes through the
    // Map. TODO(phase2): aggregate view can call clearMangaartCacheEntry
    // for LRU trim on file-close.
    const cached = mangaartCache.get(key);
    if (cached && cached.projectPath === projectPath)
    {
        mangaartActiveKey = key;
        return cached.art;
    }
    const path = await invoke("mangaart_resolve_by_uuid", { projectPath, uuid });
    if (path)
    {
        try
        {
            const contents = await invoke("read_project_file", { path });
            if (contents)
            {
                const art = JSON.parse(contents);
                putMangaartEntry(key, art, projectPath, path);
                return art;
            }
        }
        catch (_err)
        {
            // fall through to load-only (returns in-memory scaffold when no file)
        }
    }
    const loaded = await invoke("mangaart_load_by_uuid", {
        projectPath,
        uuid,
        displayName: displayName ?? null,
    });
    putMangaartEntry(key, loaded, projectPath, path);
    return loaded;
}

/**
 * UUID-first mangaart save. See loadMangaartByUuid — this is the write-side
 * companion. Bails silently when there's no cache (call load before save).
 *
 * @param {string} projectPath
 * @param {string} uuid
 * @returns {Promise<void>}
 */
export async function saveMangaartByUuid(projectPath, uuid)
{
    const key = fileKey(uuid);
    const entry = mangaartCache.get(key);
    if (!entry) return;
    entry.art.updatedAt = new Date().toISOString();
    entry.updatedAt = Date.now();
    const path = await invoke("mangaart_resolve_by_uuid", { projectPath, uuid });
    if (!path)
    {
        // No file yet — scaffold on demand so the save has a target.
        await invoke("mangaart_scaffold_by_uuid", {
            projectPath,
            uuid,
            displayName: null,
        });
    }
    const resolved = path
        || (await invoke("mangaart_resolve_by_uuid", { projectPath, uuid }));
    if (!resolved)
    {
        console.warn("saveMangaartByUuid: could not resolve path for", uuid);
        return;
    }
    entry.resolvedPath = resolved;
    await invoke("atomic_write_project_file", {
        path: resolved,
        contents: JSON.stringify(entry.art, null, 2),
    });
    entry.dirty = false;
}

/**
 * Update a single page's drawing in the in-memory cache. No-op if no cache.
 * @param {number} pageIndex — 0-based page index
 * @param {object} drawing
 * @returns {void}
 */
export function updateMangaartPage(pageIndex, drawing)
{
    if (!mangaartActiveKey) return;
    const entry = mangaartCache.get(mangaartActiveKey);
    if (!entry) return;
    const art = entry.art;
    if (!Array.isArray(art.pages)) art.pages = [];
    const existing = art.pages.find((p) => p.index === pageIndex);
    if (existing)
    {
        existing.drawing = drawing;
    }
    else
    {
        art.pages.push({ index: pageIndex, drawing, preview: null });
    }
    entry.dirty = true;
    entry.updatedAt = Date.now();
}

/**
 * Clear the in-memory `.mangaart` cache. Call on project close.
 * @returns {void}
 */
export function clearMangaartCache()
{
    mangaartCache.clear();
    mangaartActiveKey = null;
}

/**
 * Drop a single mangaart cache entry by its namespaced key
 * (`"file:<uuid>"` or `"folder:<uuid>"`). Used by aggregate-view LRU trim
 * and by folder revert-to-default. No-op when the key is absent.
 * @param {string} key
 * @returns {void}
 */
export function clearMangaartCacheEntry(key)
{
    mangaartCache.delete(key);
    if (mangaartActiveKey === key) mangaartActiveKey = null;
}

/**
 * Full storyboard erase: drop the artMap entry, trash the `.mangaart` file,
 * clear the in-memory cache. Idempotent. Next draw scaffolds a new UUID.
 * Does NOT delete the source script — that's `registryDelete`'s job.
 * @param {string} projectPath
 * @param {string} uuid
 * @returns {Promise<void>}
 */
export async function eraseMangaart(projectPath, uuid)
{
    await invoke("mangaart_erase", { projectPath, uuid });
    clearMangaartCache();
}

/**
 * Read-only access to the in-memory .mangaart cache entry for the most
 * recently loaded/mutated artifact (the "active" one). Returns the raw
 * `art` JSON blob so external callers see the same shape they saw before
 * the scalar→Map refactor.
 *
 * @deprecated Prefer {@link getMangaartCacheByKey} — capturing the entry
 * by explicit key at schedule time eliminates the race window where a
 * scheduled save reads the wrong entry after the user switches files
 * during the debounce window.
 * @returns {object | null}
 */
export function getMangaartCache()
{
    if (!mangaartActiveKey) return null;
    const entry = mangaartCache.get(mangaartActiveKey);
    return entry ? entry.art : null;
}

/**
 * Look up a cached mangaart entry by its namespaced key
 * (`"file:<uuid>"` or `"folder:<uuid>"`). Returns null when the key is
 * absent. The returned `art` reference is live — mutations propagate.
 * @param {string} key
 * @returns {MangaartCacheEntry | null}
 */
export function getMangaartCacheByKey(key)
{
    return mangaartCache.get(key) || null;
}

/**
 * Load (or scaffold) a folder-scoped mangaart artifact into the cache
 * under `"folder:<uuid>"`. Mirror of {@link loadMangaartByUuid}.
 * No caller yet — used by the aggregate view when wired in.
 *
 * @param {string} projectPath
 * @param {string} folderUuid
 * @param {string} [displayName] — unused today; kept for signature parity.
 * @returns {Promise<object | null>}
 */
// eslint-disable-next-line no-unused-vars
export async function loadMangaartForFolder(projectPath, folderUuid, displayName)
{
    const key = folderKey(folderUuid);
    const cached = mangaartCache.get(key);
    if (cached && cached.projectPath === projectPath)
    {
        mangaartActiveKey = key;
        return cached.art;
    }
    const path = await mangaartResolveByFolderUuid(projectPath, folderUuid);
    if (!path)
    {
        console.warn("loadMangaartForFolder: resolver returned null for", folderUuid);
        return null;
    }
    try
    {
        const contents = await invoke("read_project_file", { path });
        if (contents)
        {
            const art = JSON.parse(contents);
            putMangaartEntry(key, art, projectPath, path);
            return art;
        }
    }
    catch (_err)
    {
        // File may not exist yet — folder-level mangaart is created on
        // first draw. Seed an empty entry so subsequent updateMangaartPage
        // + saveMangaartForFolder land in a well-formed shape.
    }
    const seeded = { pages: [], updatedAt: new Date().toISOString() };
    putMangaartEntry(key, seeded, projectPath, path);
    return seeded;
}

/**
 * Persist a folder-scoped mangaart entry. Mirror of {@link saveMangaartByUuid}.
 * No caller yet — used by the aggregate view when wired in.
 *
 * @param {string} projectPath
 * @param {string} folderUuid
 * @returns {Promise<void>}
 */
export async function saveMangaartForFolder(projectPath, folderUuid)
{
    const key = folderKey(folderUuid);
    const entry = mangaartCache.get(key);
    if (!entry) return;
    entry.art.updatedAt = new Date().toISOString();
    entry.updatedAt = Date.now();
    const path = entry.resolvedPath
        || (await mangaartResolveByFolderUuid(projectPath, folderUuid));
    if (!path)
    {
        console.warn("saveMangaartForFolder: could not resolve path for", folderUuid);
        return;
    }
    entry.resolvedPath = path;
    await invoke("atomic_write_project_file", {
        path,
        contents: JSON.stringify(entry.art, null, 2),
    });
    entry.dirty = false;
}

/**
 * Save meta.json for the project. Path mirrors the Rust nested layout:
 * `<projectPath>/_mangaplaystudio/meta.json`.
 *
 * Team tier only. Persistent slice-of-life state (`viewMode`, `lastSoloMode`,
 * `expandedFolders`, `aggregateHeights`, `heightsCacheGeneration`,
 * `lastOpened`) lives in the OS user-settings tier under
 * `projectSessions[uuid]` — those keys are stripped here defensively in
 * case a stale in-memory meta reference still carries them across the
 * migration boundary.
 *
 * Sparse-field rule: `folderTypes` is only written when non-empty. An empty
 * `{}` is stripped from the serialised body so meta.json diffs stay quiet
 * for projects that never opted into folder-typing.
 *
 * @param {string} projectPath
 * @param {object} meta
 * @returns {Promise<void>}
 */
export async function saveMeta(projectPath, meta) {
    const metaPath = `${projectPath}/_mangaplaystudio/meta.json`;
    const payload = {
        ...meta,
        savedAt: new Date().toISOString(),
    };
    // Slice-of-life keys live in per-user projectSessions[uuid] now — strip
    // them defensively in case a stale in-memory meta reference still carries
    // them across the migration boundary.
    delete payload.viewMode;
    delete payload.lastSoloMode;
    delete payload.expandedFolders;
    delete payload.aggregateHeights;
    delete payload.heightsCacheGeneration;
    delete payload.lastOpened;
    // folderTypes: sparse — drop empty maps so meta.json stays clean.
    if (payload.folderTypes && typeof payload.folderTypes === "object"
        && Object.keys(payload.folderTypes).length === 0)
    {
        delete payload.folderTypes;
    }
    await invoke("atomic_write_project_file", {
        path: metaPath,
        contents: JSON.stringify(payload, null, 2),
    });
}

// ── Folder types ─────────────────────────────────────────────────────────
// Extracted to folder-types.js (getFolderType / setFolderType). Re-exported
// so the shell + explorer importers keep resolving them from project.js.
export { getFolderType, setFolderType } from "./folder-types.js";


// ── session (per-user, keyed by project UUID) ────────────────────────────
//
// Per-project state that survives a file-swap. Lives inside the OS
// user-settings.json under `projectSessions[<project.json.id>]`, NOT in the
// project's `_mangaplaystudio/` folder. Renaming/moving the project folder
// preserves this state because the UUID never changes; two SVN checkouts
// of the same project on the same machine intentionally share it.
//
// Shape (all fields optional; missing keys treated as defaults):
//   {
//       lastPageIndex: { "<scriptBasename>": <number>, ... },
//       openTabs:     [ { id, path, fileUuid } ],
//       activeTabId:  string | null,
//       aggregateSession: { folderUuid, focusedFileUuid, scrollTop } | absent,
//       viewMode, lastSoloMode, expandedFolders, aggregateHeights,
//       heightsCacheGeneration, lastOpened
//   }
// Errors are swallowed — session state is best-effort, never blocking.

/** @type {Map<string, string>} projectPath → project UUID. */
const projectUuidCache = new Map();
/** @type {Map<string, object>} projectPath → parsed session entry (cached in memory for spam-write coalescing). */
const sessionCache = new Map();

function sessionKey(scriptBasename)
{
    return stripMdSuffix(scriptBasename || "");
}

/**
 * Resolve the project's UUID (`project.json.id`) from an absolute path.
 * Cached per projectPath because the UUID is stable for the lifetime of
 * the folder. Returns `null` when the file is missing or malformed —
 * callers treat null as "session state unavailable, no-op".
 * @param {string} projectPath
 * @returns {Promise<string | null>}
 */
export async function resolveProjectUuid(projectPath)
{
    if (!projectPath) return null;
    if (projectUuidCache.has(projectPath))
    {
        return /** @type {string} */ (projectUuidCache.get(projectPath));
    }
    try
    {
        const pj = await loadProjectJson(projectPath);
        const id = typeof pj.id === "string" && pj.id.length > 0 ? pj.id : null;
        if (id) projectUuidCache.set(projectPath, id);
        return id;
    }
    catch (_)
    {
        return null;
    }
}

/**
 * Load (or initialise) the per-project session entry from user-settings.
 * Cached per projectPath. Returns validated shape — the same coerced keys
 * as the legacy on-disk session.json for source-level continuity, plus the
 * moved-from-meta keys (`viewMode`, `lastSoloMode`, `expandedFolders`,
 * `aggregateHeights`, `heightsCacheGeneration`, `lastOpened`).
 *
 * @param {string} projectPath
 * @returns {Promise<{ version: number, lastPageIndex: Record<string, number>, openTabs: Array<{ id: string, path: string|null, fileUuid: string|null }>, activeTabId: string|null, [k: string]: any }>}
 */
export async function loadSession(projectPath)
{
    if (sessionCache.has(projectPath)) return sessionCache.get(projectPath);
    /** @type {{ version: number, lastPageIndex: Record<string, number>, openTabs: Array<{ id: string, path: string|null, fileUuid: string|null }>, activeTabId: string|null, [k: string]: any }} */
    let parsed = { version: 1, lastPageIndex: {}, openTabs: [], activeTabId: null };
    try
    {
        const uuid = await resolveProjectUuid(projectPath);
        if (uuid)
        {
            const { getProjectSession } = await import("./user-settings.js");
            const data = getProjectSession(uuid);
            if (data && typeof data === "object")
            {
                const validated = {
                    version: 1,
                    lastPageIndex: (data.lastPageIndex && typeof data.lastPageIndex === "object")
                        ? data.lastPageIndex
                        : {},
                    openTabs: Array.isArray(data.openTabs) ? data.openTabs : [],
                    activeTabId: (typeof data.activeTabId === "string") ? data.activeTabId : null
                };
                parsed = { ...data, ...validated };
            }
        }
    }
    catch
    {
        // Missing UUID or user-settings unavailable — start from the default.
    }
    sessionCache.set(projectPath, parsed);
    return parsed;
}

/**
 * Write the in-memory session entry back to user-settings. Idempotent;
 * safe to spam. No-op if the project UUID cannot be resolved.
 * @param {string} projectPath
 */
export async function saveSession(projectPath)
{
    const data = sessionCache.get(projectPath);
    if (!data) return;
    try
    {
        const uuid = await resolveProjectUuid(projectPath);
        if (!uuid) return;
        const { saveProjectSession } = await import("./user-settings.js");
        // saveSession owns lastPageIndex + openTabs + activeTabId only.
        // Other slice-of-life keys (expandedFolders, aggregateHeights,
        // heightsCacheGeneration, storyboardDisplay) are written directly
        // by their owners via saveProjectSession. Writing the whole
        // sessionCache back would clobber those fields with stale values
        // (sessionCache is populated once on project open and never
        // reconciled with direct writes) — see the bug where collapsing
        // folders + opening a root file re-expanded them because the
        // stale expandedFolders snapshot got flushed by setLastPageIndex.
        const patch = /** @type {Record<string, any>} */ ({});
        if (data.lastPageIndex && typeof data.lastPageIndex === "object")
        {
            patch.lastPageIndex = data.lastPageIndex;
        }
        if (Array.isArray(data.openTabs)) patch.openTabs = data.openTabs;
        if (typeof data.activeTabId === "string" || data.activeTabId === null)
        {
            patch.activeTabId = data.activeTabId;
        }
        await saveProjectSession(uuid, patch);
    }
    catch (err)
    {
        console.warn("[session] save failed:", err);
    }
}

/**
 * One-shot migration on project open. Copies legacy
 * `_mangaplaystudio/settings/session.json` + slice-of-life keys from
 * `_mangaplaystudio/meta.json` into user-settings' `projectSessions[uuid]`,
 * then slims meta.json + deletes the legacy session file / settings dir.
 * Idempotent — no-op when both inputs are already empty.
 *
 * @param {string} projectPath
 * @param {string} projectUuid
 * @param {Record<string, any>} metaFromRust  — meta.json content as returned by project_open
 * @returns {Promise<void>}
 */
async function migrateProjectSessionFromDisk(projectPath, projectUuid, metaFromRust)
{
    const legacySessionPath = `${projectPath}/_mangaplaystudio/settings/session.json`;
    const legacyDirPath = `${projectPath}/_mangaplaystudio/settings`;
    const metaPath = `${projectPath}/_mangaplaystudio/meta.json`;

    // ── Read legacy session.json (may be absent). ──
    /** @type {Record<string, any>} */
    let legacySession = {};
    try
    {
        const raw = await invoke("read_project_file", { path: legacySessionPath });
        if (raw)
        {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") legacySession = parsed;
        }
    }
    catch (_) { /* absent — expected after migration */ }

    // ── Extract slice-of-life keys from meta. ──
    const SLICE_KEYS = [
        "viewMode", "lastSoloMode", "expandedFolders",
        "aggregateHeights", "heightsCacheGeneration", "lastOpened",
    ];
    /** @type {Record<string, any>} */
    const metaSlice = {};
    if (metaFromRust && typeof metaFromRust === "object")
    {
        for (const k of SLICE_KEYS)
        {
            if (Object.prototype.hasOwnProperty.call(metaFromRust, k))
            {
                metaSlice[k] = metaFromRust[k];
            }
        }
    }

    const hasLegacySession = Object.keys(legacySession).length > 0;
    const hasMetaSlice = Object.keys(metaSlice).length > 0;

    // ── Fast-exit when there's nothing to migrate. ──
    if (!hasLegacySession && !hasMetaSlice) return;

    // ── Merge into projectSessions[uuid]. ──
    const payload = { ...legacySession, ...metaSlice };
    // Drop the legacy `version` key — user-settings tier doesn't need it.
    delete payload.version;

    try
    {
        const userSettings = await import("./user-settings.js");
        // Migration runs during project open, which itself may fire before
        // boot has awaited loadUserSettings() in headless / test paths.
        // Skip silently — the next open after loadUserSettings will retry.
        try { userSettings.getUserSetting("format"); }
        catch (_) { return; }
        await userSettings.saveProjectSession(projectUuid, payload);
    }
    catch (e)
    {
        console.warn("[session] saveProjectSession during migration failed:", e);
        return;
    }

    // ── Slim meta.json: strip slice-of-life keys, keep team keys. ──
    if (hasMetaSlice && metaFromRust && typeof metaFromRust === "object")
    {
        /** @type {Record<string, any>} */
        const slim = {};
        if (typeof metaFromRust.savedAt === "string") slim.savedAt = metaFromRust.savedAt;
        if (metaFromRust.folderTypes && typeof metaFromRust.folderTypes === "object"
            && Object.keys(metaFromRust.folderTypes).length > 0)
        {
            slim.folderTypes = metaFromRust.folderTypes;
        }
        slim.savedAt = new Date().toISOString();
        try
        {
            await invoke("atomic_write_project_file", {
                path: metaPath,
                contents: JSON.stringify(slim, null, 2),
            });
            // Mutate the caller's meta reference so callers reading
            // `state.currentProject.meta` don't see stale slice-of-life keys.
            for (const k of SLICE_KEYS)
            {
                delete /** @type {any} */ (metaFromRust)[k];
            }
        }
        catch (e)
        {
            console.warn("[session] meta slim write failed:", e);
        }
    }

    // ── Delete legacy session.json + settings/ dir (best-effort). ──
    try { await invoke("app_internal_remove_project_file", { path: legacySessionPath }); }
    catch (_) { /* already gone / not a file */ }
    try { await invoke("app_internal_remove_empty_project_dir", { path: legacyDirPath }); }
    catch (_) { /* dir may still contain fold-state.json etc. — leave it */ }
}

/**
 * Read the last viewed page index for a script. Returns 0 when no entry
 * exists (cold load of a never-opened file).
 * @param {string} projectPath
 * @param {string} scriptBasename
 * @returns {Promise<number>}
 */
export async function getLastPageIndex(projectPath, scriptBasename)
{
    const data = await loadSession(projectPath);
    const v = data.lastPageIndex[sessionKey(scriptBasename)];
    return Number.isFinite(v) ? Number(v) : 0;
}

/**
 * Record the last viewed page index for a script. Writes through to disk.
 * No-op if value is non-finite.
 * @param {string} projectPath
 * @param {string} scriptBasename
 * @param {number} pageIndex
 */
export async function setLastPageIndex(projectPath, scriptBasename, pageIndex)
{
    if (!Number.isFinite(pageIndex)) return;
    const data = await loadSession(projectPath);
    data.lastPageIndex[sessionKey(scriptBasename)] = Number(pageIndex);
    await saveSession(projectPath);
}

/**
 * Read the saved tab snapshot for a project. Returns `{ openTabs: [], activeTabId: null }`
 * when no entry exists.
 * @param {string} projectPath
 * @returns {Promise<{ openTabs: Array<{ id: string, path: string|null, fileUuid: string|null }>, activeTabId: string|null }>}
 */
export async function getTabSnapshot(projectPath)
{
    const data = await loadSession(projectPath);
    /** @type {any} */
    const d = data;
    const openTabs = Array.isArray(d.openTabs) ? d.openTabs.filter((t) =>
        t && typeof t === "object" && typeof t.id === "string"
        && (t.path === null || typeof t.path === "string")
    ).map((t) => ({
        id: t.id,
        path: t.path === null ? null : String(t.path),
        // Legacy entries had no fileUuid; tolerate undefined.
        fileUuid: typeof t.fileUuid === "string" ? t.fileUuid : null,
    })) : [];
    const activeTabId = typeof d.activeTabId === "string" ? d.activeTabId : null;
    return { openTabs, activeTabId };
}

/**
 * Persist the tab snapshot for a project. Idempotent; spam-safe (caller debounces).
 * @param {string} projectPath
 * @param {{ openTabs: Array<{ id: string, path: string|null, fileUuid?: string|null }>, activeTabId: string|null }} snap
 */
export async function setTabSnapshot(projectPath, snap)
{
    const data = await loadSession(projectPath);
    /** @type {any} */
    const d = data;
    d.openTabs = (snap.openTabs || []).map((t) => ({
        id: String(t.id),
        path: t.path === null ? null : String(t.path),
        fileUuid: t.fileUuid == null ? null : String(t.fileUuid),
    }));
    d.activeTabId = snap.activeTabId == null ? null : String(snap.activeTabId);
    await saveSession(projectPath);
}

// ── aggregateSession ──────────────────────────────────────────────────────
//
// The aggregate view persists a small tuple to session.json so restore
// can re-mount the same folder + focused file + scroll position across
// close/reopen. Sparse: `null` while no aggregate is mounted so single-
// file sessions never see the key at all. `historySnapshots` is NOT
// persisted — undo across a close/reopen is scoped to the single-file
// behaviour we already have, which is "empty history on reopen."
//
// Shape: { folderUuid, focusedFileUuid, scrollTop } | null.

/**
 * Read the persisted aggregate session for a project, or null when absent
 * / malformed. loadSession's spread preserves the on-disk value even when
 * this reader isn't called — the reader is here so consumers get a
 * validated, coerced object shape.
 * @param {string} projectPath
 * @returns {Promise<{ folderUuid: string, focusedFileUuid: string, scrollTop: number } | null>}
 */
export async function getAggregateSession(projectPath)
{
    const data = await loadSession(projectPath);
    const raw = /** @type {any} */ (data).aggregateSession;
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.folderUuid !== "string" || raw.folderUuid.length === 0) return null;
    if (typeof raw.focusedFileUuid !== "string" || raw.focusedFileUuid.length === 0) return null;
    const st = Number(raw.scrollTop);
    return {
        folderUuid: raw.folderUuid,
        focusedFileUuid: raw.focusedFileUuid,
        scrollTop: Number.isFinite(st) ? st : 0,
    };
}

/**
 * Write the aggregate session for a project. Pass `null` to CLEAR the
 * entry (rather than write `null` — the loader treats absent/null the
 * same on read, but the writer strips it so meta diffs stay quiet).
 *
 * @param {string} projectPath
 * @param {{ folderUuid: string, focusedFileUuid: string, scrollTop: number } | null} session
 */
export async function setAggregateSession(projectPath, session)
{
    const data = await loadSession(projectPath);
    /** @type {any} */
    const d = data;
    if (session === null || session === undefined)
    {
        delete d.aggregateSession;
    }
    else
    {
        d.aggregateSession = {
            folderUuid: String(session.folderUuid),
            focusedFileUuid: String(session.focusedFileUuid),
            scrollTop: Number.isFinite(session.scrollTop) ? Number(session.scrollTop) : 0,
        };
    }
    await saveSession(projectPath);
}

/**
 * Drop the cached session for a project — call when a project closes so
 * the next openProject reloads from disk.
 * @param {string} projectPath
 */
export function clearSessionCache(projectPath)
{
    if (projectPath) sessionCache.delete(projectPath);
    else sessionCache.clear();
}

/**
 * Resolve legacy `{ id, path, fileUuid: null }` tab entries to include a
 * `fileUuid` by consulting the UUID file registry, then rewrite
 * session.json with the resolved uuids. One-shot on first load under the
 * UUID-registry build — becomes a no-op after the rewrite lands.
 *
 * Boot MUST NOT fail on migration errors: everything is wrapped in a
 * try/catch and downgraded to `console.warn`.
 *
 * @param {string} projectPath
 * @returns {Promise<void>}
 */
export async function migrateLegacyTabEntries(projectPath)
{
    try
    {
        if (!projectPath) return;
        const snap = await getTabSnapshot(projectPath);
        if (!snap.openTabs || snap.openTabs.length === 0) return;

        // Fast-exit: every entry either has a fileUuid already or is a
        // scratch tab (path === null). Nothing to resolve.
        const needsMigration = snap.openTabs.some((t) => t.path && !t.fileUuid);
        if (!needsMigration) return;

        // Consult the registry and build a Map<absPath, uuid>. Rust emits
        // rel_path with forward slashes; normalise projectPath the same way
        // so Windows-backslash session data doesn't miss a match.
        const entries = await registryListTree();
        const projectPrefix = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
        /** @type {Map<string, string>} */
        const byAbs = new Map();
        for (const e of entries)
        {
            if (e && typeof e.uuid === "string" && typeof e.relPath === "string")
            {
                byAbs.set(`${projectPrefix}/${e.relPath}`, e.uuid);
            }
        }

        let changed = false;
        /** @type {Array<{ id: string, path: string|null, fileUuid: string|null }>} */
        const nextTabs = snap.openTabs.map((t) =>
        {
            if (!t.path || t.fileUuid) return t;
            const normPath = String(t.path).replace(/\\/g, "/");
            const uuid = byAbs.get(normPath);
            if (uuid)
            {
                changed = true;
                return { id: t.id, path: t.path, fileUuid: uuid };
            }
            console.warn(`[session] legacy tab has no registry match: ${t.path}`);
            return t;
        });

        if (changed)
        {
            await setTabSnapshot(projectPath, {
                openTabs: nextTabs,
                activeTabId: snap.activeTabId,
            });
        }
    }
    catch (e)
    {
        console.warn(
            "[session] migrateLegacyTabEntries failed:",
            /** @type {any} */ (e)?.message || e,
        );
    }
}

/**
 * Read a file from disk (Tauri fs, not atomic — for read-only ops).
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function readFile(filePath) {
    return invoke("read_project_file", { path: filePath });
}

/**
 * List script files (*.mangaplay.md) at the project root.
 * @param {string} projectPath
 * @returns {Promise<string[]>}
 */
export async function listProjectScripts(projectPath) {
    return invoke("list_project_scripts", { dir: projectPath });
}

/**
 * List the full project tree — both folder and file rows, suitable for the
 * hierarchical file explorer. Backed by the UUID file registry
 * (`registry_list_tree`) — the `projectPath` argument is kept for
 * signature compatibility with older callers but ignored; the Rust side
 * resolves the tree from the currently-open project's registry.
 *
 * Empty folders ARE emitted (registry state carries every registered
 * entry, folder or file, regardless of children).
 *
 * @param {string} projectPath  the project root (retained for callers; unused here)
 * @returns {Promise<Array<import("../adapters/tauri-storage.js").TreeEntryDto>>}
 */
export async function listProjectTree(projectPath) {
    void projectPath;
    return registryListTree();
}

// ── Utilities ──

// ── googleDocsSync ───────────────────────────────────────────────────────
//
// Keyed by the script's durable UUID (from `scriptMap[relPath].uuid`),
// minted by the Rust `scriptmap_get_or_mint` command. Path-keyed legacy
// entries (early versions of this feature wrote the relpath as the key
// directly) are migrated to UUID keys on project open by
// `migrateLegacySyncEntries`.
//
//   googleDocsSync: {
//       "56a9f662-8538-4f2e-8c95-cf679dce615d": {
//           docId: "1AbC...",
//           rootTabId: "t.0",
//           screenplayTabId: "uuid-or-null",
//           lastKnownRevisionId: "ALm...",
//           lastKnownLockToken: "uuid-or-null",
//           lastCheckedAt: "ISO-8601",
//           format: "mangaplay" | "fountain" | "text"
//       }
//   }
//
// Orphaned legacy entries (ambiguous basename, no matching script) land in
// `googleDocsSyncOrphans` instead — never silently deleted; the user can
// re-link later.
//
// Reads + writes go through `getSyncEntry` / `setSyncEntry` /
// `removeSyncEntry` below, which call `getOrMintScriptUuid` to resolve
// relpath → UUID and treat the Rust scriptmap command as authoritative
// (the cache is replaced wholesale with the returned project_json body).

/**
 * Per-project in-memory cache of project.json. Keyed by absolute project
 * path so a session with multiple projects open in sequence each get their
 * own copy.
 * @type {Map<string, Record<string, any>>}
 */
const projectJsonCache = new Map();

// Shared with google-docs-sync-store.js (extracted sibling). The store must
// mutate the SAME cache instance + reach the SAME invoke dispatcher this
// module owns, so both are re-exported under `_`-prefixed internal names.
export { projectJsonCache as _projectJsonCache };
export const _invokeForSyncStore = invoke;

/**
 * Path to `<projectPath>/_mangaplaystudio/project.json`. Mirrors the Rust
 * `project_json_path` helper in lib.rs.
 * @param {string} projectPath
 */
function projectJsonPath(projectPath)
{
    return `${projectPath}/_mangaplaystudio/project.json`;
}

/**
 * Load project.json into the cache. Returns `{}` when the file is missing
 * or unparseable — callers treat absent/malformed as "fresh project."
 * @param {string} projectPath
 * @returns {Promise<Record<string, any>>}
 */
export async function loadProjectJson(projectPath)
{
    if (projectJsonCache.has(projectPath))
    {
        return /** @type {Record<string, any>} */ (projectJsonCache.get(projectPath));
    }
    /** @type {Record<string, any>} */
    let parsed = {};
    try
    {
        const raw = await invoke("read_project_file", { path: projectJsonPath(projectPath) });
        if (raw)
        {
            const data = JSON.parse(raw);
            if (data && typeof data === "object") parsed = data;
        }
    }
    catch
    {
        // Missing / unreadable — start from {}.
    }
    projectJsonCache.set(projectPath, parsed);
    return parsed;
}

/**
 * Persist the in-memory project.json cache via atomic write. Idempotent.
 * @param {string} projectPath
 */
export async function saveProjectJson(projectPath)
{
    const data = projectJsonCache.get(projectPath);
    if (!data) return;
    try
    {
        await invoke("atomic_write_project_file", {
            path: projectJsonPath(projectPath),
            contents: JSON.stringify(data, null, 2)
        });
    }
    catch (err)
    {
        console.warn("[project.json] save failed:", err);
    }
}

/**
 * NOTE: rootTabId/screenplayTabId are optional for back-compat with entries
 * written before they were introduced. Readers must treat absent as "stale
 * cache" and prompt the user to re-publish.
 *
 * @typedef {Object} GoogleDocsSyncEntry
 * @property {string} docId
 * @property {string} [rootTabId]                — captured from documents.create response. May be absent on legacy entries (publish before this field landed).
 * @property {string|null} [screenplayTabId]    — UUID of the Screenplay tab for mangaplay; null for fountain/text; absent on legacy entries.
 * @property {string} lastKnownRevisionId
 * @property {string|null} lastKnownLockToken
 * @property {string} lastCheckedAt           — ISO-8601
 * @property {"mangaplay"|"fountain"|"text"} format
 */

// ── googleDocsSync store ─────────────────────────────────────────────────
// The googleDocsSync map read/write helpers live in google-docs-sync-store.js
// (a sibling that imports loadProjectJson/saveProjectJson back from here).
// Re-exported so external importers still resolve them from project.js.
export {
    getOrMintScriptUuid,
    getSyncEntry,
    setSyncEntry,
    removeSyncEntry,
    migrateLegacySyncEntries,
} from "./google-docs-sync-store.js";


/** Test-only — reset the in-memory project.json cache. */
export function _resetProjectJsonCacheForTest()
{
    projectJsonCache.clear();
}

/**
 * Test-only — direct access to the in-memory project.json cache. Returns
 * the same reference the rest of the module mutates, so tests can seed
 * legacy/orphan/scriptMap shapes without going through invoke().
 *
 * @param {string} projectPath
 * @returns {Promise<Record<string, any>>}
 */
export async function _loadProjectJsonForTest(projectPath)
{
    return loadProjectJson(projectPath);
}

/**
 * Create a debounced save function. Backwards-compat re-export — new code
 * should import `debounce` directly from `./util/index.js`.
 * @type {typeof debounce}
 */
export const debouncedSave = debounce;

/**
 * Load recent projects list.
 * @returns {Promise<any[]>}
 */
export async function loadRecent() {
    return invoke("app_recent");
}

/**
 * Update the recent-projects list after opening a project.
 * @param {string} projectPath
 * @returns {Promise<void>}
 */
export async function updateRecent(projectPath) {
    return invoke("app_update_recent", { projectPath });
}

/**
 * Remove a single entry from the recent-projects list. Used when the user
 * dismisses a missing-folder entry from the start screen.
 * @param {string} projectPath
 * @returns {Promise<void>}
 */
export async function removeRecent(projectPath) {
    return invoke("app_remove_recent", { projectPath });
}

/**
 * Delete a project: move the folder to Trash (or hard-delete on mobile),
 * scrub the recent-projects list, and drop the project's session state.
 * @param {string} projectPath
 * @returns {Promise<void>}
 */
export async function deleteProject(projectPath)
{
    return invoke("app_delete_project", { projectPath });
}

/** @returns {Promise<boolean>} */
export async function shouldAutoResume() {
    try { return !!(await invoke("app_should_auto_resume")); }
    catch { return false; }
}

/** @returns {Promise<boolean>} */
export async function shouldForceOnboarding() {
    try { return !!(await invoke("app_should_force_onboarding")); }
    catch { return false; }
}

/**
 * @param {string} projectPath
 * @param {string|null} displayName
 * @param {"local"|"shared"} scope
 */
export async function renameProject(projectPath, displayName, scope) {
    return invoke("app_rename_project", { projectPath, displayName, scope });
}

/**
 * Rename a project's local display name (per-machine displayNameOverride in
 * recent.json). Pass `displayName: null` to clear the override.
 * @param {string} projectPath
 * @param {string|null} displayName
 * @returns {Promise<void>}
 */
export async function renameProjectLocal(projectPath, displayName)
{
    return invoke("app_rename_project", { projectPath, displayName, scope: "local" });
}

/**
 * @param {string} projectPath
 * @param {string} newBasename
 * @param {boolean} currentlyOpen
 * @returns {Promise<string>} New absolute path.
 */
export async function renameFolder(projectPath, newBasename, currentlyOpen) {
    return invoke("app_rename_folder", { projectPath, newBasename, currentlyOpen });
}

/**
 * @param {string} projectPath
 * @param {string} newParent
 * @param {boolean} currentlyOpen
 * @returns {Promise<string>} New absolute path.
 */
export async function moveFolder(projectPath, newParent, currentlyOpen) {
    return invoke("app_move_folder", { projectPath, newParent, currentlyOpen });
}

/** @param {string} path */
export async function revealInExplorer(path) {
    return invoke("app_reveal_in_explorer", { path });
}

/**
 * Show the OS folder-picker dialog. Returns null if user cancelled.
 * @returns {Promise<string|null>}
 */
export async function pickProjectFolder() {
    return invoke("project_pick_folder");
}

/**
 * Create a new project inside the given parent folder, returning its full path.
 * @param {string} parentPath
 * @param {string} name
 * @param {boolean} [asSubFolder=true] — when false, use parentPath itself as the project root
 * @param {{ displayName?: string, description?: string, locked?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export async function createNewProject(parentPath, name, asSubFolder = true, opts = {})
{
    return invoke("project_create_new",
    {
        path: parentPath,
        name,
        asSubFolder,
        displayName: opts.displayName,
        description: opts.description,
        locked: opts.locked,
    });
}
