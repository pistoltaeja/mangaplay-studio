// @ts-check
/**
 * editor-page-fold.js — CM6 fold infrastructure for `.mangaplay` page blocks.
 *
 * Three cooperating extensions:
 *
 *   1. foldService — for any line matching `^# Page\b` (or `# PAGE` etc., the
 *      `page` keyword is matched case-insensitively to cover legacy fixtures
 *      that ship `# PAGE 1` uppercase), returns a fold range that covers
 *      everything from the end of the page heading line down to the start of
 *      the next page heading (or end of doc).
 *
 *   2. codeFolding() — the CM6 extension that actually performs the
 *      fold/unfold state management; required for `foldedRanges`,
 *      `foldCode`, and `unfoldCode` to function.
 *
 *   3. ReplaceDecoration view plugin — for every line that starts with `#`
 *      followed by whitespace or end-of-line (loose match, catches mid-typed
 *      `# `, `# P`, `# Pa`, ...), replaces the leading `# ` (or bare `#`)
 *      with a chevron widget (▾ when expanded, ▸ when collapsed). The widget
 *      is zero-width (glyph absolute-positioned into the .cm-content
 *      padding) so the cursor can sit anywhere on the line without the
 *      chevron blocking edits — no cursor-based suppression needed.
 *
 * The widget toggles fold state on click. Glyph follows live fold state read
 * via `foldedRanges(state)`.
 *
 * Document source text is never mutated — folding is purely a view-state
 * concern. The `# ` characters stay literal on disk.
 */

import { Prec, RangeSetBuilder } from "@codemirror/state";
import {
    Decoration,
    EditorView,
    ViewPlugin,
    WidgetType
} from "@codemirror/view";
import {
    codeFolding,
    foldService,
    foldedRanges,
    foldCode,
    unfoldCode
} from "@codemirror/language";
import { icon } from "./icons.js";

/** Strict page-heading regex — `# Page N` (case-insensitive on `page`). Used
 *  by the foldService to decide whether a line can be folded: folding only
 *  applies to COMPLETE page headings, never mid-typed ones.
 *
 *  The site spec only emits warnings on lowercase `# page`, not uppercase,
 *  so widening on `page` doesn't change parse semantics. */
const PAGE_LINE_RE = /^# [Pp][Aa][Gg][Ee]\b/;

/** Loose chevron regex — any line starting with `#` followed by whitespace or
 *  end of line. Catches mid-typed states (`#`, `# `, `# P`, `# Page 1 INT...`)
 *  so the chevron + H1 styling activate from the first keystroke, eliminating
 *  the grey→black + size jitter as the user finishes typing `Page N`. */
const CHEVRON_LINE_RE = /^#(\s|$)/;

/**
 * foldService — return the foldable range for a page heading. The fold body
 * runs from the end of the page line down to the start of the next page line
 * (or end of doc). Returning `null` for non-page lines leaves them un-foldable.
 *
 * @type {import("@codemirror/state").Extension}
 */
const pageFoldService = foldService.of((state, lineStart, lineEnd) =>
{
    const line = state.doc.lineAt(lineStart);
    if (!PAGE_LINE_RE.test(line.text)) return null;

    // Walk forward until we hit the next page line or run out of doc.
    const total = state.doc.lines;
    let to = state.doc.length;
    for (let n = line.number + 1; n <= total; n++)
    {
        const l = state.doc.line(n);
        if (PAGE_LINE_RE.test(l.text))
        {
            // End fold just before the next page line so its `# ` stays visible.
            to = l.from - 1;
            break;
        }
    }
    if (to <= lineEnd) return null;
    return { from: lineEnd, to };
});

/**
 * Chevron widget that replaces the `# ` prefix on a page heading. Renders ▾
 * when the page is expanded, ▸ when folded. Click toggles fold state at the
 * page line's anchor position.
 */
class PageChevronWidget extends WidgetType
{
    /**
     * @param {boolean} folded
     */
    constructor(folded)
    {
        super();
        this.folded = folded;
    }

    /** Equality keyed only on `folded` so the same DOM node is reused while
     *  the user is typing — the absolute line offset shifts on every
     *  keystroke for any page after the first, and re-keying on it would
     *  remount the widget and visibly jitter the chevron. The click handler
     *  reads the live line position via `view.posAtDOM(this.dom)` instead.
     */
    eq(other)
    {
        return other instanceof PageChevronWidget
            && other.folded === this.folded;
    }

