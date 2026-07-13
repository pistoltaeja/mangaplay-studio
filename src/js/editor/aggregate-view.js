// @ts-check
/**
 * aggregate-view.js — windowed 3-view aggregate shell for Storyboard/
 * Screenplay folders. Mounts up to three concurrent CM6 EditorView instances
 * (previous / focused / next in alphabetical child order) plus placeholder
 * divs for out-of-window siblings, or a single `<mps-canvas>` in visual mode.
 *
 * See TODO/folder-options-menu.md §2.0 – §2.10 for the architectural spec.
 * Round A (this file) implements the shell — Round B wires consumers
 * (explorer file-open, mode toggle, fs-listeners, session restore).
 *
 * Public API (see MountAggregateOpts / AggregateHandle typedefs below):
 *   - mountAggregate(opts)         → Promise<AggregateHandle>
 *   - getActiveAggregate()         → AggregateHandle | null
 *   - _setActiveAggregate(handle)  → internal, exported for tests
 *
 * IMPORTANT: at most one aggregate handle is live in the renderer at any
 * time. `mountAggregate` sets the module-level active-handle pointer; the
 * handle's `destroy()` clears it. `flushCurrentProjectMeta` at boot.js reads
 * the active handle to drain brokers on shutdown / project close.
 */

import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyField, historyKeymap } from "@codemirror/commands";
import { invoke } from "@tauri-apps/api/core";

import { buildEditorExtensions, formatForFilename } from "./lang-registry.js";
import { registerView, unregisterView, setFocused } from "./focused-view-registry.js";
import { createBroker } from "../project/active-script-broker.js";
import { loadMangaartForFolder, saveScript } from "../project/project.js";

// ── internal kill-switch ─────────────────────────────────────────────────

/**
 * INTERNAL KILL-SWITCH — set to `true` to enable folder aggregate view;
 * `false` reverts every consumer to legacy per-file behaviour.
 *
 * When `false`:
 *   - `mountAggregate()` returns null immediately without touching the DOM.
 *   - `getActiveAggregate()` always returns null (aggregate never becomes active).
 *   - Consumers guard their fork-to-aggregate paths on this flag and fall
 *     through to the pre-existing single-file path.
 *   - The Folder Options popup still saves to meta.json, but nothing reads it.
 *
 * When `true`:
 *   - Full aggregate behaviour per §2 of TODO/folder-options-menu.md.
 *
 * Flip in source to enable. No runtime toggle, no UI, no persistence.
 */
export const renderGroupsAsOne = false;

// ── typedefs ─────────────────────────────────────────────────────────────

/**
 * @typedef {import("../project/active-script-broker.js")} BrokerModule
 */

/**
 * @typedef {Object} MountAggregateOpts
 * @property {string} folderUuid                                 - stable folder UUID
 * @property {string} activeFileUuid                             - fileUuid to focus on mount
 * @property {"source"|"text"|"visual"} mode                     - initial editor mode
 * @property {HTMLElement} container                             - scroll container to render into
 * @property {string} projectPath                                - absolute project root
 * @property {string[]} files                                    - alphabetically-ordered fileUuid list of valid children
 * @property {(fileUuid: string) => string} basenameFor          - resolve basename for tab labels + placeholder text
 * @property {(fileUuid: string) => Promise<{ path: string, text: string }>} loadFile  - read source text + path
 * @property {string} [folderName]                               - display name of the folder (falls back to basenameFor(folderUuid))
 * @property {Object.<string, number>} [initialHeights]          - fileUuid → measured pixel height (from meta.json `aggregateHeights`)
 * @property {number} [initialHeightsGeneration]                 - cache generation (from meta.json `heightsCacheGeneration`)
 * @property {(uuid: string, heightPx: number) => void} [onMeasureHeight]  - Round B persists into meta.json `aggregateHeights`
 * @property {(nextGeneration: number) => void} [onGenerationBump]         - Round B bumps meta.json `heightsCacheGeneration` on font/theme change
 * @property {number} [initialScrollTop]                         - scroll container initial scrollTop (session restore)
 */

/**
 * @typedef {Object} SlideStats
 * @property {number} count
 * @property {number} p50
 * @property {number} p95
 * @property {number} max
 */

/**
 * @typedef {Object} FsChangeEvent
 * @property {"created"|"modified"|"deleted"|"renamed"|"moved"} type
 * @property {string | null} [oldPath]
 * @property {string | null} [newPath]
 * @property {string | null} [uuid]
 */

/**
 * @typedef {Object} AggregateHandle
 * @property {() => Promise<void>} destroy
 * @property {(fileUuid: string) => Promise<void>} jumpToFile
 * @property {() => string | null} currentFocusedFileUuid
 * @property {(mode: "source"|"text"|"visual") => Promise<void>} applyMode
 * @property {() => Promise<{ text: string, folderName: string, childBasenames: string[], format: string }>} collectSourceForExport
 * @property {() => any[]} getActiveBrokers
 * @property {() => Promise<void>} drainAll
 * @property {() => SlideStats} getSlideStats
 * @property {() => number | null} getScrollTop
 * @property {(event: FsChangeEvent) => Promise<void>} onFsChange
 * @property {(fileUuid: string, action: "reload"|"keep") => Promise<void>} reconcileExternal
 * @property {(fileUuid: string) => boolean} hasUnsavedBufferForFile
 * @property {(fileUuid: string) => boolean} isFileMounted
 * @property {Map<string, { json: any, unmountedAt: number }>} historySnapshots
 * @property {string} folderUuid
 */

/**
 * @typedef {Object} MountedEntry
 * @property {EditorView} view
 * @property {"hot"|"warm"} role
 * @property {HTMLElement} container            - the per-view outer div inside the scroll container
 * @property {any} broker                        - factory Broker instance for this file
 * @property {Compartment} roleCompartment       - CM6 compartment holding buildEditorExtensions(format, role)
 * @property {import("./lang-registry.js").EditorFormat} format
 * @property {string} path                       - absolute file path
 * @property {number | null} placeholderReplacedAt
 */

// ── module-level active-handle pointer ───────────────────────────────────

/** @type {AggregateHandle | null} */
let activeAggregate = null;

/** @returns {AggregateHandle | null} */
export function getActiveAggregate()
{
    if (!renderGroupsAsOne) return null;
    return activeAggregate;
}

