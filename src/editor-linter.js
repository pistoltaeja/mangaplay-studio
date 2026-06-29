// @ts-check
/**
 * editor-linter.js — CM6 `linter()` source for .mangaplay documents.
 *
 * Parses the active document, merges parser warnings with three editor-side
 * checks (sequential pages, sequential panels, unknown panel tags), and
 * returns CM6 Diagnostic[] for the lint extension to render as squiggle
 * underlines + hover tooltips.
 *
 * Debounce is 250ms via CM6's built-in `delay` option on linter(). Hover
 * tooltip delay overridden to 300ms (CM6 default 600ms is too slow vs VS Code).
 */

import { parseScript } from "../../core/parser/fountain-plus-mangaplay-parser.js";
import {
    sequentialPages,
    sequentialPanels,
    unknownPanelTags
} from "./editor-checks.js";
import { resolveDiagnosticMessage } from "../../core/validation/diagnostic-i18n.js";
import { t } from "./adapters/tauri-i18n.js";

/**
 * Map WARN_ / EDITOR_ codes to { severity, markClass, messageKey }.
 *
 * Three visual categories:
 *   - red squiggle (`cm-mp-error`): objective errors that break the document
 *   - orange dotted (`cm-mp-style`): case/style nits where the parser still understands
 *   - green squiggle (`cm-mp-hint`): canonical-form hints (lowest priority)
 *
 * @type {Record<string, { severity: "error"|"warning"|"info", markClass: string, messageKey: string }>}
 */
export const CODE_META = {
    // Parser warnings — case/style (orange dotted)
    WARN_PAGE_LOWERCASE:      { severity: "info",    markClass: "cm-mp-hint",  messageKey: "ui.warnings.pageCamelCase" },
    WARN_PAGE_UPPERCASE:      { severity: "info",    markClass: "cm-mp-hint",  messageKey: "ui.warnings.pageCamelCase" },
    WARN_PANEL_CASE:          { severity: "info",    markClass: "cm-mp-hint",  messageKey: "ui.warnings.panelCamelCase" },
    WARN_ACTION_INDENTED:     { severity: "info",    markClass: "cm-mp-style", messageKey: "ui.warnings.actionIndented" },
    WARN_LEGACY_PANEL:        { severity: "info",    markClass: "cm-mp-style", messageKey: "ui.warnings.legacyPanel" },
    WARN_RESERVED_MARKER:     { severity: "info",    markClass: "cm-mp-style", messageKey: "ui.warnings.reservedMarker" },
    WARN_IMPLICIT_PAGE_1:     { severity: "info",    markClass: "cm-mp-style", messageKey: "ui.warnings.implicitPage1" },
    WARN_MIXED_INDENTATION:   { severity: "info",    markClass: "cm-mp-style", messageKey: "ui.warnings.mixedIndentation" },

    // Parser warnings — structural (red squiggle)
    WARN_PAGE_MISSING_HASH:   { severity: "warning", markClass: "cm-mp-error", messageKey: "ui.warnings.pageMissingHash" },
    WARN_PAGE_SUFFIX_INVALID: { severity: "warning", markClass: "cm-mp-error", messageKey: "ui.warnings.pageSuffixInvalid" },
    WARN_BONEYARD_UNTERMINATED: { severity: "error", markClass: "cm-mp-error", messageKey: "ui.warnings.boneyardUnterminated" },

    // Editor-side checks — all structural (red squiggle)
    EDITOR_PAGE_OUT_OF_ORDER:  { severity: "warning", markClass: "cm-mp-error", messageKey: "ui.warnings.pageOutOfOrder" },
    EDITOR_PANEL_OUT_OF_ORDER: { severity: "warning", markClass: "cm-mp-error", messageKey: "ui.warnings.panelOutOfOrder" },
    // Duplicate detection — same shape as out-of-order but with a
    // distinct message and NO [Change] quick-fix action (the linter's
    // action builder gates on the _OUT_OF_ORDER codes).
    EDITOR_PAGE_DUPLICATE:     { severity: "warning", markClass: "cm-mp-error", messageKey: "ui.warnings.pageDuplicate" },
    EDITOR_PANEL_DUPLICATE:    { severity: "warning", markClass: "cm-mp-error", messageKey: "ui.warnings.panelDuplicate" },
    EDITOR_UNKNOWN_PANEL_TAG:  { severity: "warning", markClass: "cm-mp-error", messageKey: "ui.warnings.unknownPanelTag" },
    EDITOR_CHARACTER_CASE:     { severity: "warning", markClass: "cm-mp-error", messageKey: "ui.warnings.characterCase" }
};

