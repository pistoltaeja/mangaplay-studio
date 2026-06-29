// @ts-check
/**
 * editor-source-tab.js — Tab + Shift+Tab key handlers for Source mode.
 *
 * Source mode strips the entire `languageExtensionsFor()` bundle (which is
 * where Text-mode's Tab→4-spaces handler lives, in editor-typing-autos.js).
 * Without a replacement, Tab would fall through to the browser's default
 * (move focus out of the editor).
 *
 * VSCode-style behaviour:
 *
 *   - Single-line cursor / single-line range → insert one indent unit
 *     (4 spaces or `\t`) at the cursor; range selections are replaced.
 *
 *   - Multi-line range → indent EVERY line touched by the selection
 *     (prefix each line's start with one indent unit). Shift+Tab outdents
 *     each line by stripping one indent unit (4 spaces, or a tab if the
 *     line starts with one; otherwise up to 4 leading spaces).
 *
 * Configuration: `editorTabBehavior` in user-settings.json
 *   - "spaces" (default) → 4 spaces
 *   - "tabs"             → literal `\t`
 *
 * Read on every keystroke so changing the setting takes effect immediately
 * without remounting the editor.
 */

import { EditorSelection, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { getUserSetting } from "./user-settings.js";

const SPACE_INDENT = "    ";

/** @returns {string} the indent unit to use */
function indentUnit()
{
    let behavior = "spaces";
    try { behavior = getUserSetting("editorTabBehavior", "spaces"); }
    catch { /* settings not loaded yet — fall back */ }
    return behavior === "tabs" ? "\t" : SPACE_INDENT;
}

/**
 * Does the selection span more than one line? Includes the case where the
 * selection extends from end-of-line N to start-of-line N+1 (rare; treated
 * as single-line to match VSCode).
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {import("@codemirror/state").SelectionRange} sel
 * @returns {boolean}
 */
function isMultiLine(state, sel)
{
    if (sel.empty) return false;
    const startLine = state.doc.lineAt(sel.from).number;
    const endLine = state.doc.lineAt(sel.to).number;
    return endLine > startLine;
}

/**
 * Indent every line touched by the selection. Returns true if applied.
 *
 * @param {import("@codemirror/view").EditorView} view
 * @returns {boolean}
 */
function indentLines(view)
{
    const state = view.state;
    const sel = state.selection.main;
    const unit = indentUnit();
    const unitLen = unit.length;

    const startLine = state.doc.lineAt(sel.from);
    const endLine = state.doc.lineAt(sel.to);

    /** @type {Array<{ from: number, insert: string }>} */
    const changes = [];
    for (let n = startLine.number; n <= endLine.number; n++)
    {
        const line = state.doc.line(n);
        // Skip empty lines so blank rows don't accumulate trailing
        // whitespace on repeated Tab presses.
        if (line.text.length === 0) continue;
        changes.push({ from: line.from, insert: unit });
    }
    if (changes.length === 0) return false;

    // Expand the selection to cover every newly-inserted unit so subsequent
    // Tab presses keep all the lines selected (VSCode behaviour).
    const insertedTotal = unitLen * changes.length;

    view.dispatch({
        changes,
        selection: EditorSelection.range(
            startLine.from,
            endLine.from + endLine.length + (endLine.number === startLine.number ? 0 : 0) + insertedTotal
        ),
        scrollIntoView: true
    });
    return true;
}

/**
 * Outdent every line touched by the selection. Strips up to one indent unit
 * from each line's leading whitespace. Returns true if anything was removed.
 *
 * @param {import("@codemirror/view").EditorView} view
 * @returns {boolean}
 */
function outdentLines(view)
{
    const state = view.state;
    const sel = state.selection.main;

    const startLine = state.doc.lineAt(sel.from);
    const endLine = state.doc.lineAt(sel.to);

    /** @type {Array<{ from: number, to: number, insert: string }>} */
    const changes = [];
    let totalRemoved = 0;
    for (let n = startLine.number; n <= endLine.number; n++)
    {
        const line = state.doc.line(n);
        if (line.text.length === 0) continue;
        // Strip a leading tab, OR up to 4 leading spaces. Mirrors VSCode's
        // editor.action.outdentLines behaviour for soft tabs.
        if (line.text[0] === "\t")
        {
            changes.push({ from: line.from, to: line.from + 1, insert: "" });
            totalRemoved += 1;
        }
        else
        {
            let n2 = 0;
            while (n2 < 4 && line.text[n2] === " ") n2++;
            if (n2 > 0)
            {
                changes.push({ from: line.from, to: line.from + n2, insert: "" });
                totalRemoved += n2;
            }
        }
    }
    if (changes.length === 0) return false;

    view.dispatch({
        changes,
        selection: EditorSelection.range(
            startLine.from,
            endLine.from + endLine.length - totalRemoved
        ),
        scrollIntoView: true
    });
    return true;
}

/** @param {import("@codemirror/view").EditorView} view */
function handleSourceTab(view)
{
    const state = view.state;
    const sel = state.selection.main;

    // Multi-line range → indent each touched line (VSCode behaviour).
    if (isMultiLine(state, sel))
    {
        return indentLines(view);
    }

    const unit = indentUnit();
    if (sel.empty)
    {
        view.dispatch({
            changes: { from: sel.head, insert: unit },
            selection: EditorSelection.cursor(sel.head + unit.length),
            scrollIntoView: true
        });
        return true;
    }

    // Single-line range — replace the selection with one indent unit.
    view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: unit },
        selection: EditorSelection.cursor(sel.from + unit.length),
        scrollIntoView: true
    });
    return true;
}

