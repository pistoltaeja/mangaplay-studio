// @ts-check
/**
 * project.js — Project folder I/O + autosave.
 *
 * v2 project folder layout (current):
 *   <project>/
 *     mangaplay_settings/
 *       .migration-in-progress.json (transient, only during migrations)
 *     project/
 *       Untitled.mangaplay.md, ...     — scripts (recursively walked, depth 16)
 *     storyboard/
 *       page-NNN.json                  — per-page drawings
 *     meta.json                        — viewMode, lastOpened, etc.
 *     project.json                     — id + shared displayName
 *
 * Legacy layout (read via migration prompt):
 *   <project>/
 *     <name>.mangaplay.md              — scripts at root
 *     art/page-NNN.json                — drawings under art/
 *     meta.json
 */

// ── Tauri bridge ──
/** @returns {boolean} */
function isTauri() {
    return !!(window.__TAURI__);
}

/**
 * Invoke a Tauri command, with browser fallback stubs.
 * @param {string} cmd
 * @param {any} [args]
 * @returns {Promise<any>}
 */
/**
 * In-memory file system for the browser stubs. Map<absPath, contents>.
 * Folders are tracked by being a prefix of file paths (no explicit folder
 * entries). The Rust contract this models is a strict subset — see the
 * comment in the switch below for the explicit non-modelled list.
 * @type {Map<string, string>}
 */
const _fakeFs = new Map();

/** Parent dir of an absolute POSIX-or-mixed path. */
function _fakeFsParent(p)
{
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i < 0 ? "" : p.slice(0, i);
}

/** Basename of an absolute path. */
function _fakeFsBasename(p)
{
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i < 0 ? p : p.slice(i + 1);
}

/**
 * `next_free_name` parity helper. `extChain` is the entire suffix string
 * (e.g. ".mangaplay.md"), not stripped per-dot.
 */
