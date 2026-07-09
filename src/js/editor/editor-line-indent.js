// @ts-check
/**
 * editor-line-indent.js — CM6 view plugin that paints whole-line padding-left
 * on character cue lines and dialogue body lines.
 *
 * Detection is regex-based on raw line text (mirrors `editor-typing-autos.js`
 * and `editor-checks.js` — the Lezer grammar token tree is overkill for a
 * cosmetic per-line decoration). The contract:
 *
 *   - Character cue:  line begins with `    ` (4 spaces) AND the trimmed
 *                     remainder is all-caps (ASCII upper / digits / punct
 *                     / spaces). Class `cm-mp-line-cue` → 2.5em padding.
 *   - Dialogue body:  line begins with `    ` (4 spaces) AND the trimmed
 *                     remainder is NOT all-caps and NOT a parenthetical.
 *                     Class `cm-mp-line-dialogue` → 1.5em padding.
 *
 * Parentheticals (`    (whisper)`) and blank indented lines fall through
 * with no decoration — they sit at the default `.cm-content` padded edge.
 *
 * Indent is measured from `.cm-content`'s padded left edge; the CSS is
 * appended to the `EditorView.theme` block in `mangaplay-highlight.js`.
 */

import { RangeSetBuilder } from "@codemirror/state";
import {
    Decoration,
    EditorView,
    ViewPlugin
} from "@codemirror/view";

/** Cue line — 4-space indent followed by all-uppercase text (with optional
 *  digits, spaces, and a small set of punctuation). */
const CUE_LINE_RE = /^ {4}[A-Z][A-Z0-9 .,'\-()&!?]*$/;

/** Parenthetical — 4-space indent followed by `(...)`. Excluded from the
 *  dialogue-body class so the open paren doesn't shift. */
const PAREN_LINE_RE = /^ {4}\(/;

/** Dialogue body — 4-space indent, non-empty content that is NOT all-caps
 *  and NOT a parenthetical. Captured by the negative check in build(). */
const INDENTED_LINE_RE = /^ {4}\S/;

const cueLine = Decoration.line({ class: "cm-mp-line-cue" });
const dialogueLine = Decoration.line({ class: "cm-mp-line-dialogue" });

/**
 * Walk visible lines, classify each indented line, emit a `Decoration.line`
 * with the cue/dialogue class.
 *
 * @param {EditorView} view
 * @returns {import("@codemirror/state").RangeSet<Decoration>}
 */
function buildIndentDecorations(view)
{
    const builder = new RangeSetBuilder();
    const state = view.state;

    for (const { from, to } of view.visibleRanges)
    {
        let pos = from;
        while (pos <= to)
        {
            const line = state.doc.lineAt(pos);
            const text = line.text;
            if (INDENTED_LINE_RE.test(text) && !PAREN_LINE_RE.test(text))
            {
                if (CUE_LINE_RE.test(text))
                {
                    builder.add(line.from, line.from, cueLine);
                }
                else
                {
                    builder.add(line.from, line.from, dialogueLine);
                }
            }
            pos = line.to + 1;
            if (line.to >= state.doc.length) break;
        }
    }
    return builder.finish();
}

/**
 * ViewPlugin maintaining the per-line indent decorations. Rebuilds on doc
 * changes and viewport changes — cue/dialogue classification depends on the
 * full line text so any edit may flip the class.
 */
const lineIndentPlugin = ViewPlugin.fromClass(
    class
    {
        /** @param {EditorView} view */
        constructor(view)
        {
            this.decorations = buildIndentDecorations(view);
        }

        /** @param {import("@codemirror/view").ViewUpdate} update */
        update(update)
        {
            if (update.docChanged || update.viewportChanged)
            {
                this.decorations = buildIndentDecorations(update.view);
            }
        }
    },
    {
        decorations: (v) => v.decorations
    }
);

/**
 * Build the indent extension. Returned as an array so `lang-registry.js` can
 * spread it inline next to the other language extensions.
 *
 * @returns {import("@codemirror/state").Extension[]}
 */
export function editorLineIndent()
{
    return [lineIndentPlugin];
}
