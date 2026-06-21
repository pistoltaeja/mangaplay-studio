// @ts-check
/**
 * mps-editor — CodeMirror 6 editable .mangaplay.md source.
 */

import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, selectAll } from "@codemirror/commands";
import { openContextMenu } from "./components/mps-context-menu.js";
import { editorCut, editorCopy, editorPaste, editorPastePlain } from "./editor-clipboard.js";
import { t } from "./adapters/tauri-i18n.js";
import { formatForFilename, languageExtensionsFor } from "./lang-registry.js";
import { editorSourceTab } from "./editor-source-tab.js";

/**
 * @typedef {"source"|"text"|"visual"} EditorMode
 */

/**
 * Module-level current mode. Visual mode lives outside CM entirely; for the
 * CM-resident modes ("source" / "text") this drives which extension set the
 * Compartment is reconfigured to. New views built while we're in Source
 * mode honour this so a freshly-opened tab doesn't surface the language
 * extensions only to be stripped a tick later.
 * @type {EditorMode}
 */
let currentEditorMode = "text";

/** @returns {EditorMode} */
export function getEditorMode()
{
    return currentEditorMode;
}

/**
 * Compute the mode-dependent CM extension list. Visual is intentionally
 * outside this — Visual mode unmounts CM entirely, so it never reaches
 * the Compartment.
 * @param {EditorMode} mode
 * @param {import("./lang-registry.js").EditorFormat} format
 * @returns {import("@codemirror/state").Extension}
 */
function extensionsForMode(mode, format)
{
    if (mode === "source")
    {
        // Plain monospace plaintext. NO language, fold, autocomplete,
        // typing-autos, highlight, page region, line indent, panel tag
        // style. The one exception is a slim Tab handler so cursor
        // navigation matches what users expect from a text editor — left
        // out and Tab falls through to the browser default (focus shift).
        //
        // drawSelection() is intentionally NOT included here — Source
        // mode uses the browser-native selection so the highlight paints
        // reliably under WebView2 (the CM6 selection layer fails to
        // render in this surface). drawSelection() also injects
        // `::selection { background-color: transparent !important }` on
        // .cm-line, which would suppress any native selection styling we
        // add via CSS, so it must be omitted, not just visually hidden.
        return editorSourceTab();
    }
    // "text" (the default) and "visual" (CM not visible but state survives)
    // get the full mangaplay surface. drawSelection() is omitted across
    // all modes — the CM6 selection layer fails to render under WebView2
    // even with z-index/specificity/opacity overrides. Native browser
    // ::selection paints reliably; we style it in app.css.
    return languageExtensionsFor(format);
}

/**
 * Build and mount a CodeMirror 6 editor inside the given parent element.
 * @param {HTMLElement} parent
 * @param {object} [opts]
 * @param {string} [opts.doc] - Initial document text
 * @param {(text: string) => void} [opts.onChange] - Called on every change
 * @param {string} [opts.format] - Format ID (mangaplay / fountain / superscript / general-text).
 *                                 Defaults to "mangaplay".
 * @returns {EditorView}
 */
export function buildEditor(parent, opts = {}) {
    const { doc = "", onChange, format = "mangaplay" } = opts;

    const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged && onChange) {
            onChange(update.state.doc.toString());
        }
    });

    // The language + decoration set lives behind a Compartment so we can
    // swap it Text↔Source without re-instantiating the EditorState
    // (preserves doc, cursor, scroll, undo history).
    const languageCompartment = new Compartment();
    const initialLanguageSlot = extensionsForMode(
        currentEditorMode === "visual" ? "text" : currentEditorMode,
        /** @type {any} */ (format)
    );

    const state = EditorState.create({
        doc,
        extensions: [
            lineNumbers(),
            highlightActiveLine(),
            history(),
            // drawSelection() moved into the language compartment so Source
            // mode can opt out (see extensionsForMode). Text/Visual modes
            // include it; Source mode falls back to native ::selection.
            keymap.of([...defaultKeymap, ...historyKeymap]),
            languageCompartment.of(initialLanguageSlot),
            updateListener,
            EditorView.lineWrapping,
        ],
    });

    const view = new EditorView({
        state,
        parent,
    });

    // Stash the compartment + format on the view so `setEditorMode` can
    // reach them without us threading another handle through every caller.
    /** @type {any} */ (view).__mpsLanguageCompartment = languageCompartment;
    /** @type {any} */ (view).__mpsFormat = format;

    // Editor right-click routes through the single capture-phase contextmenu
    // listener in app.js (see routeContextMenu). We just expose the active
    // view so the router can build the menu against it. Multiple editors
    // would only update this on focus; for v1 there's one editor at a time.
    /** @type {any} */ (window).__mpsActiveEditorView = view;
    /** @type {any} */ (window).__mpsBuildEditorMenu = () => buildEditorMenu(view);

    return view;
}

