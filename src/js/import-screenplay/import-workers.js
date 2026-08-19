// @ts-check
/**
 * import-workers.js — pure functions the Import Screenplay FSM calls.
 *
 * Wraps the shared core/import/ validators + the Fountain-Plus parsers so
 * the desktop preflight runs the SAME code fountain.plus does. Also owns
 * the Tauri IPC for opening a file dialog and reading arbitrary files
 * (`app_open_file_dialog` + `app_read_file_bytes` — new Rust commands
 * added in src-tauri/src/commands/file_ops/crud.rs).
 *
 * Everything here is UI-agnostic; the FSM injects these into transitions.
 */

import { invoke } from "@tauri-apps/api/core";
import validatePdf from "../../../../core/import/validators/pdf.js";
import validateFountain from "../../../../core/import/validators/fountain.js";
import { errorStringFor } from "../../../../core/import/error-strings.js";
import { parseFountain } from "@mangaplay-studio/core";
import { parsePdf } from "../../../../core/import/pdf-reader.js";
import { parseViaFountain } from "../../../../core/import/fountain-intermediate.js";
import { loadPdfJs } from "./pdf-loader.js";

export { errorStringFor };

/**
 * Open a native Open-File dialog. Returns the chosen absolute path, or
 * null if the user cancelled.
 * @param {Array<[string, string[]]>} filters — e.g. [["PDF", ["pdf"]]]
 * @returns {Promise<string|null>}
 */
export async function pickFile(filters)
{
    const result = await invoke("app_open_file_dialog", { filters });
    return /** @type {string|null} */ (result);
}

/**
 * Open a native multi-select Open-File dialog. Returns the chosen absolute
 * paths, or null if the user cancelled.
 * @param {Array<[string, string[]]>} filters — e.g. [["Fountain", ["fountain"]]]
 * @returns {Promise<string[]|null>}
 */
export async function pickFiles(filters)
{
    const result = await invoke("app_open_files_dialog", { filters });
    return /** @type {string[]|null} */ (result);
}

/**
 * Read a file as UTF-8 text. Thin wrapper around app_read_file_bytes.
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function readTextFile(path)
{
    const bytes = /** @type {number[]} */ (
        await invoke("app_read_file_bytes", { path }));
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

/**
 * Read a file as an ArrayBuffer.
 * @param {string} path
 * @returns {Promise<ArrayBuffer>}
 */
export async function readBinaryFile(path)
{
    console.log("[import] readBinaryFile start:", path);
    try
    {
        const bytes = /** @type {number[]} */ (
            await invoke("app_read_file_bytes", { path }));
        console.log("[import] readBinaryFile got", bytes?.length, "bytes");
        const arr = new Uint8Array(bytes);
        // Return a fresh ArrayBuffer (not a shared SAB) so pdf.js is happy.
        return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    }
    catch (e)
    {
        console.error("[import] readBinaryFile threw:", e);
        throw e;
    }
}

/**
 * PDF preflight — mirrors websites/fountain.plus's sniff pipeline. Delegates
 * the heavy lifting to `validatePdf` from core so the desktop and website
 * classify PDFs identically.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<{ valid: boolean, reason: string|null, detail: string|null }>}
 */
export async function preflightPdf(arrayBuffer)
{
    console.log("[import] preflightPdf start, buffer bytes:", arrayBuffer?.byteLength, "detached:", arrayBuffer?.byteLength === 0);
    let getDocument;
    try
    {
        getDocument = await loadPdfJs();
        console.log("[import] pdfjs loaded, getDocument type:", typeof getDocument);
    }
    catch (e)
    {
        console.error("[import] loadPdfJs threw:", e);
        throw e;
    }
    try
    {
        // pdf.js detaches the ArrayBuffer we hand it — clone so the caller's
        // buffer stays intact for the next stage (parsePdfToFountain).
        const clone = arrayBuffer.slice(0);
        console.log("[import] preflight clone bytes:", clone.byteLength);
        const result = await validatePdf(
            { text: null, arrayBuffer: clone, file: /** @type {any} */ (null) },
            getDocument
        );
        console.log("[import] validatePdf result:", result);
        return result;
    }
    catch (e)
    {
        console.error("[import] validatePdf threw:", e);
        throw e;
    }
}

