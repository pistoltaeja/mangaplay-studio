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

import { validateBasename } from "../../core/validate-basename.js";
import { t, subscribe as subscribeI18n } from "./adapters/tauri-i18n.js";
import { buildTree, flattenForRender } from "./folder-tree.js";
import { icon } from "./icons.js";
import { hideTooltipImmediate } from "./tooltip.js";
import { isTauri } from "./util/is-tauri.js";

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
 * Normalise the `files` input. Strings (legacy / browser fallback) become
 * file entries with empty path and zero timestamps.
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
            return { name: f, kind: "file", path: "", modifiedAt: 0, createdAt: 0 };
        }
        const kind = f.kind === "folder" ? "folder" : "file";
        return {
            name: String(f.name || ""),
            kind,
            path: String(f.path || ""),
            modifiedAt: Number(f.modifiedAt || 0),
            createdAt: Number(f.createdAt || 0),
        };
    });
}

/**
 * Mount a hierarchical file tree into the given scroll container.
 *
 * @param {HTMLElement} container
 * @param {Array<string|TreeEntry>} files
 * @param {{
 *   activeFile?: string|null,
 *   initialExpanded?: string[],
 *   projectRoot?: string,
 *   onRename?: (path: string, newBasename: string) => Promise<string|void>,
 *   onToggleExpand?: (relPath: string, expanded: boolean) => void,
 *   onMove?: (srcAbs: string, newParentAbs: string) => Promise<void>|void,
 * }} [opts]
 */
