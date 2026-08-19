/**
 * Desktop storage adapter.
 *
 * Consolidates three responsibilities (matching the extension's pattern):
 *   1. `STORAGE_KEYS` + `STORAGE_DEFAULTS` constants — the build aliases
 *      `browser-storage-keys.js` here too.
 *   2. `PersistentStorage` backed by the Tauri WebView2's real localStorage.
 *   3. A single-slot `SaveSlotManager` + `resolveDrawingId()` that bridge
 *      drawing reads/writes to the desktop's `.mangaart` cache via the
 *      `globalThis.__MPS_DESKTOP__` runtime contract (wired by app.js).
 *
 * Methods not used by mps-canvas / mps-paint-widget are stubbed with one-line
 * comments. Anything else needed by the website components must be added
 * here and exported by name.
 */

const STORAGE_PREFIX = 'mps_';

const STORAGE_KEYS = {
    EXPORT_SETTINGS: 'export_settings',
    UI_SETTINGS: 'ui_settings',
    MANGA_SETTINGS: 'manga_settings',
    MANGA_PREFIX: 'manga_',
    RECENT_FILES: 'recent_files',
    THEME: 'theme',
    USER_DATE_CREATED: 'user_date_created',
    USER_DATE_INSTALLED: 'user_date_installed',
    ONBOARDING_COMPLETED: 'onboarding_completed',
    ONBOARDING_COMPLETED_AT: 'onboarding_completed_at',
    HOMEPAGE_DONT_SHOW: 'homepage_dont_show_again',
    HAS_VISITED: 'has_visited',
    SAVE_VERSION: 'save_version',
    SAVE_SLOTS: 'save_slots',
    ACTIVE_SLOT: 'active_slot',
    SAVE_SLOT_PREFIX: 'save_slot_',
    MANGASTORY_V2: 'mangastory_v2',
    DRAWING_META: 'drawing_meta',
    PENDING_SYNC: 'pending_sync',
    DRAWING_TOOL_SETTINGS_V1: 'drawing_tool_settings_v1',
    TOUCH_SETTINGS: 'touch_settings',
    EDITOR_VIEW_MODE: 'editor_view_mode',
};

const STORAGE_DEFAULTS = {
    [STORAGE_KEYS.MANGA_SETTINGS]: {
        format: 'Manga',
        storyboardFormat: 'PNG',
        screenplayFormat: 'PDF',
        navStyle: 'sidebar',
        autoArrows: true,
        autoPanelColors: false,
        showPanelTags: true,
        showPanelDescriptions: true,
        showPanelBorders: true,
        speechBubbleRendering: true,
        characterTitleCards: true,
        developerMode: false,
        useCourierPrime: false,
        boldHeadings: false,
        boldAction: false,
        pageNumbers: true,
        // Target indentation convention for the "Fix Structural Issues"
        // button on mangaplay documents. See structural-fixer.js
        // INDENT_WIDTHS for the spec. "B" is the editor's default (panels
        // at column 0, dialogue at 4 spaces) and matches the codebase
        // samples. Override via Settings.
        structuralFixTargetConvention: 'B',
    },
    [STORAGE_KEYS.UI_SETTINGS]: {
        sidebarCollapsed: false,
    },
    [STORAGE_KEYS.EXPORT_SETTINGS]: {
        pageType: 'png',
        background: 'white',
        dpi: 300,
        scope: 'current',
    },
    [STORAGE_KEYS.USER_DATE_CREATED]: null,
    [STORAGE_KEYS.USER_DATE_INSTALLED]: null,
    [STORAGE_KEYS.ONBOARDING_COMPLETED]: false,
    [STORAGE_KEYS.ONBOARDING_COMPLETED_AT]: null,
    [STORAGE_KEYS.DRAWING_TOOL_SETTINGS_V1]: {
        activeTool: 'pencil',
        pencilSize: 1,
        eraserSize: 12,
        color: '#000000',
    },
    [STORAGE_KEYS.TOUCH_SETTINGS]: {
        stylusOnly: false,
    },
};

/**
 * Deep merge — arrays and nulls are not recursed.
 * @param {Record<string, any>} target
 * @param {Record<string, any>} source
 * @returns {Record<string, any>}
 */