function _fakeFsNextFreeName(parent, base, extChain, start)
{
    const exists = (name) => _fakeFs.has(`${parent}/${name}`);
    if (start === 1)
    {
        const candidate = `${base}${extChain}`;
        if (!exists(candidate)) return candidate;
    }
    for (let n = Math.max(start, 2); n < 10000; n++)
    {
        const candidate = `${base} ${n}${extChain}`;
        if (!exists(candidate)) return candidate;
    }
    return `${base} ${Date.now()}${extChain}`;
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
        return window.__TAURI__.core.invoke(cmd, args);
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
    //   - `app_detect_layout` / `app_migrate_legacy_layout` — `detectLayout`
    //     always returns v2 here, `migrateLegacyLayout` is a no-op. If a
    //     test needs to exercise the legacy/crash branches it must run
    //     against the real .exe via the CDP harness.
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
            // Walk in-memory FS for entries under `<dir>/project/` whose
            // basename ends in `.mangaplay.md` or `.fountain.md`. Returns
            // forward-slash-joined paths relative to `project/`.
            const dir = args?.dir;
            if (!dir) return [];
            const prefix = `${dir}/project/`;
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
        case "app_create_file":
        {
            const parent = args?.parent;
            const kind = args?.kind;
            if (!parent) throw new Error("parent-not-dir");
            const map = {
                "folder": { ext: "", seed: null },
                "mangaplay": { ext: ".mangaplay.md", seed: "# Page 1\n" },
                "fountain": { ext: ".fountain.md", seed: "" },
            };
            const conf = map[kind];
            if (!conf) throw new Error("invalid-kind");
            const name = _fakeFsNextFreeName(parent, "Untitled", conf.ext, 1);
            const dst = `${parent}/${name}`;
            if (kind !== "folder") _fakeFs.set(dst, conf.seed ?? "");
            return dst;
        }
        case "app_copy_file":
        {
            const src = args?.path;
            if (!src || !_fakeFs.has(src)) throw new Error("not-found");
            const parent = _fakeFsParent(src);
            const base = _fakeFsBasename(src);
            // Strip the longest known double suffix; fall back to last dot.
            let baseStem = base;
            let extChain = "";
            for (const sfx of [".mangaplay.md", ".fountain.md"])
            {
                if (base.endsWith(sfx))
                {
                    baseStem = base.slice(0, -sfx.length);
                    extChain = sfx;
                    break;
                }
            }
            if (!extChain)
            {
                const dot = base.lastIndexOf(".");
                if (dot > 0) { baseStem = base.slice(0, dot); extChain = base.slice(dot); }
            }
            const newName = _fakeFsNextFreeName(parent, baseStem, extChain, 2);
            const dst = `${parent}/${newName}`;
            _fakeFs.set(dst, _fakeFs.get(src) ?? "");
            return dst;
        }
        case "app_delete_file":
        case "app_delete_file_force":
        {
            const path = args?.path;
            if (!path || !_fakeFs.has(path)) throw new Error("not-found");
            _fakeFs.delete(path);
            return null;
        }
        case "app_rename_file":
        {
            const path = args?.path;
            const newName = args?.newName;
            if (args?.currentlyOpen) throw new Error("project-is-open");
            if (!path || !_fakeFs.has(path)) throw new Error("not-found");
            if (!newName) throw new Error("invalid-name");
            const parent = _fakeFsParent(path);
            const dst = `${parent}/${newName}`;
            if (dst !== path && _fakeFs.has(dst)) throw new Error("target-exists");
            const contents = _fakeFs.get(path);
            _fakeFs.delete(path);
            _fakeFs.set(dst, contents ?? "");
            return dst;
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
        case "app_detect_layout":
            return { layout: "v2", crash_recovery: false };
        case "app_migrate_legacy_layout":
            return null;
        case "mangaart_scaffold":
            return {
                format: "mangaart:v1",
                uuid: "00000000-0000-4000-8000-000000000000",
                name: stripMdSuffix(args?.scriptFile || "Untitled"),
                scriptFile: args?.scriptFile || "Untitled.mangaplay.md",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                pages: []
            };
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
 * Thrown by `openProject` when the project on disk uses the legacy layout
 * (scripts at root + `art/`). The caller must prompt the user to migrate
 * (see `src/migration-modal.js`) before the project can be opened.
 */
export class LayoutLegacyError extends Error
{
    /**
     * @param {string} projectPath
     * @param {{layout: string, crash_recovery: boolean}} layoutInfo
     */
    constructor(projectPath, layoutInfo)
    {
        super("layout-legacy");
        this.name = "LayoutLegacyError";
        this.projectPath = projectPath;
        this.layoutInfo = layoutInfo;
    }
}

/**
 * Thrown by `openProject` when a previous migration was interrupted
 * (`.migration-in-progress.json` is still on disk). The caller must offer
 * a Resume / Cancel choice before the project can be opened.
 */
export class MigrationCrashedError extends Error
{
    /**
     * @param {string} projectPath
     * @param {{layout: string, crash_recovery: boolean}} layoutInfo
     */
    constructor(projectPath, layoutInfo)
    {
        super("migration-crashed");
        this.name = "MigrationCrashedError";
        this.projectPath = projectPath;
        this.layoutInfo = layoutInfo;
    }
}

/**
 * Open a project from a folder path.
 *
 * The Rust side returns a tagged result:
 *   { status: "ok", project: {...} }
 *   { status: "legacy", layout_info: {...} }
 *   { status: "migration-crashed", layout_info: {...} }
 *
 * Non-ok statuses are converted into typed errors so the auto-resume / picker
 * callers can branch cleanly without inspecting raw payloads.
 *
 * @param {string} projectPath — absolute path to the project folder
 * @returns {Promise<{path: string, name: string, script: string, scriptPath: string | null, scriptBasename: string, drawings: Record<string, object>, meta: object}>}
 */
export async function openProject(projectPath) {
    const result = await invoke("project_open", { path: projectPath });

    if (result && result.status === "legacy")
    {
        throw new LayoutLegacyError(projectPath, result.layout_info);
    }
    if (result && result.status === "migration-crashed")
    {
        throw new MigrationCrashedError(projectPath, result.layout_info);
    }
    if (!result || result.status !== "ok")
    {
        throw new Error("unknown-open-result");
    }

    const project = result.project || {};

    // Derive project name from folder name
    const name = projectPath.split("/").pop() || projectPath.split("\\").pop() || "Untitled";
    const scriptFile = project.scriptFile || "";
    // v2: scripts live under <project>/project/<relative-name>. scriptFile is
    // already a forward-slash-joined relative path from the Rust walker.
    const scriptPath = scriptFile ? `${projectPath}/project/${scriptFile}` : null;
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
 * Detect the on-disk layout of a project folder.
 * @param {string} projectPath
 * @returns {Promise<{layout: "v2"|"legacy"|"unknown", crash_recovery: boolean}>}
 */
export async function detectLayout(projectPath)
{
    return invoke("app_detect_layout", { projectPath });
}

/**
 * Migrate a legacy-layout project to v2 in place. Idempotent on success
 * (calling it on an already-v2 project is a no-op from the JS perspective —
 * the Rust side returns Ok and the marker file never appears).
 * @param {string} projectPath
 * @returns {Promise<void>}
 */
export async function migrateLegacyLayout(projectPath)
{
    return invoke("app_migrate_legacy_layout", { projectPath });
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
 * Load (or scaffold) the project's `.mangaart` file into the module cache.
 * Path is derived as `${projectPath}/${stripMdSuffix(scriptBasename)}.mangaart`.
 * @param {string} projectPath
 * @param {string} scriptBasename — e.g. "Untitled.mangaplay.md"
 * @returns {Promise<object>}
 */
export async function loadMangaart(projectPath, scriptBasename)
{
    const path = `${projectPath}/${stripMdSuffix(scriptBasename)}.mangaart`;
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
        // fall through to scaffold
    }
    mangaartCache = await invoke("mangaart_scaffold", { projectPath, scriptFile: scriptBasename });
    return mangaartCache;
}

/**
 * Persist the in-memory `.mangaart` cache via atomic write. No-op if no cache.
 * @param {string} projectPath
 * @param {string} scriptBasename
 * @returns {Promise<void>}
 */
export async function saveMangaart(projectPath, scriptBasename)
{
    if (mangaartCache === null) return;
    mangaartCache.updatedAt = new Date().toISOString();
    const path = `${projectPath}/${stripMdSuffix(scriptBasename)}.mangaart`;
    await invoke("atomic_write_project_file", {
        path,
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
 * Read-only access to the in-memory .mangaart cache for the active project.
 * Returns null when no project is open.
 * @returns {object | null}
 */
export function getMangaartCache()
{
    return mangaartCache;
}

/**
 * Save meta.json for the project.
 * @param {string} projectPath
 * @param {object} meta
 * @returns {Promise<void>}
 */
export async function saveMeta(projectPath, meta) {
    const metaPath = `${projectPath}/meta.json`;
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
// Lives at `<projectPath>/mangaplay_settings/session.json`. Schema v1:
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
    return `${projectPath}/mangaplay_settings/session.json`;
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
 * @returns {Promise<{ openTabs: Array<{ id: string, path: string|null }>, activeTabId: string|null }>}
 */
export async function getTabSnapshot(projectPath)
{
    const data = await loadSession(projectPath);
    /** @type {any} */
    const d = data;
    const openTabs = Array.isArray(d.openTabs) ? d.openTabs.filter((t) =>
        t && typeof t === "object" && typeof t.id === "string"
        && (t.path === null || typeof t.path === "string")
    ) : [];
    const activeTabId = typeof d.activeTabId === "string" ? d.activeTabId : null;
    return { openTabs, activeTabId };
}

/**
 * Persist the tab snapshot for a project. Idempotent; spam-safe (caller debounces).
 * @param {string} projectPath
 * @param {{ openTabs: Array<{ id: string, path: string|null }>, activeTabId: string|null }} snap
 */
export async function setTabSnapshot(projectPath, snap)
{
    const data = await loadSession(projectPath);
    /** @type {any} */
    const d = data;
    d.openTabs = (snap.openTabs || []).map((t) => ({ id: String(t.id), path: t.path === null ? null : String(t.path) }));
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
 * Read a file from disk (Tauri fs, not atomic — for read-only ops).
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function readFile(filePath) {
    return invoke("read_project_file", { path: filePath });
}

/**
 * List art files in the project.
 * @param {string} projectPath
 * @returns {Promise<string[]>}
 */
export async function listArt(projectPath) {
    return invoke("list_project_art", { dir: projectPath });
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
 * hierarchical file explorer. Folders are only emitted when their subtree
 * carries at least one script.
 * @param {string} projectPath  the project root (NOT `<root>/project`)
 * @returns {Promise<Array<{name:string,kind:"file"|"folder",path:string,modifiedAt:number,createdAt:number}>>}
 */
export async function listProjectTree(projectPath) {
    return invoke("app_list_project_tree", { dir: `${projectPath}/project` });
}

// ── Utilities ──

/**
 * Create a debounced save function.
 * @param {(arg?: any) => Promise<void>} fn
 * @param {number} delayMs
 * @returns {(arg?: any) => void}
 */
export function debouncedSave(fn, delayMs) {
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    return (arg) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(arg), delayMs);
    };
}

/**
 * Get the Tauri app data directory (or browser fallback).
 * @returns {Promise<string>}
 */
export async function getAppDataDir() {
    const platform = await invoke("app_platform");
    return platform.appDataDir || "";
}

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
