// @ts-check
/**
 * editor-checks.js — Editor-side grammar checks that the parser does NOT emit.
 *
 * Pure functions. Take a parsed AST (and, for unknownPanelTags, the raw source)
 * and return ParseWarning-shaped objects. The linter merges these with the
 * parser's own warnings into a single Diagnostic stream.
 *
 * Why not in the parser:
 *   The parser is a re-export shim from @fountain-plus/storyboard, shared across
 *   the website, the extension, and the desktop app. These checks are desktop-
 *   editor heuristics — out-of-order numbering and tag-typo correction — that
 *   only make sense as live editing aids.
 */

import { extractTags, classifyTags } from "../../core/parser/tag-classifier.js";

/**
 * @typedef {Object} EditorWarning
 * @property {string} code            - 'EDITOR_PAGE_OUT_OF_ORDER' | 'EDITOR_PANEL_OUT_OF_ORDER' | 'EDITOR_UNKNOWN_PANEL_TAG'
 * @property {Array<string|number>} args
 * @property {number} line            - 0-based line number
 * @property {number} [column]        - 0-based column
 * @property {number} [length]        - Length of offending text
 * @property {'warning' | 'info'} severity
 */

/**
 * Walk ast.pages[] and flag any page whose `baseNumber` is not previous + 1.
 * Ranges (`# Page 1-3`) are treated as starting at baseNumber and "consuming"
 * up through the suffix end (e.g. 1-3 → next expected page is 4).
 *
 * @param {any} ast
 * @returns {EditorWarning[]}
 */
export function sequentialPages(ast)
{
    /** @type {EditorWarning[]} */
    const out = [];
    if (!ast || !Array.isArray(ast.pages)) return out;

    let expected = null;
    for (const page of ast.pages)
    {
        if (typeof page.baseNumber !== "number") continue;
        const actual = page.baseNumber;

        if (expected !== null && actual !== expected)
        {
            out.push({
                code: "EDITOR_PAGE_OUT_OF_ORDER",
                args: [expected, actual],
                line: typeof page.lineNumber === "number" ? page.lineNumber : 0,
                column: 0,
                length: 0,
                severity: "warning"
            });
        }

        // Advance expected. For ranges like "1-3", the suffix may be a number;
        // use the numeric suffix end if present.
        let consumedTo = actual;
        if (page.suffix && /^\d+$/.test(page.suffix))
        {
            const suffixNum = parseInt(page.suffix, 10);
            if (suffixNum > consumedTo) consumedTo = suffixNum;
        }
        expected = consumedTo + 1;
    }

    return out;
}

/**
 * For each page, walk panels[] and flag any panel whose `displayNumber` is not
 * previous + 1. Ranges like `Panel 1-3` advance the cursor to 4.
 *
 * @param {any} ast
 * @returns {EditorWarning[]}
 */
export function sequentialPanels(ast)
{
    /** @type {EditorWarning[]} */
    const out = [];
    if (!ast || !Array.isArray(ast.pages)) return out;

    for (const page of ast.pages)
    {
        if (!Array.isArray(page.panels)) continue;
        let expected = null;
        for (const panel of page.panels)
        {
            const actual = panel.displayNumber;
            if (typeof actual !== "number") continue;

            if (expected !== null && actual !== expected)
            {
                out.push({
                    code: "EDITOR_PANEL_OUT_OF_ORDER",
                    args: [expected, actual],
                    line: typeof panel.lineNumber === "number" ? panel.lineNumber : 0,
                    column: 0,
                    length: 0,
                    severity: "warning"
                });
            }
            expected = actual + 1;
        }
    }

    return out;
}

/**
 * Scan the source for `Panel N [tags]` lines, extract bracketed tags, and run
 * them through classifyTags(). Any tag flagged `unknown-tag` becomes an
 * EDITOR_UNKNOWN_PANEL_TAG warning. The classifier also gives us a "did you
 * mean" suggestion when one is available.
 *
 * We work off the raw source rather than the AST because the AST loses the
 * original tag spelling (it normalises aliases away).
 *
 * @param {any} _ast        - Currently unused; signature kept for symmetry.
 * @param {string} source   - Raw .mangaplay document text.
 * @returns {EditorWarning[]}
 */
export function unknownPanelTags(_ast, source)
{
    /** @type {EditorWarning[]} */
    const out = [];
    if (typeof source !== "string" || source.length === 0) return out;

    const lines = source.split("\n");
    // Detect any line shaped like "Panel N" with bracketed tags after it.
    // We deliberately do not anchor to a strict indent — Convention A and B
    // both produce panel lines we want to check.
    const PANEL_TAG_LINE = /^\s*Panel\s+\d+(?:-\d+)?\s*((?:\s*\[[^\[\]]+\])+)/;

    for (let i = 0; i < lines.length; i++)
    {
        const line = lines[i];
        const m = line.match(PANEL_TAG_LINE);
        if (!m) continue;
        const tagBlock = m[1];

        const tags = extractTags(tagBlock);
        if (tags.length === 0) continue;

        const classified = classifyTags(tags);
        if (!classified || !Array.isArray(classified.warnings)) continue;

        for (const w of classified.warnings)
        {
            if (w.code !== "unknown-tag") continue;
            const offending = w.offendingTag || "";
            // Locate the column of the bracketed offender in the original line
            // (case-insensitive — the classifier upper-cases for matching).
            const idx = offending
                ? line.toUpperCase().indexOf("[" + offending + "]")
                : -1;
            out.push({
                code: "EDITOR_UNKNOWN_PANEL_TAG",
                args: [
                    offending ? `[${offending}]` : "",
                    w.suggestion ? `[${w.suggestion}]` : ""
                ],
                line: i,
                column: idx >= 0 ? idx : 0,
                length: idx >= 0 ? offending.length + 2 : 0,
                severity: "warning"
            });
        }
    }

    return out;
}