function deepMerge(target, source)
{
    if (!source || typeof source !== 'object') return target;
    if (!target || typeof target !== 'object') return source;
    const result = { ...target };
    for (const key of Object.keys(source))
    {
        if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key]))
        {
            result[key] = deepMerge(result[key], source[key]);
        }
        else
        {
            result[key] = source[key];
        }
    }
    return result;
}

/**
 * PersistentStorage backed by browser localStorage (the Tauri WebView2 has a
 * real, durable localStorage scoped to the app's data dir).
 *
 * `STORAGE_DEFAULTS[key]` wins over the caller-supplied `defaultValue` when
 * the key is documented — matches the website / extension semantics so
 * shared components that call `get(KEY, {})` to mean "give me an object"
 * still receive the documented default shape.
 */
const PersistentStorage = {
    lastError: /** @type {Error|null} */ (null),

    /**
     * @param {string} key
     * @param {any} [defaultValue]
     * @returns {any}
     */
    get(key, defaultValue)
    {
        const fullKey = STORAGE_PREFIX + key;
        const documentedDefault = STORAGE_DEFAULTS[key];
        const resolvedDefault = documentedDefault !== undefined
            ? documentedDefault
            : (defaultValue !== undefined ? defaultValue : null);

        let stored;
        try
        {
            const raw = globalThis.localStorage?.getItem?.(fullKey);
            stored = raw == null ? null : JSON.parse(raw);
        }
        catch (e)
        {
            this.lastError = /** @type {Error} */ (e);
            return resolvedDefault;
        }

        if (stored === undefined || stored === null) return resolvedDefault;
        if (typeof resolvedDefault === 'object' && resolvedDefault !== null && !Array.isArray(resolvedDefault))
        {
            return deepMerge(resolvedDefault, stored);
        }
        return stored;
    },

    /**
     * @param {string} key
     * @param {any} value
     * @returns {boolean}
     */
    set(key, value)
    {
        const fullKey = STORAGE_PREFIX + key;
        try
        {
            globalThis.localStorage?.setItem?.(fullKey, JSON.stringify(value));
            return true;
        }
        catch (e)
        {
            this.lastError = /** @type {Error} */ (e);
            return false;
        }
    },

    /** @param {string} key */
    remove(key)
    {
        const fullKey = STORAGE_PREFIX + key;
        try { globalThis.localStorage?.removeItem?.(fullKey); }
        catch (e) { this.lastError = /** @type {Error} */ (e); }
    },

    /** localStorage is synchronous — flush is a no-op. */
    flush() {},

    clear()
    {
        try { globalThis.localStorage?.clear?.(); }
        catch (e) { this.lastError = /** @type {Error} */ (e); }
    },
};

/**
 * Bridge to the desktop runtime. `app.js` populates this object once a
 * project is open. Adapter only reads — never mutates the cache directly.
 * Shape:
 *   {
 *     getActiveSlotId: () => string|null,
 *     getMangaart: () => { pages: Array<{ index, drawing }>, ... } | null,
 *     updatePage: (pageIndex, drawing) => void,
 *     queueSave: () => void,
 *   }
 *
 * @returns {{
 *   getActiveSlotId: () => (string|null),
 *   getMangaart: () => any,
 *   updatePage: (pageIndex: number, drawing: any) => void,
 *   queueSave: () => void,
 * }|null}
 */
function _bridge()
{
    return /** @type {any} */ (globalThis).__MPS_DESKTOP__ || null;
}

/**
 * Single-slot SaveSlotManager for the desktop. The "slot" is the open
 * project (identified by its on-disk path). Methods not exercised by
 * mps-canvas / mps-paint-widget are stubbed.
 */
class SaveSlotManagerImpl
{
    /** @returns {string|null} */
    getActiveSlotId()
    {
        const b = _bridge();
        return b ? b.getActiveSlotId() : null;
    }

    /** STUB: desktop opens projects via project_open, not via this API. */
    setActiveSlotId(_id) {}

    /** @returns {Array<{id: string, name: string, lastModified: number, createdAt?: number}>} */
    getSlots()
    {
        const id = this.getActiveSlotId();
        if (!id) return [];
        const name = id.split(/[\\/]/).pop() || 'project';
        const now = Date.now();
        return [{ id, name, lastModified: now, createdAt: now }];
    }

    /** @returns {Array<{id: string, name: string, lastModified: number}>} */
    getDisplaySlots()
    {
        return this.getSlots();
    }

    /** STUB: desktop has exactly one slot per open project. */
    ensureFiveSlots() {}

