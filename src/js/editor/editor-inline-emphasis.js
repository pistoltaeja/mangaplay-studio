// @ts-check
/**
 * editor-inline-emphasis.js — CM6 ViewPlugin that hides Fountain-style
 * emphasis markers (`*`, `**`, `***`, `_`) and paints their content with
 * bold / italic / underline classes.
 *
 * Runs for BOTH the Fountain and Mangaplay branches of `lang-registry.js`
 * — the marker syntax and semantics are identical across the two formats,
 * per https://fountain.io/syntax/#emphasis.
 *
 * Gated to prose-bearing Lezer nodes via `lezer-prose-ranges.js`:
 *   Action / Dialogue / Parenthetical / Centered / Lyric.
 *
 * NOT applied inside: scene headings, transitions, character cues,
 * page/panel headings, notes, boneyards, title-page entries, sections,
 * synopses.
 *
 * Caret reveal: when the primary selection overlaps a marker span, the
 * markers on THAT emphasis run become visible (dimmed) instead of hidden
 * — the user can still see where `**` opens/closes when the caret is on
 * the run. Everything else stays hidden.
 *
 * The scanner mirrors the algorithm in `parseEmphasis()` in
 * `Fountain-Plus/Storyboard/core/parser/fountain-plus-mangaplay-parser.js`
 * — same marker priority (`***` > `**` > `*`), same `\*` / `\_`
 * escape handling, same nesting — but tracks absolute doc positions
 * instead of emitting cleaned text. `parseEmphasis()` itself can't be
 * used directly here because its output spans have escape backslashes
 * stripped, so the returned lengths don't line up with source positions.
 *
 * If two emphasis kinds nest (e.g. `_**bold underline**_`), each layer
 * emits its own `Decoration.mark` covering the same inner range — CM6
 * merges the classes so a single DOM span carries both.
 */

import { RangeSetBuilder } from "@codemirror/state";
import {
    Decoration,
    EditorView,
    ViewPlugin,
    WidgetType
} from "@codemirror/view";
import { proseRanges } from "./lezer-prose-ranges.js";

// TitlePageEntry values pass through the emphasis painter — user-accepted
// trade-off (title-page values are almost never emphasised).

const boldMark = Decoration.mark({ class: "cm-mp-bold" });
const italicMark = Decoration.mark({ class: "cm-mp-italic" });
const underlineMark = Decoration.mark({ class: "cm-mp-underline" });

/**
 * Marker widget — replaces the raw `*` / `**` / `***` / `_` characters
 * with a zero-width span. `fontSize: 0` is used rather than
 * `display: none` because `display: none` on inline widgets causes CM6
 * caret jumps when the user arrows past the collapsed region.
 */
class MarkerWidget extends WidgetType
{
    /** @param {string} raw the marker text ("*", "**", "***", "_") */
    constructor(raw)
    {
        super();
        this.raw = raw;
    }

    /** @param {MarkerWidget} other */
    eq(other)
    {
        return other.raw === this.raw;
    }

    toDOM()
    {
        const span = document.createElement("span");
        span.className = "cm-mp-emph-marker-hidden";
        span.textContent = this.raw;
        return span;
    }

    ignoreEvent()
    {
        return true;
    }
}

/**
 * @typedef {Object} EmphasisRange
 * @property {number} openFrom absolute doc start of the opening marker
 * @property {number} openTo absolute doc end of the opening marker (== inner start)
 * @property {number} closeFrom absolute doc start of the closing marker (== inner end)
 * @property {number} closeTo absolute doc end of the closing marker
 * @property {"italic"|"bold"|"bold-italic"|"underline"} kind
 */

/**
 * Find the next unescaped occurrence of `marker` in `text` starting at
 * `start`. An occurrence is "unescaped" when the number of consecutive
 * backslashes immediately preceding it is even (they pair off as `\\`);
 * an odd count means the marker is escaped.
 *
 * Mirrors `findUnescapedMarker()` in `parseEmphasis()`
 * (`Fountain-Plus/Storyboard/core/parser/fountain-plus-mangaplay-parser.js`)
 * so the editor and PDF exporter agree on marker structure.
 *
 * @param {string} text
 * @param {string} marker
 * @param {number} start
 * @returns {number}
 */
function findUnescapedMarker(text, marker, start)
{
    let from = start;
    while (from < text.length)
    {
        const idx = text.indexOf(marker, from);
        if (idx === -1) return -1;
        let bs = 0;
        let k = idx - 1;
        while (k >= 0 && text[k] === "\\") { bs++; k--; }
        if ((bs & 1) === 0) return idx;
        from = idx + 1;
    }
    return -1;
}

