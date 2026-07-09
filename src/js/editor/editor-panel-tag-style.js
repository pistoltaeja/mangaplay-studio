// @ts-check
/**
 * editor-panel-tag-style.js — CM6 view plugin that paints bracketed Panel
 * tags (e.g. `[BLEED]`, `[L]`, `[H]`) purple.
 *
 * View-plugin approach (not a grammar change) — the Lezer grammar lives in
 * `Fountain-Plus/Storyboard/` and is shared across the website, the Chrome
 * extension, and the desktop app. Patching it would have cross-surface blast
 * radius. A view plugin keeps the colour change desktop-local.
 *
 * Detection mirrors `editor-checks.js`'s `unknownPanelTags()`:
 *   - Line shaped like `Panel <N>[-<N>]?` at column 0 (Convention A/B),
 *     OR a boneyard panel `/* PANEL <N> ... *\/`.
 *   - Inside the line, every `/\[([A-Z]+)\]/g` span is marked with the
 *     `cm-mp-panel-tag` class.
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

/** Bracketed tag — `[<all-caps>]`. Matches each span globally on the line. */
const TAG_RE = /\[[A-Z]+\]/g;

const tagMark = Decoration.mark({ class: "cm-mp-panel-tag" });

/**
 * Walk visible lines, find Panel/Boneyard-Panel lines, and mark every
 * bracketed tag span with `cm-mp-panel-tag`.
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
            if (PANEL_LINE_RE.test(text) || BONEYARD_PANEL_RE.test(text))
            {
                TAG_RE.lastIndex = 0;
                let m;
                while ((m = TAG_RE.exec(text)) !== null)
                {
                    const start = line.from + m.index;
                    const end = start + m[0].length;
                    builder.add(start, end, tagMark);
                }
            }
            pos = line.to + 1;
            if (line.to >= state.doc.length) break;
        }
    }
    return builder.finish();
}

/**
 * ViewPlugin maintaining the bracketed-tag decorations. Rebuilds on doc and
 * viewport changes.
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
 * Build the panel-tag-style extension. Returned as an array so
 * `lang-registry.js` can spread it inline alongside the other extensions.
 *
 * @returns {import("@codemirror/state").Extension[]}
 */
export function editorPanelTagStyle()
{
    return [panelTagPlugin];
}
