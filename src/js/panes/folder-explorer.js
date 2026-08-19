// @ts-check
/**
 * folder-explorer.js — hierarchical tree file list for the project's left pane.
 *
 * Replaces the earlier virtualised flat list. Rows render in DOM order
 * (no transform-based virtualisation) since real-world script counts are
 * small and the tree's variable expand state makes virtualisation more
 * trouble than it's worth.
 *
 * Each row is a pill with the filename on the left (ellipsis-on-overflow)
 * and an UPPERCASE badge derived from the file extension on the right.
 * Folders show a disclosure triangle in place of the badge column. Hover
 * shows a two-line tooltip with "Last modified" / "Created" times.
 *
 * `entries` accepts the shape emitted by `app_list_project_tree`:
 *   Array<{ name, kind, path, modifiedAt, createdAt }>
 * — where `name` is the forward-slash relative path (e.g. `chapter-1`,
 * `chapter-1/intro.mangaplay.md`).
 *
 * Public API (preserved across the virtualised → tree refactor):
 *   - update(entries)         — replace the entry list, remount rows
 *   - setFiles(entries)       — legacy alias for update(entries)
 *   - setActive(name)         — highlight the row with this basename / relPath
 *   - beginRename(filename)   — enter inline-rename mode on the row
 *   - getRover()/setRover(i)  — rover index across the visible row sequence
 *   - destroy()               — tear down listeners + DOM
 *
 * Roving tabindex: exactly one visible row has tabIndex=0 (the "rover"),
 * every other row has tabIndex=-1. Arrow keys move the rover when focus
 * is inside the explorer:
 *   - Up / Down  : move between visible rows (regardless of depth)
 *   - Left       : collapse the focused folder, OR move to parent
 *   - Right      : expand the focused folder
 *   - F2         : begin inline rename on the focused row
 *
 * Drag-and-drop: rows are `draggable`. Folder rows and the explorer's
 * empty area accept drops. The actual filesystem move runs through the
 * `opts.onMove(srcAbs, newParentAbs)` callback — Rust enforces refusal
 * cases too, but the JS short-circuit skips a round-trip when the user
 * tries to drop onto themselves or into their own descendant.
 *
 * Inline rename: `beginRename(filename)` swaps the row's name label for
 * a text input. Enter commits, Esc cancels, F2 on the focused row also
 * enters rename. The commit calls the `opts.onRename(path, newBasename)`
 * callback; the suffix (`.mangaplay.md` / `.fountain.md`) is stripped
 * before edit and re-attached on commit.
 */

import { validateBasename } from "../../../../core/validate-basename.js";
import { t, subscribe as subscribeI18n } from "../adapters/tauri-i18n.js";
import { buildTree, flattenForRender, findNodeByUuid, findNodeByRelPath } from "./folder-tree.js";
import { icon } from "./icons.js";
import { hideTooltipImmediate } from "../tooltip/tooltip.js";
import { isTauri } from "../util/index.js";

const KNOWN_SUFFIXES = [".mangaplay.md", ".fountain.md", ".sup.md"];
const KNOWN_SINGLE_SUFFIXES = [".mangaplay", ".fountain", ".sup", ".txt", ".md"];

/**
 * Split a basename into (stem, suffix). Suffix is one of KNOWN_SUFFIXES,
 * one of KNOWN_SINGLE_SUFFIXES, OR the last `.ext` segment when there's a
 * single extension we don't specifically recognise. Returns `{ stem: name,
 * suffix: "" }` only for files with no extension at all.
 *
 * This drives the rename input — the input value is initialised to the
 * stem and the original suffix is re-appended verbatim on commit, so
 * users can't change the extension through rename (intentional — wrong
 * extension would break the slot's format detection).
 *
 * @param {string} name
 * @returns {{ stem: string, suffix: string }}
 */
function splitSuffix(name)
{
    if (!name) return { stem: "", suffix: "" };
    const lower = name.toLowerCase();
    // Double-extension forms first (longer match wins).
    for (const sfx of KNOWN_SUFFIXES)
    {
        if (lower.endsWith(sfx))
        {
            return { stem: name.slice(0, -sfx.length), suffix: name.slice(-sfx.length) };
        }
    }
    // Then registered single extensions.
    for (const sfx of KNOWN_SINGLE_SUFFIXES)
    {
        if (lower.endsWith(sfx))
        {
            return { stem: name.slice(0, -sfx.length), suffix: name.slice(-sfx.length) };
        }
    }
    // Fallback: anything after the last dot. Folders typically have no
    // dot in their basename and pass through unchanged.
    const dot = name.lastIndexOf(".");
    if (dot > 0)
    {
        return { stem: name.slice(0, dot), suffix: name.slice(dot) };
    }
    return { stem: name, suffix: "" };
}

/**
 * Derive a short UPPERCASE badge from a filename.
 * @param {string} name
 * @returns {string}
 */
function badgeFor(name)
{
    const lower = name.toLowerCase();
    if (lower.endsWith(".sup.md")      || lower.endsWith(".sup"))       return "SUPERSCRIPT";
    if (lower.endsWith(".mangaplay.md") || lower.endsWith(".mangaplay")) return "MANGAPLAY";
    if (lower.endsWith(".fountain.md")  || lower.endsWith(".fountain"))  return "FOUNTAIN";
    if (lower.endsWith(".txt"))                                          return "TXT";
    const idx = lower.lastIndexOf(".");
    if (idx > 0) return lower.slice(idx + 1).toUpperCase();
    return "FILE";
}

/**
 * Derive a file-type token for the leading type-icon (mobile explorer).
 * Mirrors badgeFor's extension checks.
 * @param {string} name
 * @returns {"mangaplay"|"fountain"|"superscript"|"text"|"other"}
 */
