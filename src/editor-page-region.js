// @ts-check
/**
 * editor-page-region.js — CM6 view plugin that draws a grey border around
 * each `# Page` region (heading + its panels), fold-aware.
 *
 * Three states per region:
 *
 *   - EXPANDED  → heading line gets `cm-mp-page-region-start` (top + sides),
 *                  interior lines get `cm-mp-page-region-mid` (sides only),
 *                  final line gets `cm-mp-page-region-end` (bottom + sides
 *                  + margin-bottom).
 *
 *   - COLLAPSED → the page heading is the only visible line in the region;
 *                  it gets `cm-mp-page-region-collapsed` (all four sides +
 *                  margin-bottom).
 *
 * Fold ranges come from `foldedRanges(state)` — same source `editor-page-
 * fold.js` uses for chevron orientation, so the two plugins stay in lock-
 * step.
 *
 * Page heading detection mirrors `editor-page-fold.js`'s `PAGE_LINE_RE`.
 */

import { RangeSetBuilder } from "@codemirror/state";
import {
    Decoration,
    EditorView,
    ViewPlugin
} from "@codemirror/view";
import { foldedRanges } from "@codemirror/language";

/** Strict page heading — `# Page N` (case-insensitive on `page`). Matches
 *  the canonical form `editor-page-fold.js`'s `foldService` accepts. */
const PAGE_LINE_RE = /^# [Pp][Aa][Gg][Ee]\b/;

const startLine = Decoration.line({ class: "cm-mp-page-region-start" });
const midLine = Decoration.line({ class: "cm-mp-page-region-mid" });
const endLine = Decoration.line({ class: "cm-mp-page-region-end" });
const collapsedLine = Decoration.line({ class: "cm-mp-page-region-collapsed" });

/**
 * Find page heading line numbers in the document.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @returns {number[]}
 */
function pageHeadingLines(state)
{
    /** @type {number[]} */
    const out = [];
    const total = state.doc.lines;
    for (let n = 1; n <= total; n++)
    {
        const line = state.doc.line(n);
        if (PAGE_LINE_RE.test(line.text)) out.push(n);
    }
    return out;
}

/**
 * Is the page beginning at `headingLineNumber` currently folded? Mirrors
 * the probe in `editor-page-fold.js`'s `buildPageDecorations` — a folded
 * range starts at or after the end of the heading line.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {number} headingLineNumber
 * @returns {boolean}
 */
function isPageFolded(state, headingLineNumber)
{
    const line = state.doc.line(headingLineNumber);
    const folded = foldedRanges(state);
    let result = false;
    folded.between(line.from, line.to + 2, (rangeFrom) =>
    {
        if (rangeFrom >= line.to)
        {
            result = true;
            return false;
        }
        return undefined;
    });
    return result;
}

/**
 * Build the page-region decoration set. Decorations are emitted in
 * document order (CM6 requires a non-decreasing `from` sequence) by
 * walking the doc top-to-bottom and emitting whichever class fits each
 * line based on the active page region.
 *
 * @param {EditorView} view
 * @returns {import("@codemirror/state").RangeSet<Decoration>}
 */
function buildRegionDecorations(view)
{
    const builder = new RangeSetBuilder();
    const state = view.state;
    const headings = pageHeadingLines(state);
    if (headings.length === 0) return builder.finish();

    const total = state.doc.lines;

    for (let i = 0; i < headings.length; i++)
    {
        const headLineNum = headings[i];
        const nextHeadLineNum = i + 1 < headings.length ? headings[i + 1] : total + 1;
        const endLineNum = nextHeadLineNum - 1;
        const headLine = state.doc.line(headLineNum);

        if (isPageFolded(state, headLineNum))
        {
            // Only the heading line is visible. Single fully-bordered row.
            builder.add(headLine.from, headLine.from, collapsedLine);
            continue;
        }

        // Expanded — heading is start, interior lines are mid, final line
        // gets end. Single-line region (heading only, no panels yet) gets
        // collapsed treatment too, since "start + end" on one line would
        // need a merged class — collapsed already paints all four sides.
        if (endLineNum === headLineNum)
        {
            builder.add(headLine.from, headLine.from, collapsedLine);
            continue;
        }

        builder.add(headLine.from, headLine.from, startLine);
        for (let n = headLineNum + 1; n < endLineNum; n++)
        {
            const l = state.doc.line(n);
            builder.add(l.from, l.from, midLine);
        }
        const last = state.doc.line(endLineNum);
        builder.add(last.from, last.from, endLine);
    }

    return builder.finish();
}

/**
 * ViewPlugin maintaining the page-region border decorations. Rebuilds on
 * doc, viewport, AND transaction-level changes — fold-state toggles arrive
 * as transactions without `docChanged` set, so we must also re-run when
 * `update.transactions.length > 0`.
 */
const pageRegionPlugin = ViewPlugin.fromClass(
    class
    {
        /** @param {EditorView} view */
        constructor(view)
        {
            this.decorations = buildRegionDecorations(view);
        }

        /** @param {import("@codemirror/view").ViewUpdate} update */
        update(update)
        {
            if (
                update.docChanged
                || update.viewportChanged
                || update.transactions.length > 0
            )
            {
                this.decorations = buildRegionDecorations(update.view);
            }
        }
    },
    {
        decorations: (v) => v.decorations
    }
);

/**
 * Build the page-region extension. Returned as an array so
 * `lang-registry.js` can spread it inline.
 *
 * @returns {import("@codemirror/state").Extension[]}
 */
export function editorPageRegion()
{
    return [pageRegionPlugin];
}
