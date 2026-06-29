// @ts-check
/**
 * editor-clipboard.js — CodeMirror 6 clipboard helpers for the editor
 * context menu (cut / copy / paste / paste-as-plain-text).
 *
 * Clipboard path: prefer tauri-plugin-clipboard-manager when running inside
 * the .exe (no WebView2 permission prompt on cut/copy/paste). Falls back to
 * navigator.clipboard for the web preview build, and execCommand("paste")
 * as a final shim when the async API is unavailable.
 *
 * Why multi-range awareness: CM6 allows rectangular and multi-cursor
 * selections. The native browser cut/copy on a CM6 selection only sees the
 * primary range. We concatenate all non-empty ranges with "\n" so the user
 * gets the same payload they'd see if they pressed Ctrl/Cmd-C.
 *
 * Paste-as-plain-text reads `text/html` if present and runs it through a
 * DOM-attached hidden node's `.textContent` (NOT `innerText` which returns
 * "" without layout). Layout-attached `.textContent` is what reviewer 2
 * called out as the only reliable way to strip HTML in WebView2.
 */

import { isTauri } from "./util/is-tauri.js";

/** Dynamically loaded handle to the Tauri clipboard plugin (.exe target). */
let tauriClipboardPromise = null;
function getTauriClipboard()
{
    if (!isTauri()) return null;
    if (!tauriClipboardPromise)
    {
        tauriClipboardPromise = import("@tauri-apps/plugin-clipboard-manager").catch(() => null);
    }
    return tauriClipboardPromise;
}

async function writeClipboardText(text)
{
    const tauri = getTauriClipboard();
    if (tauri)
    {
        try
        {
            const mod = await tauri;
            if (mod && typeof mod.writeText === "function")
            {
                await mod.writeText(text);
                return;
            }
        }
        catch { /* fall through to web API */ }
    }
    try { await navigator.clipboard.writeText(text); }
    catch { /* swallow — most likely a permissions edge case */ }
}

/**
 * Return the text of the current selection. Multi-range selections are
 * concatenated in document order, joined with "\n". Empty selection → "".
 * @param {import("@codemirror/view").EditorView} view
 * @returns {string}
 */
export function getSelectedText(view)
{
    const ranges = view.state.selection.ranges.filter((r) => !r.empty);
    if (ranges.length === 0) return "";
    // Document order — CM6 ranges may be in any order if the user dragged
    // backwards; sort by `from` so the concatenated payload reads top→bottom.
    const sorted = ranges.slice().sort((a, b) => a.from - b.from);
    return sorted.map((r) => view.state.sliceDoc(r.from, r.to)).join("\n");
}

/**
 * Write the selected text to the clipboard, then delete each selected range.
 * Ranges are deleted in reverse order so earlier offsets remain valid.
 * @param {import("@codemirror/view").EditorView} view
 * @returns {Promise<void>}
 */
export async function editorCut(view)
{
    const text = getSelectedText(view);
    if (!text) return;
    await writeClipboardText(text);
    const changes = view.state.selection.ranges
        .filter((r) => !r.empty)
        .sort((a, b) => b.from - a.from)
        .map((r) => ({ from: r.from, to: r.to }));
    view.dispatch({ changes });
}

/**
 * Copy the selected text to the clipboard. No-op on empty selection.
 * @param {import("@codemirror/view").EditorView} view
 * @returns {Promise<void>}
 */
export async function editorCopy(view)
{
    const text = getSelectedText(view);
    if (!text) return;
    await writeClipboardText(text);
}

/**
 * Paste plain text from the clipboard at the primary selection. Falls back
 * to a hidden-textarea + execCommand("paste") path when the async clipboard
 * API rejects.
 * @param {import("@codemirror/view").EditorView} view
 * @returns {Promise<void>}
 */
export async function editorPaste(view)
{
    const text = await readClipboardText();
    if (!text) return;
    dispatchPaste(view, text);
}

/**
 * Paste text from the clipboard, stripping HTML if the clipboard offers
 * `text/html`. Falls back to plain-text on any failure.
 * @param {import("@codemirror/view").EditorView} view
 * @returns {Promise<void>}
 */
export async function editorPastePlain(view)
{
    const text = await readClipboardHtmlAsPlain();
    if (!text) return;
    dispatchPaste(view, text);
}

/**
 * Replace the primary selection with `text` and place the caret at the end.
 * Other ranges are left untouched — matches CM6's default paste behaviour
 * when the clipboard has fewer lines than the cursor count.
 * @param {import("@codemirror/view").EditorView} view
 * @param {string} text
 */
export function dispatchPaste(view, text)
{
    const sel = view.state.selection.main;
    view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
    });
}

/**
 * Read text/plain from the clipboard. Async-API first, execCommand fallback.
 * @returns {Promise<string>}
 */
async function readClipboardText()
{
    const tauri = getTauriClipboard();
    if (tauri)
    {
        try
        {
            const mod = await tauri;
            if (mod && typeof mod.readText === "function")
            {
                const t = await mod.readText();
                if (t) return t;
            }
        }
        catch { /* fall through to web API */ }
    }
    try
    {
        const t = await navigator.clipboard.readText();
        if (t) return t;
    }
    catch { /* fall through */ }
    return execCommandPasteFallback();
}

/**
 * Fallback paste path. Mounts a hidden textarea, focuses it, issues
 * execCommand("paste"), reads `.value`, then tears down.
 * @returns {string}
 */
function execCommandPasteFallback()
{
    try
    {
        const tmp = document.createElement("textarea");
        tmp.style.cssText = "position:fixed;top:-9999px;left:0;opacity:0;";
        document.body.appendChild(tmp);
        tmp.focus();
        const ok = document.execCommand("paste");
        const text = ok ? tmp.value : "";
        tmp.remove();
        return text;
    }
    catch
    {
        return "";
    }
}

/**
 * Read clipboard, preferring `text/html` (run through `.textContent` of a
 * DOM-attached hidden div) over `text/plain`. Falls back to text/plain on
 * any failure path.
 * @returns {Promise<string>}
 */
async function readClipboardHtmlAsPlain()
{
    // Inside Tauri the format-specific read API isn't routed through the
    // plugin; calling navigator.clipboard.read() would trigger the WebView2
    // permission prompt for no gain (the Tauri plugin only exposes text).
    // Skip straight to text read.
    if (!isTauri())
    {
        try
        {
            if (typeof navigator.clipboard?.read === "function")
            {
                const items = await navigator.clipboard.read();
                const htmlItem = items.find((i) => i.types.includes("text/html"));
                if (htmlItem)
                {
                    const blob = await htmlItem.getType("text/html");
                    const html = await blob.text();
                    return stripHtmlViaTextContent(html);
                }
            }
        }
        catch { /* fall through */ }
    }
    return readClipboardText();
}

/**
 * Strip HTML via `.textContent` on a DOM-attached hidden node. `.textContent`
 * works in WebView2 without layout; `innerText` does NOT (returns "" because
 * layout is suppressed by `visibility:hidden` / off-screen positioning).
 * @param {string} html
 * @returns {string}
 */
function stripHtmlViaTextContent(html)
{
    const hidden = document.createElement("div");
    hidden.style.cssText = "position:fixed;top:-9999px;visibility:hidden;";
    hidden.innerHTML = html;
    document.body.appendChild(hidden);
    const text = hidden.textContent || "";
    hidden.remove();
    return text;
}