/**
 * Recursively scan `text` for emphasis runs and push {@link EmphasisRange}s
 * into `out`. Positions are RELATIVE to `text`; the caller adds the base
 * offset when emitting decorations.
 *
 * Marker priority mirrors `parseEmphasis()`: `***` > `**` > `*`, and `_`
 * is orthogonal. Escapes (`\*`, `\_`, `\\`) suppress marker detection.
 *
 * @param {string} text
 * @param {number} startInText
 * @param {number} endInText exclusive
 * @param {EmphasisRange[]} out
 */
function scanEmphasis(text, startInText, endInText, out)
{
    let i = startInText;
    while (i < endInText)
    {
        const ch = text[i];
        if (ch === "\\" && i + 1 < endInText)
        {
            i += 2;
            continue;
        }

        // *** … *** (bold-italic)
        if (text.substr(i, 3) === "***")
        {
            const end = findUnescapedMarker(text, "***", i + 3);
            if (end !== -1 && end < endInText)
            {
                out.push({
                    openFrom: i,
                    openTo: i + 3,
                    closeFrom: end,
                    closeTo: end + 3,
                    kind: "bold-italic"
                });
                // Descend into the inner content so nested `_underline_`
                // still gets styled.
                scanEmphasis(text, i + 3, end, out);
                i = end + 3;
                continue;
            }
        }
        // ** … ** (bold)
        if (text.substr(i, 2) === "**")
        {
            const end = findUnescapedMarker(text, "**", i + 2);
            if (end !== -1 && end < endInText)
            {
                out.push({
                    openFrom: i,
                    openTo: i + 2,
                    closeFrom: end,
                    closeTo: end + 2,
                    kind: "bold"
                });
                scanEmphasis(text, i + 2, end, out);
                i = end + 2;
                continue;
            }
        }
        // * … * (italic). Require non-empty inner run.
        if (ch === "*")
        {
            const end = findUnescapedMarker(text, "*", i + 1);
            if (end !== -1 && end > i + 1 && end < endInText)
            {
                out.push({
                    openFrom: i,
                    openTo: i + 1,
                    closeFrom: end,
                    closeTo: end + 1,
                    kind: "italic"
                });
                scanEmphasis(text, i + 1, end, out);
                i = end + 1;
                continue;
            }
        }
        // _ … _ (underline). Require non-empty inner run.
        if (ch === "_")
        {
            const end = findUnescapedMarker(text, "_", i + 1);
            if (end !== -1 && end > i + 1 && end < endInText)
            {
                out.push({
                    openFrom: i,
                    openTo: i + 1,
                    closeFrom: end,
                    closeTo: end + 1,
                    kind: "underline"
                });
                scanEmphasis(text, i + 1, end, out);
                i = end + 1;
                continue;
            }
        }
        i++;
    }
}

/**
 * @typedef {Object} DecoEmit
 * @property {number} from
 * @property {number} to
 * @property {Decoration} deco
 * @property {number} priority `0` for `Decoration.mark`, `1` for widget/replace
 *   — used ONLY as a tie-breaker when two ranges share `from`. CM6 requires
 *   widget/replace decorations at the same start to sort before marks.
 */

/**
 * Build the decoration set for the visible ranges. Walks prose nodes,
 * runs the emphasis scanner on each, and emits marker-replace + style-mark
 * decorations.
 *
 * @param {EditorView} view
 * @returns {import("@codemirror/state").RangeSet<Decoration>}
 */
