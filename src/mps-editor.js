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
import { getSpellcheckState, getSpellcheckConfig } from "./spellcheck-state.js";
import { combinedLinter } from "./combined-linter.js";
import { forceLinting } from "@codemirror/lint";

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
        // Lint diagnostics ARE enabled for mangaplay / fountain / superscript
        // formats via combinedLinter() — Source mode still wants parser
        // grammar squiggles (WARN_PAGE_LOWERCASE, EDITOR_PAGE_OUT_OF_ORDER,
        // EDITOR_UNKNOWN_PANEL_TAG, etc). general-text and superscript-bin
        // skip the linter — there's no parser grammar to surface.
        //
        // drawSelection() is intentionally NOT included here — Source
        // mode uses the browser-native selection so the highlight paints
        // reliably under WebView2 (the CM6 selection layer fails to
        // render in this surface). drawSelection() also injects
        // `::selection { background-color: transparent !important }` on
        // .cm-line, which would suppress any native selection styling we
        // add via CSS, so it must be omitted, not just visually hidden.
        // Source mode opts in to WebView2 native spellcheck via the
        // contenteditable's `spellcheck` + `lang` attributes. The
        // contentDOM is the editable surface so contentAttributes hits the
        // right element.
        //
        // Three subtleties:
        //   1. The facet uses the function form so CM6 re-reads on every
        //      update — toggle flips propagate without a Compartment swap.
        //   2. `lang` is set alongside `spellcheck` so Chromium picks the
        //      right dictionary. Without it the WebView falls back to
        //      <html lang>, which is the UI locale, not what the user
        //      chose in the Text Editor settings.
        //   3. We rely on the facet, but ALSO set the attribute imperatively
        //      after mount (see buildEditor → applySpellcheckAttrs). Some
        //      WebView2 builds latch their spellcheck decision on first
        //      paint from the attribute value present at that moment;
        //      if the state was seeded after the view mounted, the facet
        //      eventually wins but the squiggle paint never wakes up.
        const ext = [
            editorSourceTab(),
            EditorView.contentAttributes.of(() =>
            {
                const s = getSpellcheckState();
                if (!s.enabled) return null;
                return { spellcheck: "true", lang: spellcheckHtmlLang(s.language) };
            }),
            // CM6's baseTheme sets `-webkit-user-modify: read-write-plaintext-only`
            // on contenteditable .cm-content as a paste-safety measure. Chromium
            // (and therefore WebView2) explicitly disables the native spellchecker
            // on any element with that property set to plaintext-only — it can't
            // safely insert correction markup there. Override it back to the
            // standard `read-write` so squiggles paint. Paste safety is unaffected
            // because our editorPaste / editorPastePlain handlers already
            // intercept and sanitise paste at the keymap layer.
            EditorView.theme({
                ".cm-content": { WebkitUserModify: "read-write" }
            })
        ];
        if (format === "mangaplay" || format === "fountain" || format === "superscript")
        {
            ext.push(combinedLinter(getSpellcheckConfig, format));
        }
        return ext;
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

    activeViews.add(view);

    // Belt-and-braces: set the attribute imperatively on first mount so
    // WebView2 sees `spellcheck="true"` at first paint, not a brief flash
    // of CM6's hardcoded `"false"` default. The facet wins on subsequent
    // updates; this just prevents the boot race.
    applySpellcheckAttrs(view);

    return view;
}

/**
 * Map a spellcheck language code to the BCP-47 value the WebView2
 * spellchecker expects in `lang=`. Identity for everything except the
 * three single-tag codes we accept (which already match BCP-47).
 * @param {string | null | undefined} code
 * @returns {string}
 */
function spellcheckHtmlLang(code)
{
    if (!code) return "en-US";
    return String(code);
}

/**
 * Push the live spellcheck state onto a view's contentDOM directly.
 * Idempotent — called from buildEditor (initial mount) and from
 * applySpellcheckToAllViews (toggle / language change).
 * @param {EditorView} view
 */
function applySpellcheckAttrs(view)
{
    try
    {
        const dom = view.contentDOM;
        if (!dom) return;
        const s = getSpellcheckState();
        if (s.enabled)
        {
            dom.setAttribute("spellcheck", "true");
            dom.setAttribute("lang", spellcheckHtmlLang(s.language));
        }
        else
        {
            dom.setAttribute("spellcheck", "false");
            dom.removeAttribute("lang");
        }
    }
    catch (_) { /* view detached or DOM not ready */ }
}

/**
 * Track live EditorView instances so settings-modal can reconfigure them
 * when the spellcheck toggle or language changes. For v1 there's one
 * editor at a time per the buildEditor comment, but a Set keeps us honest
 * if that changes.
 * @type {Set<EditorView>}
 */
const activeViews = new Set();

/**
 * Reconfigure every live EditorView's language compartment so the new
 * spellcheck state takes effect immediately. Source-mode views pick up
 * the new `spellcheck` content attribute on the same dispatch. Visual
 * editors in the DOM get the toggle pushed onto their editable fields
 * via the component's `applySpellcheckState` method.
 */
export function applySpellcheckToAllViews()
{
    const enabled = getSpellcheckState().enabled;

    for (const v of activeViews)
    {
        const compartment = /** @type {Compartment|null} */ (
            /** @type {any} */ (v).__mpsLanguageCompartment
        );
        if (!compartment) continue;
        const format = /** @type {any} */ (v).__mpsFormat || "mangaplay";
        const effective = currentEditorMode === "visual" ? "text" : currentEditorMode;
        try
        {
            v.dispatch({ effects: compartment.reconfigure(extensionsForMode(effective, format)) });
        }
        catch (_) { /* view detached; skip */ }

        // Imperative attribute write to defeat WebView2's first-paint
        // latching. The facet would catch up on the next update, but if
        // we're toggling OFF→ON we want squiggles immediately.
        applySpellcheckAttrs(v);
    }

    if (typeof document !== "undefined")
    {
        const visuals = document.querySelectorAll("mps-visual-editor");
        for (const el of visuals)
        {
            const fn = /** @type {any} */ (el).applySpellcheckState;
            if (typeof fn === "function")
            {
                try { fn.call(el, enabled); }
                catch (_) { /* ignore */ }
            }
        }
    }
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
    // Force the linter to schedule against the newly-installed
    // extensions. Without this the lint stays stale (or empty) until the
    // next docChanged — which after Visual round-trips can be seconds
    // away. forceLinting arms CM6's lint timer immediately; the linter's
    // configured 250ms delay still throttles the actual run.
    try { forceLinting(view); }
    catch (_) { /* mode/format has no linter — fine */ }
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
