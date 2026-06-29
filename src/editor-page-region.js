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
import { metaGutterLine } from "./editor-meta-region.js";
import { PAGE_LINE_RE } from "./editor-line-regexes.js";

/** Panel heading — `Panel N` (with optional bracketed tags). Matches the
 *  canonical form `editor-typing-autos.js`'s `isPanelLine` accepts. */
const PANEL_LINE_RE = /^Panel\s+\d+(\s*\[[^\]]*\])*\s*$/;

/** Confirmed CHARACTER cue — 4-space-indented line whose content is
 *  ALL CAPS letters / digits / common cue punctuation. Mirrors the cue
 *  shape produced by editor-typing-autos.js's ALL-CAPS+Enter promote.
 *  The promote indents the line, so a column-0 mid-typed `DELHI` does
 *  NOT match — keeping the bold styling out of the typing flow. */
const CUE_LINE_RE = /^ {4}[A-Z][A-Z0-9 .,'"&()\-]*$/;

const startLine = Decoration.line({ class: "cm-mp-page-region-start" });
const midLine = Decoration.line({ class: "cm-mp-page-region-mid" });
const endLine = Decoration.line({ class: "cm-mp-page-region-end" });
const collapsedLine = Decoration.line({ class: "cm-mp-page-region-collapsed" });
/** Confirmed Panel heading — applied as a SECONDARY class on top of
 *  the region decoration when the cursor is NOT on that Panel line
 *  (i.e. the user has moved off, committing the heading). Without
 *  this gate the H3 styling jitters as the tokenizer flips between
 *  ActionTok and PanelHeadingTok mid-typing. */
const midPanelLine = Decoration.line({ class: "cm-mp-page-region-mid cm-mp-panel-confirmed" });
const endPanelLine = Decoration.line({ class: "cm-mp-page-region-end cm-mp-panel-confirmed" });
const firstBodyPanelLine = Decoration.line({ class: "cm-mp-page-region-mid cm-mp-page-region-first-body cm-mp-panel-confirmed" });
const firstBodyEndPanelLine = Decoration.line({ class: "cm-mp-page-region-end cm-mp-page-region-first-body cm-mp-panel-confirmed" });
/** Confirmed CHARACTER cue line — the 4-space-indented ALL-CAPS row is
 *  the canonical post-promote shape, so the bold styling only kicks in
 *  AFTER Enter has indented the line. Same rationale as the Panel
 *  confirmed variants above. */
const midCueLine = Decoration.line({ class: "cm-mp-page-region-mid cm-mp-cue-confirmed" });
const endCueLine = Decoration.line({ class: "cm-mp-page-region-end cm-mp-cue-confirmed" });
const firstBodyCueLine = Decoration.line({ class: "cm-mp-page-region-mid cm-mp-page-region-first-body cm-mp-cue-confirmed" });
const firstBodyEndCueLine = Decoration.line({ class: "cm-mp-page-region-end cm-mp-page-region-first-body cm-mp-cue-confirmed" });
/** Blank lines between a page heading and its first non-blank child are
 *  visually collapsed in the Text editor — the user's source `# Page` ↔
 *  `Panel 1` separator stays in the doc, but the rendered row is hidden
 *  so the panel sits flush under the heading. */
const hiddenMidLine = Decoration.line({ class: "cm-mp-page-region-mid cm-mp-page-region-hidden" });
/** Inter-card gutter line — blank lines AFTER the last non-blank line of a
 *  page region, before the next `# Page` heading. Painted with no border
 *  + fixed height to act as a 14px gap between cards. */
const gutterLine = Decoration.line({ class: "cm-mp-page-region-gutter" });
/** First non-blank line under a page heading (typically `Panel 1`). Gets a
 *  small top padding so the Panel sits visually separated from the heading
 *  text without re-introducing the hidden blank row. */
const firstBodyLine = Decoration.line({ class: "cm-mp-page-region-mid cm-mp-page-region-first-body" });
/** As above but for the case where the first non-blank line is also the
 *  LAST line of the region (single-Panel pages). It needs both the
 *  start-of-body padding AND the end-of-region border treatment. */
const firstBodyEndLine = Decoration.line({ class: "cm-mp-page-region-end cm-mp-page-region-first-body" });

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

        // Find the first non-blank line after the heading. Blank lines in
        // that prefix get hidden so the first Panel sits flush under the
        // page heading — the source text is untouched.
        let firstNonBlank = headLineNum + 1;
        while (firstNonBlank <= endLineNum
            && state.doc.line(firstNonBlank).text.trim() === "")
        {
            firstNonBlank++;
        }

        // Find the last non-blank line in the region. Trailing blanks (the
        // user's separator between this page and the next `# Page`) get
        // pushed OUTSIDE the card so the bottom border hugs the final
        // action line, and the trailing blanks render as the inter-card
        // gutter. Same source-preservation guarantee as the leading
        // hidden block — the doc text is untouched.
        let lastNonBlank = endLineNum;
        while (lastNonBlank > headLineNum
            && state.doc.line(lastNonBlank).text.trim() === "")
        {
            lastNonBlank--;
        }

        // Card boundary: the card hugs its content by default. Every
        // trailing blank beyond the first one is promoted INTO the
        // card body as a visible mid-line — the user kept pressing
        // Enter, expecting the card to grow line by line.
        //
        //   trailingBlanks=0 → card ends at content, no gutter.
        //   trailingBlanks=1 → card ends at content, single blank
        //                       becomes the gutter.
        //   trailingBlanks=N (N≥2) → N-1 blanks inside the card,
        //                            last blank is the gutter.
        //
        // LAST page in the doc (no `# Page` heading follows): there's
        // nothing to gutter against, so EVERY trailing blank becomes
        // a card-extension row. Without this branch, Enter on the
        // bottom action line of the last card would just produce a
        // free-standing gutter row instead of growing the card.
        const isLastPage = i === headings.length - 1;
        const trailingBlanks = endLineNum - lastNonBlank;
        let cardEnd = lastNonBlank;
        if (isLastPage) cardEnd = endLineNum;
        else if (trailingBlanks >= 2) cardEnd = lastNonBlank + (trailingBlanks - 1);

        // Heading-only region (every interior line was blank) → collapsed.
        if (lastNonBlank === headLineNum)
        {
            // Replace the startLine with a collapsedLine to paint all four
            // sides. The builder requires increasing positions, so we can't
            // re-add at headLine.from — but in this branch we already
            // emitted startLine above. Cleanest path: fall through. The
            // top + sides paint correctly; the bottom border just won't
            // appear, which is a rare edge case (page with no content yet).
            // Subsequent blank lines become gutter.
            for (let n = headLineNum + 1; n <= endLineNum; n++)
            {
                const l = state.doc.line(n);
                builder.add(l.from, l.from, gutterLine);
            }
            continue;
        }

        for (let n = headLineNum + 1; n < cardEnd; n++)
        {
            const l = state.doc.line(n);
            // Confirmed Panel = the line text already matches the
            // canonical `Panel N` form. PANEL_LINE_RE rejects partial
            // typed states (`P`, `Pan`, `Panel `, `Panel 1 [`), so the
            // styling only applies once the form is complete — no
            // cursor-position gate needed.
            const isConfirmedPanel = PANEL_LINE_RE.test(l.text);
            // Confirmed CHARACTER cue = 4-space-indented ALL-CAPS line.
            // The promote path always indents, so mid-typed column-0
            // ALL-CAPS lines won't match this regex and won't get the
            // bold styling — the visual snaps in only after Enter has
            // committed the cue.
            const isConfirmedCue = CUE_LINE_RE.test(l.text);
            let deco;
            if (n < firstNonBlank) deco = hiddenMidLine;
            else if (n === firstNonBlank)
            {
                if (isConfirmedPanel) deco = firstBodyPanelLine;
                else if (isConfirmedCue) deco = firstBodyCueLine;
                else deco = firstBodyLine;
            }
            else if (l.text.trim() === ""
                && n > headLineNum + 1
                && PANEL_LINE_RE.test(state.doc.line(n - 1).text))
            {
                // Blank line directly under a Panel heading — the user's
                // canonical `Panel N\n\nAction` separator. Hide it in the
                // Text editor so the Panel heading hugs its first action
                // line, mirroring the hidden blank under `# Page` →
                // `Panel 1`. Source text untouched.
                deco = hiddenMidLine;
            }
            else
            {
                if (isConfirmedPanel) deco = midPanelLine;
                else if (isConfirmedCue) deco = midCueLine;
                else deco = midLine;
            }
            builder.add(l.from, l.from, deco);
        }
        const last = state.doc.line(cardEnd);
        const lastIsConfirmedPanel = PANEL_LINE_RE.test(last.text);
        const lastIsConfirmedCue = CUE_LINE_RE.test(last.text);
        // Single-body-line page (Panel 1 is also the last action line) →
        // first-body padding + end-of-region border on the same row.
        let lastDeco;
        if (cardEnd === firstNonBlank)
        {
            if (lastIsConfirmedPanel) lastDeco = firstBodyEndPanelLine;
            else if (lastIsConfirmedCue) lastDeco = firstBodyEndCueLine;
            else lastDeco = firstBodyEndLine;
        }
        else
        {
            if (lastIsConfirmedPanel) lastDeco = endPanelLine;
            else if (lastIsConfirmedCue) lastDeco = endCueLine;
            else lastDeco = endLine;
        }
        builder.add(last.from, last.from, lastDeco);

        // Trailing blanks (cardEnd+1 … endLineNum) become inter-card
        // gutter rows. Only the FIRST such row needs to render — additional
        // blanks would stack gutters. Hide every gutter row after the first.
        let emittedFirstGutter = false;
        for (let n = cardEnd + 1; n <= endLineNum; n++)
        {
            const l = state.doc.line(n);
            if (!emittedFirstGutter)
            {
                builder.add(l.from, l.from, gutterLine);
                emittedFirstGutter = true;
            }
            else
            {
                builder.add(l.from, l.from, hiddenMidLine);
            }
        }
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
 * Return the line number of the gutter row associated with a given page
 * heading, or null if the page has no trailing-blank gutter.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {number} headLineNum
 * @returns {number|null}
 */
function gutterLineForHeading(state, headLineNum)
{
    const total = state.doc.lines;
    let next = headLineNum + 1;
    while (next <= total && !PAGE_LINE_RE.test(state.doc.line(next).text)) next++;
    // Next page heading line (or end+1). Region ends at next-1.
    const endLineNum = next - 1;
    // Last page in the doc (no next `# Page`) has no gutter — every
    // trailing blank belongs to the card. Mirrors buildRegionDecorations.
    const isLastPage = next > total;
    if (isLastPage) return null;
    let lastNonBlank = endLineNum;
    while (lastNonBlank > headLineNum
        && state.doc.line(lastNonBlank).text.trim() === "")
    {
        lastNonBlank--;
    }
    // Mirror the cardEnd promotion in buildRegionDecorations: all but
    // the final trailing blank become card-extension rows; only the
    // final one is the gutter.
    const trailingBlanks = endLineNum - lastNonBlank;
    if (trailingBlanks < 1) return null;
    const cardEnd = trailingBlanks >= 2 ? lastNonBlank + (trailingBlanks - 1) : lastNonBlank;
    return cardEnd + 1;
}

/**
 * Test whether a doc line number is a gutter line (the first blank row
 * after a page region's last non-blank line). Used by the mousedown
 * interceptor to re-route clicks that hit the gutter back to a real line.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {number} lineNumber
 * @returns {boolean}
 */
function isGutterLine(state, lineNumber)
{
    if (lineNumber < 1 || lineNumber > state.doc.lines) return false;
    // Meta → page gutter (between `Title:` card and the first `# Page`).
    if (metaGutterLine(state) === lineNumber) return true;
    // Walk up from the line until we hit a page heading. If the line
    // between that heading and the gutter we identify matches our target,
    // it's a gutter line.
    for (let n = lineNumber; n >= 1; n--)
    {
        if (PAGE_LINE_RE.test(state.doc.line(n).text))
        {
            return gutterLineForHeading(state, n) === lineNumber;
        }
    }
    return false;
}

/**
 * Mousedown interceptor: CM6 maps clicks to doc positions via geometry
 * (`view.posAtCoords`), bypassing per-line CSS pointer-events. When the
 * user clicks inside the 14px inter-card gutter, the resulting cursor
 * lands on the gutter's underlying doc line — a blank row the user
 * doesn't think is selectable. Re-route by computing the click's doc
 * position, detecting the gutter line, and dispatching the cursor to
 * the nearest visible line above the gutter (the previous card's last
 * action line). preventDefault stops CM's own click handler from
 * overwriting our selection.
 */
const gutterClickInterceptor = EditorView.domEventHandlers({
    mousedown(event, view)
    {
        // Left-button only — let middle/right click pass through.
        if (event.button !== 0) return false;

        let lineNumber = null;

        // Path A: posAtCoords resolves a doc position → use it directly.
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos != null)
        {
            lineNumber = view.state.doc.lineAt(pos).number;
        }
        else
        {
            // Path B: pointer-events:none on the gutter element makes
            // posAtCoords return null when the click lands inside a
            // gutter's bounding rect. Detect by hit-testing the y-coord
            // against every visible gutter element's rect — if we find
            // one, treat the click as targeting that gutter's doc line.
            const gutters = view.dom.querySelectorAll(".cm-mp-page-region-gutter");
            for (const g of gutters)
            {
                const r = g.getBoundingClientRect();
                if (event.clientY >= r.top && event.clientY <= r.bottom)
                {
                    // posAtDOM resolves the doc position of this DOM node.
                    try
                    {
                        const guess = view.posAtDOM(g);
                        if (guess != null)
                        {
                            lineNumber = view.state.doc.lineAt(guess).number;
                        }
                    }
                    catch
                    {
                        // posAtDOM can throw if the node detaches mid-resolve.
                        // Fall back to the next gutter or the no-op exit.
                    }
                    break;
                }
            }
        }

        if (lineNumber == null) return false;
        if (!isGutterLine(view.state, lineNumber)) return false;

        // Re-route to the end of the previous non-blank line. Walk
        // upward until we find one.
        let target = lineNumber - 1;
        while (target >= 1 && view.state.doc.line(target).text.trim() === "")
        {
            target--;
        }
        if (target < 1) return false;

        const targetLine = view.state.doc.line(target);
        view.dispatch({
            selection: { anchor: targetLine.to, head: targetLine.to }
        });
        event.preventDefault();
        return true;
    }
});

/**
 * Build the page-region extension. Returned as an array so
 * `lang-registry.js` can spread it inline.
 *
 * @returns {import("@codemirror/state").Extension[]}
 */
export function editorPageRegion()
{
    return [pageRegionPlugin, gutterClickInterceptor];
}