/**
 * Reconfigure a single view's language compartment to match `mode`. No-op
 * for "visual" — Visual mode unmounts CM, so callers should not invoke
 * this with "visual"; we tolerate it defensively by falling back to the
 * text-mode extension set so the buffer stays editable if Visual fails
 * to mount.
 * @param {EditorView} view
 * @param {EditorMode} mode
 */
export function setEditorViewMode(view, mode)
{
    const compartment = /** @type {Compartment|null} */ (
        /** @type {any} */ (view).__mpsLanguageCompartment
    );
    if (!compartment) return;
    const format = /** @type {any} */ (view).__mpsFormat || "mangaplay";
    const effective = mode === "visual" ? "text" : mode;
    view.dispatch({
        effects: compartment.reconfigure(extensionsForMode(effective, format))
    });
}

/**
 * Set the module-level editor mode. Used by `applyEditorMode` in app.js
 * so newly-built views (tabs opened after the switch) honour the current
 * mode. Does NOT touch existing views — callers reconfigure each view
 * via `setEditorViewMode`.
 * @param {EditorMode} mode
 */
export function setEditorMode(mode)
{
    currentEditorMode = mode;
}

/**
 * Build the items list for the editor context menu. Selection-aware:
 * Cut / Copy are disabled when no range is selected. Paste / Paste as
 * plain text are always enabled (the menu item is a user gesture so the
 * async clipboard API has activation).
 * @param {EditorView} view
 * @returns {Array<any>}
 */
function buildEditorMenu(view)
{
    const hasSel = view.state.selection.ranges.some((r) => !r.empty);
    return [
        { id: "cut",       label: t("mangaplay-studio.menu.editor.cut"),        icon: "scissors", disabled: !hasSel, onSelect: () => { view.focus(); editorCut(view); } },
        { id: "copy",      label: t("mangaplay-studio.menu.editor.copy"),       icon: "copy",     disabled: !hasSel, onSelect: () => { view.focus(); editorCopy(view); } },
        { id: "paste",     label: t("mangaplay-studio.menu.editor.paste"),                                            onSelect: () => { view.focus(); editorPaste(view); } },
        { id: "paste-pln", label: t("mangaplay-studio.menu.editor.pastePlain"),                                       onSelect: () => { view.focus(); editorPastePlain(view); } },
        { kind: "divider" },
        { id: "selall",    label: t("mangaplay-studio.menu.editor.selectAll"),                                        onSelect: () => { view.focus(); selectAll(view); } },
    ];
}

/**
 * Initialize mps-editor custom element.
 * Called when the element is connected to the DOM.
 * @param {HTMLElement} el
 * @param {object} [opts]
 * @param {string} [opts.filename] - Active script basename; selects the CM6
 *                                   language pack via the lang-registry.
 * @returns {EditorView}
 */
export function initEditor(el, opts = {}) {
    const format = formatForFilename(opts.filename);
    return buildEditor(el, {
        format,
        onChange: (text) => {
            // Dispatch custom event for app.js to pick up
            el.dispatchEvent(new CustomEvent("mps-change", {
                detail: { text },
                bubbles: true,
            }));
        },
    });
}
