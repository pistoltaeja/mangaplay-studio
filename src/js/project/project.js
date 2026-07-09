// @ts-check
/**
 * project.js — Project folder I/O + autosave.
 *
 * Project folder layout (current):
 *   <project>/
 *     _mangaplaystudio/                — reserved app-managed root
 *       project.json                   — id + shared displayName + artMap
 *       meta.json                      — viewMode, lastOpened, etc.
 *       storyboard/
 *         page-NNN.json                — per-page drawings
 *         <uuid>.mangaart              — script-associated drawing (root scripts)
 *         <script-rel-dir>/<uuid>.mangaart — mirrored hierarchy for nested scripts
 *       settings/
 *         session.json                 — current page, viewport, tab state
 *         fold-state.json              — editor fold ranges
 *     Untitled.mangaplay.md, ...       — user scripts at the root (recursive)
 *     <user folders>/                  — user-created folders at the root (recursive)
 *
 * The previous four-sibling layout (`project.json`/`meta.json`/`storyboard/`/`mangaplay_settings/`
 * at the project root) is NOT supported — projects from older builds will not open.
 */

// ── Tauri bridge ──
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isTauri } from "../util/index.js";
import { debounce } from "../util/index.js";
import { registryListTree } from "../adapters/tauri-storage.js";

/**
 * In-memory file system for the browser stubs. Map<absPath, contents>.
 * Folders are tracked by being a prefix of file paths (no explicit folder
 * entries). The Rust contract this models is a strict subset — see the
 * comment in the `invoke()` switch below for the explicit non-modelled list.
 * @type {Map<string, string>}
 */
const _fakeFs = new Map();

/**
 * In-memory analogue of `project.json`'s artMap.scripts section. Keyed by
 * `${projectPath}::${scriptFile}` (`::` chosen as delimiter — neither side
 * contains it on the platforms we care about). Value records the durable
 * UUID + the on-disk art path so `mangaart_resolve_path` can answer without
 * recomputing.
 * @type {Map<string, {uuid: string, artPath: string}>}
 */
const _fakeArtMap = new Map();

/**
 * Browser/test stub for the Rust `scriptmap_get_or_mint` command. Keyed by
 * `${projectPath}::${scriptRelPath}`. Mints stable UUIDs on first ask,
 * returns the same UUID on subsequent asks — matches the Rust contract.
 * @type {Map<string, {uuid: string}>}
 */
const _fakeScriptMap = new Map();

function _fakeArtMapKey(projectPath, scriptFile)
{
    return `${projectPath}::${scriptFile}`;
}

/**
 * Mirror the Rust `resolve_art_path` shape: strip the script's basename and
 * place the art file under
 * `<projectPath>/_mangaplaystudio/storyboard/<mirrored-dir>/<uuid>.mangaart`.
 * Root-level scripts collapse to
 * `<projectPath>/_mangaplaystudio/storyboard/<uuid>.mangaart`.
 *
 * Mirrors the Rust nested layout — the storyboard tree lives inside the
 * `_mangaplaystudio/` reserved root, not at the project root.
 */
function _fakeArtMapComputePath(projectPath, scriptFile, uuid)
{
    const slash = scriptFile.lastIndexOf("/");
    const mirroredDir = slash < 0 ? "" : scriptFile.slice(0, slash);
    return mirroredDir
        ? `${projectPath}/_mangaplaystudio/storyboard/${mirroredDir}/${uuid}.mangaart`
        : `${projectPath}/_mangaplaystudio/storyboard/${uuid}.mangaart`;
}

function _fakeArtMapMintUuid()
{
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    {
        return crypto.randomUUID();
    }
    return "00000000-0000-4000-8000-000000000000";
}

/**
 * Test helper. Clears the in-memory FS so each test starts clean.
 * Not exported from the bundle index — tests import the module directly.
 */
export function _resetFakeFsForTest()
{
    _fakeFs.clear();
}

/**
 * Test helper. Clears the in-memory artMap so each test starts with a
 * fresh script→uuid map. Separate from `_resetFakeFsForTest` because the
 * production `clearMangaartCache` only drops the in-memory cache; it does
 * NOT wipe project.json on disk. Tests that need a true cold start call
 * this alongside `clearMangaartCache`.
 */