/**
 * Convert a positional `args` array (e.g. ["1", "page"]) into a params object
 * keyed `{0}`, `{1}`, etc. — matches the format used in en.json templates.
 *
 * @param {Array<string|number> | undefined} args
 * @returns {Record<string, string|number>}
 */
function argsToParams(args)
{
    /** @type {Record<string, string|number>} */
    const params = {};
    if (!Array.isArray(args)) return params;
    for (let i = 0; i < args.length; i++)
    {
        params[String(i)] = args[i];
    }
    return params;
}

/**
 * Translate a `ui.warnings.*` style key.
 * Both `t()` and the diagnostic-i18n resolver agree on `{0}/{1}` placeholders.
 *
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function translate(key, fallback)
{
    try
    {
        return t(key, fallback);
    }
    catch
    {
        return fallback;
    }
}

/**
 * Convert a (line, column, length) triple from the parser into CM6 `from`/`to`
 * absolute offsets. Falls back to whole-line range if column/length absent.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {{ line: number, column?: number, length?: number }} loc
 * @returns {{ from: number, to: number }}
 */
function locToRange(state, loc)
{
    const lineNumber = Math.max(1, Math.min((loc.line || 0) + 1, state.doc.lines));
    const line = state.doc.line(lineNumber);
    const colStart = typeof loc.column === "number" && loc.column >= 0 ? loc.column : 0;
    const length = typeof loc.length === "number" && loc.length > 0 ? loc.length : 0;
    const from = Math.min(line.from + colStart, line.to);
    let to = length > 0 ? Math.min(from + length, line.to) : line.to;
    // Empty ranges don't render; expand to at least one character.
    if (to <= from) to = Math.min(from + 1, line.to);
    if (to <= from) to = Math.min(line.to, line.from + 1);
    return { from, to };
}

/**
 * Run the parser linter synchronously against a CM6 view and return the
 * Diagnostic[] directly. Split out of `editorLinter()` so combined-linter.js
 * can merge these with spellcheck diagnostics inside a single CM6 lint
 * source — see TODO/lint-regression-investigation.md for the regression
 * this avoids (CM6's `batchResults` dropping the parser source when
 * spellcheck's async callback hung past its budget).
 *
 * @param {import("@codemirror/view").EditorView} view
 * @param {string} [format] - Document format hint. Case-hint warnings only fire for "mangaplay".
 * @returns {import("@codemirror/lint").Diagnostic[]}
 */
export function runParserLinter(view, format = "mangaplay")
{
    const source = view.state.doc.toString();
    /** @type {import("@codemirror/lint").Diagnostic[]} */
    const diagnostics = [];

    let ast;
    try
    {
        ast = parseScript(source);
    }
    catch
    {
        return diagnostics;
    }

    /** @type {any[]} */
    const allWarnings = [];
    if (ast && Array.isArray(ast.warnings))
    {
        for (const w of ast.warnings) allWarnings.push(w);
    }
    for (const w of sequentialPages(ast))   allWarnings.push(w);
    for (const w of sequentialPanels(ast))  allWarnings.push(w);
    for (const w of unknownPanelTags(ast, source)) allWarnings.push(w);

    const CASE_HINT_CODES = new Set([
        "WARN_PAGE_LOWERCASE",
        "WARN_PAGE_UPPERCASE",
        "WARN_PANEL_CASE"
    ]);

    for (const w of allWarnings)
    {
        const meta = CODE_META[w.code];
        if (!meta) continue;

        // Case hints are mangaplay-specific. Fountain / SuperScript / general
        // text documents should not see them.
        if (format !== "mangaplay" && CASE_HINT_CODES.has(w.code)) continue;

        const params = argsToParams(w.args);
        const message = resolveDiagnosticMessage(
            {
                messageKey: meta.messageKey,
                message: w.message || w.code,
                messageParams: params
            },
            translate
        );

        const { from, to } = locToRange(view.state, w);

        diagnostics.push({
            from,
            to,
            severity: meta.severity,
            message,
            markClass: meta.markClass
            // Source tag (Mangaplay / Fountain / Superscript) hidden by
            // request — re-enable by uncommenting the line below. The
            // associated CSS (.cm-diagnosticSource in app.css) is left in
            // place so the tag renders correctly when restored.
            // source: "mangaplay"
        });

        const actions = buildCaseHintAction(w) || buildSequentialAction(w);
        if (actions)
        {
            diagnostics[diagnostics.length - 1].actions = actions;
        }
    }

    return diagnostics;
}