    /**
     * @param {string} id
     * @returns {{id: string, name: string, lastModified: number}|null}
     */
    getSlot(id)
    {
        return this.getSlots().find((s) => s.id === id) || null;
    }

    /** @returns {{id: string, name: string, lastModified: number}|null} */
    getActiveSlot()
    {
        const id = this.getActiveSlotId();
        return id ? this.getSlot(id) : null;
    }

    /** STUB: desktop reads scripts via openProject; not used here. */
    getSlotContent(_id)
    {
        return null;
    }

    /** STUB: desktop creates projects via project_create_new. */
    createSlot(_content, _name)
    {
        throw new Error('createSlot: desktop creates projects via project_create_new, not save-slot-manager');
    }

    /** STUB: script saves go via saveScript on the desktop. */
    saveSlotContent(_id, _content) {}

    /** STUB: future PR may wire to project folder rename. */
    renameSlot(_id, _newName) {}

    /** STUB: desktop projects are deleted from the filesystem, not from storage. */
    deleteSlot(_id)
    {
        return false;
    }

    /** STUB: no legacy single-key save format on the desktop. */
    migrateFromLegacy()
    {
        return null;
    }

    /** STUB: desktop does not use the mangastory v2 store. */
    getMangastory(_slotId)
    {
        return null;
    }

    /** STUB: desktop does not use the mangastory v2 store. */
    setMangastory(_slotId, _mangastory)
    {
        return false;
    }

    /**
     * PAGE DRAWING API — primary call-site for mps-canvas.
     * @param {string} _slotId
     * @param {number} pageIndex
     * @returns {{ strokes: any[], version: string, recordedWidth: number }|null}
     */
    getPageDrawing(_slotId, pageIndex)
    {
        const b = _bridge();
        if (!b) return null;
        const m = b.getMangaart();
        if (!m || !Array.isArray(m.pages)) return null;
        const entry = m.pages.find((p) => p.index === pageIndex);
        return entry ? entry.drawing : null;
    }

    /**
     * @param {string} _slotId
     * @param {number} pageIndex
     * @param {any[]} strokes
     * @param {string} [format]
     * @param {number} [recordedWidth]
     * @returns {boolean}
     */
    savePageDrawing(_slotId, pageIndex, strokes, format, recordedWidth)
    {
        const b = _bridge();
        if (!b) return false;
        const drawing = {
            strokes,
            version: format || 'drawengine:v1',
            recordedWidth: recordedWidth || 800,
        };
        b.updatePage(pageIndex, drawing);
        b.queueSave();
        return true;
    }

    /**
     * Tool settings persist via PersistentStorage (global, not per-slot).
     * @param {string} _slotId
     * @returns {any}
     */
    getDrawingToolSettings(_slotId)
    {
        return PersistentStorage.get(
            STORAGE_KEYS.DRAWING_TOOL_SETTINGS_V1,
            STORAGE_DEFAULTS[STORAGE_KEYS.DRAWING_TOOL_SETTINGS_V1]
        );
    }

    /**
     * @param {any} settings
     * @returns {boolean}
     */
    saveDrawingToolSettings(settings)
    {
        return PersistentStorage.set(STORAGE_KEYS.DRAWING_TOOL_SETTINGS_V1, settings);
    }
}

const SaveSlotManager = new SaveSlotManagerImpl();

/**
 * Resolve the active drawing-key id. Follows the same `__MPS_ENV__`
 * convention as the website so `core/drawing/*` keeps working unchanged.
 * @returns {string|null}
 */
function resolveDrawingId()
{
    const env = /** @type {any} */ (globalThis).__MPS_ENV__;
    if (env && typeof env.getDrawingId === 'function')
    {
        return env.getDrawingId();
    }
    return SaveSlotManager.getActiveSlotId();
}

// ── Tauri FS command wrappers ──────────────────────────────────────────────
//
// Thin JS shims over the `app_*` Tauri commands. They dispatch the same way
// as `project.js` — through `@tauri-apps/api/core` invoke in the .exe, or
// through the in-memory `_fakeFs` stub in the browser / jsdom test harness
// (re-routed via `_invokeForTest` so the stub branches stay in one place).
//
// Each helper throws on any Rust-side error string so callers can `try/catch`
// for specific variants like `trash-unavailable`, `target-exists`,
// `access-denied`, `project-is-open`, `not-found`.

import { _invokeForTest } from "../project/project.js";
import { isTauri } from "../util/index.js";