export function mountFolderList(container, files, opts = {})
{
    let entries = normalise(files);
    let tree = buildTree(entries);
    const expanded = new Set(Array.isArray(opts.initialExpanded) ? opts.initialExpanded : []);
    /** @type {TreeNode[]} */
    let visibleRows = flattenForRender(tree, expanded);

    const onRename = typeof opts.onRename === "function" ? opts.onRename : null;
    const onToggleExpand = typeof opts.onToggleExpand === "function" ? opts.onToggleExpand : null;
    const onMove = typeof opts.onMove === "function" ? opts.onMove : null;
    const projectRoot = typeof opts.projectRoot === "string" ? opts.projectRoot : "";

    let activeFile = opts.activeFile ?? null;

    /** rel-path of the row currently in inline-rename mode, or null. */
    let renamingRelPath = /** @type {string|null} */ (null);
    /** debounced blur-commit timer so refresh-driven blurs don't re-enter. */
    let blurCommitTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);

    /** Currently-dragged rel-path, set on dragstart, cleared on dragend. */
    let currentDragRelPath = /** @type {string|null} */ (null);

    /** Roving tabindex — index into `visibleRows`. */
    let roverIndex = 0;

    /** @type {Map<string, HTMLDivElement>} */
    const rowEls = new Map();

    function buildTooltip(node)
    {
        const entry = node.entry || /** @type {TreeEntry} */ ({ modifiedAt: 0, createdAt: 0 });
        return t("mangaplay-studio.fileRow.lastModifiedAt", { time: formatTs(entry.modifiedAt) })
             + "\n"
             + t("mangaplay-studio.fileRow.createdAt", { time: formatTs(entry.createdAt) });
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
        row.dataset.relPath = node.relPath;
        row.dataset.kind = node.kind;
        row.dataset.depth = String(node.depth);
        // data-filename / data-path preserved for the global contextmenu
        // dispatcher and the rename plumbing in app.js.
        row.dataset.filename = node.kind === "file" ? node.name : node.relPath;
        row.dataset.path = absPathFor(node);
        row.dataset.tooltip = buildTooltip(node);
        row.dataset.tooltipSide = "right";
        row.draggable = true;
        row.style.paddingLeft = (10 + node.depth * 16) + "px";

        if (node.kind === "folder")
        {
            const disclosure = document.createElement("span");
            disclosure.className = "folder-list-disclosure";
            disclosure.innerHTML = icon("chevron-right", { size: 16 });
            disclosure.setAttribute("aria-hidden", "true");
            if (expanded.has(node.relPath))
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

        if (activeFile && (node.relPath === activeFile || node.name === activeFile))
        {
            row.setAttribute("aria-current", "true");
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
            rowEls.set(visibleRows[i].relPath, row);
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

        const prevRow = rowEls.get(visibleRows[prev]?.relPath);
        if (prevRow) prevRow.tabIndex = -1;

        const newRow = rowEls.get(visibleRows[wrapped]?.relPath);
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
     * Toggle the expand state of a folder. Updates the visible row list,
     * re-renders, and fires the `onToggleExpand` callback so the host can
     * persist the new state into meta.json.
     * @param {string} relPath
     */
    function toggleExpand(relPath)
    {
        const willExpand = !expanded.has(relPath);
        if (willExpand) expanded.add(relPath);
        else expanded.delete(relPath);
        rebuildVisible();
        render();
        notifyWatcherForFolder(relPath, willExpand);
        if (onToggleExpand)
        {
            try { onToggleExpand(relPath, willExpand); }
            catch (e) { console.warn("onToggleExpand failed:", e); }
        }
    }

    /**
     * Expand a folder explicitly (no-op when already expanded).
     * @param {string} relPath
     */
    function expandFolder(relPath)
    {
        if (expanded.has(relPath)) return;
        expanded.add(relPath);
        rebuildVisible();
        render();
        notifyWatcherForFolder(relPath, true);
        if (onToggleExpand)
        {
            try { onToggleExpand(relPath, true); }
            catch (e) { console.warn("onToggleExpand failed:", e); }
        }
    }

    /**
     * Collapse a folder explicitly (no-op when already collapsed).
     * @param {string} relPath
     */
    function collapseFolder(relPath)
    {
        if (!expanded.has(relPath)) return;
        expanded.delete(relPath);
        rebuildVisible();
        render();
        notifyWatcherForFolder(relPath, false);
        if (onToggleExpand)
        {
            try { onToggleExpand(relPath, false); }
            catch (e) { console.warn("onToggleExpand failed:", e); }
        }
    }

    /** @param {KeyboardEvent} e */
    function onKeyDown(e)
    {
        const active = document.activeElement;
        if (!active || !container.contains(active)) return;
        if (renamingRelPath) return;
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
                if (!expanded.has(node.relPath))
                {
                    expandFolder(node.relPath);
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
            if (node.kind === "folder" && expanded.has(node.relPath))
            {
                collapseFolder(node.relPath);
                moveRoverTo(roverIndex);
                return;
            }
            // Otherwise jump to the parent folder when there is one.
            const parentRelPath = node.relPath.includes("/")
                ? node.relPath.slice(0, node.relPath.lastIndexOf("/"))
                : "";
            if (!parentRelPath) return;
            const parentIdx = visibleRows.findIndex((r) => r.relPath === parentRelPath);
            if (parentIdx >= 0) moveRoverTo(parentIdx);
        }
        else if (e.key === "F2")
        {
            e.preventDefault();
            const node = visibleRows[roverIndex];
            if (node)
            {
                beginRename(node.kind === "file" ? node.name : node.relPath);
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
        const relPath = row.dataset.relPath;
        if (!relPath) return;
        const node = visibleRows.find((r) => r.relPath === relPath);
        if (!node) return;

        // Disclosure click on a folder toggles expand. Stop propagation so
        // the host's row-click handler (which opens files) doesn't fire.
        if (target.classList.contains("folder-list-disclosure")
            && node.kind === "folder")
        {
            e.stopPropagation();
            toggleExpand(relPath);
            return;
        }
        // Click on a folder body (not the disclosure): also toggle expand
        // — the user expects a folder click to reveal its contents.
        if (node.kind === "folder")
        {
            e.stopPropagation();
            toggleExpand(relPath);
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
        const relPath = row.dataset.relPath || "";
        currentDragRelPath = relPath;
        try
        {
            // WebView2 / Chromium on Windows refuses to start a native drag
            // when only an unrecognised custom MIME type is on the
            // DataTransfer. Set text/plain too — that's the well-known type
            // every drag-aware target understands. Read paths from the
            // custom type at drop time.
            e.dataTransfer?.setData("text/plain", relPath);
            e.dataTransfer?.setData("application/x-mps-rel-path", relPath);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        }
        catch { /* ignore */ }
    }

    /** @param {DragEvent} e */
    function onDragEnd()
    {
        currentDragRelPath = null;
        clearDropTarget();
    }

    /** @param {DragEvent} e */
    function onDragOver(e)
    {
        if (!currentDragRelPath && !e.dataTransfer?.types.includes("application/x-mps-rel-path"))
        {
            return;
        }
        const target = /** @type {HTMLElement} */ (e.target);
        const row = /** @type {HTMLDivElement|null} */ (target.closest(".folder-list-row"));
        // Allow drop onto a folder row OR the container's empty area (root).
        if (row && row.dataset.kind === "folder")
        {
            const dstRel = row.dataset.relPath || "";
            if (currentDragRelPath && isSelfOrDescendant(currentDragRelPath, dstRel))
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
        const srcRel = e.dataTransfer?.getData("application/x-mps-rel-path") || currentDragRelPath || "";
        if (!srcRel)
        {
            clearDropTarget();
            return;
        }
        const target = /** @type {HTMLElement} */ (e.target);
        const row = /** @type {HTMLDivElement|null} */ (target.closest(".folder-list-row"));

        let dstRel = "";
        let newParentAbs = "";
        if (row && row.dataset.kind === "folder")
        {
            dstRel = row.dataset.relPath || "";
            newParentAbs = row.dataset.path || "";
        }
        else if (!row)
        {
            // Container empty area → project root.
            dstRel = "";
            newParentAbs = projectRoot ? `${projectRoot}/project` : "";
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

        // Resolve the source absolute path from the entry list.
        const srcEntry = entries.find((en) => en.name === srcRel);
        const srcAbs = (srcEntry && srcEntry.path)
            ? srcEntry.path
            : (projectRoot ? `${projectRoot}/${srcRel}` : "");
        if (!srcAbs || !newParentAbs) return;

        if (onMove)
        {
            try { await onMove(srcAbs, newParentAbs); }
            catch (err) { console.warn("onMove failed:", err); }
        }
    }

    /**
     * Replace the row's name label with a text input so the user can type a
     * new basename. Suffix (`.mangaplay.md` etc.) is stripped before edit
     * and re-appended on commit.
     * @param {string} key  either a basename (file) or a rel-path
     */
    function beginRename(key)
    {
        if (!onRename) return;
        if (renamingRelPath) return;
        // Look up by relPath first, then by basename (files at any depth).
        let node = visibleRows.find((r) => r.relPath === key);
        if (!node) node = visibleRows.find((r) => r.name === key);
        if (!node) return;
        const row = rowEls.get(node.relPath);
        if (!row) return;

        renamingRelPath = node.relPath;
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
            renamingRelPath = null;
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
            renamingRelPath = null;
            try
            {
                await onRename(path, newName);
            }
            catch (err)
            {
                const code = String((err && err.message) || err || "unknown");
                committed = false;
                renamingRelPath = node.relPath;
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
    container.addEventListener("dragstart", onDragStart);
    container.addEventListener("dragend", onDragEnd);
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("dragleave", onDragLeave);
    container.addEventListener("drop", onDrop);

    const ro = new ResizeObserver(() => { /* no-op — flow layout self-sizes */ });
    ro.observe(container);

    const unsubI18n = subscribeI18n(() =>
    {
        for (const [relPath, el] of rowEls)
        {
            const node = visibleRows.find((r) => r.relPath === relPath);
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
        setActive(name)
        {
            activeFile = name;
            for (const [relPath, el] of rowEls)
            {
                const isMatch = name && (relPath === name
                    || el.dataset.filename === name);
                el.setAttribute("aria-current", isMatch ? "true" : "false");
            }
        },
        /**
         * Scroll the active row into view and apply a 1s flash highlight so
         * the user can locate it. No-op if there's no active row.
         */
        revealActive()
        {
            if (!activeFile) return;
            /** @type {HTMLElement|null} */
            let row = null;
            for (const [relPath, el] of rowEls)
            {
                if (relPath === activeFile || el.dataset.filename === activeFile)
                {
                    row = el;
                    break;
                }
            }
            if (!row) return;
            try { row.scrollIntoView({ block: "nearest", behavior: "instant" }); }
            catch { try { row.scrollIntoView(); } catch {} }
            row.classList.remove("is-flashing");
            // Force reflow so the keyframe restarts when revealActive is
            // called twice in quick succession.
            void row.offsetWidth;
            row.classList.add("is-flashing");
            setTimeout(() => row && row.classList.remove("is-flashing"), 1100);
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
         * Enter inline-rename mode on the row whose basename or rel-path
         * matches. No-op if the row isn't visible or `onRename` wasn't
         * provided.
         * @param {string} key
         */
        beginRename(key)
        {
            beginRename(key);
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
