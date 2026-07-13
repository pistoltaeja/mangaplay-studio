// @ts-check
/**
 * find-engine.js — CodeMirror-side text search for the in-editor Find widget.
 *
 * The extension is installed lazily on first `runFindOn(view, …)` call via
 * `StateEffect.appendConfig`, so the base `buildEditorExtensions()` list
 * stays untouched for editors that never open Find.
 *
 * All matches receive a `.cm-find-match` decoration. The current match also
 * receives `.cm-find-match-current`. Both classes are styled in `app.css`
 * under the "find widget" block.
 */

import { StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

/**
 * @typedef {Object} FindState
 * @property {string} query                - current query (empty = cleared)
 * @property {{ from: number, to: number }[]} matches
 * @property {number} currentIndex         - -1 when no matches
 */

/** @type {FindState} */
const EMPTY_FIND_STATE = { query: "", matches: [], currentIndex: -1 };

/** @type {import("@codemirror/state").StateEffectType<FindState>} */
const setFindStateEffect = StateEffect.define();

const matchMark = Decoration.mark({ class: "cm-find-match" });
const currentMark = Decoration.mark({ class: "cm-find-match cm-find-match-current" });

/**
 * @param {import("@codemirror/state").EditorState} state
 * @param {FindState} findState
 * @returns {import("@codemirror/view").DecorationSet}
 */
function buildDecorations(state, findState)
{
    void state;
    const builder = new RangeSetBuilder();
    for (let i = 0; i < findState.matches.length; i++)
    {
        const m = findState.matches[i];
        builder.add(m.from, m.to, i === findState.currentIndex ? currentMark : matchMark);
    }
    return builder.finish();
}

const findStateField = StateField.define({
    /** @returns {FindState} */
    create()
    {
        return EMPTY_FIND_STATE;
    },
    /**
     * @param {FindState} value
     * @param {import("@codemirror/state").Transaction} tr
     * @returns {FindState}
     */
    update(value, tr)
    {
        let next = value;
        for (const e of tr.effects)
        {
            if (e.is(setFindStateEffect))
            {
                next = /** @type {FindState} */ (e.value);
            }
        }
        // Doc-change invalidates positions — if the doc changed and we still
        // hold matches, drop them; the widget will re-run search.
        if (tr.docChanged && next.matches.length > 0 && next === value)
        {
            next = { query: value.query, matches: [], currentIndex: -1 };
        }
        return next;
    }
});

const findDecorationField = StateField.define({
    create(state) { return buildDecorations(state, EMPTY_FIND_STATE); },
    update(value, tr)
    {
        const fs = tr.state.field(findStateField);
        return buildDecorations(tr.state, fs);
    },
    provide: (f) => EditorView.decorations.from(f)
});

let installed = new WeakSet();

/**
 * Ensure the find extension is installed on this view. Idempotent.
 * @param {import("@codemirror/view").EditorView} view
 */
function ensureInstalled(view)
{
    if (installed.has(view)) return;
    installed.add(view);
    view.dispatch({
        effects: StateEffect.appendConfig.of([findStateField, findDecorationField])
    });
}

/**
 * @param {string} query
 * @param {string} docText
 * @returns {{ from: number, to: number }[]}
 */
function scan(query, docText)
{
    if (!query) return [];
    const q = query.toLowerCase();
    const hay = docText.toLowerCase();
    /** @type {{ from: number, to: number }[]} */
    const out = [];
    let idx = 0;
    while (idx <= hay.length - q.length)
    {
        const hit = hay.indexOf(q, idx);
        if (hit === -1) break;
        out.push({ from: hit, to: hit + q.length });
        idx = hit + Math.max(q.length, 1);
    }
    return out;
}

/**
 * Run `query` against `view`'s document. Highlights all matches, sets
 * the "current" match to the first result at or after the anchor cursor
 * (or 0 when nothing matches).
 *
 * @param {import("@codemirror/view").EditorView} view
 * @param {string} query
 * @returns {{ total: number, current: number }} - `current` is 1-based; 0 when no matches
 */
export function runFindOn(view, query)
{
    ensureInstalled(view);
    const doc = view.state.doc.toString();
    const matches = scan(query, doc);
    const anchor = view.state.selection.main.head;
    /** @type {number} */
    let currentIndex = -1;
    if (matches.length > 0)
    {
        // First match starting at or after the anchor. If none, wrap to 0.
        currentIndex = matches.findIndex((m) => m.from >= anchor);
        if (currentIndex === -1) currentIndex = 0;
    }
    /** @type {FindState} */
    const next = { query, matches, currentIndex };
    view.dispatch({ effects: setFindStateEffect.of(next) });
    if (currentIndex !== -1)
    {
        scrollTo(view, matches[currentIndex]);
    }
    return {
        total: matches.length,
        current: currentIndex === -1 ? 0 : currentIndex + 1
    };
}

/**
 * @param {import("@codemirror/view").EditorView} view
 * @param {"next"|"prev"} dir
 * @returns {{ total: number, current: number }}
 */
export function step(view, dir)
{
    const fs = view.state.field(findStateField, false);
    if (!fs || fs.matches.length === 0) return { total: 0, current: 0 };
    let idx = fs.currentIndex;
    if (idx === -1) idx = 0;
    else idx = (dir === "next")
        ? (idx + 1) % fs.matches.length
        : (idx - 1 + fs.matches.length) % fs.matches.length;
    /** @type {FindState} */
    const next = { query: fs.query, matches: fs.matches, currentIndex: idx };
    view.dispatch({ effects: setFindStateEffect.of(next) });
    scrollTo(view, fs.matches[idx]);
    return { total: fs.matches.length, current: idx + 1 };
}

/**
 * @param {import("@codemirror/view").EditorView} view
 */
export function clearFind(view)
{
    const fs = view.state.field(findStateField, false);
    if (!fs) return;
    view.dispatch({ effects: setFindStateEffect.of(EMPTY_FIND_STATE) });
}

/**
 * @param {import("@codemirror/view").EditorView} view
 * @param {{ from: number, to: number }} range
 */
function scrollTo(view, range)
{
    try
    {
        view.dispatch({
            effects: EditorView.scrollIntoView(range.from, { y: "center" })
        });
    }
    catch (_) { /* ignore — view may be detaching */ }
}