/**
 * Dispatch a Tauri command, falling back to the browser fakefs stub. Throws
 * if the command returns / resolves to an Error-shape (Tauri rejects with a
 * string; the WebView2 client surfaces that as a thrown string).
 * @param {string} cmd
 * @param {any} [args]
 * @returns {Promise<any>}
 */
async function _invokeFs(cmd, args)
{
    if (isTauri())
    {
        const { invoke } = await import("@tauri-apps/api/core");
        return invoke(cmd, args);
    }
    return _invokeForTest(cmd, args);
}

/**
 * Open a Save-As dialog. Returns the chosen absolute path or `null` on cancel.
 * When MPS_TEST_SAVE_DIR is set in the host process the Rust side skips the
 * dialog and returns `<test-dir>/<defaultName>` directly.
 *
 * @param {string} defaultName  Suggested filename (e.g. "Big-Fish.fdx").
 * @param {Array<[string, string[]]>} filters  e.g. [["Final Draft", ["fdx"]]]
 * @returns {Promise<string|null>}
 */
export async function saveFileDialog(defaultName, filters)
{
    return _invokeFs("app_save_file_dialog", { defaultName, filters });
}

/**
 * Write bytes (Uint8Array or number[]) to `path`. Creates parent directories
 * as needed. Used by Export Screenplay for binary blobs (PDF, FadeIn ZIP)
 * AND text outputs (Fountain, FDX, TXT) — both go through the same byte path
 * so the writer doesn't have to track which format is binary.
 *
 * @param {string} path
 * @param {Uint8Array|number[]} bytes
 * @returns {Promise<void>}
 */
export async function writeBytes(path, bytes)
{
    const arr = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
    return _invokeFs("app_write_bytes", { path, bytes: arr });
}

/**
 * Resolve the on-disk path of a folder-scoped `.mangaart` at
 * `<project>/_mangaplaystudio/storyboard/folders/<folderUuid>.mangaart`.
 *
 * Mirrors the file-scoped `mangaart_resolve_by_uuid` (which project.js
 * invokes directly). The Rust command ensures the `folders/` subdirectory
 * exists on disk before returning, so callers can immediately write to the
 * returned path.
 *
 * Returns the resolved path even when the file has not been scaffolded yet;
 * `null` only when the storyboard root cannot be created.
 *
 * @param {string} projectPath  Absolute project root.
 * @param {string} folderUuid   Registry UUID of the folder entry.
 * @returns {Promise<string|null>}
 */
export async function mangaartResolveByFolderUuid(projectPath, folderUuid)
{
    return _invokeFs("mangaart_resolve_by_folder_uuid", { projectPath, folderUuid });
}

/**
 * Look up the Google Slides link for `scriptRelPath`. When `folderUuid` is
 * non-null the folder-scoped link is preferred; otherwise the file-scoped
 * entry is returned.
 *
 * Returns `null` when no link exists (no error, no thrown). Rust errors
 * (validation, project.json read failure) surface as thrown strings so
 * callers keep their existing try/catch shapes.
 *
 * @param {{projectPath: string, scriptRelPath: string, folderUuid?: string|null}} args
 * @returns {Promise<any>}
 */
export async function slidesLinkGet({ projectPath, scriptRelPath, folderUuid = null })
{
    return _invokeFs("slides_link_get", { projectPath, scriptRelPath, folderUuid });
}

// ── UUID-aware registry adapter layer ──────────────────────────────────────
//
// UUID-aware registry adapter layer — calls the Rust `registry_*` commands.
// The legacy path-based helpers above still exist and will be migrated over.
//
// Callers use `uuid` as the identity key. `relPath` in TreeEntryDto is a
// display hint only — never round-trip it back to Rust.