/**
 * Build the [Change] quick-fix action for a case-hint warning. Each of
 * the three case-hint codes has a canonical replacement: `Page` for the
 * page warnings, `Panel` for the panel one. The replacement spans
 * exactly the squiggle range (from..to derived from line/column/length).
 *
 * @param {any} warning   Parser warning record.
 * @returns {import("@codemirror/lint").Action[] | null}
 */
function buildCaseHintAction(warning)
{
    let replacement = null;
    if (warning.code === "WARN_PAGE_LOWERCASE" || warning.code === "WARN_PAGE_UPPERCASE")
    {
        replacement = "Page";
    }
    else if (warning.code === "WARN_PANEL_CASE")
    {
        replacement = "Panel";
    }
    if (replacement === null) return null;
    const label = translate("ui.warnings.changeAction", "Change");
    return [{
        name: label,
        apply(v, aFrom, aTo)
        {
            v.dispatch({ changes: { from: aFrom, to: aTo, insert: replacement } });
        }
    }];
}

/**
 * Build the [Change] quick-fix action for EDITOR_PAGE_OUT_OF_ORDER and
 * EDITOR_PANEL_OUT_OF_ORDER. Rewrites the bad id token on the warning line
 * with the expected number (warning.args[0]). The action range spans the
 * whole line; the apply callback scopes the rewrite to just the id token so
 * trailing scene-heading / label text is preserved.
 *
 * @param {any} warning
 * @returns {import("@codemirror/lint").Action[] | null}
 */
function buildSequentialAction(warning)
{
    const isPage = warning.code === "EDITOR_PAGE_OUT_OF_ORDER";
    const isPanel = warning.code === "EDITOR_PANEL_OUT_OF_ORDER";
    if (!isPage && !isPanel) return null;
    const expected = warning.args?.[0];
    if (expected === undefined || expected === null) return null;
    const label = translate("ui.warnings.changeAction", "Change");
    // Match `# Page <id>` or `Panel <id>` (id = digits + optional -suffix).
    const tokenRe = isPage
        ? /(^#\s+page\s+)(\d+(?:-(?:\d+|[IVXLCDM]+|[A-Z]))?)/i
        : /((?:^|\s)panel\s+)(\d+(?:-\d+)?)/i;
    return [{
        name: label,
        apply(v, aFrom, aTo)
        {
            const lineText = v.state.doc.sliceString(aFrom, aTo);
            const m = lineText.match(tokenRe);
            if (!m) return;
            // Index of the id token (group 2) within lineText.
            const idx = (m.index ?? 0) + m[1].length;
            const tokenFrom = aFrom + idx;
            const tokenTo = tokenFrom + m[2].length;
            v.dispatch({ changes: { from: tokenFrom, to: tokenTo, insert: String(expected) } });
        }
    }];
}

// Test-only hook: lets the CDP smoke harness probe diagnostics + action list
// without needing dynamic imports inside the bundled WebView context.
if (typeof globalThis !== "undefined")
{
    /** @type {any} */ (globalThis).__mpsRunParserLinter = runParserLinter;
}
