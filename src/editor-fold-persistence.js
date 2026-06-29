// @ts-check
/**
 * editor-fold-persistence.js — read/write per-project page-fold state to
 * `<projectDir>/_mangaplaystudio/settings/fold-state.json`.
 *
 * The `.mangaplay.md` source file is never mutated. Fold state is purely a
 * desktop-app view concern, stored in a side-channel JSON file.
 *
 * File format:
 *   { "folded_pages": [1, 3, 7] }
 *
 * Project directory discovery: reads `window.__mpsCurrentProjectDir`, which
 * `app.js` is responsible for keeping current. If unset (e.g. start screen,
 * test bootstrap before project mount), persistence is silently disabled
 * until the global appears. A view-plugin re-attempts the initial restore on
 * the first update after the global goes live.
 *
 * Filesystem access uses Tauri's invoke wrappers exposed by
 * `src/project.js` (`atomic_write_project_file` + `read_project_file`).
 * Read failures fall through to "no saved state" — never a hard error.
 *
 * On every fold-state change (folded ranges differ from the previous tick),
 * the file is rewritten. A small leading-edge debounce (250ms) batches
 * rapid toggles.
 */

import { Prec } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { foldCode } from "@codemirror/language";
import { PAGE_LINE_RE } from "./editor-line-regexes.js";
import { isPageFolded } from "./editor-page-fold.js";
import { isTauri } from "./util/is-tauri.js";

/** Posix-style path join — `project.js` consistently uses forward slashes
 *  for invoke arguments, including on Windows. */
function joinPath(...parts)
{
    return parts
        .map((p, i) => (i === 0 ? String(p).replace(/[/\\]+$/, "") : String(p).replace(/^[/\\]+/, "").replace(/[/\\]+$/, "")))
        .filter((p) => p !== "")
        .join("/");
}

/**
 * Resolve the active project directory. Looks up `window.__mpsCurrentProjectDir`
 * first (the app.js hook), then falls back to a test/dev override on the same
 * global for harness bootstrap. Returns null if no project is active.
 *
 * @returns {string | null}
 */
function getActiveProjectDir()
{
    const w = /** @type {any} */ (window);
    return (w.__mpsCurrentProjectDir && String(w.__mpsCurrentProjectDir)) || null;
}

/**
 * Path to the fold-state JSON for a project.
 *
 * @param {string} projectDir
 */
function foldStatePath(projectDir)
{
    return joinPath(projectDir, "_mangaplaystudio", "settings", "fold-state.json");
}

/** Tauri invoke shim. Mirrors project.js — call @tauri-apps/api/core invoke. */
async function tauriInvoke(cmd, args)
{
    if (!isTauri()) throw new Error("Tauri unavailable");
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(cmd, args);
}

/**
 * Read saved fold state from disk. Returns an array of page numbers, or
 * empty array on any error / missing file.
 *
 * @param {string} projectDir
 * @returns {Promise<number[]>}
 */
async function readFoldState(projectDir)
{
    try
    {
        const path = foldStatePath(projectDir);
        const contents = await tauriInvoke("read_project_file", { path });
        if (!contents) return [];
        const parsed = JSON.parse(contents);
        if (parsed && Array.isArray(parsed.folded_pages))
        {
            return parsed.folded_pages.filter((n) => Number.isInteger(n) && n >= 1);
        }
        return [];
    }
    catch
    {
        return [];
    }
}

/**
 * Write fold state to disk. Best-effort; failures are logged but don't throw.
 *
 * @param {string} projectDir
 * @param {number[]} foldedPages
 */
async function writeFoldState(projectDir, foldedPages)
{
    try
    {
        const path = foldStatePath(projectDir);
        const contents = JSON.stringify({ folded_pages: foldedPages }, null, 2) + "\n";
        await tauriInvoke("atomic_write_project_file", { path, contents });
    }
    catch (e)
    {
        console.debug("[fold-persistence] write failed:", e);
    }
}


/**
 * Walk the doc and return a Map from page number (1-based ordinal of page
 * headings, NOT the `# Page N` literal number) to the line object. The
 * persistence model is "the Nth page heading in the doc" — robust against
 * users skipping numbers (`# Page 1`, `# Page 5`) without losing fold state.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @returns {Array<{ ordinal: number, line: import("@codemirror/text").Line }>}
 */