/**
 * Internal setter — exposed for tests that need to plant a fake handle.
 * Production code should NEVER call this directly; `mountAggregate` /
 * `AggregateHandle.destroy` own the pointer.
 * @param {AggregateHandle | null} h
 */
export function _setActiveAggregate(h)
{
    activeAggregate = h;
}

// ── LRU + history helpers ────────────────────────────────────────────────

const HISTORY_LRU_MAX = 20;

/**
 * @param {Map<string, { json: any, unmountedAt: number }>} snapshots
 */
function enforceHistoryLru(snapshots)
{
    if (snapshots.size <= HISTORY_LRU_MAX) return;
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [k, v] of snapshots)
    {
        if (v.unmountedAt < oldestTs)
        {
            oldestTs = v.unmountedAt;
            oldestKey = k;
        }
    }
    if (oldestKey) snapshots.delete(oldestKey);
}

/**
 * Snapshot a view's CM6 history state onto the per-aggregate LRU map.
 * @param {Map<string, { json: any, unmountedAt: number }>} snapshots
 * @param {string} fileUuid
 * @param {EditorView} view
 */
function snapshotHistoryOnto(snapshots, fileUuid, view)
{
    try
    {
        const json = view.state.toJSON({ history: historyField });
        snapshots.set(fileUuid, { json, unmountedAt: Date.now() });
        enforceHistoryLru(snapshots);
    }
    catch (err)
    {
        console.warn("[aggregate-view] snapshotHistory failed for", fileUuid, err);
    }
}

// ── title-page stripping ─────────────────────────────────────────────────

/**
 * Best-effort strip of a mangaplay/fountain title-page block from the top of
 * `text`. The block runs from the first line to the first blank line iff the
 * first line matches a title-page key (`Title:`, `Author:`, etc). If the top
 * doesn't look like a title page, `text` is returned unchanged.
 *
 * Deliberately narrow: the parser's own title-page recogniser is the source
 * of truth; this is only used to prepare per-file bodies for concatenation
 * where the folder-level `Title: <folderName>` supersedes.
 *
 * @param {string} text
 * @returns {string}
 */
function stripTitlePage(text)
{
    if (!text) return text;
    // A title-page key is a run of letters + spaces followed by ":".
    const keyLine = /^[A-Za-z][A-Za-z ]*:/;
    const lines = text.split(/\r?\n/);
    if (lines.length === 0 || !keyLine.test(lines[0])) return text;
    let i = 0;
    // Consume until the first blank line — the title-page terminator per the
    // Fountain / mangaplay spec.
    while (i < lines.length && lines[i].trim() !== "") i++;
    // Skip the blank line itself.
    while (i < lines.length && lines[i].trim() === "") i++;
    return lines.slice(i).join("\n");
}

// ── height estimate ──────────────────────────────────────────────────────

const HEIGHT_LINE_PX = 22;
const HEIGHT_CONSTANT_PX = 40;

/**
 * Cheap first-time placeholder height. Real cached heights are measured on
 * rAF post-mount and overwrite this estimate in the state map.
 * @param {string} text
 * @returns {number}
 */
function estimateHeight(text)
{
    if (!text) return HEIGHT_CONSTANT_PX;
    let lineCount = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineCount++;
    return lineCount * HEIGHT_LINE_PX + HEIGHT_CONSTANT_PX;
}

// ── main entry ───────────────────────────────────────────────────────────

/**
 * Mount an aggregate view. Round A never has a producer — Round B wires it
 * into explorer's file-open path.
 *
 * @param {MountAggregateOpts} opts
 * @returns {Promise<AggregateHandle | null>}
 */