/** @param {import("@codemirror/view").EditorView} view */
function handleSourceShiftTab(view)
{
    const state = view.state;
    const sel = state.selection.main;

    // Multi-line range → outdent each touched line.
    if (isMultiLine(state, sel))
    {
        return outdentLines(view);
    }

    // Single-line cursor / range → outdent the cursor's line. Useful for
    // quick "back-out one level" without selecting the whole line.
    const line = state.doc.lineAt(sel.head);
    if (line.text.length === 0) return false;
    if (line.text[0] === "\t")
    {
        view.dispatch({
            changes: { from: line.from, to: line.from + 1, insert: "" },
            selection: EditorSelection.cursor(Math.max(line.from, sel.head - 1)),
            scrollIntoView: true
        });
        return true;
    }
    let n2 = 0;
    while (n2 < 4 && line.text[n2] === " ") n2++;
    if (n2 > 0)
    {
        view.dispatch({
            changes: { from: line.from, to: line.from + n2, insert: "" },
            selection: EditorSelection.cursor(Math.max(line.from, sel.head - n2)),
            scrollIntoView: true
        });
        return true;
    }
    return false;
}

/**
 * Plain newline on Enter — overrides CM6 defaultKeymap's
 * `insertNewlineAndIndent` which copies the previous line's leading
 * whitespace to the next line. Source mode is meant to be a literal
 * plaintext editor (no auto-indent), so we insert just `\n`. Without
 * this, typing a screenplay line-by-line through Source view causes
 * indent to accumulate — every Enter adds the previous line's leading
 * whitespace, and the user keeps drifting right.
 *
 * @param {import("@codemirror/view").EditorView} view
 * @returns {boolean}
 */
function handleSourceEnter(view)
{
    const state = view.state;
    const sel = state.selection.main;
    view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: "\n" },
        selection: EditorSelection.cursor(sel.from + 1),
        scrollIntoView: true
    });
    return true;
}

/**
 * Build the Source-mode keymap. Returned as an array so
 * `extensionsForMode("source")` can spread it inline. Uses `Prec.high()`
 * so our Enter binding outranks defaultKeymap's insertNewlineAndIndent.
 *
 * @returns {import("@codemirror/state").Extension[]}
 */
export function editorSourceTab()
{
    return [
        Prec.high(keymap.of([
            { key: "Tab", run: handleSourceTab },
            { key: "Shift-Tab", run: handleSourceShiftTab },
            { key: "Enter", run: handleSourceEnter }
        ]))
    ];
}
