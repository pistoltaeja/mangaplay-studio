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

import { linter } from "@codemirror/lint";
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
 * Two visual categories:
 *   - red squiggle (`cm-mp-error`): objective errors that break the document
 *   - orange dotted (`cm-mp-style`): case/style nits where the parser still understands
 *
 * @type {Record<string, { severity: "error"|"warning"|"info", markClass: string, messageKey: string }>}
 */
const CODE_META = {
    // Parser warnings — case/style (orange dotted)
    WARN_PAGE_LOWERCASE:      { severity: "info",    markClass: "cm-mp-style", messageKey: "ui.warnings.pageLowercase" },
    WARN_ACTION_INDENTED:     { severity: "info",    markClass: "cm-mp-style", messageKey: "ui.warnings.actionIndented" },
    WARN_LEGACY_PANEL:        { severity: "info",    markClass: "cm-mp-style", messageKey: "ui.warnings.legacyPanel" },
    WARN_RESERVED_MARKER:     { severity: "info",    markClass: "cm-mp-style", messageKey: "ui.warnings.reservedMarker" },
    WARN_IMPLICIT_PAGE_1:     { severity: "info",    markClass: "cm-mp-style", messageKey: "ui.warnings.implicitPage1" },
    WARN_MIXED_INDENTATION:   { severity: "info",    markClass: "cm-mp-style", messageKey: "ui.warnings.mixedIndentation" },

    // Parser warnings — structural (red squiggle)
    WARN_PAGE_MISSING_HASH:   { severity: "warning", markClass: "cm-mp-error", messageKey: "ui.warnings.pageMissingHash" },
    WARN_BONEYARD_UNTERMINATED: { severity: "error", markClass: "cm-mp-error", messageKey: "ui.warnings.boneyardUnterminated" },

    // Editor-side checks — all structural (red squiggle)
    EDITOR_PAGE_OUT_OF_ORDER:  { severity: "warning", markClass: "cm-mp-error", messageKey: "ui.warnings.pageOutOfOrder" },
    EDITOR_PANEL_OUT_OF_ORDER: { severity: "warning", markClass: "cm-mp-error", messageKey: "ui.warnings.panelOutOfOrder" },
    EDITOR_UNKNOWN_PANEL_TAG:  { severity: "warning", markClass: "cm-mp-error", messageKey: "ui.warnings.unknownPanelTag" }
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
 * Build the CM6 linter() extension for .mangaplay editors.
 * @returns {import("@codemirror/state").Extension}
 */
export function editorLinter()
{
    return linter(
        (view) =>
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

            for (const w of allWarnings)
            {
                const meta = CODE_META[w.code];
                if (!meta) continue;

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
                    markClass: meta.markClass,
                    source: "mangaplay"
                });
            }

            return diagnostics;
        },
        {
            delay: 250,
            hoverTime: 300
        }
    );
}