/**
 * @typedef {"file"|"folder"} TreeEntryKind
 *
 * @typedef {Object} TreeEntryDto
 * @property {string} uuid
 * @property {string|null} parentUuid
 * @property {string} name              Basename only, no slashes.
 * @property {string} relPath           Project-relative forward-slash path — display hint only.
 * @property {TreeEntryKind} kind
 * @property {number} rev
 * @property {string|null} modifiedAt
 *
 * @typedef {"created" | "modified" | "deleted" | "renamed" | "moved" | "unknown"} RegistryFsChangeKind
 *
 * @typedef {object} RegistryFsChange
 * @property {RegistryFsChangeKind} change    - Variant tag.
 * @property {string | null} uuid             - Entry UUID (null on `unknown`).
 * @property {string | null} parentUuid       - Parent UUID (only on `created`).
 * @property {string | null} name             - Basename (only on `created`).
 * @property {string | null} relPath          - Project-relative forward-slash path.
 * @property {number | null} rev              - Post-change revision (null on `deleted`/`unknown`).
 * @property {string | null} kind             - "file" | "folder" (only on `created`).
 * @property {string | null} newName          - New basename (only on `renamed`).
 * @property {string | null} newParentUuid    - New parent UUID (only on `moved`).
 *
 * Emitted by Rust's `registry-fs-changed` event. The raw wire payload uses
 * kebab-case keys; this typedef describes the CAMELCASE shape after
 * `subscribeRegistryFsChanged` normalises.
 */

/**
 * Error thrown by any `registry*` adapter helper when Rust returns a
 * `fs-err:...` string. The `kind` field is one of:
 *   "unknown-uuid" | "deleted" | "stale" | "stale-rev"
 *   | "permission-denied" | "no-project-open" | "io" | "internal"
 */
export class FsError extends Error
{
    /**
     * @param {string} kind
     * @param {Record<string, any>} payload
     * @param {string|null} [raw]  Original `fs-err:...` wire string, when available.
     */
    constructor(kind, payload, raw = null)
    {
        super(`${kind}: ${JSON.stringify(payload)}`);
        this.name = "FsError";
        this.kind = kind;
        this.payload = payload;
        this.raw = raw;
        this.uuid = payload.uuid ?? null;
        this.rev = payload["current-rev"] ?? null;
        this.expectedRev = payload["expected-rev"] ?? null;
        this.lastKnownPath = payload["last-known-path"] ?? null;
    }
}

/**
 * Parse a Rust-side `fs-err:{...json}` error string into a {@link FsError}.
 * Accepts either a bare string or an `Error` instance whose `.message` is the
 * raw wire string (Tauri v2 sometimes surfaces command rejections that way).
 * Returns `null` when the raw value is not a recognisable fs-err.
 * @param {unknown} rawErr
 * @returns {FsError|null}
 */
export function parseFsError(rawErr)
{
    let str = null;
    if (typeof rawErr === "string") str = rawErr;
    else if (rawErr instanceof Error && typeof rawErr.message === "string") str = rawErr.message;
    else return null;

    if (!str.startsWith("fs-err:")) return null;
    try
    {
        const parsed = JSON.parse(str.slice("fs-err:".length));
        if (!parsed || typeof parsed !== "object") return null;
        const { kind, ...payload } = parsed;
        if (typeof kind !== "string") return null;
        return new FsError(kind, payload, str);
    }
    catch (e)
    {
        return null;
    }
}

/**
 * Invoke a `registry_*` Tauri command with unified error handling — any raw
 * `fs-err:...` string is rethrown as {@link FsError}; anything else passes
 * through unchanged.
 * @param {string} cmd
 * @param {any} [args]
 * @returns {Promise<any>}
 */
