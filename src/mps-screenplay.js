// @ts-check
/**
 * mps-screenplay — Desktop entry that mounts the website's <mps-screenplay>
 * custom element. The component reads its content from the shared
 * RuntimeStorage which app.js's live-parse already updates on each keystroke,
 * so we don't drive it imperatively. buildScreenplay / updateScreenplay are
 * kept as no-op shims so existing call sites in app.js keep working without
 * an immediate rewrite.
 */

// Side-import — registers customElements.define('mps-screenplay', MPSScreenplay).
import "../../websites/mangaplay.studio/src/components/mps-screenplay.js";

/**
 * No-op shim — the website component drives itself from RuntimeStorage.
 * @param {HTMLElement} parent
 * @param {string} _source
 * @returns {any} a fake view object app.js can hold without using.
 */
export function buildScreenplay(parent, _source)
{
    return { _isShim: true, parent };
}

/**
 * No-op shim — store updates flow through publishParsedScript in app.js.
 * @param {any} _view
 * @param {string} _source
 */
export function updateScreenplay(_view, _source) {}
