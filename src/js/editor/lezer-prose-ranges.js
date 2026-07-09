// @ts-check
/**
 * lezer-prose-ranges.js — extract prose-bearing ranges from the Lezer
 * tree of the active CM6 document.
 *
 * The Mangaplay grammar marks structural lines (page headings, panel
 * headings, character cues, scene headings, SFX, transitions, notes,
 * boneyard) with distinct node names so we can SKIP them during
 * spellcheck — typing `INT.` or `BOOM` is not a misspelling.
 *
 * Only the prose-bearing nodes get yielded: `Action`, `Dialogue`,
 * `Parenthetical`, `Centered`, `Lyric`, `TitlePageEntry`.
 */

import { syntaxTree } from "@codemirror/language";

const PROSE_NODE_NAMES = new Set([
    "Action",
    "Dialogue",
    "Parenthetical",
    "Centered",
    "Lyric",
    "TitlePageEntry"
]);

/**
 * Walk the syntax tree and yield the byte ranges of every prose-bearing
 * node, along with the doc text in that range so the caller doesn't have
 * to re-slice.
 * @param {import("@codemirror/state").EditorState} state
 * @returns {Array<{ from: number, to: number, text: string }>}
 */
export function proseRanges(state)
{
    /** @type {Array<{ from: number, to: number, text: string }>} */
    const out = [];

    const tree = syntaxTree(state);
    if (!tree) return out;

    tree.iterate({
        enter(node)
        {
            if (PROSE_NODE_NAMES.has(node.name))
            {
                // Trim leading whitespace from Dialogue / Parenthetical /
                // Centered / Lyric / TitlePageEntry nodes — the parser
                // includes the line's indent (4 or 8 spaces for dialogue)
                // inside the node range, which makes Harper see the
                // whitespace as part of the sentence and produce spurious
                // "leading whitespace" / "unusual spacing" grammar lints
                // pinned to the indent column. Walk forward to the first
                // non-whitespace doc position before yielding.
                const raw = state.doc.sliceString(node.from, node.to);
                let leading = 0;
                while (leading < raw.length
                    && (raw.charCodeAt(leading) === 32 /* space */
                        || raw.charCodeAt(leading) === 9 /* tab */))
                {
                    leading++;
                }
                const from = node.from + leading;
                const to = node.to;
                if (to > from)
                {
                    out.push({
                        from,
                        to,
                        text: raw.slice(leading)
                    });
                }
                // Don't descend — prose-bearing nodes are leaves for our
                // purposes (inline emphasis markers stay inside the range
                // and Harper tolerates them).
                return false;
            }
            return undefined;
        }
    });

    return out;
}