    toDOM(view)
    {
        // Zero-width container so it consumes no inline space; an absolute
        // child glyph sits in the .cm-content left padding (styled in
        // mangaplay-highlight.js). This keeps `Page N` text flush with the
        // other column-0 line types (Panel, action).
        const span = document.createElement("span");
        span.className = "cm-mp-page-chevron";
        span.setAttribute("role", "button");
        span.setAttribute("aria-label", this.folded ? "Unfold page" : "Fold page");
        span.style.cursor = "pointer";
        const glyph = document.createElement("span");
        glyph.className = "cm-mp-page-chevron-glyph";
        // Render lucide SVG (ChevronRight when folded, ChevronDown when open).
        // 20px square, currentColor stroke inherits from .cm-mp-page-chevron.
        glyph.innerHTML = icon(this.folded ? "chevron-right" : "chevron-down", { size: 20 });
        span.appendChild(glyph);
        span.addEventListener("mousedown", (e) =>
        {
            // mousedown not click — CM6's contentDOM eats clicks before they
            // bubble in some cases. preventDefault keeps focus on the editor.
            e.preventDefault();
            e.stopPropagation();
            // Look up the live line offset from the DOM node — the cached
            // value from construction would be stale after edits. posAtDOM
            // returns the doc position the widget currently sits at; we
            // expand to the start of that line.
            let pos = 0;
            try
            {
                const here = view.posAtDOM(span);
                pos = view.state.doc.lineAt(here).from;
            }
            catch
            {
                pos = 0;
            }
            // Place the selection on the page line so foldCode / unfoldCode
            // operate on the correct anchor.
            view.dispatch({ selection: { anchor: pos, head: pos } });
            const cmd = this.folded ? unfoldCode : foldCode;
            cmd(view);
        });
        return span;
    }

    ignoreEvent()
    {
        // Let our mousedown handler run; everything else passes through to
        // the editor so cursor placement still works elsewhere on the line.
        return false;
    }
}

/**
 * Build the decoration set for the current view state. Iterates every visible
 * line, finds page-heading-like lines (loose match — see CHEVRON_LINE_RE),
 * and emits a `Decoration.replace` over the leading `# ` (or bare `#` when
 * the line is only one char). The chevron stays mounted regardless of
 * cursor position — the zero-width design (glyph absolute-positioned into
 * .cm-content padding) means it doesn't interfere with editing.
 *
 * @param {EditorView} view
 * @returns {import("@codemirror/state").RangeSet<Decoration>}
 */
function buildPageDecorations(view)
{
    const builder = new RangeSetBuilder();
    const state = view.state;
    const folded = foldedRanges(state);

    // Visible-range iteration. Even though we built a foldService that hides
    // chunks of the doc, the page heading LINES themselves remain visible,
    // so iterating viewportLineBlocks is fine.
    for (const { from, to } of view.visibleRanges)
    {
        let pos = from;
        while (pos <= to)
        {
            const line = state.doc.lineAt(pos);
            if (CHEVRON_LINE_RE.test(line.text))
            {
                // Replace `# ` (two chars) when a space follows, or just `#`
                // when the line is a bare `#` end-of-line. Either way the
                // chevron glyph is absolute-positioned into the padding so
                // the remaining text stays flush with column-0 lines.
                const replaceLen = line.text.length >= 2 && line.text[1] === " " ? 2 : 1;

                // Is this page currently folded? Probe foldedRanges for a
                // range whose `from` sits at or after `line.to` (our fold
                // service emits ranges starting at the end of the page line).
                let isFolded = false;
                folded.between(line.from, line.to + 2, (rangeFrom) =>
                {
                    if (rangeFrom >= line.to)
                    {
                        isFolded = true;
                        return false;
                    }
                    return undefined;
                });

                builder.add(
                    line.from,
                    line.from + replaceLen,
                    Decoration.replace({
                        widget: new PageChevronWidget(isFolded)
                    })
                );
            }
            pos = line.to + 1;
            if (line.to >= state.doc.length) break;
        }
    }
    return builder.finish();
}

/**
 * ViewPlugin that maintains the page-chevron decorations. Re-decorates on
 * doc changes, selection movement, viewport changes, and any other update
 * (cheap — the doc is small relative to typical CM6 content).
 */
const pageChevronPlugin = ViewPlugin.fromClass(
    class
    {
        /** @param {EditorView} view */
        constructor(view)
        {
            this.decorations = buildPageDecorations(view);
        }

        /** @param {import("@codemirror/view").ViewUpdate} update */
        update(update)
        {
            // Re-decorate on every update. Detecting fold-state changes
            // robustly is awkward (foldedRanges is a DecorationSet, not a
            // value-equal field) and the doc isn't large.
            if (
                update.docChanged
                || update.selectionSet
                || update.viewportChanged
                || update.transactions.length > 0
            )
            {
                this.decorations = buildPageDecorations(update.view);
            }
        }
    },
    {
        decorations: (v) => v.decorations
    }
);

/**
 * Build the page-fold extension array. Returns the bundle the editor wires
 * via lang-registry. Order matters within the array — `codeFolding()` must
 * be present for foldedRanges/foldCode/unfoldCode to work.
 *
 * Wrapped in `Prec.low()` so the lint extension's own widgets / underlines
 * take precedence at overlapping positions if any do exist.
 *
 * @returns {import("@codemirror/state").Extension[]}
 */
export function editorPageFold()
{
    return [
        codeFolding(),
        pageFoldService,
        Prec.low(pageChevronPlugin)
    ];
}