export function _resetFakeArtMapForTest()
{
    _fakeArtMap.clear();
}

/**
 * Test helper. Clears the fake scriptMap so each test starts with no
 * minted UUIDs. Separate from `_resetFakeArtMapForTest` so tests that care
 * about legacy artMap pull-forward can seed artMap without leaking the
 * pulled-forward scriptMap entry from a prior test.
 */
export function _resetFakeScriptMapForTest()
{
    _fakeScriptMap.clear();
}

/**
 * Test helper. Direct passthrough to the private `invoke` dispatcher so
 * tests can exercise FS commands (`app_create_file`, etc.) that don't have
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
    // Browser stubs for tests and dev — names must match Tauri command names exactly.
    //
    // _fakeFs intentionally does NOT model:
    //   - Case-folding (names are treated case-sensitively)
    //   - Cross-device EXDEV (everything lives in one map)
    //   - File locking / sharing violations
    //   - Symlinks
    //   - Trash directories — `app_delete_file` is hard-delete in the stub
    //   - `trash-unavailable` / `access-denied` error variants — happy path
    //     plus `not-found` / `target-exists` are modelled; other classes are
    //     only reachable against the real .exe via the CDP harness.
    switch (cmd) {
        case "project_open":
            return {
                status: "ok",
                project: {
                    script: "",
                    scriptFile: "",
                    drawings: {},
                    meta: { viewMode: "dual", lastSoloMode: "solo-storyboard", lastOpened: new Date().toISOString() },
                    id: "00000000-0000-4000-8000-000000000000",
                    displayName: null,
                },
            };
        case "atomic_write_project_file":
            console.log("[stub] atomic write:", args?.path);
            if (args?.path) _fakeFs.set(args.path, args.contents ?? "");
            return null;
        case "read_project_file":
            return args?.path && _fakeFs.has(args.path) ? _fakeFs.get(args.path) : "";
        case "list_project_art":
            return [];
        case "list_project_scripts":
        {
            // Walk in-memory FS for entries under `<dir>/` whose basename
            // ends in `.mangaplay.md` or `.fountain.md`. Returns
            // forward-slash-joined paths relative to `<dir>`.
            const dir = args?.dir;
            if (!dir) return [];
            const prefix = `${dir}/`;
            const out = [];
            for (const p of _fakeFs.keys())
            {
                if (!p.startsWith(prefix)) continue;
                const rel = p.slice(prefix.length);
                if (rel.startsWith(".")) continue;
                if (rel.endsWith(".mangaplay.md") || rel.endsWith(".fountain.md"))
                {
                    out.push(rel);
                }
            }
            return out;
        }
        case "app_recent":
            return [];
        case "app_platform":
            return { os: navigator.platform || "browser", appDataDir: "", version: "0.0.0" };
        case "app_update_recent":
            return null;
        case "app_remove_recent":
        case "app_rename_project":
        case "app_rename_folder":
        case "app_move_folder":
        case "app_reveal_in_explorer":
            return null;
        case "app_should_auto_resume":
            return false;
        case "project_pick_folder":
            return null; // browser cannot show OS folder dialog
        case "project_create_new":
            return `/tmp/${args?.name || "new-project"}`;
        case "mangaart_scaffold":
        {
            const projectPath = args?.projectPath || "";
            const scriptFile = args?.scriptFile || "Untitled.mangaplay.md";
            const key = _fakeArtMapKey(projectPath, scriptFile);
            // Idempotent: re-use the stored UUID + path on repeat scaffold,
            // matching the Rust contract.
            let entry = _fakeArtMap.get(key);
            if (!entry)
            {
                const uuid = _fakeArtMapMintUuid();
                const artPath = _fakeArtMapComputePath(projectPath, scriptFile, uuid);
                entry = { uuid, artPath };
                _fakeArtMap.set(key, entry);
            }
            const body = {
                format: "mangaart:v1",
                uuid: entry.uuid,
                name: stripMdSuffix(scriptFile),
                scriptFile,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                pages: []
            };
            // Seed the in-memory FS so a subsequent read_project_file at the
            // resolved path returns the scaffold body (parity with Rust which
            // atomically writes the scaffold to disk).
            _fakeFs.set(entry.artPath, JSON.stringify(body, null, 2));
            return body;
        }
        case "mangaart_resolve_path":
        {
            const projectPath = args?.projectPath || "";
            const scriptFile = args?.scriptFile || "";
            const entry = _fakeArtMap.get(_fakeArtMapKey(projectPath, scriptFile));
            return entry ? entry.artPath : null;
        }
        case "mangaart_scaffold_by_uuid":
        {
            const projectPath = args?.projectPath || "";
            const uuid = args?.uuid || "";
            const displayName = args?.displayName || uuid;
            const artPath = `${projectPath}/_mangaplaystudio/storyboard/${uuid}.mangaart`;
            const existing = _fakeFs.get(artPath);
            if (existing)
            {
                try { return JSON.parse(existing); } catch { /* fall through to rewrite */ }
            }
            const body = {
                format: "mangaart:v1",
                uuid,
                name: displayName,
                scriptFile: displayName,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                pages: []
            };
            _fakeFs.set(artPath, JSON.stringify(body, null, 2));
            return body;
        }
        case "mangaart_resolve_by_uuid":
        {
            const projectPath = args?.projectPath || "";
            const uuid = args?.uuid || "";
            const artPath = `${projectPath}/_mangaplaystudio/storyboard/${uuid}.mangaart`;
            return _fakeFs.has(artPath) ? artPath : null;
        }
        case "mangaart_erase":
        {
            const projectPath = args?.projectPath || "";
            const uuid = args?.uuid || "";
            // Drop every fake artMap entry pointing at this uuid.
            for (const [key, entry] of _fakeArtMap.entries())
            {
                if (entry && entry.uuid === uuid && key.startsWith(`${projectPath}::`))
                {
                    _fakeFs.delete(entry.artPath);
                    _fakeArtMap.delete(key);
                }
            }
            // Also nuke the flat UUID-first art file if present.
            const flat = `${projectPath}/_mangaplaystudio/storyboard/${uuid}.mangaart`;
            _fakeFs.delete(flat);
            return null;
        }
        case "scriptmap_get_or_mint":
        {
            const projectPath = args?.projectPath || "";
            const scriptRelPath = args?.scriptRelPath || "";
            // Fake-fs stores the project.json body in projectJsonCache (the
            // module-level Map below). We can't access it here because of
            // module ordering, so the fake holds its own per-project store
            // keyed by projectPath::scriptRelPath. Mints are stable across
            // repeated calls for the same key — matches the Rust contract.
            const key = `${projectPath}::${scriptRelPath}`;
            let entry = _fakeScriptMap.get(key);
            const minted = !entry;
            if (!entry)
            {
                entry = { uuid: _fakeArtMapMintUuid() };
                _fakeScriptMap.set(key, entry);
            }
            // Build a tiny project_json shape the JS-side cache replacement
            // can ingest. Real Rust returns the full body; the fake returns
            // just the scriptMap subtree so JS reads do the right thing.
            // Merge with whatever was already in the JS cache so other
            // top-level fields (id, artMap, googleDocsSync) survive.
            const existing = projectJsonCache.get(projectPath) || {};
            const mergedScriptMap = Object.assign({}, existing.scriptMap || {});
            mergedScriptMap[scriptRelPath] = { uuid: entry.uuid };
            const projectJson = Object.assign({}, existing, { scriptMap: mergedScriptMap });
            return { uuid: entry.uuid, minted, projectJson };
        }
        default:
            return null;
    }
}