function fileTypeFor(name)
{
    const lower = name.toLowerCase();
    if (lower.endsWith(".sup.md")       || lower.endsWith(".sup"))       return "superscript";
    if (lower.endsWith(".mangaplay.md") || lower.endsWith(".mangaplay")) return "mangaplay";
    if (lower.endsWith(".fountain.md")  || lower.endsWith(".fountain"))  return "fountain";
    if (lower.endsWith(".txt"))                                          return "text";
    return "other";
}

/**
 * Compute the visible label: strip a known double-suffix when present,
 * otherwise strip everything after the last dot. Folders typically have
 * no dot in their basename and pass through unchanged — the rule is
 * uniform between files and folders.
 * @param {string} name
 * @returns {string}
 */
function displayLabel(name)
{
    const { stem } = splitSuffix(name);
    if (stem !== name) return stem;
    const idx = name.lastIndexOf(".");
    if (idx > 0) return name.slice(0, idx);
    return name;
}

/**
 * Coerce a mixed timestamp value into unix-seconds. Accepts numbers
 * (already seconds), ISO date strings (from `registry_list_tree`), and
 * null/undefined (returns 0). Millisecond-scale numbers (>= 1e12) are
 * downshifted to seconds.
 * @param {unknown} v
 * @returns {number}
 */
function coerceUnixSeconds(v)
{
    if (v == null) return 0;
    if (typeof v === "number" && Number.isFinite(v))
    {
        return v >= 1e12 ? Math.floor(v / 1000) : v;
    }
    if (typeof v === "string")
    {
        const parsed = Date.parse(v);
        if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
        const asNum = Number(v);
        if (Number.isFinite(asNum)) return asNum >= 1e12 ? Math.floor(asNum / 1000) : asNum;
    }
    return 0;
}

/**
 * Format a unix-seconds timestamp as `YYYY-MM-DD HH:MM:SS` in local time.
 * @param {number} secs
 * @returns {string}
 */
