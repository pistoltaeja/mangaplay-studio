// @ts-check
/**
 * mps-editor — CodeMirror 6 editable .mangaplay.md source.
 */

import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, selectAll } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { openContextMenu } from "../components/mps-context-menu.js";
import { editorCut, editorCopy, editorPaste, editorPastePlain } from "./editor-clipboard.js";
import { t } from "../adapters/tauri-i18n.js";
import { formatForFilename, languageExtensionsFor } from "./lang-registry.js";
import { editorSourceTab } from "./editor-source-tab.js";
import { getSpellcheckState, getSpellcheckConfig } from "../spellcheck/spellcheck-state.js";
import { combinedLinter } from "./combined-linter.js";
import { editorPanelTagStyle } from "./editor-panel-tag-style.js";
import { editorBracketMatch } from "./editor-bracket-match.js";
import { forceLinting, forEachDiagnostic } from "@codemirror/lint";
import { registerView, getAllRegisteredViews } from "./focused-view-registry.js";
import { setRelintHook, addIgnore, setAlwaysCorrect, addToPersonalDict } from "../spellcheck/spellcheck-store.js";

// Wire the spellcheck store's relint hook. When a spelling decision mutates
// the store (addIgnore, setAlwaysCorrect, addToPersonalDict, etc.) this
// fires forceLinting on all registered CM6 views so squiggles update
// immediately without waiting for the next keystroke.
setRelintHook(() =>
{
    for (const v of getAllRegisteredViews())
    {
        try { forceLinting(v); }
        catch (_) { /* view detached — skip */ }
    }
});

/**
 * @typedef {"source"|"wysiwyg"|"easy"} EditorMode
 */

/**
 * Module-level current mode. Easy Editor mode lives outside CM entirely; for the
 * CM-resident modes ("source" / "wysiwyg") this drives which extension set the
 * Compartment is reconfigured to. New views built while we're in Source
 * mode honour this so a freshly-opened tab doesn't surface the language
 * extensions only to be stripped a tick later.
 * @type {EditorMode}
 */
let currentEditorMode = "wysiwyg";

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
            indentUnit.of("    "),
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
            // Caret colour lives in default-skins/*/*.css. Because
            // drawSelection() is disabled the native browser caret is what
            // paints — so `caret-color` on `.cm-content` is the effective
            // rule, not `border-left-color` on `.cm-cursor` (which would
            // only matter with drawSelection active).
        ];
        if (format === "mangaplay" || format === "fountain" || format === "superscript")
        {
            ext.push(combinedLinter(getSpellcheckConfig, format));
            // Bring the Page-line + [TAG] colouring into Source mode. Text
            // mode already gets this via lang-registry.js's full extension
            // set; Source mode is otherwise plaintext and would show these
            // tokens uncoloured without the explicit push.
            ext.push(...editorPanelTagStyle());
            // Bracket-match colouring for `()`, `[]`, `{}` — matched top =
            // yellow, matched nested = pink, unmatched = red. Whole-doc
            // scan on every doc/viewport change.
            ext.push(...editorBracketMatch());
        }
        return ext;
    }
    // "wysiwyg" (the default) and "easy" (CM not visible but state survives)
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
        currentEditorMode === "easy" ? "wysiwyg" : currentEditorMode,
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
    // listener in app.js (see routeContextMenu). The registry publishes the
    // focused view onto `window.__mpsActiveEditorView` (mirror-write) so
    // legacy consumers keep working; the router still reads the global.
    registerView(view);
    /** @type {any} */ (window).__mpsBuildEditorMenu = (ev) => buildEditorMenu(view, ev);

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
 * Reconfigure every live EditorView's language compartment so the new
 * spellcheck state takes effect immediately. Source-mode views pick up
 * the new `spellcheck` content attribute on the same dispatch. Visual
 * editors in the DOM get the toggle pushed onto their editable fields
 * via the component's `applySpellcheckState` method.
 *
 * View iteration comes from the focused-view registry so all mounted
 * editors (including future aggregate-mode views) are covered.
 */
export function applySpellcheckToAllViews()
{
    const enabled = getSpellcheckState().enabled;

    for (const v of getAllRegisteredViews())
    {
        const compartment = /** @type {Compartment|null} */ (
            /** @type {any} */ (v).__mpsLanguageCompartment
        );
        if (!compartment) continue;
        const format = /** @type {any} */ (v).__mpsFormat || "mangaplay";
        const effective = currentEditorMode === "easy" ? "wysiwyg" : currentEditorMode;
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
        const visuals = document.querySelectorAll("mps-easy-editor");
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
 * for "easy" — Easy Editor mode unmounts CM, so callers should not invoke
 * this with "easy"; we tolerate it defensively by falling back to the
 * wysiwyg-mode extension set so the buffer stays editable if Easy Editor fails
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
    const effective = mode === "easy" ? "wysiwyg" : mode;
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
 * Build the items list for the editor context menu. When `ev` is provided,
 * checks whether the right-click landed on a spell-suggestion diagnostic; if
 * so, returns a spell-specific menu instead of the default Cut/Copy/Paste set.
 * Normal text right-click is byte-for-byte unchanged when `ev` is absent or
 * the click position covers no spell diagnostic.
 *
 * @param {EditorView} view
 * @param {MouseEvent} [ev]
 * @returns {Array<any>}
 */
function buildEditorMenu(view, ev)
{
    // ── Spell branch ──
    if (ev != null)
    {
        const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
        if (pos != null)
        {
            /** @type {{ d: import("@codemirror/lint").Diagnostic, from: number, to: number } | null} */
            let spellHit = null;
            forEachDiagnostic(view.state, (d, from, to) =>
            {
                if (spellHit) return;   // first match wins
                if (
                    /** @type {any} */ (d).mpsSpellSuggestion &&
                    d.actions && d.actions.length > 0 &&
                    pos >= from && pos <= to
                )
                {
                    spellHit = { d, from, to };
                }
            });

            if (spellHit)
            {
                const { d, from, to } = spellHit;
                const flagged = view.state.doc.sliceString(from, to);
                const suggestion = d.actions[0].name;
                return [
                    { kind: "header", label: t("mangaplay-studio.menu.editor.spell.didYouMean") },
                    { id: "spell-fix",    label: suggestion, onSelect: () => { d.actions[0].apply(view, from, to); } },
                    { kind: "divider" },
                    { id: "spell-ignore", label: t("mangaplay-studio.menu.editor.spell.ignoreAll"),                                  onSelect: () => { addIgnore(flagged); } },
                    { id: "spell-always", label: t("mangaplay-studio.menu.editor.spell.alwaysCorrectTo", { word: suggestion }),      onSelect: () => { setAlwaysCorrect(flagged, suggestion); } },
                    { id: "spell-dict",   label: t("mangaplay-studio.menu.editor.spell.addToDictionary"),                            onSelect: () => { addToPersonalDict(flagged); } },
                ];
            }
        }
    }

    // ── Default Cut / Copy / Paste / Select-All menu ──
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