/** @type {object | null} */
let mangaartCache = null;

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
 * @returns {Promise<{path: string, name: string, script: string, scriptPath: string | null, scriptBasename: string, drawings: Record<string, object>, meta: object}>}
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

    return {
        path: projectPath,
        name,
        script: project.script || "",
        scriptPath,
        scriptBasename,
        drawings: project.drawings || {},
        meta: project.meta || {},
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
 * Load (or scaffold) the project's `.mangaart` file into the module cache.
 * Path is resolved via the project.json artMap (mangaart_resolve_path).
 * Falls through to mangaart_scaffold when no mapping exists OR when the
 * mapped file is missing/unreadable (crash-after-map-write recovery).
 * @param {string} projectPath
 * @param {string} scriptBasename — e.g. "Untitled.mangaplay.md"
 * @returns {Promise<object>}
 */
export async function loadMangaart(projectPath, scriptBasename)
{
    const path = await resolveArtPath(projectPath, scriptBasename);
    if (path)
    {
        try
        {
            const contents = await invoke("read_project_file", { path });
            if (contents)
            {
                mangaartCache = JSON.parse(contents);
                return mangaartCache;
            }
        }
        catch (err)
        {
            // fall through to scaffold (recovery path)
        }
    }
    mangaartCache = await invoke("mangaart_scaffold", { projectPath, scriptFile: scriptBasename });
    return mangaartCache;
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
    if (mangaartCache === null) return;
    mangaartCache.updatedAt = new Date().toISOString();
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
    await invoke("atomic_write_project_file", {
        path,
        contents: JSON.stringify(mangaartCache, null, 2),
    });
}

/**
 * UUID-first mangaart load. Address the .mangaart file by the script's
 * registry UUID rather than by its project-relative path. Rename/move can't
 * desynchronise the mapping because the UUID never changes.
 *
 * @param {string} projectPath
 * @param {string} uuid       — script's registry UUID
 * @param {string} [displayName] — optional stem for the scaffold's `name` field
 * @returns {Promise<object>}
 */
export async function loadMangaartByUuid(projectPath, uuid, displayName)
{
    const path = await invoke("mangaart_resolve_by_uuid", { projectPath, uuid });
    if (path)
    {
        try
        {
            const contents = await invoke("read_project_file", { path });
            if (contents)
            {
                mangaartCache = JSON.parse(contents);
                return mangaartCache;
            }
        }
        catch (_err)
        {
            // fall through to scaffold (crash-after-write recovery)
        }
    }
    mangaartCache = await invoke("mangaart_scaffold_by_uuid", {
        projectPath,
        uuid,
        displayName: displayName ?? null,
    });
    return mangaartCache;
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
    if (mangaartCache === null) return;
    mangaartCache.updatedAt = new Date().toISOString();
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
    await invoke("atomic_write_project_file", {
        path: resolved,
        contents: JSON.stringify(mangaartCache, null, 2),
    });
}

/**
 * Update a single page's drawing in the in-memory cache. No-op if no cache.
 * @param {number} pageIndex — 0-based page index
 * @param {object} drawing
 * @returns {void}
 */
export function updateMangaartPage(pageIndex, drawing)
{
    if (mangaartCache === null) return;
    if (!Array.isArray(mangaartCache.pages)) mangaartCache.pages = [];
    const existing = mangaartCache.pages.find((p) => p.index === pageIndex);
    if (existing)
    {
        existing.drawing = drawing;
    }
    else
    {
        mangaartCache.pages.push({ index: pageIndex, drawing, preview: null });
    }
}

/**
 * Clear the in-memory `.mangaart` cache. Call on project close.
 * @returns {void}
 */
export function clearMangaartCache()
{
    mangaartCache = null;
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
 * Read-only access to the in-memory .mangaart cache for the active project.
 * Returns null when no project is open.
 * @returns {object | null}
 */
export function getMangaartCache()
{
    return mangaartCache;
}

/**
 * Save meta.json for the project. Path mirrors the Rust nested layout:
 * `<projectPath>/_mangaplaystudio/meta.json`.
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
    await invoke("atomic_write_project_file", {
        path: metaPath,
        contents: JSON.stringify(payload, null, 2),
    });
}

// ── session.json ─────────────────────────────────────────────────────────
//
// Per-project state that should survive a file-swap but not a project close.
// Lives at `<projectPath>/_mangaplaystudio/settings/session.json`. Schema v1:
//   {
//       "version": 1,
//       "lastPageIndex": { "<scriptBasename>": <number>, ... }
//   }
// Keys are the file basename WITH the `.mangaplay.md` suffix stripped to
// match how mangaart files are named (one session entry per storyboard).
// Errors are swallowed — session state is best-effort, never blocking.

/** @type {Map<string, object>} */
const sessionCache = new Map();

function sessionPath(projectPath)
{
    return `${projectPath}/_mangaplaystudio/settings/session.json`;
}

function sessionKey(scriptBasename)
{
    return stripMdSuffix(scriptBasename || "");
}

/**
 * Load (or initialise) session.json for a project. Cached per projectPath.
 * @param {string} projectPath
 * @returns {Promise<{ version: number, lastPageIndex: Record<string, number>, openTabs?: Array<{ id: string, path: string|null }>, activeTabId?: string|null }>}
 */
export async function loadSession(projectPath)
{
    if (sessionCache.has(projectPath)) return sessionCache.get(projectPath);
    /** @type {{ version: number, lastPageIndex: Record<string, number>, openTabs: Array<{ id: string, path: string|null }>, activeTabId: string|null }} */
    let parsed = { version: 1, lastPageIndex: {}, openTabs: [], activeTabId: null };
    try
    {
        const raw = await invoke("read_project_file", { path: sessionPath(projectPath) });
        if (raw)
        {
            const data = JSON.parse(raw);
            if (data && typeof data === "object")
            {
                parsed = {
                    version: 1,
                    lastPageIndex: (data.lastPageIndex && typeof data.lastPageIndex === "object")
                        ? data.lastPageIndex
                        : {},
                    openTabs: Array.isArray(data.openTabs) ? data.openTabs : [],
                    activeTabId: (typeof data.activeTabId === "string") ? data.activeTabId : null
                };
            }
        }
    }
    catch
    {
        // File missing or unreadable — start from the default.
    }
    sessionCache.set(projectPath, parsed);
    return parsed;
}

/**
 * Write the in-memory session.json back to disk. Idempotent; safe to spam.
 * @param {string} projectPath
 */
export async function saveSession(projectPath)
{
    const data = sessionCache.get(projectPath);
    if (!data) return;
    try
    {
        await invoke("atomic_write_project_file", {
            path: sessionPath(projectPath),
            contents: JSON.stringify(data, null, 2)
        });
    }
    catch (err)
    {
        console.warn("[session] save failed:", err);
    }
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
 * See TODO/uuid-file-registry.md Part 5.
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
async function loadProjectJson(projectPath)
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
async function saveProjectJson(projectPath)
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

/**
 * UUID v4 shape — 8-4-4-4-12 hex with version nibble '4' at position 14.
 * Used to distinguish UUID-keyed entries from legacy relpath-keyed entries
 * in `googleDocsSync`.
 * @param {string} s
 */
function isUuidV4Shape(s)
{
    return typeof s === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Mint (or fetch) the durable UUID for a script. Calls Rust under the
 * per-project mutex, then replaces the JS-side project.json cache with the
 * returned body so subsequent reads see the new state without a re-read.
 *
 * @param {string} projectPath
 * @param {string} scriptRelPath  — forward-slash path relative to project root
 * @returns {Promise<string|null>}  resolved UUID, or `null` when inputs are blank
 */
export async function getOrMintScriptUuid(projectPath, scriptRelPath)
{
    if (!projectPath || !scriptRelPath) return null;
    try
    {
        const result = await invoke("scriptmap_get_or_mint",
            { projectPath, scriptRelPath });
        if (!result || typeof result.uuid !== "string") return null;
        if (result.projectJson && typeof result.projectJson === "object")
        {
            // Rust is authoritative — replace the cache wholesale.
            projectJsonCache.set(projectPath, result.projectJson);
        }
        return result.uuid;
    }
    catch (err)
    {
        console.warn("[scriptmap] get_or_mint failed:", err);
        return null;
    }
}

/**
 * Read a sync entry for a script. Resolves relpath → UUID via scriptMap
 * (does NOT mint — a never-published script must not gain a UUID just
 * because the UI checked its sync state). Falls back to the legacy
 * relpath-keyed entry when no UUID-keyed entry exists; the boot-time
 * migration pass `migrateLegacySyncEntries` cleans up legacy keys.
 *
 * @param {string} projectPath
 * @param {string} scriptRelPath  — forward-slash path relative to project root
 * @returns {Promise<GoogleDocsSyncEntry | null>}
 */
export async function getSyncEntry(projectPath, scriptRelPath)
{
    if (!projectPath || !scriptRelPath) return null;
    const pj = await loadProjectJson(projectPath);
    const map = pj.googleDocsSync;
    if (!map || typeof map !== "object") return null;

    const scriptMap = (pj.scriptMap && typeof pj.scriptMap === "object")
        ? pj.scriptMap : null;
    const uuid = scriptMap && scriptMap[scriptRelPath] && scriptMap[scriptRelPath].uuid;
    if (uuid && map[uuid] && typeof map[uuid] === "object")
    {
        return /** @type {GoogleDocsSyncEntry} */ (map[uuid]);
    }
    // Legacy fallback — pre-migration entries keyed by relpath.
    const legacy = map[scriptRelPath];
    return legacy && typeof legacy === "object"
        ? /** @type {GoogleDocsSyncEntry} */ (legacy) : null;
}

/**
 * Upsert a sync entry, keyed by the script's UUID. Mints a UUID on first
 * call (via Rust under the per-project lock). Persists project.json.
 *
 * Merge semantics: the incoming `entry` is shallow-merged over the prior
 * entry, so writers that only carry a subset of fields (e.g. the sync
 * state machine writing `lastKnownRevisionId` after a push) don't drop
 * long-lived fields (`rootTabId`/`screenplayTabId`) written by other
 * callers. Use `removeSyncEntry` for intentional field-drops.
 * @param {string} projectPath
 * @param {string} scriptRelPath
 * @param {GoogleDocsSyncEntry} entry
 */
export async function setSyncEntry(projectPath, scriptRelPath, entry)
{
    if (!projectPath || !scriptRelPath || !entry) return;
    const uuid = await getOrMintScriptUuid(projectPath, scriptRelPath);
    if (!uuid) return;
    const pj = await loadProjectJson(projectPath);
    const map = (pj.googleDocsSync && typeof pj.googleDocsSync === "object")
        ? pj.googleDocsSync
        : (pj.googleDocsSync = {});
    const prior = (map[uuid] && typeof map[uuid] === "object") ? map[uuid] : null;
    map[uuid] = prior ? Object.assign({}, prior, entry) : entry;
    // Defensive: if a legacy relpath-keyed entry coexists, drop it so the
    // gear-icon lookup doesn't see two entries pointing at the same script.
    if (scriptRelPath !== uuid && map[scriptRelPath])
    {
        delete map[scriptRelPath];
    }
    await saveProjectJson(projectPath);
}

/**
 * Remove a sync entry. Drops both UUID-keyed and legacy relpath-keyed
 * entries when present. Does NOT remove the underlying scriptMap entry —
 * other features (storyboard art, future caches) may still need the UUID.
 * @param {string} projectPath
 * @param {string} scriptRelPath
 */
export async function removeSyncEntry(projectPath, scriptRelPath)
{
    if (!projectPath || !scriptRelPath) return;
    const pj = await loadProjectJson(projectPath);
    const map = pj.googleDocsSync;
    if (!map || typeof map !== "object") return;

    let mutated = false;
    const scriptMap = (pj.scriptMap && typeof pj.scriptMap === "object")
        ? pj.scriptMap : null;
    const uuid = scriptMap && scriptMap[scriptRelPath] && scriptMap[scriptRelPath].uuid;
    if (uuid && uuid in map) { delete map[uuid]; mutated = true; }
    if (scriptRelPath in map) { delete map[scriptRelPath]; mutated = true; }
    if (mutated) await saveProjectJson(projectPath);
}

/**
 * One-shot migration of legacy relpath-keyed `googleDocsSync` entries to
 * UUID keys. Run once at project open, BEFORE any `SyncStateMachine`
 * boots, so the gear-icon lookup at activation sees clean state.
 *
 * For each non-UUID key in `googleDocsSync`:
 *   1. If the relpath maps to a known scriptMap entry → mint/get UUID,
 *      move the entry under the UUID key, delete the legacy key.
 *   2. If the relpath is a bare basename, search the project's scriptMap
 *      for a unique basename match — if exactly one matches, treat as (1).
 *   3. Ambiguous or unresolvable → move to `googleDocsSyncOrphans` with a
 *      `reason` field. Never deleted; the user can re-link later.
 *
 * @param {string} projectPath
 * @returns {Promise<{migrated: number, orphaned: number}>}
 */
export async function migrateLegacySyncEntries(projectPath)
{
    if (!projectPath) return { migrated: 0, orphaned: 0 };
    const pj = await loadProjectJson(projectPath);
    const map = pj.googleDocsSync;
    if (!map || typeof map !== "object") return { migrated: 0, orphaned: 0 };

    const scriptMap = (pj.scriptMap && typeof pj.scriptMap === "object")
        ? pj.scriptMap : {};
    const artMapScripts = (pj.artMap && pj.artMap.scripts && typeof pj.artMap.scripts === "object")
        ? pj.artMap.scripts : {};

    // Build a basename → [relpath...] index across BOTH scriptMap and the
    // legacy artMap so basename-unique-match resolves correctly even when
    // scriptMap hasn't been populated yet for that script.
    /** @type {Map<string, string[]>} */
    const basenameIndex = new Map();
    const considerRelPath = (rel) => {
        const idx = rel.lastIndexOf("/");
        const base = idx < 0 ? rel : rel.slice(idx + 1);
        const list = basenameIndex.get(base) || [];
        if (!list.includes(rel)) list.push(rel);
        basenameIndex.set(base, list);
    };
    for (const rel of Object.keys(scriptMap)) considerRelPath(rel);
    for (const rel of Object.keys(artMapScripts)) considerRelPath(rel);

    let migrated = 0;
    let orphaned = 0;
    const orphans = (pj.googleDocsSyncOrphans && typeof pj.googleDocsSyncOrphans === "object")
        ? pj.googleDocsSyncOrphans
        : null;

    const ensureOrphans = () => {
        if (!pj.googleDocsSyncOrphans || typeof pj.googleDocsSyncOrphans !== "object")
        {
            pj.googleDocsSyncOrphans = {};
        }
        return pj.googleDocsSyncOrphans;
    };

    for (const key of Object.keys(map))
    {
        if (isUuidV4Shape(key)) continue;
        const entry = map[key];
        if (!entry || typeof entry !== "object") continue;

        // Resolve the legacy key to a real script relpath.
        /** @type {string|null} */
        let resolvedRel = null;
        if (key in scriptMap || key in artMapScripts)
        {
            resolvedRel = key;
        }
        else if (!key.includes("/"))
        {
            const candidates = basenameIndex.get(key) || [];
            if (candidates.length === 1) resolvedRel = candidates[0];
            else if (candidates.length > 1)
            {
                ensureOrphans()[key] = Object.assign({}, entry,
                    { reason: "ambiguous-basename", candidates });
                delete map[key];
                orphaned++;
                continue;
            }
        }

        if (!resolvedRel)
        {
            ensureOrphans()[key] = Object.assign({}, entry,
                { reason: "no-matching-script" });
            delete map[key];
            orphaned++;
            continue;
        }

        const uuid = await getOrMintScriptUuid(projectPath, resolvedRel);
        if (!uuid)
        {
            ensureOrphans()[key] = Object.assign({}, entry,
                { reason: "mint-failed", resolvedRel });
            delete map[key];
            orphaned++;
            continue;
        }
        // getOrMintScriptUuid replaced our cached pj with the Rust body —
        // re-grab the live cache reference so subsequent mutations land
        // on the right object.
        const live = await loadProjectJson(projectPath);
        const liveMap = live.googleDocsSync || (live.googleDocsSync = {});
        liveMap[uuid] = entry;
        if (key !== uuid) delete liveMap[key];
        migrated++;
    }

    if (migrated > 0 || orphaned > 0)
    {
        await saveProjectJson(projectPath);
        console.info(
            `[scriptmap:migrate] ${projectPath} — migrated ${migrated}, orphaned ${orphaned}`,
        );
        if (orphans)
        {
            // Was already non-empty before this run — surface to the user
            // eventually via the Settings panel. v1: console-only.
        }
    }
    return { migrated, orphaned };
}

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
 * @returns {Promise<string>}
 */
export async function createNewProject(parentPath, name) {
    return invoke("project_create_new", { path: parentPath, name });
}