function formatTs(secs)
{
    if (!secs) return "—";
    const d = new Date(secs * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
         + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * @typedef {import("./folder-tree.js").TreeEntry} TreeEntry
 * @typedef {import("./folder-tree.js").TreeNode} TreeNode
 */

/**
 * Normalise the `files` input into TreeEntryDto-shaped entries. Accepts:
 *   - TreeEntryDto objects from `registry_list_tree` (uuid + parentUuid +
 *     relPath, basename in `name`).
 *   - Legacy string entries (browser fallback / older callers) — synthesises
 *     `uuid = "legacy:" + name` so the tree still builds, and warns.
 *   - Legacy object entries where `name` is a forward-slash relPath (old
 *     `app_list_project_tree` shape). Coerced to the DTO shape: uuid
 *     synthesised from relPath, parentUuid null (attaches to root, mostly
 *     harmless for legacy call sites).
 *
 * @param {Array<string|TreeEntry>} list
 * @returns {TreeEntry[]}
 */
function normalise(list)
{
    if (!Array.isArray(list)) return [];
    return list.map((f) =>
    {
        if (typeof f === "string")
        {
            console.warn("[folder-explorer] legacy string entry — UUID missing");
            return {
                uuid: `legacy:${f}`,
                parentUuid: null,
                name: f,
                relPath: f,
                kind: "file",
                path: "",
                rev: 0,
                modifiedAt: 0,
                createdAt: 0,
            };
        }
        const kind = f.kind === "folder" ? "folder" : "file";
        // Prefer explicit UUID / parentUuid from the DTO. If missing (legacy
        // caller shape where `name` was the relPath), synthesise a stable
        // uuid from the relPath so tree still builds.
        const relPath = typeof f.relPath === "string" && f.relPath !== ""
            ? f.relPath
            : String(f.name || "");
        const basename = typeof f.name === "string" && !f.name.includes("/") && f.name !== ""
            ? f.name
            : (relPath.includes("/") ? relPath.slice(relPath.lastIndexOf("/") + 1) : relPath);
        const uuid = typeof f.uuid === "string" && f.uuid !== ""
            ? f.uuid
            : `legacy:${relPath}`;
        const parentUuid = f.parentUuid === undefined ? null : f.parentUuid;
        return {
            uuid,
            parentUuid,
            name: basename,
            relPath,
            kind,
            path: typeof f.path === "string" ? f.path : "",
            rev: typeof f.rev === "number" ? f.rev : 0,
            modifiedAt: f.modifiedAt ?? 0,
            createdAt: f.createdAt ?? 0,
        };
    });
}

/**
 * Mount a hierarchical file tree into the given scroll container.
 *
 * Identity contract:
 *   - `uuid` is the authoritative identity key for every internal map
 *     (rowEls, expanded, currentDrag, renaming).
 *   - `relPath` is preserved on the row DOM (`data-rel-path`) and passed
 *     through callbacks as a display hint. Do NOT use relPath for
 *     identity comparisons — callers should key on uuid.
 *   - `activeFile` accepts BOTH uuid and relPath; uuid is authoritative.
 *
 * @param {HTMLElement} container
 * @param {Array<string|TreeEntry>} files
 * @param {{
 *   activeFile?: string|null,
 *   initialExpanded?: string[],
 *   projectRoot?: string,
 *   typeIcons?: boolean,
 *   onRename?: (path: string, newBasename: string) => Promise<string|void>,
 *   onRenameByUuid?: (uuid: string, newBasename: string, relPath: string) => Promise<string|void>,
 *   onToggleExpand?: (relPath: string, expanded: boolean) => void,
 *   onToggleExpandByUuid?: (uuid: string, expanded: boolean, relPath: string) => void,
 *   onMove?: (srcAbs: string, newParentAbs: string) => Promise<void>|void,
 *   onMoveByUuid?: (srcUuid: string, newParentUuid: string|null, srcRelPath: string, newParentRelPath: string) => Promise<void>|void,
 * }} [opts]
 *
 * NOTE: UUID-first callbacks (`onRenameByUuid`, `onToggleExpandByUuid`,
 * `onMoveByUuid`) are provided alongside the OLD path-first callbacks.
 * When both are present the UUID variant wins. When only the OLD callback
 * is provided the internal dispatch reconstructs the legacy shape
 * (absPath / relPath / newParentAbs). The OLD path-first callbacks will be
 * removed once the caller-side migration lands.
 */
export function mountFolderList(container, files, opts = {})
{
    let entries = normalise(files);
    let tree = buildTree(entries);
    // Internal `expanded` Set is keyed by uuid. `initialExpanded` is a
    // relPath[] emitted by pre-4b callers (meta.expandedFolders in
    // project.meta) — resolve each to its uuid via the freshly-built tree.
    /** @type {Set<string>} */
    const expanded = new Set();
    const initialExpandedRelPaths = Array.isArray(opts.initialExpanded) ? opts.initialExpanded : [];
    if (initialExpandedRelPaths.length > 0)
    {
        for (const rel of initialExpandedRelPaths)
        {
            if (typeof rel !== "string" || rel === "") continue;
            const node = findNodeByRelPath(tree, rel);
            if (node && node.uuid && node.kind === "folder") expanded.add(node.uuid);
        }
    }
    /** @type {TreeNode[]} */
    let visibleRows = flattenForRender(tree, expanded);

    const onRename = typeof opts.onRename === "function" ? opts.onRename : null;
    const onRenameByUuid = typeof opts.onRenameByUuid === "function" ? opts.onRenameByUuid : null;
    const onToggleExpand = typeof opts.onToggleExpand === "function" ? opts.onToggleExpand : null;
    const onToggleExpandByUuid = typeof opts.onToggleExpandByUuid === "function" ? opts.onToggleExpandByUuid : null;
    const onMove = typeof opts.onMove === "function" ? opts.onMove : null;
    const onMoveByUuid = typeof opts.onMoveByUuid === "function" ? opts.onMoveByUuid : null;
    const projectRoot = typeof opts.projectRoot === "string" ? opts.projectRoot : "";
    const typeIcons = opts.typeIcons === true;
    const tooltips = opts.tooltips !== false;
    const dnd = opts.dnd !== false;

    let activeFile = opts.activeFile ?? null;

    /** uuid of the row currently in inline-rename mode, or null. */
    let renamingUuid = /** @type {string|null} */ (null);
    /** debounced blur-commit timer so refresh-driven blurs don't re-enter. */
    let blurCommitTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);

    /** Currently-dragged uuid, set on dragstart, cleared on dragend. */
    let currentDragUuid = /** @type {string|null} */ (null);

    /** Roving tabindex — index into `visibleRows`. */
    let roverIndex = 0;

    /** @type {Map<string, HTMLDivElement>} uuid → row */
    const rowEls = new Map();

    function buildTooltip(node)
    {
        const entry = node.entry || /** @type {TreeEntry} */ ({ modifiedAt: 0, createdAt: 0 });
        // registry_list_tree emits `modifiedAt` as an ISO-string OR null.
        // Legacy path callers emit unix-seconds numbers. Coerce to seconds.
        const modSecs = coerceUnixSeconds(entry.modifiedAt);
        const createdSecs = coerceUnixSeconds(entry.createdAt);
        return t("mangaplay-studio.fileRow.lastModifiedAt", { time: formatTs(modSecs) })
             + "\n"
             + t("mangaplay-studio.fileRow.createdAt", { time: formatTs(createdSecs) });
    }

    /**
     * Absolute path for a node — prefers the entry's own `path`, falls back
     * to `<projectRoot>/<relPath>` when only a synthesised entry exists.
     * @param {TreeNode} node
     */
    function absPathFor(node)
    {
        if (node.entry && node.entry.path) return node.entry.path;
        if (projectRoot) return `${projectRoot}/${node.relPath}`;
        return "";
    }

    /**
     * Build a single row element for a visible TreeNode.
     * @param {TreeNode} node
     * @param {number} idx index into `visibleRows`
     * @returns {HTMLDivElement}
     */
    function buildRow(node, idx)
    {
        const row = document.createElement("div");
        row.className = "folder-list-row";
        row.dataset.index = String(idx);
        // UUID is authoritative. relPath + path stay for now — will be
        // removed once the broker + slot manager go UUID-only.
        row.dataset.uuid = node.uuid;
        row.dataset.relPath = node.relPath;
        row.dataset.kind = node.kind;
        row.dataset.depth = String(node.depth);
        // data-filename / data-path preserved for the global contextmenu
        // dispatcher and the rename plumbing in app.js.
        row.dataset.filename = node.kind === "file" ? node.name : node.relPath;
        row.dataset.path = absPathFor(node);
        if (tooltips)
        {
            row.dataset.tooltip = buildTooltip(node);
            row.dataset.tooltipSide = "right";
        }
        if (dnd) row.draggable = true;
        row.style.paddingLeft = (10 + node.depth * 16) + "px";
        row.style.setProperty("--mps-row-depth", String(node.depth));

        if (node.kind === "folder")
        {
            const disclosure = document.createElement("span");
            disclosure.className = "folder-list-disclosure";
            disclosure.innerHTML = icon("chevron-right", { size: 16 });
            disclosure.setAttribute("aria-hidden", "true");
            if (expanded.has(node.uuid))
            {
                row.setAttribute("data-expanded", "");
            }
            row.append(disclosure);
        }
        // Files no longer get a 16px disclosure-spacer — the entry name sits
        // flush with the row's left padding so the explorer reads as a
        // left-aligned list. Folders still get the chevron (it carries
        // expand/collapse interaction); the visual offset between folder
        // names and file names is acceptable since folders are uncommon at
        // depth 0 in this project layout.

        if (typeIcons && node.kind === "file")
        {
            const typeIconEl = document.createElement("span");
            typeIconEl.className = "folder-list-type-icon";
            typeIconEl.dataset.filetype = fileTypeFor(node.name);
            typeIconEl.setAttribute("aria-hidden", "true");
            row.append(typeIconEl);
        }

        const nameEl = document.createElement("span");
        nameEl.className = "folder-list-name";
        nameEl.textContent = displayLabel(node.name);
        row.append(nameEl);

        if (node.kind === "file")
        {
            const badgeEl = document.createElement("span");
            badgeEl.className = "folder-list-badge";
            badgeEl.textContent = badgeFor(node.name);
            row.append(badgeEl);
        }

        // Prefer uuid match, then relPath match, then basename fallback.
        // uuid is unambiguous; relPath is unique within a project;
        // basename can collide across subfolders (legacy).
        if (activeFile)
        {
            const anyUuidMatch = visibleRows.some((r) => r.uuid === activeFile);
            const anyRelMatch = !anyUuidMatch && visibleRows.some((r) => r.relPath === activeFile);
            let isMatch = false;
            if (anyUuidMatch) isMatch = node.uuid === activeFile;
            else if (anyRelMatch) isMatch = node.relPath === activeFile;
            else isMatch = node.name === activeFile;
            if (isMatch) row.setAttribute("aria-current", "true");
        }
        row.tabIndex = idx === roverIndex ? 0 : -1;
        return row;
    }

    function render()
    {
        // Full re-render — rows are cheap, tree mutations are rare. Avoids
        // the bookkeeping the virtualised list needed.
        for (const el of rowEls.values()) el.remove();
        rowEls.clear();

        // Clamp rover into the new visible range.
        if (visibleRows.length === 0) roverIndex = 0;
        else if (roverIndex >= visibleRows.length) roverIndex = visibleRows.length - 1;

        for (let i = 0; i < visibleRows.length; i++)
        {
            const row = buildRow(visibleRows[i], i);
            container.append(row);
            rowEls.set(visibleRows[i].uuid, row);
        }
    }

    function rebuildVisible()
    {
        tree = buildTree(entries);
        visibleRows = flattenForRender(tree, expanded);
    }

    /**
     * Move the rover to `nextIdx`, refresh tabindex on affected rows,
     * scroll the new row into view, and focus it.
     * @param {number} nextIdx
     */
    function moveRoverTo(nextIdx)
    {
        if (visibleRows.length === 0) return;
        const n = visibleRows.length;
        const wrapped = ((nextIdx % n) + n) % n;
        if (wrapped === roverIndex) return;

        const prev = roverIndex;
        roverIndex = wrapped;

        const prevRow = rowEls.get(visibleRows[prev]?.uuid);
        if (prevRow) prevRow.tabIndex = -1;

        const newRow = rowEls.get(visibleRows[wrapped]?.uuid);
        if (newRow)
        {
            newRow.tabIndex = 0;
            try { newRow.scrollIntoView({ block: "nearest" }); } catch { /* ignore */ }
            try { newRow.focus(); } catch { /* ignore */ }
        }
    }

    /**
     * Absolute path for a relPath using the same convention as `absPathFor`:
     * `<projectRoot>/<relPath>`. Returns "" when projectRoot is unknown
     * (jsdom / test).
     * @param {string} relPath
     */
    function absPathForRel(relPath)
    {
        if (!projectRoot) return "";
        return `${projectRoot}/${relPath}`;
    }

    /**
     * Tell the Rust FS watcher to start/stop monitoring a subdirectory.
     * No-op outside Tauri. The commands tolerate Ok(()) when the watcher
     * isn't running, so it's safe to call unconditionally.
     * @param {string} relPath
     * @param {boolean} expand
     */
    function notifyWatcherForFolder(relPath, expand)
    {
        const abs = absPathForRel(relPath);
        if (!abs) return;
        if (!isTauri()) return;
        const cmd = expand ? "fs_watch_add_subdir" : "fs_watch_remove_subdir";
        import("@tauri-apps/api/core").then(({ invoke }) =>
        {
            invoke(cmd, { path: abs }).catch((e) =>
            {
                console.warn(`[${cmd}] failed:`, e);
            });
        });
    }

    /**
     * Look up a visible-row TreeNode by uuid (fast path via rowEls' key set
     * is not sufficient because we need the node data itself).
     * @param {string} uuid
     */
    function visibleNodeByUuid(uuid)
    {
        return visibleRows.find((r) => r.uuid === uuid) || null;
    }

    /**
     * Toggle the expand state of a folder. Updates the visible row list,
     * re-renders, and fires the `onToggleExpand` callback so the host can
     * persist the new state into meta.json.
     * @param {string} uuid
     * @param {string} [relPathHint]
     */
    function toggleExpand(uuid, relPathHint)
    {
        const relPath = relPathHint != null ? relPathHint : (visibleNodeByUuid(uuid)?.relPath ?? "");
        const willExpand = !expanded.has(uuid);
        if (willExpand) expanded.add(uuid);
        else expanded.delete(uuid);
        rebuildVisible();
        render();
        notifyWatcherForFolder(relPath, willExpand);
        emitToggleExpand(uuid, willExpand, relPath);
    }

    /**
     * Expand a folder explicitly (no-op when already expanded).
     * @param {string} uuid
     * @param {string} [relPathHint]
     */
    function expandFolder(uuid, relPathHint)
    {
        if (expanded.has(uuid)) return;
        const relPath = relPathHint != null ? relPathHint : (visibleNodeByUuid(uuid)?.relPath ?? "");
        expanded.add(uuid);
        rebuildVisible();
        render();
        notifyWatcherForFolder(relPath, true);
        emitToggleExpand(uuid, true, relPath);
    }

    /**
     * Collapse a folder explicitly (no-op when already collapsed).
     * @param {string} uuid
     * @param {string} [relPathHint]
     */
    function collapseFolder(uuid, relPathHint)
    {
        if (!expanded.has(uuid)) return;
        const relPath = relPathHint != null ? relPathHint : (visibleNodeByUuid(uuid)?.relPath ?? "");
        expanded.delete(uuid);
        rebuildVisible();
        render();
        notifyWatcherForFolder(relPath, false);
        emitToggleExpand(uuid, false, relPath);
    }

    /**
     * Dispatch the toggle-expand callback. Prefers `onToggleExpandByUuid`
     * (new signature). Falls back to `onToggleExpand(relPath, expanded)`
     * — the pre-4b path signature that app.js still uses to persist
     * `meta.expandedFolders` as a Set<relPath>.
     * @param {string} uuid
     * @param {boolean} isExpanded
     * @param {string} relPath
     */
    function emitToggleExpand(uuid, isExpanded, relPath)
    {
        if (onToggleExpandByUuid)
        {
            try { onToggleExpandByUuid(uuid, isExpanded, relPath); }
            catch (e) { console.warn("onToggleExpandByUuid failed:", e); }
            return;
        }
        if (onToggleExpand)
        {
            try { onToggleExpand(relPath, isExpanded); }
            catch (e) { console.warn("onToggleExpand failed:", e); }
        }
    }

    /** @param {KeyboardEvent} e */
    function onKeyDown(e)
    {
        const active = document.activeElement;
        if (!active || !container.contains(active)) return;
        if (renamingUuid) return;
        if (e.key === "ArrowDown")
        {
            e.preventDefault();
            moveRoverTo(roverIndex + 1);
        }
        else if (e.key === "ArrowUp")
        {
            e.preventDefault();
            moveRoverTo(roverIndex - 1);
        }
        else if (e.key === "ArrowRight")
        {
            const node = visibleRows[roverIndex];
            if (node && node.kind === "folder")
            {
                e.preventDefault();
                if (!expanded.has(node.uuid))
                {
                    expandFolder(node.uuid, node.relPath);
                    moveRoverTo(roverIndex); // refocus current row
                }
                else
                {
                    // Already expanded — step into the first child if any.
                    moveRoverTo(roverIndex + 1);
                }
            }
        }
        else if (e.key === "ArrowLeft")
        {
            const node = visibleRows[roverIndex];
            if (!node) return;
            e.preventDefault();
            if (node.kind === "folder" && expanded.has(node.uuid))
            {
                collapseFolder(node.uuid, node.relPath);
                moveRoverTo(roverIndex);
                return;
            }
            // Otherwise jump to the parent folder when there is one.
            // Prefer parentUuid; fall back to relPath prefix.
            let parentIdx = -1;
            if (node.parentUuid && node.parentUuid !== "")
            {
                parentIdx = visibleRows.findIndex((r) => r.uuid === node.parentUuid);
            }
            if (parentIdx < 0)
            {
                const parentRelPath = node.relPath.includes("/")
                    ? node.relPath.slice(0, node.relPath.lastIndexOf("/"))
                    : "";
                if (!parentRelPath) return;
                parentIdx = visibleRows.findIndex((r) => r.relPath === parentRelPath);
            }
            if (parentIdx >= 0) moveRoverTo(parentIdx);
        }
        else if (e.key === "F2")
        {
            e.preventDefault();
            const node = visibleRows[roverIndex];
            if (node)
            {
                // Pass uuid — unambiguous. beginRename cascades uuid → relPath
                // → basename for legacy callers.
                beginRename(node.uuid);
            }
        }
    }

    /**
     * Click handler: disclosure triangle toggles expand; click on a folder
     * row body selects but doesn't expand; click on a file row body is left
     * to the upstream listener (app.js handles file opens via the existing
     * `.folder-list-row` delegated click on the container).
     * @param {MouseEvent} e
     */
    function onClick(e)
    {
        const target = /** @type {HTMLElement} */ (e.target);
        if (!target) return;
        const row = /** @type {HTMLDivElement|null} */ (target.closest(".folder-list-row"));
        if (!row || !container.contains(row)) return;
        const uuid = row.dataset.uuid;
        if (!uuid) return;
        const node = visibleRows.find((r) => r.uuid === uuid);
        if (!node) return;

        // Disclosure click on a folder toggles expand. Stop propagation so
        // the host's row-click handler (which opens files) doesn't fire.
        if (target.classList.contains("folder-list-disclosure")
            && node.kind === "folder")
        {
            e.stopPropagation();
            toggleExpand(node.uuid, node.relPath);
            return;
        }
        // Click on a folder body (not the disclosure): also toggle expand
        // — the user expects a folder click to reveal its contents.
        if (node.kind === "folder")
        {
            e.stopPropagation();
            toggleExpand(node.uuid, node.relPath);
        }
    }

    // ── Drag-and-drop ────────────────────────────────────────────────────

    /**
     * Test: is `dst` `src` itself or a descendant of `src`? Compares against
     * the rel-path string. Both arguments are forward-slash rel-paths.
     * @param {string} src
     * @param {string} dst
     */
    function isSelfOrDescendant(src, dst)
    {
        if (src === dst) return true;
        return dst.startsWith(src + "/");
    }

    /** Clear any currently-highlighted drop target. */
    function clearDropTarget()
    {
        for (const el of container.querySelectorAll("[data-drop-target]"))
        {
            el.removeAttribute("data-drop-target");
        }
        container.removeAttribute("data-drop-target");
    }

    /** @param {DragEvent} e */
    function onDragStart(e)
    {
        const target = /** @type {HTMLElement} */ (e.target);
        const row = /** @type {HTMLDivElement|null} */ (target.closest(".folder-list-row"));
        if (!row || !container.contains(row)) return;
        const uuid = row.dataset.uuid || "";
        const relPath = row.dataset.relPath || "";
        currentDragUuid = uuid;
        try
        {
            // WebView2 / Chromium on Windows refuses to start a native drag
            // when only an unrecognised custom MIME type is on the
            // DataTransfer. Set text/plain too — that's the well-known type
            // every drag-aware target understands. Read identity from the
            // custom types at drop time; prefer uuid over rel-path.
            e.dataTransfer?.setData("text/plain", relPath);
            e.dataTransfer?.setData("application/x-mps-rel-path", relPath);
            e.dataTransfer?.setData("application/x-mps-uuid", uuid);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        }
        catch { /* ignore */ }
    }

    /** @param {DragEvent} e */
    function onDragEnd()
    {
        currentDragUuid = null;
        clearDropTarget();
    }

    /**
     * Look up the relPath for the currently-dragged uuid using the visible
     * node list first, then the flat entries list (covers the case where
     * the source folder was collapsed after drag began — shouldn't happen
     * mid-drag, but defensive).
     */
    function dragSrcRelPath()
    {
        if (!currentDragUuid) return "";
        const visible = visibleRows.find((r) => r.uuid === currentDragUuid);
        if (visible) return visible.relPath;
        const flat = entries.find((en) => en.uuid === currentDragUuid);
        return flat && typeof flat.relPath === "string" ? flat.relPath : "";
    }

    /** @param {DragEvent} e */
    function onDragOver(e)
    {
        const types = e.dataTransfer?.types;
        const hasUuidType = types ? types.includes("application/x-mps-uuid") : false;
        const hasRelType = types ? types.includes("application/x-mps-rel-path") : false;
        if (!currentDragUuid && !hasUuidType && !hasRelType)
        {
            return;
        }
        const target = /** @type {HTMLElement} */ (e.target);
        const row = /** @type {HTMLDivElement|null} */ (target.closest(".folder-list-row"));
        // Allow drop onto a folder row OR the container's empty area (root).
        if (row && row.dataset.kind === "folder")
        {
            const dstRel = row.dataset.relPath || "";
            const srcRel = dragSrcRelPath();
            if (srcRel && isSelfOrDescendant(srcRel, dstRel))
            {
                return; // refuse silently
            }
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            // Reset other highlights then mark this row.
            clearDropTarget();
            row.setAttribute("data-drop-target", "");
        }
        else if (!row)
        {
            // Drop on container empty area — represents project root.
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            clearDropTarget();
            container.setAttribute("data-drop-target", "");
        }
    }

    /** @param {DragEvent} e */
    function onDragLeave(e)
    {
        const target = /** @type {HTMLElement} */ (e.target);
        const row = /** @type {HTMLDivElement|null} */ (target.closest(".folder-list-row"));
        if (row) row.removeAttribute("data-drop-target");
        // Only clear the container highlight when the pointer truly leaves
        // the container (relatedTarget falls outside).
        const related = /** @type {Node|null} */ (e.relatedTarget);
        if (!related || !container.contains(related))
        {
            container.removeAttribute("data-drop-target");
        }
    }

    /** @param {DragEvent} e */
    async function onDrop(e)
    {
        // Prefer UUID from the DataTransfer, then the drag-state fallback,
        // then the legacy rel-path wire.
        const srcUuid = e.dataTransfer?.getData("application/x-mps-uuid")
            || currentDragUuid
            || "";
        const legacySrcRel = e.dataTransfer?.getData("application/x-mps-rel-path") || "";
        // Resolve the source entry via uuid (authoritative) or rel-path (legacy).
        let srcEntry = null;
        if (srcUuid)
        {
            srcEntry = entries.find((en) => en.uuid === srcUuid) || null;
        }
        if (!srcEntry && legacySrcRel)
        {
            srcEntry = entries.find((en) => en.relPath === legacySrcRel) || null;
        }
        if (!srcEntry)
        {
            clearDropTarget();
            return;
        }
        const srcRel = srcEntry.relPath || "";
        const resolvedSrcUuid = srcEntry.uuid || srcUuid;

        const target = /** @type {HTMLElement} */ (e.target);
        const row = /** @type {HTMLDivElement|null} */ (target.closest(".folder-list-row"));

        let dstRel = "";
        let newParentUuid = /** @type {string|null} */ (null);
        if (row && row.dataset.kind === "folder")
        {
            dstRel = row.dataset.relPath || "";
            newParentUuid = row.dataset.uuid || null;
        }
        else if (!row)
        {
            // Container empty area → project root. null uuid signals "root".
            dstRel = "";
            newParentUuid = null;
        }
        else
        {
            clearDropTarget();
            return;
        }

        if (isSelfOrDescendant(srcRel, dstRel))
        {
            clearDropTarget();
            return;
        }
        // Refuse no-op moves: src already lives in dstRel.
        const srcParent = srcRel.includes("/")
            ? srcRel.slice(0, srcRel.lastIndexOf("/"))
            : "";
        if (srcParent === dstRel)
        {
            clearDropTarget();
            return;
        }

        e.preventDefault();
        clearDropTarget();

        if (onMoveByUuid)
        {
            try { await onMoveByUuid(resolvedSrcUuid, newParentUuid, srcRel, dstRel); }
            catch (err) { console.warn("onMoveByUuid failed:", err); }
            return;
        }
        if (onMove)
        {
            // Legacy path-first signature — reconstruct absolute paths
            // EXACTLY as pre-4b onDrop did: srcAbs from srcEntry.path or
            // `<projectRoot>/<relPath>`; newParentAbs from row.dataset.path
            // for folder drops, or `<projectRoot>/project` for the
            // empty-area root drop. Guard against empty strings — the
            // pre-4b guard short-circuited when either was missing.
            const srcAbs = (srcEntry && srcEntry.path)
                ? srcEntry.path
                : (projectRoot ? `${projectRoot}/${srcRel}` : "");
            let newParentAbs = "";
            if (row && row.dataset.kind === "folder")
            {
                newParentAbs = row.dataset.path || "";
            }
            else
            {
                newParentAbs = projectRoot ? `${projectRoot}/project` : "";
            }
            if (!srcAbs || !newParentAbs) return;
            try { await onMove(srcAbs, newParentAbs); }
            catch (err) { console.warn("onMove failed:", err); }
        }
    }

    /**
     * Replace the row's name label with a text input so the user can type a
     * new basename. Suffix (`.mangaplay.md` etc.) is stripped before edit
     * and re-appended on commit.
     *
     * Cascade: try uuid match first, then relPath, then basename (with warn).
     * @param {string} key  uuid, rel-path, or basename
     */
    function beginRename(key)
    {
        if (!onRename && !onRenameByUuid) return;
        if (renamingUuid) return;
        // uuid → relPath → basename cascade.
        let node = visibleRows.find((r) => r.uuid === key);
        if (!node) node = visibleRows.find((r) => r.relPath === key);
        if (!node)
        {
            node = visibleRows.find((r) => r.name === key);
            if (node)
            {
                console.warn("[folder-explorer] beginRename() matched by basename fallback — caller should pass uuid. key=", key);
            }
        }
        if (!node) return;
        const row = rowEls.get(node.uuid);
        if (!row) return;

        renamingUuid = node.uuid;
        row.classList.add("is-renaming");

        // Tooltip suppression: the row carries a `data-tooltip` with file
        // metadata that re-shows on hover the moment the row receives the
        // pointer. While renaming, the input owns the row and the tooltip
        // would float over the input. Stash the value into a sibling
        // attribute, kill any currently-visible bubble, and let `finish()`
        // restore it on rename teardown (commit, cancel, or error).
        if (row.dataset.tooltip)
        {
            row.dataset.tooltipStashed = row.dataset.tooltip;
            delete row.dataset.tooltip;
        }
        try { hideTooltipImmediate(row); } catch { /* ignore */ }

        const { stem, suffix } = splitSuffix(node.name);
        const originalName = node.name;
        const path = absPathFor(node);

        const nameEl = row.querySelector(".folder-list-name");
        if (nameEl) nameEl.remove();

        const input = document.createElement("input");
        input.type = "text";
        input.maxLength = 200;
        input.className = "folder-list-rename-input";
        input.value = stem;
        input.setAttribute("data-allow-native-menu", "true");

        const hint = document.createElement("span");
        hint.className = "folder-list-rename-hint";
        hint.textContent = "";
        hint.style.display = "none";

        const badge = row.querySelector(".folder-list-badge");
        if (badge)
        {
            row.insertBefore(input, badge);
            row.insertBefore(hint, badge);
        }
        else
        {
            row.append(input, hint);
        }

        requestAnimationFrame(() =>
        {
            try { input.focus(); input.select(); } catch { /* ignore */ }
        });

        let committed = false;

        const setError = (msg) =>
        {
            row.classList.add("is-error");
            hint.textContent = msg;
            hint.style.display = "";
        };
        const clearError = () =>
        {
            row.classList.remove("is-error");
            hint.style.display = "none";
            hint.textContent = "";
        };

        const finish = () =>
        {
            committed = true;
            if (blurCommitTimer)
            {
                clearTimeout(blurCommitTimer);
                blurCommitTimer = null;
            }
            renamingUuid = null;
            // Restore the stashed tooltip if the row is still in the DOM.
            // After a successful commit `render()` recreates rows so this is
            // a no-op there; on cancel / target-clash the same row stays.
            if (row.isConnected && row.dataset.tooltipStashed)
            {
                row.dataset.tooltip = row.dataset.tooltipStashed;
                delete row.dataset.tooltipStashed;
            }
        };

        const cancel = () =>
        {
            if (committed) return;
            finish();
            render();
        };

        const commit = async () =>
        {
            if (committed) return;
            let raw = (input.value || "").trim();
            // Extension changes aren't allowed through rename — the slot's
            // format detector keys off the suffix, and renaming
            // `script.fountain` to `script.txt` would silently break
            // parsing. If the user typed the original suffix back into the
            // stem (e.g. they re-typed the whole filename), strip it so the
            // re-append below doesn't produce `name.fountain.fountain`.
            if (suffix && raw.toLowerCase().endsWith(suffix.toLowerCase()))
            {
                raw = raw.slice(0, -suffix.length);
            }
            const newName = raw + suffix;
            if (newName === originalName)
            {
                cancel();
                return;
            }
            const v = validateBasename(newName);
            if (!v.ok)
            {
                setError(`Invalid: ${v.reason}`);
                try { input.focus(); } catch { /* ignore */ }
                return;
            }
            clearError();
            committed = true;
            if (blurCommitTimer)
            {
                clearTimeout(blurCommitTimer);
                blurCommitTimer = null;
            }
            renamingUuid = null;
            try
            {
                // Prefer the new UUID-first callback. Fall back to the
                // pre-4b path-first shape `(absPath, newBasename)` — that's
                // what app.js `handleRename` still expects until 4d
                // migrates it. `path` is `absPathFor(node)` captured above.
                if (onRenameByUuid)
                {
                    await onRenameByUuid(node.uuid, newName, node.relPath);
                }
                else if (onRename)
                {
                    await onRename(path, newName);
                }
            }
            catch (err)
            {
                const code = String((err && err.message) || err || "unknown");
                committed = false;
                renamingUuid = node.uuid;
                if (code.includes("target-exists"))
                {
                    setError(" (taken)");
                }
                else if (code.includes("access-denied"))
                {
                    setError("File is read-only");
                }
                else
                {
                    setError(`Rename failed: ${code}`);
                }
                try { input.focus(); } catch { /* ignore */ }
            }
        };

        input.addEventListener("keydown", (ev) =>
        {
            if (ev.key === "Enter")
            {
                ev.preventDefault();
                ev.stopPropagation();
                commit();
            }
            else if (ev.key === "Escape")
            {
                ev.preventDefault();
                ev.stopPropagation();
                cancel();
            }
        });

        input.addEventListener("blur", () =>
        {
            if (committed) return;
            if (blurCommitTimer) clearTimeout(blurCommitTimer);
            blurCommitTimer = setTimeout(() =>
            {
                blurCommitTimer = null;
                if (!committed) commit();
            }, 100);
        });
    }

    // ── Event wiring ─────────────────────────────────────────────────────

    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("click", onClick);
    if (dnd)
    {
        container.addEventListener("dragstart", onDragStart);
        container.addEventListener("dragend", onDragEnd);
        container.addEventListener("dragover", onDragOver);
        container.addEventListener("dragleave", onDragLeave);
        container.addEventListener("drop", onDrop);
    }

    const ro = new ResizeObserver(() => { /* no-op — flow layout self-sizes */ });
    ro.observe(container);

    /**
     * Scroll a row into view and apply the 1s flash highlight.
     * @param {HTMLElement} row
     */
    function flashRow(row)
    {
        try { row.scrollIntoView({ block: "nearest", behavior: "instant" }); }
        catch { try { row.scrollIntoView(); } catch {} }
        row.classList.remove("is-flashing");
        // Force reflow so the keyframe restarts when called twice in
        // quick succession.
        void row.offsetWidth;
        row.classList.add("is-flashing");
        setTimeout(() => row && row.classList.remove("is-flashing"), 2100);
    }

    const unsubI18n = subscribeI18n(() =>
    {
        for (const [uuid, el] of rowEls)
        {
            const node = visibleRows.find((r) => r.uuid === uuid);
            if (node) el.dataset.tooltip = buildTooltip(node);
        }
    });

    render();

    return {
        /**
         * Replace the entry list and rebuild the tree. Preserves expand
         * state across the swap so folders the user expanded stay open.
         * @param {Array<string|TreeEntry>} next
         */
        update(next)
        {
            entries = normalise(next);
            rebuildVisible();
            render();
        },
        /** Legacy alias for `update(entries)`. */
        setFiles(next)
        {
            this.update(next);
        },
        /**
         * Highlight the row matching `key`. Cascade:
         *   uuid → relPath → basename (last with warn).
         * Accepts either during the 4b/4c/4d transition.
         * @param {string|null} key
         */
        setActive(key)
        {
            activeFile = key;
            let hasUuidMatch = false;
            let hasRelMatch = false;
            if (key)
            {
                for (const uuid of rowEls.keys())
                {
                    if (uuid === key) { hasUuidMatch = true; break; }
                }
                if (!hasUuidMatch)
                {
                    for (const el of rowEls.values())
                    {
                        if (el.dataset.relPath === key) { hasRelMatch = true; break; }
                    }
                }
            }
            let sawBasenameFallback = false;
            for (const [uuid, el] of rowEls)
            {
                let isMatch = false;
                if (key)
                {
                    if (hasUuidMatch) isMatch = (uuid === key);
                    else if (hasRelMatch) isMatch = (el.dataset.relPath === key);
                    else if (el.dataset.filename === key)
                    {
                        isMatch = true;
                        sawBasenameFallback = true;
                    }
                }
                el.setAttribute("aria-current", isMatch ? "true" : "false");
            }
            if (sawBasenameFallback)
            {
                console.warn("[folder-explorer] setActive() matched by basename fallback — caller should pass uuid. key=", key);
            }
        },
        /**
         * Highlight the row by uuid. No relPath/basename fallback.
         * @param {string} uuid
         */
        setActiveByUuid(uuid)
        {
            activeFile = uuid;
            for (const [rowUuid, el] of rowEls)
            {
                el.setAttribute("aria-current", rowUuid === uuid ? "true" : "false");
            }
        },
        /**
         * Scroll the active row into view and apply a 1s flash highlight so
         * the user can locate it. No-op if there's no active row.
         * Cascade: uuid → relPath → basename.
         */
        revealActive()
        {
            if (!activeFile) return;
            /** @type {HTMLElement|null} */
            let row = null;
            // uuid first (map key).
            row = rowEls.get(activeFile) || null;
            if (!row)
            {
                for (const el of rowEls.values())
                {
                    if (el.dataset.relPath === activeFile) { row = el; break; }
                }
            }
            if (!row)
            {
                for (const el of rowEls.values())
                {
                    if (el.dataset.filename === activeFile) { row = el; break; }
                }
            }
            if (!row) return;
            flashRow(row);
        },
        /**
         * Scroll and flash the row matching `uuid`. No fallback.
         * @param {string} uuid
         */
        revealActiveByUuid(uuid)
        {
            const row = rowEls.get(uuid);
            if (!row) return;
            flashRow(row);
        },
        getRover()
        {
            return roverIndex;
        },
        setRover(idx)
        {
            if (typeof idx !== "number" || !Number.isFinite(idx)) return;
            moveRoverTo(idx);
        },
        /**
         * Enter inline-rename mode on the row matching `key`.
         * Cascade: uuid → relPath → basename.
         * No-op if the row isn't visible or `onRename` wasn't provided.
         * @param {string} key
         */
        beginRename(key)
        {
            beginRename(key);
        },
        /**
         * Enter inline-rename mode on the row matching `uuid`.
         * @param {string} uuid
         */
        beginRenameByUuid(uuid)
        {
            beginRename(uuid);
        },
        destroy()
        {
            container.removeEventListener("keydown", onKeyDown);
            container.removeEventListener("click", onClick);
            container.removeEventListener("dragstart", onDragStart);
            container.removeEventListener("dragend", onDragEnd);
            container.removeEventListener("dragover", onDragOver);
            container.removeEventListener("dragleave", onDragLeave);
            container.removeEventListener("drop", onDrop);
            ro.disconnect();
            unsubI18n?.();
            if (blurCommitTimer) { clearTimeout(blurCommitTimer); blurCommitTimer = null; }
            for (const el of rowEls.values()) el.remove();
            rowEls.clear();
        }
    };
}
