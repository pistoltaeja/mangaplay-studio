// @ts-check
/**
 * lezer-prose-ranges.js — extract prose-bearing ranges from the Lezer
 * tree of the active CM6 document.
 *
 * This is the first filter in the spellcheck pipeline. It decides WHICH
 * parts of the document reach the grammar checker (Harper) by walking
 * the Lezer syntax tree and yielding only the node types that contain
 * user-written prose.
 *
 * Adding / removing linted node types
 * ------------------------------------
 * Edit PROSE_NODE_NAMES below. Nodes NOT in this set are silently
 * skipped — their text never reaches Harper. This is how structural
 * screenplay elements (page headings, panel headings, character cues,
 * scene slugs, SFX lines, transitions, notes, boneyard) are excluded
 * from grammar checking. If the Lezer grammar adds a new structural
 * node type, it is automatically excluded (safe default). If it adds
 * a new prose-bearing node type, add it to the set or its text won't
 * be checked.
 *
 * Leading-whitespace trimming
 * ----------------------------
 * Dialogue / Parenthetical nodes include the line's 4- or 8-space
 * indent in their Lezer range. Without trimming, Harper sees leading
 * whitespace and produces spurious "unusual spacing" lints. The walker
 * strips leading spaces/tabs before yielding each range.
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