async function invokeRegistry(cmd, args)
{
    try
    {
        return await _invokeFs(cmd, args);
    }
    catch (rawErr)
    {
        const parsed = parseFsError(rawErr);
        if (parsed) throw parsed;
        throw rawErr;
    }
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * List every entry in the currently-open project registry.
 * @returns {Promise<Array<TreeEntryDto>>}
 */
export async function registryListTree()
{
    return invokeRegistry("registry_list_tree");
}

/**
 * Read a file by UUID.
 *
 * Throws FsError with kind="io", payload.message="is-a-folder" if uuid
 * resolves to a folder entry.
 *
 * @param {string} uuid
 * @returns {Promise<{ contents: string, rev: number }>}
 */
export async function registryReadFile(uuid)
{
    return invokeRegistry("registry_read_file", { uuid });
}

// ── Writes ─────────────────────────────────────────────────────────────────

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Create a new file or folder under `parentUuid` (or the project root when
 * `parentUuid` is `null`). `basename` is validated Rust-side.
 * @param {string|null} parentUuid
 * @param {string} basename
 * @param {"folder"|"mangaplay"|"fountain"|"superscript"|"text"} kind
 * @returns {Promise<TreeEntryDto>}
 */
export async function registryCreateFile(parentUuid, basename, kind)
{
    return invokeRegistry("registry_create_file", { parentUuid, basename, kind });
}

/**
 * Rename a UUID's basename in place. Basename only — no slashes.
 * @param {string} uuid
 * @param {string} newBasename
 * @param {number} [expectedRev=0]
 * @returns {Promise<TreeEntryDto>}
 */
export async function registryRename(uuid, newBasename, expectedRev = 0)
{
    return invokeRegistry("registry_rename", { uuid, newBasename, expectedRev });
}

/**
 * Move a UUID under `newParentUuid` (or the project root when `null`).
 * @param {string} uuid
 * @param {string|null} newParentUuid
 * @param {number} [expectedRev=0]
 * @returns {Promise<TreeEntryDto>}
 */
export async function registryMove(uuid, newParentUuid, expectedRev = 0)
{
    return invokeRegistry("registry_move", { uuid, newParentUuid, expectedRev });
}

/**
 * Trash-delete a UUID. Rust returns `fs-err:{kind:"io",...trash-unavailable}`
 * on platforms without a trash — caller falls back to
 * {@link registryDeleteForce} after user confirmation.
 * @param {string} uuid
 * @param {number} [expectedRev=0]
 * @returns {Promise<void>}
 */
export async function registryDelete(uuid, expectedRev = 0)
{
    return invokeRegistry("registry_delete", { uuid, expectedRev });
}

/**
 * Hard-delete a UUID, bypassing the trash. Only call after explicit user
 * confirmation.
 * @param {string} uuid
 * @param {number} [expectedRev=0]
 * @returns {Promise<void>}
 */
export async function registryDeleteForce(uuid, expectedRev = 0)
{
    return invokeRegistry("registry_delete_force", { uuid, expectedRev });
}

/**
 * Duplicate a file inside its own parent directory. Rust picks the next free
 * basename via `next_free_name`.
 *
 * Throws FsError with kind="io", payload.message="copy-folder-not-supported"
 * if uuid resolves to a folder entry.
 *
 * @param {string} uuid
 * @returns {Promise<TreeEntryDto>}
 */
export async function registryCopy(uuid)
{
    return invokeRegistry("registry_copy", { uuid });
}

// ── Watcher ────────────────────────────────────────────────────────────────

/**
 * Normalise a raw `registry-fs-changed` wire payload (kebab-case) to the
 * camelCase {@link RegistryFsChange} shape callers expect. Only the specific
 * keys the JS side consumes are translated — DO NOT do a generic kebab→camel
 * conversion, because Rust may add fields we don't know about yet.
 * @param {any} raw
 * @returns {RegistryFsChange}
 */
export function normaliseRegistryFsChange(raw)
{
    if (!raw || typeof raw !== "object") return raw;
    return {
        change: raw.change,
        uuid: raw.uuid ?? null,
        parentUuid: raw["parent-uuid"] ?? null,
        name: raw.name ?? null,
        relPath: raw["rel-path"] ?? null,
        rev: raw.rev ?? null,
        kind: raw.kind ?? null,
        newName: raw["new-name"] ?? null,
        newParentUuid: raw["new-parent-uuid"] ?? null,
    };
}

/**
 * Subscribe to `registry-fs-changed` events. Callers MUST await the return
 * value to obtain the unsubscribe function:
 *
 *   const unsub = await subscribeRegistryFsChanged(payload => { ... });
 *   // ... later:
 *   unsub();
 *
 * Handler receives a camelCase {@link RegistryFsChange} — the raw kebab-case
 * wire payload is normalised via {@link normaliseRegistryFsChange} before
 * dispatch.
 *
 * The legacy `project-fs-changed` listener (path-based, wired in app.js) is
 * intentionally left in place — it will be replaced when 4b migrates
 * project.js.
 *
 * @param {(change: RegistryFsChange) => void} handler
 * @returns {Promise<() => void>} unsubscribe fn (resolves after listener registers).
 */
export async function subscribeRegistryFsChanged(handler)
{
    const { listen } = await import("@tauri-apps/api/event");
    return listen("registry-fs-changed", (event) =>
    {
        const raw = /** @type {any} */ (event.payload)?.change ?? event.payload;
        const normalised = normaliseRegistryFsChange(raw);
        handler(normalised);
    });
}

export {
    PersistentStorage,
    STORAGE_KEYS,
    STORAGE_DEFAULTS,
    SaveSlotManager,
    resolveDrawingId,
};

export default SaveSlotManager;
