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
import { basename } from "./util/basename.js";
import { isTauri } from "./util/is-tauri.js";
import { debounce } from "./util/debounce.js";

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

/** Parent dir of an absolute POSIX-or-mixed path. */
function _fakeFsParent(p)
{
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i < 0 ? "" : p.slice(0, i);
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
            const base = basename(src);
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
    return invoke("app_list_project_tree", { dir: projectPath });
}

// ── Utilities ──

// ── googleDocsSync (Phase 1 of Google Docs sync) ─────────────────────────
//
// Optional map at `project.json.googleDocsSync`, keyed by script-file path
// RELATIVE to the project root (forward-slash joined). Each entry caches
// the Drive-side state of a published Doc so the UI never blocks on a
// Drive round-trip just to render the gear icon.
//
//   googleDocsSync: {
//       "scripts/dorothy/chapter-01.mangaplay.md": {
//           docId: "1AbC...",
//           lastKnownRevisionId: "ALm...",
//           lastKnownLockToken: "uuid-or-null",
//           lastCheckedAt: "ISO-8601",
//           format: "mangaplay" | "fountain" | "text"
//       }
//   }
//
// Cache is read-modify-write — older project.json files without the field
// load fine (we treat absent === empty map). Rust round-trips project.json
// as opaque `serde_json::Value` (see lib.rs `read_project_json` /
// `write_project_json`), so adding the field needs no Rust changes.

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
 * @typedef {Object} GoogleDocsSyncEntry
 * @property {string} docId
 * @property {string} lastKnownRevisionId
 * @property {string|null} lastKnownLockToken
 * @property {string} lastCheckedAt           — ISO-8601
 * @property {"mangaplay"|"fountain"|"text"} format
 */

/**
 * Read a sync entry for a script. Returns `null` when project.json has no
 * `googleDocsSync` map OR no entry for the given relative path.
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
    const entry = map[scriptRelPath];
    return entry && typeof entry === "object" ? /** @type {GoogleDocsSyncEntry} */ (entry) : null;
}

/**
 * Upsert a sync entry. Persists project.json.
 * @param {string} projectPath
 * @param {string} scriptRelPath
 * @param {GoogleDocsSyncEntry} entry
 */
export async function setSyncEntry(projectPath, scriptRelPath, entry)
{
    if (!projectPath || !scriptRelPath || !entry) return;
    const pj = await loadProjectJson(projectPath);
    const map = (pj.googleDocsSync && typeof pj.googleDocsSync === "object")
        ? pj.googleDocsSync
        : (pj.googleDocsSync = {});
    map[scriptRelPath] = entry;
    await saveProjectJson(projectPath);
}

/**
 * Remove a sync entry. Persists project.json. No-op when the entry is
 * already absent.
 * @param {string} projectPath
 * @param {string} scriptRelPath
 */
export async function removeSyncEntry(projectPath, scriptRelPath)
{
    if (!projectPath || !scriptRelPath) return;
    const pj = await loadProjectJson(projectPath);
    const map = pj.googleDocsSync;
    if (!map || typeof map !== "object" || !(scriptRelPath in map)) return;
    delete map[scriptRelPath];
    await saveProjectJson(projectPath);
}

/** Test-only — reset the in-memory project.json cache. */
export function _resetProjectJsonCacheForTest()
{
    projectJsonCache.clear();
}

/**
 * Create a debounced save function. Backwards-compat re-export — new code
 * should import `debounce` directly from `./util/debounce.js`.
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