function listPageLines(state)
{
    /** @type {Array<{ ordinal: number, line: any }>} */
    const out = [];
    let ordinal = 0;
    for (let n = 1; n <= state.doc.lines; n++)
    {
        const line = state.doc.line(n);
        if (PAGE_LINE_RE.test(line.text))
        {
            ordinal++;
            out.push({ ordinal, line });
        }
    }
    return out;
}

/**
 * Read the currently-folded page ordinals from view state.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @returns {number[]}
 */
function currentlyFoldedOrdinals(state)
{
    const result = [];
    for (const { ordinal, line } of listPageLines(state))
    {
        if (isPageFolded(state, line)) result.push(ordinal);
    }
    return result;
}

/**
 * Build the persistence extension.
 *
 * @param {object} [opts]
 * @param {string | null} [opts.projectDir]  Override / explicit project dir;
 *   if omitted, reads `window.__mpsCurrentProjectDir` dynamically.
 * @returns {import("@codemirror/state").Extension}
 */
export function editorFoldPersistence(opts = {})
{
    /** @type {string | null} */
    const explicitDir = opts.projectDir || null;

    return Prec.low(ViewPlugin.fromClass(
        class
        {
            /** @param {EditorView} view */
            constructor(view)
            {
                this.view = view;
                /** Last set of folded ordinals we wrote / restored — used as the
                 *  diff key for the writeback path. */
                this.lastFolded = "";
                /** Whether we've successfully read and applied the initial
                 *  state. Retried on each update until the project dir
                 *  becomes available. */
                this.restored = false;
                /** Debounce timer for writebacks. */
                this.writeTimer = null;
                /** Last seen project dir — reset triggers re-restore. */
                this.seenProjectDir = "";

                // Kick off initial restore. Asynchronous — the view is already
                // built; we dispatch a fold transaction after the file load.
                this.attemptRestore();
            }

            getProjectDir()
            {
                return explicitDir || getActiveProjectDir();
            }

            attemptRestore()
            {
                const dir = this.getProjectDir();
                if (!dir) return;
                if (this.restored && this.seenProjectDir === dir) return;
                this.seenProjectDir = dir;

                readFoldState(dir).then((ordinals) =>
                {
                    if (!ordinals.length)
                    {
                        this.restored = true;
                        this.lastFolded = "";
                        return;
                    }
                    // Defer one tick so the editor's view + foldState facet are
                    // both fully wired before we dispatch fold transactions.
                    setTimeout(() =>
                    {
                        const pages = listPageLines(this.view.state);
                        const wanted = new Set(ordinals);
                        for (const { ordinal, line } of pages)
                        {
                            if (!wanted.has(ordinal)) continue;
                            this.view.dispatch({
                                selection: { anchor: line.from, head: line.from }
                            });
                            try { foldCode(this.view); }
                            catch (e) { console.debug("[fold-persistence] foldCode failed", e); }
                        }
                        this.restored = true;
                        this.lastFolded = ordinals.slice().sort((a, b) => a - b).join(",");
                    }, 50);
                }).catch(() =>
                {
                    // Treat as no saved state — first toggle will create the file.
                    this.restored = true;
                });
            }

            /** @param {import("@codemirror/view").ViewUpdate} update */
            update(update)
            {
                // Retry initial restore if the project dir wasn't ready at
                // construction time.
                if (!this.restored)
                {
                    this.attemptRestore();
                }

                // Detect fold-state changes by diffing the ordinal list.
                const dir = this.getProjectDir();
                if (!dir) return;

                const ordinals = currentlyFoldedOrdinals(update.state);
                const key = ordinals.slice().sort((a, b) => a - b).join(",");
                if (key === this.lastFolded) return;
                this.lastFolded = key;
                // Only persist once the initial restore is done — otherwise
                // the empty-state pre-restore moment would clobber the file.
                if (!this.restored) return;

                if (this.writeTimer)
                {
                    clearTimeout(this.writeTimer);
                }
                this.writeTimer = setTimeout(() =>
                {
                    this.writeTimer = null;
                    writeFoldState(dir, ordinals);
                }, 250);
            }

            destroy()
            {
                if (this.writeTimer)
                {
                    clearTimeout(this.writeTimer);
                    this.writeTimer = null;
                }
            }
        }
    ));
}