/**
 * Fountain preflight — runs the (currently no-op) shared validateFountain
 * stub AND does an inline parse-and-content check. The double call is
 * DELIBERATE future-proofing: when the fountain.plus team fleshes out
 * validateFountain, the desktop inherits the new checks for free.
 *
 * On success returns the parsed screenplay so the PARSING phase can skip
 * a second parse.
 *
 * @param {string} text
 * @returns {Promise<{ valid: boolean, reason: string|null, detail: string|null, screenplay?: any }>}
 */
export async function preflightFountain(text)
{
    // 1. Shared stub validator — currently returns {valid:true}. Do NOT
    //    remove; wired so a future core-side check lands automatically.
    const stubResult = await validateFountain(
        { text, arrayBuffer: null, file: /** @type {any} */ (null) });
    if (!stubResult.valid) return stubResult;

    // 2. Inline parse + content check.
    let screenplay;
    try
    {
        screenplay = parseFountain(text);
    }
    catch (e)
    {
        return { valid: false, reason: "fountain-parse-failed",
            detail: /** @type {any} */ (e)?.message || "parse failed" };
    }

    const scenes = screenplay && screenplay.scenes;
    if (!scenes || scenes.length === 0)
    {
        return { valid: false, reason: "empty-screenplay",
            detail: "No screenplay content was found in this file." };
    }

    return { valid: true, reason: null, detail: null, screenplay };
}

/**
 * PDF → Fountain conversion. parsePdf produces a raw Screenplay; then
 * parseViaFountain round-trips through Fountain to normalise it — the
 * fountain.plus converter does the same.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<{ fountainText: string }>}
 */
export async function parsePdfToFountain(arrayBuffer)
{
    console.log("[import] parsePdfToFountain start, buffer bytes:", arrayBuffer?.byteLength, "detached:", arrayBuffer?.byteLength === 0);
    try
    {
        const getDocument = await loadPdfJs();
        console.log("[import] pdfjs ready for parsePdf");

        // pdf.js detaches the buffer. Clone defensively so this stage owns
        // a fresh copy regardless of what the caller did.
        const clone = arrayBuffer.slice(0);
        console.log("[import] parse clone bytes:", clone.byteLength);

        const raw = await parsePdf(clone, getDocument);
        console.log("[import] parsePdf ok, scenes:", raw?.scenes?.length);

        const result = await parseViaFountain(raw);
        console.log("[import] parseViaFountain ok, fountainText length:", result?.fountainText?.length);

        return { fountainText: result.fountainText };
    }
    catch (e)
    {
        console.error("[import] parsePdfToFountain threw:", e);
        console.error("[import] error name:", /** @type {any} */ (e)?.name);
        console.error("[import] error message:", /** @type {any} */ (e)?.message);
        console.error("[import] error stack:", /** @type {any} */ (e)?.stack);
        throw e;
    }
}

/**
 * Fountain passthrough — the input source IS the output.
 * @param {string} text
 * @returns {{ fountainText: string }}
 */
export function fountainPassthrough(text)
{
    return { fountainText: text };
}

/**
 * Apply the imported Fountain text to the active CodeMirror editor.
 * Preserves undo history (userEvent tag lets a future "undo import" target
 * this dispatch); dirty flag propagates via the existing docChanged
 * listener at mps-editor.js:135.
 *
 * @param {string} fountainText
 * @returns {void}
 */
export function applyToEditor(fountainText)
{
    // editor-slot-manager.js publishes the active EditorView on
    // window.__mpsActiveEditorView every slot switch — this is the
    // sanctioned public accessor.
    const view = /** @type {any} */ (window).__mpsActiveEditorView;
    console.log("[import] applyToEditor: view found?", !!view,
        "doc len:", view?.state?.doc?.length);
    if (!view) throw new Error("no active editor view");

    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: fountainText },
        userEvent: "import.screenplay",
    });
}