export async function mountAggregate(opts)
{
    if (!renderGroupsAsOne)
    {
        return null;
    }
    if (activeAggregate)
    {
        console.warn("[aggregate-view] mountAggregate called with an existing active aggregate; destroying previous.");
        try { await activeAggregate.destroy(); }
        catch (e) { console.warn("[aggregate-view] previous destroy failed:", e); }
    }

    const {
        folderUuid,
        activeFileUuid,
        mode: initialMode,
        container,
        projectPath,
        files,
        basenameFor,
        loadFile,
        folderName,
        initialHeights,
        initialHeightsGeneration,
        onMeasureHeight,
        onGenerationBump,
        initialScrollTop,
    } = opts;

    if (!container) throw new Error("mountAggregate: container is required");
    if (!Array.isArray(files) || files.length === 0)
    {
        throw new Error("mountAggregate: files must be a non-empty array");
    }
    let focusedIdx = files.indexOf(activeFileUuid);
    if (focusedIdx < 0) focusedIdx = 0;

    // ── internal state ────────────────────────────────────────────────
    const state = {
        /** @type {string[]} */
        files: files.slice(),
        focusedIdx,
        /** @type {Map<string, MountedEntry>} */
        mounted: new Map(),
        /** @type {Map<string, HTMLElement>} */
        placeholders: new Map(),
        /** @type {Map<string, { json: any, unmountedAt: number }>} */
        historySnapshots: new Map(),
        /** @type {Object.<string, number>} */
        heights: { ...(initialHeights || {}) },
        heightsGeneration: (typeof initialHeightsGeneration === "number") ? initialHeightsGeneration : 0,
        /**
         * Last generation the height cache was invalidated for. When the
         * next `readCachedHeight` sees a bump beyond this value it flushes
         * `state.heights` — cheap lazy invalidation.
         */
        heightsGenerationInvalidated: (typeof initialHeightsGeneration === "number") ? initialHeightsGeneration : 0,
        /**
         * Cached line-count per fileUuid. Populated on measure (alongside
         * pixel-height cache) and consulted by width-change placeholder
         * refresh so we can re-estimate `lineCount × 22 + 40` instead of
         * collapsing to the 40px constant.
         * @type {Map<string, number>}
         */
        lineCounts: new Map(),
        /** @type {number | null} */
        pendingSlide: null,
        /** @type {Promise<void> | null} */
        slideLock: null,
        disposed: false,
        errorState: false,
        consecutiveErrors: 0,
        /** @type {HTMLElement | null} */
        canvasEl: null,
        mode: initialMode,
        lastSourceFocusedIdx: focusedIdx,
        /** @type {number | null} */
        lastContainerWidth: null,
        /** @type {ResizeObserver | null} */
        resizeObserver: null,
        /** @type {number | null} */
        resizeRafHandle: null,
        /**
         * Rolling window (last 40) of slide durations in ms. Used by
         * `getSlideStats()` and smoke case #29 to verify the 300ms p95
         * budget. Populated by `doSlide`'s try/finally bracket.
         * @type {number[]}
         */
        slideMsHistory: [],
        lastSlideMs: 0,
        /** @type {(() => void) | null} */
        fontChangeListener: null,
        /** @type {(() => void) | null} */
        skinChangeListener: null,
        /**
         * Reconcile prompt in-flight guard, keyed by fileUuid. Prevents
         * stacking modals when fs-listeners fires burst `modified` events
         * for the same file.
         * @type {Set<string>}
         */
        reconcileInFlight: new Set(),
    };

    // ── DOM scaffolding ───────────────────────────────────────────────
    container.innerHTML = "";
    container.classList.add("mps-aggregate-container");
    // Aggregate is a vertical column of per-file slots (or placeholders).
    // Scroll happens on the caller-provided container.
    const stackEl = document.createElement("div");
    stackEl.className = "mps-aggregate-stack";
    container.appendChild(stackEl);

    // ── helpers over state ────────────────────────────────────────────

    /**
     * Read cached pixel-height for `fileUuid`. Returns null when no entry
     * exists — callers fall back to `estimateHeight()`.
     *
     * Generation mismatch (font/theme change bumped `heightsGeneration`
     * after seed) invalidates the entire map on first read, so downstream
     * placeholder/measure logic never touches stale numbers.
     * @param {string} fileUuid
     */
    function readCachedHeight(fileUuid)
    {
        // Lazy invalidation guarantees at-most-one clear per generation bump
        // and never bills the cost when the cache is already empty.
        if (state.heightsGenerationInvalidated !== state.heightsGeneration)
        {
            state.heights = {};
            state.heightsGenerationInvalidated = state.heightsGeneration;
        }
        const v = state.heights[fileUuid];
        return (typeof v === "number" && v > 0) ? v : null;
    }

    /**
     * Estimate placeholder height from a cached line count when we have
     * one — falls back to the constant when we don't. Used by placeholder
     * mint AND the ResizeObserver's width-change refresh.
     * @param {string} fileUuid
     */
    function estimateFromLineCount(fileUuid)
    {
        const lc = state.lineCounts.get(fileUuid);
        if (typeof lc === "number" && lc > 0)
        {
            return lc * HEIGHT_LINE_PX + HEIGHT_CONSTANT_PX;
        }
        return HEIGHT_CONSTANT_PX;
    }

    /**
     * Build a placeholder div for an unmounted file. Height picked from the
     * per-fileUuid cache when present, otherwise a text-based estimate.
     * @param {string} fileUuid
     * @param {string | null} [previewText]
     * @returns {HTMLElement}
     */
    function makePlaceholder(fileUuid, previewText = null)
    {
        const el = document.createElement("div");
        el.className = "mps-aggregate-placeholder";
        el.dataset.fileUuid = fileUuid;
        const cached = readCachedHeight(fileUuid);
        // Priority ladder: measured pixel cache → per-file line-count
        // estimate → cheap text-based estimate → constant. Line-count
        // estimate is only meaningful for files we've mounted before this
        // session; new files fall through to the text estimate.
        let h;
        if (cached != null) h = cached;
        else if (state.lineCounts.has(fileUuid)) h = estimateFromLineCount(fileUuid);
        else h = estimateHeight(previewText || "");
        el.style.height = `${h}px`;
        el.textContent = basenameFor(fileUuid) || fileUuid;
        return el;
    }

    /**
     * Mount a single view for `fileUuid` at role `role`. Assembled per §2.3:
     * fresh EditorState (or fromJSON when a history snapshot exists), wrapped
     * in a role compartment so hot↔warm swap does not destroy the view.
     * @param {string} fileUuid
     * @param {"hot"|"warm"} role
     * @returns {Promise<MountedEntry>}
     */
    async function mountViewForFile(fileUuid, role)
    {
        const loaded = await loadFile(fileUuid);
        const format = formatForFilename(loaded.path || basenameFor(fileUuid));
        const roleCompartment = new Compartment();

        // Assemble extensions. `history()` sits OUTSIDE the compartment so
        // undo state survives a hot↔warm reconfigure. Language + decoration
        // extensions ride inside the compartment.
        const outerExtensions = [
            lineNumbers(),
            highlightActiveLine(),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            roleCompartment.of(buildEditorExtensions(format, role)),
            EditorView.lineWrapping,
            EditorView.updateListener.of((update) =>
            {
                if (update.docChanged)
                {
                    // Autosave via this view's dedicated factory broker. The
                    // saveFn closes over the file path we captured at mount
                    // time — a subsequent rename in explorer is expected to
                    // drain + remount, so this closure never fires for a
                    // stale path.
                    try
                    {
                        entry.broker.scheduleScriptSave(
                            update.state.doc.toString(),
                            async (/** @type {string} */ latest) =>
                            {
                                try { await saveScript(entry.path, latest); }
                                catch (e) { console.error("[aggregate-view] autosave failed:", e); }
                            }
                        );
                    }
                    catch (e) { console.warn("[aggregate-view] scheduleScriptSave threw:", e); }
                }
            }),
        ];

        // Restore CM6 history when a snapshot exists; else fresh state.
        const snapshot = state.historySnapshots.get(fileUuid);
        let editorState;
        if (snapshot)
        {
            try
            {
                editorState = EditorState.fromJSON(
                    snapshot.json,
                    { doc: loaded.text, extensions: outerExtensions },
                    { history: historyField }
                );
            }
            catch (e)
            {
                console.warn("[aggregate-view] history fromJSON failed; falling back to fresh state:", e);
                editorState = EditorState.create({ doc: loaded.text, extensions: outerExtensions });
            }
        }
        else
        {
            editorState = EditorState.create({ doc: loaded.text, extensions: outerExtensions });
        }

        const viewContainer = document.createElement("div");
        viewContainer.className = "mps-aggregate-slot";
        viewContainer.dataset.fileUuid = fileUuid;

        const view = new EditorView({ state: editorState, parent: viewContainer });

        // Stash so the mps-editor consumers (spellcheck reconfigure) can
        // reach the compartment + format on this aggregate-owned view.
        /** @type {any} */ (view).__mpsLanguageCompartment = roleCompartment;
        /** @type {any} */ (view).__mpsFormat = format;

        const broker = createBroker();
        broker.setActive(loaded.path, fileUuid);

        /** @type {MountedEntry} */
        const entry = {
            view,
            role,
            container: viewContainer,
            broker,
            roleCompartment,
            format,
            path: loaded.path,
            placeholderReplacedAt: null,
        };

        registerView(view, { aggregateId: folderUuid, fileUuid });

        // Measure once on next rAF and cache. `onMeasureHeight` is Round-B's
        // hook to persist into meta.json's `aggregateHeights`. We also
        // capture the CM6 line count — width-change refresh needs it to
        // re-estimate placeholders without paying the CM6 measure cost.
        requestAnimationFrame(() =>
        {
            try
            {
                const h = view.contentDOM.getBoundingClientRect().height;
                if (h > 0)
                {
                    state.heights[fileUuid] = h;
                    // Track this measurement under the current generation
                    // so the lazy invalidator can distinguish stale entries.
                    state.heightsGenerationInvalidated = state.heightsGeneration;
                    if (onMeasureHeight) onMeasureHeight(fileUuid, h);
                }
                try { state.lineCounts.set(fileUuid, view.state.doc.lines); }
                catch (_) { /* doc may be gone if the view was disposed */ }
            }
            catch (_) { /* view destroyed before rAF fired */ }
        });

        return entry;
    }

    // ── mount / unmount / reconfigure primitives ──────────────────────

    /**
     * Reconfigure a mounted view's language-slot compartment. `history()`
     * lives outside the compartment so undo survives.
     * @param {MountedEntry} entry
     * @param {"hot"|"warm"} nextRole
     */
    function reconfigureRole(entry, nextRole)
    {
        if (entry.role === nextRole) return;
        try
        {
            entry.view.dispatch({
                effects: entry.roleCompartment.reconfigure(
                    buildEditorExtensions(entry.format, nextRole)
                )
            });
            entry.role = nextRole;
        }
        catch (e)
        {
            console.warn("[aggregate-view] reconfigureRole failed:", e);
        }
    }

    /**
     * Insert a mounted view's container into the DOM at its natural position
     * relative to already-mounted siblings. Placeholders that occupied the
     * slot are removed. Ordering is the alphabetical `files` array index.
     * @param {string} fileUuid
     * @param {MountedEntry} entry
     */
    function insertMountedInDom(fileUuid, entry)
    {
        const idx = state.files.indexOf(fileUuid);
        // Remove placeholder if present.
        const placeholder = state.placeholders.get(fileUuid);
        if (placeholder && placeholder.parentNode)
        {
            placeholder.parentNode.replaceChild(entry.container, placeholder);
            state.placeholders.delete(fileUuid);
            return;
        }
        // Otherwise find the correct insertion point: the first child whose
        // fileUuid index is > idx.
        const children = /** @type {HTMLElement[]} */ (Array.from(stackEl.children));
        let before = null;
        for (const child of children)
        {
            const otherUuid = child.dataset.fileUuid;
            if (!otherUuid) continue;
            const otherIdx = state.files.indexOf(otherUuid);
            if (otherIdx > idx) { before = child; break; }
        }
        stackEl.insertBefore(entry.container, before);
    }

    /**
     * Convert a mounted view back into a placeholder. Drains the broker,
     * snapshots history, unregisters, destroys, swaps DOM.
     * @param {string} fileUuid
     */
    async function unmountToPlaceholder(fileUuid)
    {
        const entry = state.mounted.get(fileUuid);
        if (!entry) return;
        try { await entry.broker.drainAllPending(); }
        catch (e) { console.warn("[aggregate-view] drain failed on unmount:", e); }
        snapshotHistoryOnto(state.historySnapshots, fileUuid, entry.view);
        unregisterView(entry.view);
        try { entry.view.destroy(); } catch (_) { /* ignore */ }
        state.mounted.delete(fileUuid);
        const placeholder = makePlaceholder(fileUuid, null);
        if (entry.container.parentNode)
        {
            entry.container.parentNode.replaceChild(placeholder, entry.container);
        }
        state.placeholders.set(fileUuid, placeholder);
    }

    // ── initial mount ─────────────────────────────────────────────────

    /**
     * Mount trio: [focusedIdx - 1, focusedIdx, focusedIdx + 1] clamped.
     */
    async function initialSourceMount()
    {
        // Placeholders for every file first — cheap fill so the scroll
        // container has real geometry before the CM6 views paint.
        for (const uuid of state.files)
        {
            const placeholder = makePlaceholder(uuid, null);
            state.placeholders.set(uuid, placeholder);
            stackEl.appendChild(placeholder);
        }
        const idx = state.focusedIdx;
        const trio = [idx - 1, idx, idx + 1].filter((i) => i >= 0 && i < state.files.length);
        // Mount focused first so the user sees it fastest, then neighbours.
        const focusedUuid = state.files[idx];
        const focusedEntry = await mountViewForFile(focusedUuid, "hot");
        state.mounted.set(focusedUuid, focusedEntry);
        insertMountedInDom(focusedUuid, focusedEntry);
        setFocused(focusedEntry.view);
        for (const i of trio)
        {
            if (i === idx) continue;
            const uuid = state.files[i];
            const entry = await mountViewForFile(uuid, "warm");
            state.mounted.set(uuid, entry);
            insertMountedInDom(uuid, entry);
        }
        // Apply session-restore scrollTop after mount so measured heights
        // are close to real. Round B may re-pin via anchor-delta.
        if (typeof initialScrollTop === "number" && initialScrollTop > 0)
        {
            container.scrollTop = initialScrollTop;
        }
    }

    async function initialVisualMount()
    {
        state.canvasEl = document.createElement("mps-canvas");
        stackEl.appendChild(state.canvasEl);
        try
        {
            const art = await loadMangaartForFolder(projectPath, folderUuid, folderName || basenameFor(folderUuid));
            const setScript = /** @type {any} */ (state.canvasEl).setScript;
            if (typeof setScript === "function")
            {
                try { setScript.call(state.canvasEl, { art }); }
                catch (e) { console.warn("[aggregate-view] canvas setScript failed:", e); }
            }
        }
        catch (e)
        {
            console.warn("[aggregate-view] loadMangaartForFolder failed:", e);
        }
    }

    if (initialMode === "visual")
    {
        await initialVisualMount();
    }
    else
    {
        await initialSourceMount();
    }

    // ── slide algorithm (§2.4) ────────────────────────────────────────

    function scheduleEvaluate()
    {
        if (state.pendingSlide != null) return;
        state.pendingSlide = requestAnimationFrame(() => { evaluateSlide(); });
    }

    function evaluateSlide()
    {
        state.pendingSlide = null;
        if (state.disposed || state.errorState) return;
        if (state.slideLock) return; // will re-schedule on next scroll
        if (state.mode === "visual") return;
        const focusedUuid = state.files[state.focusedIdx];
        const entry = state.mounted.get(focusedUuid);
        if (!entry) return;
        let containerRect, currRect;
        try
        {
            containerRect = container.getBoundingClientRect();
            currRect = entry.view.dom.getBoundingClientRect();
        }
        catch (_) { return; }
        const relTop = currRect.top - containerRect.top;
        const relBot = currRect.bottom - containerRect.top;
        const clientH = container.clientHeight;
        if (relTop > clientH * 0.75)
        {
            state.slideLock = doSlide(-1).finally(() => { state.slideLock = null; });
        }
        else if (relBot < clientH * 0.25)
        {
            state.slideLock = doSlide(+1).finally(() => { state.slideLock = null; });
        }
    }

    /**
     * @param {-1 | 1} direction
     */
    async function doSlide(direction)
    {
        // Bracket the whole slide so smoke case #29 has a live sample —
        // `performance.now()` is available in every runtime we target
        // (WebView2, jsdom, Bun). The finally guard runs even on early
        // return so short-circuit paths (boundary, incoming mount failure)
        // still contribute to `slideMsHistory`; without them the p95 would
        // skew low.
        const t0 = performance.now();
        try
        {
            return await doSlideBody(direction);
        }
        finally
        {
            const dt = performance.now() - t0;
            state.lastSlideMs = dt;
            state.slideMsHistory.push(dt);
            if (state.slideMsHistory.length > 40) state.slideMsHistory.shift();
        }
    }

    /**
     * @param {-1 | 1} direction
     */
    async function doSlideBody(direction)
    {
        if (state.disposed) return;
        const newFocusedIdx = state.focusedIdx + direction;
        if (newFocusedIdx < 0 || newFocusedIdx >= state.files.length) return;
        const incomingIdx = newFocusedIdx + direction;
        const outgoingIdx = state.focusedIdx - direction;
        const incomingUuid = (incomingIdx >= 0 && incomingIdx < state.files.length) ? state.files[incomingIdx] : null;
        const outgoingUuid = (outgoingIdx >= 0 && outgoingIdx < state.files.length) ? state.files[outgoingIdx] : null;

        // Anchor is the new focused view (which was already mounted as warm).
        const pinAnchorUuid = state.files[newFocusedIdx];
        const anchorEntry = state.mounted.get(pinAnchorUuid);
        let anchorRectBefore = null;
        if (anchorEntry)
        {
            try { anchorRectBefore = anchorEntry.view.dom.getBoundingClientRect().top; }
            catch (_) { anchorRectBefore = null; }
        }

        // 1. MOUNT incoming (warm) BEFORE destroying outgoing.
        let incomingEntry = null;
        if (incomingUuid && !state.mounted.has(incomingUuid))
        {
            try
            {
                incomingEntry = await mountViewForFile(incomingUuid, "warm");
                state.mounted.set(incomingUuid, incomingEntry);
                insertMountedInDom(incomingUuid, incomingEntry);
            }
            catch (err)
            {
                console.error("[aggregate-view] slide mount failed:", err);
                state.consecutiveErrors++;
                if (state.consecutiveErrors >= 2)
                {
                    state.errorState = true;
                    console.error("[aggregate-view] entering errorState after 2 consecutive slide failures");
                }
                return; // leave state untouched
            }
        }

        // 2. Pin scrollTop via anchor delta.
        if (anchorRectBefore != null && anchorEntry)
        {
            try
            {
                const anchorRectAfter = anchorEntry.view.dom.getBoundingClientRect().top;
                const delta = anchorRectAfter - anchorRectBefore;
                if (delta !== 0) container.scrollTop += delta;
            }
            catch (_) { /* view detached mid-slide */ }
        }

        // 3. Reconfigure roles.
        const outgoingFocusEntry = state.mounted.get(state.files[state.focusedIdx]);
        if (outgoingFocusEntry) reconfigureRole(outgoingFocusEntry, "warm");
        const newFocusEntry = state.mounted.get(pinAnchorUuid);
        if (newFocusEntry)
        {
            reconfigureRole(newFocusEntry, "hot");
            setFocused(newFocusEntry.view);
        }
        state.focusedIdx = newFocusedIdx;
        state.lastSourceFocusedIdx = newFocusedIdx;

        // 4. Drain + snapshot + destroy outgoing.
        if (outgoingUuid && state.mounted.has(outgoingUuid))
        {
            try { await unmountToPlaceholder(outgoingUuid); }
            catch (e) { console.warn("[aggregate-view] outgoing unmount failed:", e); }
        }

        // Clean success — reset the error counter.
        state.consecutiveErrors = 0;
    }

    // Scroll wiring. `passive: true` per DOM spec — we do not preventDefault
    // and need the browser to skip the intent check.
    const onScroll = () => { scheduleEvaluate(); };
    container.addEventListener("scroll", onScroll, { passive: true });

    // ── ResizeObserver: invalidate height cache on container width change ─

    function scheduleResizeCallback()
    {
        if (state.resizeRafHandle != null) return;
        state.resizeRafHandle = requestAnimationFrame(() =>
        {
            state.resizeRafHandle = null;
            if (state.disposed) return;
            const w = container.clientWidth;
            if (state.lastContainerWidth == null)
            {
                state.lastContainerWidth = w;
                return;
            }
            if (w === state.lastContainerWidth) return;
            state.lastContainerWidth = w;
            // Width change ⇒ line-wrap changes ⇒ cached heights are stale.
            // Refresh placeholder heights from cached line counts; measured
            // heights overwrite on next mount. Line counts are width-
            // independent so they remain valid; only the pixel-height cache
            // is invalidated.
            state.heights = {};
            state.heightsGenerationInvalidated = state.heightsGeneration;
            for (const [uuid, el] of state.placeholders)
            {
                el.style.height = `${estimateFromLineCount(uuid)}px`;
            }
        });
    }

    try
    {
        state.resizeObserver = new ResizeObserver(scheduleResizeCallback);
        state.resizeObserver.observe(container);
        state.lastContainerWidth = container.clientWidth;
    }
    catch (e)
    {
        // ResizeObserver unavailable (very old surface) — non-fatal.
        console.warn("[aggregate-view] ResizeObserver setup failed:", e);
    }

    // Font / theme change subscription. `applyEditorFont`, `applyScreenplayFont`
    // and `applySkin` dispatch `mps:font-change` and `mps:skin-change` on
    // window; either invalidates line-wrap and glyph metrics, so we bump the
    // generation. The read side (readCachedHeight) lazily clears the pixel
    // cache on next placeholder/mount touch; line counts remain valid.
    /** @param {"font"|"skin"} kind */
    function bumpHeightsGeneration(kind)
    {
        state.heightsGeneration++;
        if (onGenerationBump)
        {
            try { onGenerationBump(state.heightsGeneration); }
            catch (e) { console.warn("[aggregate-view] onGenerationBump threw:", e); }
        }
        // Best-effort refresh visible placeholders — pixel cache is stale
        // but line counts are not, so estimateFromLineCount is the closest
        // truth we have until the next mount pays for a real measure.
        for (const [uuid, el] of state.placeholders)
        {
            el.style.height = `${estimateFromLineCount(uuid)}px`;
        }
        void kind;
    }
    state.fontChangeListener = () => { bumpHeightsGeneration("font"); };
    state.skinChangeListener = () => { bumpHeightsGeneration("skin"); };
    try
    {
        window.addEventListener("mps:font-change", state.fontChangeListener);
        window.addEventListener("mps:skin-change", state.skinChangeListener);
    }
    catch (e) { console.warn("[aggregate-view] window listener wire failed:", e); }

    // ── public API surface ────────────────────────────────────────────

    async function drainAll()
    {
        const brokers = [...state.mounted.values()].map((m) => m.broker);
        await Promise.all(brokers.map((b) =>
        {
            try { return b.drainAllPending(); }
            catch (e) { console.warn("[aggregate-view] drainAllPending threw:", e); return Promise.resolve(); }
        }));
    }

    function getActiveBrokers()
    {
        return [...state.mounted.values()].map((m) => m.broker);
    }

    /**
     * Return {count, p50, p95, max} over the current slide-time window.
     * count is the number of samples in the rolling window (≤ 40), so a
     * caller can distinguish "no data" (0) from "warm — 30 samples".
     * @returns {SlideStats}
     */
    function getSlideStats()
    {
        const src = state.slideMsHistory;
        const count = src.length;
        if (count === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
        const sorted = src.slice().sort((a, b) => a - b);
        // Nearest-rank percentile — ceil(p/100 × N) − 1. Matches p50/p95
        // in the perf plan (§2.9) without importing a stats dep.
        const p = (frac) =>
        {
            const idx = Math.min(count - 1, Math.max(0, Math.ceil(frac * count) - 1));
            return sorted[idx];
        };
        return {
            count,
            p50: p(0.5),
            p95: p(0.95),
            max: sorted[count - 1],
        };
    }

    function getScrollTop()
    {
        try { return container.scrollTop; }
        catch (_) { return null; }
    }

    /**
     * @param {string} fileUuid
     * @returns {boolean}
     */
    function isFileMounted(fileUuid)
    {
        return state.mounted.has(fileUuid);
    }

    /**
     * A view has a pending buffer edit when its broker holds a queued
     * script save. `pendingScript` is the write-side surface that lands
     * on disk after debounce — the source of truth for "unsaved" here.
     * @param {string} fileUuid
     * @returns {boolean}
     */
    function hasUnsavedBufferForFile(fileUuid)
    {
        const entry = state.mounted.get(fileUuid);
        if (!entry) return false;
        return !!(entry.broker && entry.broker.pendingScript);
    }

    function currentFocusedFileUuid()
    {
        return state.files[state.focusedIdx] || null;
    }

    /** @param {string} fileUuid */
    async function jumpToFile(fileUuid)
    {
        if (state.disposed) return;
        if (state.mode === "visual") return;
        const targetIdx = state.files.indexOf(fileUuid);
        if (targetIdx < 0) return;
        if (state.mounted.has(fileUuid))
        {
            // Already in window — just scroll + focus.
            const entry = state.mounted.get(fileUuid);
            if (entry)
            {
                try { entry.view.dom.scrollIntoView({ block: "start" }); }
                catch (_) { /* ignore */ }
                const prevUuid = state.files[state.focusedIdx];
                const prevEntry = state.mounted.get(prevUuid);
                if (prevEntry && prevEntry !== entry) reconfigureRole(prevEntry, "warm");
                reconfigureRole(entry, "hot");
                setFocused(entry.view);
                state.focusedIdx = targetIdx;
                state.lastSourceFocusedIdx = targetIdx;
            }
            return;
        }
        // Target is out-of-window — drain + tear down current trio, mount fresh.
        await drainAll();
        for (const uuid of [...state.mounted.keys()])
        {
            await unmountToPlaceholder(uuid);
        }
        state.focusedIdx = targetIdx;
        state.lastSourceFocusedIdx = targetIdx;
        const trio = [targetIdx - 1, targetIdx, targetIdx + 1].filter(
            (i) => i >= 0 && i < state.files.length
        );
        const focusedUuid = state.files[targetIdx];
        const focusedEntry = await mountViewForFile(focusedUuid, "hot");
        state.mounted.set(focusedUuid, focusedEntry);
        insertMountedInDom(focusedUuid, focusedEntry);
        setFocused(focusedEntry.view);
        for (const i of trio)
        {
            if (i === targetIdx) continue;
            const uuid = state.files[i];
            const entry = await mountViewForFile(uuid, "warm");
            state.mounted.set(uuid, entry);
            insertMountedInDom(uuid, entry);
        }
    }

    /**
     * @param {"source"|"text"|"visual"} nextMode
     */
    async function applyMode(nextMode)
    {
        if (state.disposed) return;
        if (nextMode === state.mode) return;
        const goingVisual = nextMode === "visual";
        const leavingVisual = state.mode === "visual";
        if (goingVisual === leavingVisual)
        {
            // source ↔ text: no destroy. Fan out mode reconfigure to every
            // mounted view. mps-editor.js owns the per-view mode swap; we
            // dispatch through the same helper so aggregate + single-file
            // stay symmetrical. Dynamic import avoids a static cycle with
            // mps-editor which itself may consume aggregate helpers later.
            const { setEditorViewMode } = await import("./mps-editor.js");
            for (const entry of state.mounted.values())
            {
                try { setEditorViewMode(entry.view, nextMode); }
                catch (e) { console.warn("[aggregate-view] setEditorViewMode failed:", e); }
            }
            state.mode = nextMode;
            return;
        }
        if (goingVisual)
        {
            // source/text → visual: drain + snapshot + destroy all views, mount canvas.
            await drainAll();
            for (const uuid of [...state.mounted.keys()])
            {
                await unmountToPlaceholder(uuid);
            }
            state.lastSourceFocusedIdx = state.focusedIdx;
            // Placeholders remain in the DOM under stackEl. Clear them and
            // mount the canvas as the sole child.
            stackEl.innerHTML = "";
            state.placeholders.clear();
            state.mode = nextMode;
            await initialVisualMount();
        }
        else
        {
            // visual → source/text: destroy canvas, remount trio at last focus.
            if (state.canvasEl && state.canvasEl.parentNode)
            {
                state.canvasEl.parentNode.removeChild(state.canvasEl);
            }
            state.canvasEl = null;
            state.mode = nextMode;
            state.focusedIdx = state.lastSourceFocusedIdx;
            await initialSourceMount();
        }
    }

    async function collectSourceForExport()
    {
        await drainAll();
        /** @type {string[]} */
        const parts = [];
        /** @type {string[]} */
        const basenames = [];
        /** @type {string | null} */
        let firstFormat = null;
        for (const fileUuid of state.files)
        {
            const base = basenameFor(fileUuid);
            basenames.push(base);
            if (firstFormat == null)
            {
                firstFormat = formatForFilename(base);
            }
            let text;
            const mounted = state.mounted.get(fileUuid);
            if (mounted)
            {
                text = mounted.view.state.doc.toString();
            }
            else
            {
                try
                {
                    const loaded = await loadFile(fileUuid);
                    text = loaded.text;
                }
                catch (e)
                {
                    console.warn("[aggregate-view] collectSourceForExport: loadFile failed for", fileUuid, e);
                    text = "";
                }
            }
            parts.push(stripTitlePage(text));
        }
        const resolvedFolderName = folderName || basenameFor(folderUuid) || "Untitled";
        const synthetic = `Title: ${resolvedFolderName}\n\n`;
        return {
            text: synthetic + parts.join("\n\n"),
            folderName: resolvedFolderName,
            childBasenames: basenames,
            format: firstFormat || "mangaplay",
        };
    }

    /**
     * Reconcile an external `modified` event against a mounted view that
     * has queued edits. `action` picks: "reload" replaces the CM6 doc from
     * disk (and drops the file's history snapshot — it's referenced against
     * a doc range that no longer exists), "keep" is a no-op (the next
     * broker save will overwrite disk with the buffer).
     *
     * Callers (fs-listeners) prompt the user via confirmModal and hand the
     * resolved action here. Idempotent + guarded — a burst of `modified`
     * events for the same file collapses to one live prompt.
     *
     * @param {string} fileUuid
     * @param {"reload"|"keep"} action
     */
    async function reconcileExternal(fileUuid, action)
    {
        if (state.disposed) return;
        const entry = state.mounted.get(fileUuid);
        if (!entry) return;
        if (action === "keep")
        {
            // Nothing to do — the buffer wins on the next debounced save.
            return;
        }
        if (action !== "reload") return;
        try
        {
            const loaded = await loadFile(fileUuid);
            const cur = entry.view.state.doc.length;
            entry.view.dispatch({
                changes: { from: 0, to: cur, insert: loaded.text }
            });
            // History against the old doc is now invalid — the snapshot
            // records positions past the new doc end.
            state.historySnapshots.delete(fileUuid);
        }
        catch (e)
        {
            console.warn("[aggregate-view] reconcile reload failed:", e);
        }
    }

    /**
     * Refresh internal state on a folder-scoped fs event. Callers
     * (fs-listeners) resolve the alphabetical child list themselves and
     * pass the delta via `event`; we diff against `state.files` +
     * `state.mounted` and re-mount replacement neighbours when a mounted
     * file is deleted or moved out.
     *
     * `renamed`/`moved` within-folder update the basename mapping only.
     * `renamed`/`moved` out-of-folder AND `deleted` fire drop-and-shift.
     * `created` is a metadata refresh — the file only mounts if it enters
     * the current 3-view window on the next scroll.
     *
     * This runs on a bare await, not a slideLock, so a burst of events
     * can queue multiple invocations. fs-listeners debounces upstream
     * before invoking us so realistic bursts collapse to one call.
     *
     * @param {FsChangeEvent} event
     */
    async function onFsChange(event)
    {
        if (state.disposed) return;
        if (state.mode === "visual")
        {
            // Visual mode doesn't mount the source trio — nothing to
            // reshape here. The folder-scoped mangaart reload is Round C.
            return;
        }
        if (!event || !event.type) return;
        // Re-resolve the alphabetical child list. For rename/move we can
        // reuse the existing list mostly; for delete/create we need the
        // authoritative snapshot from the caller. In v1 we ask the caller
        // to refresh state.files by rebuilding via the same producer used
        // at mount — we simply expose a re-index primitive. Since the
        // producer lives in explorer.js and cross-module state is
        // brittle, we do a targeted diff based on the event only.
        try
        {
            if (event.type === "deleted" && event.uuid)
            {
                const idx = state.files.indexOf(event.uuid);
                if (idx < 0) return;
                const wasMounted = state.mounted.has(event.uuid);
                // Drop from files list, adjust focusedIdx to a live entry.
                state.files.splice(idx, 1);
                if (state.files.length === 0)
                {
                    // Empty folder — leave the aggregate alive but disposed
                    // of its trio. Consumer (fs-listeners) is expected to
                    // close the tab shortly after.
                    return;
                }
                if (state.focusedIdx >= state.files.length)
                {
                    state.focusedIdx = state.files.length - 1;
                    state.lastSourceFocusedIdx = state.focusedIdx;
                }
                const placeholder = state.placeholders.get(event.uuid);
                if (placeholder && placeholder.parentNode)
                {
                    placeholder.parentNode.removeChild(placeholder);
                }
                state.placeholders.delete(event.uuid);
                if (wasMounted)
                {
                    const entry = state.mounted.get(event.uuid);
                    if (entry)
                    {
                        try { unregisterView(entry.view); } catch (_) { /* ignore */ }
                        try { entry.view.destroy(); } catch (_) { /* ignore */ }
                        if (entry.container.parentNode)
                        {
                            entry.container.parentNode.removeChild(entry.container);
                        }
                    }
                    state.mounted.delete(event.uuid);
                }
                // Best-effort: mount replacement neighbour so the trio
                // stays at 3 where possible. jumpToFile handles the
                // rebuild + focus + scroll.
                const targetUuid = state.files[state.focusedIdx];
                if (targetUuid && !state.mounted.has(targetUuid))
                {
                    await jumpToFile(targetUuid);
                }
            }
            else if (event.type === "renamed" || event.type === "moved")
            {
                // Basename / label refresh only — the fileUuid is stable
                // across renames, so `state.files` doesn't shift. The
                // placeholder text (which reads through `basenameFor`) is
                // re-derived on next paint; force-refresh visible
                // placeholders so the label updates immediately.
                for (const [uuid, el] of state.placeholders)
                {
                    try { el.textContent = basenameFor(uuid) || uuid; }
                    catch (_) { /* ignore */ }
                }
            }
            else if (event.type === "created")
            {
                // Caller injects the new fileUuid via `event.uuid`. When
                // present and not already tracked, splice it into the
                // alphabetical position and mint a placeholder. We don't
                // mount unless it falls in-window on the next scroll.
                if (!event.uuid || state.files.includes(event.uuid)) return;
                const name = (basenameFor(event.uuid) || "").toLowerCase();
                let insertAt = state.files.length;
                for (let i = 0; i < state.files.length; i++)
                {
                    const sib = (basenameFor(state.files[i]) || "").toLowerCase();
                    if (name < sib) { insertAt = i; break; }
                }
                state.files.splice(insertAt, 0, event.uuid);
                if (insertAt <= state.focusedIdx) state.focusedIdx++;
                const placeholder = makePlaceholder(event.uuid, null);
                state.placeholders.set(event.uuid, placeholder);
                const siblingUuid = state.files[insertAt + 1];
                let siblingEl = null;
                if (siblingUuid)
                {
                    siblingEl = state.mounted.get(siblingUuid)?.container
                        || state.placeholders.get(siblingUuid) || null;
                }
                stackEl.insertBefore(placeholder, siblingEl);
            }
        }
        catch (e) { console.warn("[aggregate-view] onFsChange failed:", e); }
    }

    async function destroy()
    {
        if (state.disposed) return;
        state.disposed = true;
        if (state.pendingSlide != null)
        {
            try { cancelAnimationFrame(state.pendingSlide); } catch (_) { /* ignore */ }
            state.pendingSlide = null;
        }
        if (state.resizeRafHandle != null)
        {
            try { cancelAnimationFrame(state.resizeRafHandle); } catch (_) { /* ignore */ }
            state.resizeRafHandle = null;
        }
        try { container.removeEventListener("scroll", onScroll); } catch (_) { /* ignore */ }
        if (state.fontChangeListener)
        {
            try { window.removeEventListener("mps:font-change", state.fontChangeListener); }
            catch (_) { /* ignore */ }
            state.fontChangeListener = null;
        }
        if (state.skinChangeListener)
        {
            try { window.removeEventListener("mps:skin-change", state.skinChangeListener); }
            catch (_) { /* ignore */ }
            state.skinChangeListener = null;
        }
        if (state.resizeObserver)
        {
            try { state.resizeObserver.disconnect(); } catch (_) { /* ignore */ }
            state.resizeObserver = null;
        }
        try { await drainAll(); }
        catch (e) { console.warn("[aggregate-view] destroy: drainAll failed:", e); }
        for (const [uuid, entry] of state.mounted)
        {
            snapshotHistoryOnto(state.historySnapshots, uuid, entry.view);
            try { unregisterView(entry.view); } catch (_) { /* ignore */ }
            try { entry.view.destroy(); } catch (_) { /* ignore */ }
        }
        state.mounted.clear();
        state.placeholders.clear();
        try { container.innerHTML = ""; } catch (_) { /* ignore */ }
        if (activeAggregate === handle)
        {
            activeAggregate = null;
        }
    }

    /** @type {AggregateHandle} */
    const handle = {
        destroy,
        jumpToFile,
        currentFocusedFileUuid,
        applyMode,
        collectSourceForExport,
        getActiveBrokers,
        drainAll,
        getSlideStats,
        getScrollTop,
        onFsChange,
        reconcileExternal,
        hasUnsavedBufferForFile,
        isFileMounted,
        historySnapshots: state.historySnapshots,
        folderUuid,
    };

    activeAggregate = handle;
    return handle;
}

// ── boot-flush helper (drain-on-unmount wiring) ──────────────────────────
//
// `flushCurrentProjectMeta` at boot.js drains the singleton broker before
// project close. The aggregate view's per-view brokers are outside that
// singleton, so we expose a drain entry that boot can await unconditionally
// (no-op when no aggregate is mounted).

/** @returns {Promise<void>} */
export async function drainActiveAggregate()
{
    if (!renderGroupsAsOne) return;
    const h = activeAggregate;
    if (!h) return;
    try { await h.drainAll(); }
    catch (e) { console.warn("[aggregate-view] drainActiveAggregate failed:", e); }
}

/**
 * @param {any} val — invoke `read_project_file` for tests. Not used by
 *   production code. Present so the invoke import is not stripped when only
 *   `mountAggregate` is called; forward-compatible with future disk reads.
 * @returns {Promise<any>}
 */
export async function _readProjectFileForTest(val)
{
    return invoke("read_project_file", { path: val });
}
