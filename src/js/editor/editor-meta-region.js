// @ts-check
/**
 * editor-meta-region.js — CM6 view plugin that draws a grey border around
 * the title-page metadata block at the top of a `.mangaplay` document.
 *
 * The metadata block is every line from the start of the doc up to (but not
 * including) the first blank line OR the first `# Page` heading, whichever
 * comes first. A line counts as a title-page entry when it matches the
 * tokenizer's `Key: Value` form: `/^[A-Za-z][A-Za-z0-9_-]*:/`.
 *
 * Three line-decoration classes mirror `editor-page-region.js`:
 *
 *   - `cm-mp-meta-region-start`     → first line (top + sides)
 *   - `cm-mp-meta-region-mid`       → interior lines (sides only)
 *   - `cm-mp-meta-region-end`       → final line (bottom + sides + margin)
 *   - `cm-mp-meta-region-collapsed` → single-line block (all four sides)
 *
 * If the first non-blank line is already a page heading or fails the
 * `Key:` regex, the plugin emits nothing — there's no metadata to wrap.
 */

import { RangeSetBuilder } from "@codemirror/state";
import {
    Decoration,
    EditorView,
    ViewPlugin
} from "@codemirror/view";
import { PAGE_LINE_RE } from "./editor-line-regexes.js";

/** Title-page entry line — mirrors the tokenizer's `Key:` recognition. */
const META_LINE_RE = /^[A-Za-z][A-Za-z0-9_-]*:/;

const startLine = Decoration.line({ class: "cm-mp-meta-region-start" });
const midLine = Decoration.line({ class: "cm-mp-meta-region-mid" });
const endLine = Decoration.line({ class: "cm-mp-meta-region-end" });
const collapsedLine = Decoration.line({ class: "cm-mp-meta-region-collapsed" });
/** Inter-card gutter after the meta-region — same 14px treatment as the
 *  inter-page gutter so the gap between `Title:` card and the first
 *  `# Page` card has identical spacing + unselectable / unclickable
 *  semantics. Reuses the page-region gutter class so a single CSS rule
 *  + a single mousedown-interceptor predicate cover both surfaces. */
const gutterLine = Decoration.line({ class: "cm-mp-page-region-gutter" });

/**
 * Compute the inclusive line-number range `[from, to]` covering the
 * metadata block, or `null` if no metadata exists.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @returns {{from: number, to: number} | null}
 */
function metaRange(state)
{
    const total = state.doc.lines;
    if (total === 0) return null;

    // Skip leading blank lines to find the first non-blank line.
    let first = 1;
    while (first <= total && state.doc.line(first).text.trim() === "")
    {
        first++;
    }
    if (first > total) return null;

    const firstLine = state.doc.line(first);
    if (PAGE_LINE_RE.test(firstLine.text)) return null;
    if (!META_LINE_RE.test(firstLine.text)) return null;

    // Walk forward until blank or page line.
    let last = first;
    for (let n = first + 1; n <= total; n++)
    {
        const text = state.doc.line(n).text;
        if (text.trim() === "") break;
        if (PAGE_LINE_RE.test(text)) break;
        last = n;
    }

    return { from: first, to: last };
}

/**
 * Build the meta-region decoration set.
 *
 * @param {EditorView} view
 * @returns {import("@codemirror/state").RangeSet<Decoration>}
 */
function buildMetaDecorations(view)
{
    const builder = new RangeSetBuilder();
    const state = view.state;
    const range = metaRange(state);
    if (!range) return builder.finish();

    // Count trailing blanks immediately after the meta range. Mirrors
    // the page-region semantics: every trailing blank beyond the first
    // is promoted into the card body so the user can keep pressing
    // Enter to grow the meta card. Only the final blank serves as the
    // inter-card gutter.
    const total = state.doc.lines;
    let trailingBlanks = 0;
    while (range.to + 1 + trailingBlanks <= total
        && state.doc.line(range.to + 1 + trailingBlanks).text.trim() === "")
    {
        trailingBlanks++;
    }
    const cardEnd = trailingBlanks >= 2
        ? range.to + (trailingBlanks - 1)
        : range.to;

    if (range.from === cardEnd)
    {
        const l = state.doc.line(range.from);
        builder.add(l.from, l.from, collapsedLine);
    }
    else
    {
        const startL = state.doc.line(range.from);
        builder.add(startL.from, startL.from, startLine);
        for (let n = range.from + 1; n < cardEnd; n++)
        {
            const l = state.doc.line(n);
            builder.add(l.from, l.from, midLine);
        }
        const endL = state.doc.line(cardEnd);
        builder.add(endL.from, endL.from, endLine);
    }

    // Emit a single gutter line so the space between the meta card and
    // the first `# Page` matches the inter-page gutter. The gutter row
    // is the FIRST blank when there's only one (card stays small), or
    // the SECOND blank when extension is in effect (cardEnd took the
    // first).
    if (trailingBlanks >= 1)
    {
        const gutterL = state.doc.line(cardEnd + 1);
        builder.add(gutterL.from, gutterL.from, gutterLine);
    }

    return builder.finish();
}

/**
 * Return the doc line number that the meta-region paints as its trailing
 * gutter, or null if none. The mousedown interceptor in
 * `editor-page-region.js` consults this so clicks on the meta→page gap
 * route past the gutter exactly like clicks on inter-page gaps.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @returns {number|null}
 */
export function metaGutterLine(state)
{
    const range = metaRange(state);
    if (!range) return null;
    const total = state.doc.lines;
    // Mirror buildMetaDecorations: all but the last trailing blank are
    // promoted into the card. The final blank is the gutter.
    let trailingBlanks = 0;
    while (range.to + 1 + trailingBlanks <= total
        && state.doc.line(range.to + 1 + trailingBlanks).text.trim() === "")
    {
        trailingBlanks++;
    }
    if (trailingBlanks < 1) return null;
    const cardEnd = trailingBlanks >= 2
        ? range.to + (trailingBlanks - 1)
        : range.to;
    return cardEnd + 1;
}

/**
 * ViewPlugin maintaining the meta-region border decorations. Rebuilds on
 * any doc / viewport / transaction-level change for parity with the
 * page-region plugin.
 */
const metaRegionPlugin = ViewPlugin.fromClass(
    class
    {
        /** @param {EditorView} view */
        constructor(view)
        {
            this.decorations = buildMetaDecorations(view);
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
                this.decorations = buildMetaDecorations(update.view);
            }
        }
    },
    {
        decorations: (v) => v.decorations
    }
);

/**
 * Build the meta-region extension. Returned as an array so
 * `lang-registry.js` can spread it inline.
 *
 * @returns {import("@codemirror/state").Extension[]}
 */
export function editorMetaRegion()
{
    return [metaRegionPlugin];
}
