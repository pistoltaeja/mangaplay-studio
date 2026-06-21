// @ts-check
/**
 * mps-canvas — Desktop entry that mounts the website's <mps-canvas> custom element.
 *
 * The website component (websites/mangaplay.studio/src/components/mps-canvas.js)
 * registers itself as 'mps-canvas' on first import via customElements.define.
 * Once imported, every <mps-canvas> tag in the document upgrades to the real
 * component. Adapters route storage/i18n/device calls to desktop equivalents;
 * see scripts/build-bundle.js for the aliasPlugin map.
 */

// Side-import — registers customElements.define('mps-canvas', MPSCanvas).
import "../../websites/mangaplay.studio/src/components/mps-canvas.js";
// Side-import — registers customElements.define('mps-paint-widget', ...).
// The widget is position:fixed (per canvas.css) — host tag in index.html is
// just a placeholder so the upgrade fires once and the floating UI mounts.
import "../../websites/mangaplay.studio/src/components/mps-paint-widget.js";
// Side-import — registers customElements.define('mps-quick-toggle-sidebar', ...).
// The sidebar is rendered as a child of mps-canvas via innerHTML in canvas
// render(). The transitive import chain isn't enough to guarantee the element
// is defined BEFORE mps-canvas first parses its innerHTML — without this
// explicit import, the sidebar tag stays empty (no upgrade, no _render).
import "../../websites/mangaplay.studio/src/components/mps-quick-toggle-sidebar.js";

/** @type {HTMLElement | null} */
let canvasEl = null;

/**
 * Initialize the canvas inside the given element. The host <mps-canvas> tag
 * is already present in index.html; once the website module loads, the tag
 * upgrades and connectedCallback runs. This shim exposes a small API that
 * app.js's existing callers expect (onSave, setScript, setPage).
 *
 * @param {HTMLElement} el — the <mps-canvas> custom element instance
 * @param {object} [opts]
 * @param {(pageIndex: number, drawing: object) => void | Promise<void>} [opts.onSave]
 * @param {(text: string) => void} [opts.onScriptChange]
 */
export async function initCanvas(el, opts = {})
{
    canvasEl = el;

    // The website component drives its own save lifecycle via the
    // drawing-store adapter (which calls globalThis.__MPS_DESKTOP__.updatePage
    // + queueSave). The onSave callback from app.js is therefore optional —
    // we still surface it via a document event for compatibility.
    /** @type {((ev: Event) => void) | null} */
    let savedHandler = null;
    if (opts.onSave)
    {
        savedHandler = (ev) =>
        {
            const detail = /** @type {any} */ (ev)?.detail;
            if (!detail) return;
            // detail typically: { pageIndex, drawing }
            opts.onSave(detail.pageIndex ?? 0, detail.drawing ?? {});
        };
        document.addEventListener("drawing-save-complete", savedHandler);
    }

    if (opts.onScriptChange)
    {
        // The current desktop pipeline calls canvasApi.setScript(text) directly;
        // see getCanvas() below for the imperative path. No event subscription needed.
    }

    return {
        /** Pass the current script text to the canvas (for page-count detection, etc). */
        setScript(text)
        {
            if (canvasEl && typeof /** @type {any} */ (canvasEl).setScript === "function")
            {
                /** @type {any} */ (canvasEl).setScript(text);
            }
            else if (canvasEl)
            {
                canvasEl.dispatchEvent(new CustomEvent("script-change", { detail: { text } }));
            }
        },
        /** Set the current page index. */
        setPage(index)
        {
            if (canvasEl && typeof /** @type {any} */ (canvasEl).setPage === "function")
            {
                /** @type {any} */ (canvasEl).setPage(index);
            }
            else if (canvasEl)
            {
                canvasEl.dispatchEvent(new CustomEvent("page-change", { detail: { pageIndex: index } }));
            }
        },
        destroy()
        {
            // Detach the document-level save listener so back-to-back
            // initCanvas() calls don't stack handlers (each stacked handler
            // re-fires opts.onSave → duplicate persistence per stroke).
            if (savedHandler)
            {
                document.removeEventListener("drawing-save-complete", savedHandler);
                savedHandler = null;
            }
            canvasEl = null;
        },
    };
}

export function getCanvas()
{
    return canvasEl;
}
