// @ts-check
/**
 * editor-panel-tag-style.js — CM6 view plugin that paints Page headings
 * blue and colours the inner text of bracketed Panel/Page tags (e.g.
 * `[BLEED]`, `[L]`, `[H]`) tan. The bracket characters themselves are
 * handled by editor-bracket-match.js, which colours every bracket in the
 * document by matched/unmatched state and nesting depth.
 *
 * View-plugin approach (not a grammar change) — the Lezer grammar lives in
 * `Fountain-Plus/Storyboard/` and is shared across the website, the Chrome
 * extension, and the desktop app. Patching it would have cross-surface blast
 * radius. A view plugin keeps the colour change desktop-local.
 *
 * Detection:
 *   - Page lines (`# Page N`, `# Page 2-3`, `# Page COVER`, ...) — canonical
 *     form only. Whole line receives a line decoration that paints the text
 *     blue.
 *   - Panel lines (`Panel <N>[-<N>]?` at column 0, Convention A/B), Boneyard
 *     Panel lines (`/* PANEL <N> ... *\/`), AND Page lines get bracketed-tag
 *     scanning. Every `/\[([A-Z]+)\]/g` span emits a `cm-mp-panel-tag-text`
 *     decoration over the inner tag text. Brackets are NOT emitted here —
 *     editor-bracket-match.js paints them per its matched/unmatched rules.
 *
 * The plugin exposes a single combined RangeSet. Line decorations are added
 * at `line.from` BEFORE any mark ranges on the same line so RangeSetBuilder's
 * strictly-increasing-position invariant holds.
 */

import { RangeSetBuilder } from "@codemirror/state";
import {
    Decoration,
    EditorView,
    ViewPlugin
} from "@codemirror/view";

/** Canonical Panel line — `Panel N` or `Panel N-M` at column 0. */
const PANEL_LINE_RE = /^Panel\s+\d+(?:-\d+)?\b/;

/** Boneyard Panel line — `/* PANEL N ...` (case-sensitive PANEL per spec). */
const BONEYARD_PANEL_RE = /^\/\*\s*PANEL\s+\d+/;

/** Canonical Page line — `# Page N`, `# Page 2-3`, `# Page COVER`, etc. */
const PAGE_LINE_RE = /^# Page\b/;

/** Bracketed tag — `[<all-caps>]`. Matches each span globally on the line. */
const TAG_RE = /\[[A-Z]+\]/g;

const pageLineMark = Decoration.line({ class: "cm-mp-page-line-source" });
const innerMark = Decoration.mark({ class: "cm-mp-panel-tag-text" });

/**
 * Walk visible lines. For each Page line emit a line decoration; for each
 * Panel / Boneyard-Panel / Page line, mark the inner text of every `[TAG]`
 * span. Bracket chars are painted by editor-bracket-match.js.
 *
 * @param {EditorView} view
 * @returns {import("@codemirror/state").RangeSet<Decoration>}
 */
function buildPanelTagDecorations(view)
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
            const isPage = PAGE_LINE_RE.test(text);
            const isPanel = PANEL_LINE_RE.test(text) || BONEYARD_PANEL_RE.test(text);

            if (isPage)
            {
                // Line decoration MUST be added at line.from before any mark
                // ranges on the same line — RangeSetBuilder demands strictly
                // increasing positions (equal positions are OK only when the
                // earlier addition is a line decoration).
                builder.add(line.from, line.from, pageLineMark);
            }

            if (isPage || isPanel)
            {
                TAG_RE.lastIndex = 0;
                let m;
                while ((m = TAG_RE.exec(text)) !== null)
                {
                    const openStart = line.from + m.index;
                    const openEnd = openStart + 1;
                    const closeStart = line.from + m.index + m[0].length - 1;
                    if (openEnd < closeStart)
                    {
                        builder.add(openEnd, closeStart, innerMark);
                    }
                }
            }
            pos = line.to + 1;
            if (line.to >= state.doc.length) break;
        }
    }
    return builder.finish();
}

/**
 * ViewPlugin maintaining the Page-line + bracketed-tag decorations. Rebuilds
 * on doc and viewport changes.
 */
const panelTagPlugin = ViewPlugin.fromClass(
    class
    {
        /** @param {EditorView} view */
        constructor(view)
        {
            this.decorations = buildPanelTagDecorations(view);
        }

        /** @param {import("@codemirror/view").ViewUpdate} update */
        update(update)
        {
            if (update.docChanged || update.viewportChanged)
            {
                this.decorations = buildPanelTagDecorations(update.view);
            }
        }
    },
    {
        decorations: (v) => v.decorations
    }
);

/**
 * Base theme co-located with the plugin so callers (Text mode via
 * lang-registry.js, Source mode via mps-editor.js) get the colours by
 * merely spreading `editorPanelTagStyle()` — no separate CSS import needed.
 *
 * Colours:
 *   - Page line       → #569cd6 (blue), full line.
 *   - Tag inner text  → #ce9178 (tan),  weight 600.
 */
const panelTagBaseTheme = EditorView.baseTheme({
    ".cm-mp-page-line-source": {
        color: "#569cd6"
    },
    ".cm-mp-panel-tag-text": {
        color: "#ce9178"
    }
});

/**
 * Build the panel-tag-style extension. Returned as an array so
 * `lang-registry.js` can spread it inline alongside the other extensions.
 *
 * @returns {import("@codemirror/state").Extension[]}
 */
export function editorPanelTagStyle()
{
    return [panelTagPlugin, panelTagBaseTheme];
}
