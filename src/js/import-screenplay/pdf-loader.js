// @ts-check
/**
 * pdf-loader.js — desktop-local pdf.js loader.
 *
 * Mirrors websites/fountain.plus/src/pdf-loader.js in shape, but resolves
 * pdfjs-dist from the local workspace (bundled via Bun) and points the
 * worker at `./vendor/pdf.worker.mjs` — a file that scripts/build-bundle.js
 * copies into the frontend output at build time so Tauri's `'self'` CSP
 * accepts it.
 *
 * Initialisation contract: `GlobalWorkerOptions.workerSrc` is set as a
 * side-effect on first load. `validatePdf` / `parsePdf` from
 * `core/import/validators/pdf.js` + `core/import/pdf-reader.js` rely on
 * this — they call `getDocument(...)` and expect the worker to be wired.
 */

/** @type {any|null} */
let _pdfjsModule = null;

/**
 * Load pdfjs-dist. Idempotent — subsequent calls return the same
 * `getDocument`. Sets `GlobalWorkerOptions.workerSrc` once on first load.
 * @returns {Promise<Function>}
 */
export async function loadPdfJs()
{
    if (_pdfjsModule) return _pdfjsModule.getDocument;

    const mod = await import("pdfjs-dist/build/pdf.mjs");
    mod.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.mjs";

    if (typeof mod.getDocument !== "function")
    {
        throw new Error("pdf.js loaded but getDocument is not a function");
    }

    _pdfjsModule = mod;
    return mod.getDocument;
}

/** @returns {boolean} */
export function isPdfJsLoaded()
{
    return _pdfjsModule !== null;
}