function buildDecorations(view)
{
    /** @type {DecoEmit[]} */
    const emits = [];
    const state = view.state;
    const nodes = proseRanges(state);
    if (nodes.length === 0)
    {
        return Decoration.none;
    }

    // Which byte ranges are inside the current viewport? Skip anything
    // else — CM6 warns if we return decorations outside visible ranges.
    const visible = view.visibleRanges;

    // Selection ranges — used to decide whether markers on a given run
    // should be revealed instead of hidden.
    const selRanges = state.selection.ranges;

    /**
     * @param {number} from
     * @param {number} to
     * @returns {boolean}
     */
    function overlapsSelection(from, to)
    {
        for (const r of selRanges)
        {
            // Reveal when caret is INSIDE the run or touching either
            // marker boundary. `r.from <= to && r.to >= from` covers
            // both point cursors and non-empty selections.
            if (r.from <= to && r.to >= from) return true;
        }
        return false;
    }

    /**
     * @param {number} from
     * @param {number} to
     * @returns {boolean}
     */
    function inVisible(from, to)
    {
        for (const v of visible)
        {
            if (from >= v.from && to <= v.to) return true;
            // Partial overlap still counts — CM6 accepts decorations that
            // clip the visible range, but not decorations wholly outside.
            if (from < v.to && to > v.from) return true;
        }
        return false;
    }

    for (const node of nodes)
    {
        // TitlePageEntry values pass through the emphasis painter — user-
        // accepted trade-off (title-page values are almost never emphasised).
        if (!inVisible(node.from, node.to)) continue;

        /** @type {EmphasisRange[]} */
        const ranges = [];
        scanEmphasis(node.text, 0, node.text.length, ranges);
        if (ranges.length === 0) continue;

        for (const r of ranges)
        {
            const openFrom = node.from + r.openFrom;
            const openTo = node.from + r.openTo;
            const closeFrom = node.from + r.closeFrom;
            const closeTo = node.from + r.closeTo;
            const innerFrom = openTo;
            const innerTo = closeFrom;
            if (innerTo <= innerFrom) continue;

            const revealMarkers = overlapsSelection(openFrom, closeTo);

            // Style the inner content. Bold-italic emits both marks so
            // CM6 stacks the classes on the same DOM span.
            if (r.kind === "bold" || r.kind === "bold-italic")
            {
                emits.push({ from: innerFrom, to: innerTo, deco: boldMark, priority: 0 });
            }
            if (r.kind === "italic" || r.kind === "bold-italic")
            {
                emits.push({ from: innerFrom, to: innerTo, deco: italicMark, priority: 0 });
            }
            if (r.kind === "underline")
            {
                emits.push({ from: innerFrom, to: innerTo, deco: underlineMark, priority: 0 });
            }

            if (revealMarkers)
            {
                // Reveal — paint the raw marker text dimmed so the user
                // can see where the run opens/closes.
                emits.push({
                    from: openFrom,
                    to: openTo,
                    deco: Decoration.mark({ class: "cm-mp-emph-marker-visible" }),
                    priority: 0
                });
                emits.push({
                    from: closeFrom,
                    to: closeTo,
                    deco: Decoration.mark({ class: "cm-mp-emph-marker-visible" }),
                    priority: 0
                });
            }
            else
            {
                // Hide — replace each marker with a zero-width widget.
                const openRaw = state.doc.sliceString(openFrom, openTo);
                const closeRaw = state.doc.sliceString(closeFrom, closeTo);
                emits.push({
                    from: openFrom,
                    to: openTo,
                    deco: Decoration.replace({ widget: new MarkerWidget(openRaw) }),
                    priority: 1
                });
                emits.push({
                    from: closeFrom,
                    to: closeTo,
                    deco: Decoration.replace({ widget: new MarkerWidget(closeRaw) }),
                    priority: 1
                });
            }
        }
    }

    // CM6 requires decorations sorted by `from`, with widget/replace
    // decorations sorted before `mark` decorations at the same start.
    emits.sort((a, b) =>
    {
        if (a.from !== b.from) return a.from - b.from;
        // Higher priority (replace) first.
        return b.priority - a.priority;
    });

    const builder = new RangeSetBuilder();
    for (const e of emits)
    {
        builder.add(e.from, e.to, e.deco);
    }
    return builder.finish();
}

const emphasisPlugin = ViewPlugin.fromClass(
    class
    {
        /** @param {EditorView} view */
        constructor(view)
        {
            this.decorations = buildDecorations(view);
        }

        /** @param {import("@codemirror/view").ViewUpdate} update */
        update(update)
        {
            if (update.docChanged
                || update.viewportChanged
                || update.selectionSet)
            {
                this.decorations = buildDecorations(update.view);
            }
        }
    },
    {
        decorations: (v) => v.decorations,
        // The replace-marker widgets are visible atoms — CM6 must skip
        // over them cursor-wise so arrow keys don't get stuck inside the
        // hidden marker range.
        provide: (plugin) => EditorView.atomicRanges.of((view) =>
        {
            const inst = view.plugin(plugin);
            return inst ? inst.decorations : Decoration.none;
        })
    }
);

/**
 * Build the inline-emphasis extension. Returned as an array so
 * `lang-registry.js` can spread it inline alongside the other extensions.
 *
 * @returns {import("@codemirror/state").Extension[]}
 */
export function editorInlineEmphasis()
{
    return [emphasisPlugin];
}
