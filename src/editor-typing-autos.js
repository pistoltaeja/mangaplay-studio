// @ts-check
/**
 * editor-typing-autos.js — keymap + state-field driven structural autos
 * for `.mangaplay` editing.
 *
 * Behaviours:
 *   - Enter on `# Page N` → inserts `\n\nPanel 1` below, cursor at end of `Panel 1`.
 *   - Enter on `Panel N ...` → inserts `\n\n`, cursor at column 0 of a blank action line.
 *   - Tab on a blank column-0 line → indents 4 spaces and enters the
 *     dialogue block in CHARACTER (uppercase) mode.
 *   - Tab on a blank indented line under a dialogue line → wraps to `    ()`,
 *     cursor between the parens (mixed casing). Guard: refuses to insert a
 *     second consecutive parenthetical.
 *   - Enter inside the dialogue block:
 *       - CHARACTER cue (casing "upper") → drops to indented dialogue line,
 *         switches casing to "mixed".
 *       - Dialogue line (casing "mixed") → drops to another indented
 *         dialogue line, assuming more dialogue.
 *   - Esc inside the dialogue block → exits block, inserts a newline, cursor
 *     at column 0 of a fresh action line. Returns false when not active so
 *     other Esc bindings still fire.
 *
 * State: a single `dialogueBlock` state field of `{ active, casing }`. A
 * `transactionFilter` upper-cases inserted text while `casing === "upper"`.
 * A view update listener clears the block when the selection leaves the
 * indented region (clicks / arrow keys = same exit as Esc).
 */

import { StateField, StateEffect, Prec, EditorSelection, EditorState } from "@codemirror/state";
import { keymap, EditorView } from "@codemirror/view";
import { snippet, completionStatus } from "@codemirror/autocomplete";

/** Snippet expander for `# Page ${1:N}` — keymap-driven fallback when the
 *  autocompletion-source path didn't open the picker (e.g. `#` is not a word
 *  character so CM6 won't auto-activate on it). */
const expandHashPage = snippet("# Page ${1:N}");

/** Effect — set or clear the dialogue block state. */
export const setDialogueBlock = StateEffect.define();

/**
 * State field tracking whether the editor is in a CHARACTER/dialogue typing
 * block, and whether the active line is being upper-cased.
 *
 * @type {StateField<{ active: boolean, casing: "upper" | "mixed" }>}
 */
export const dialogueBlock = StateField.define({
    create()
    {
        return { active: false, casing: "mixed" };
    },
    update(value, tr)
    {
        for (const e of tr.effects)
        {
            if (e.is(setDialogueBlock))
            {
                return e.value;
            }
        }
        return value;
    }
});

/**
 * transactionFilter — while the dialogue block is active and casing is
 * "upper", upper-case the text of any user-inserted change. Skips trans-
 * actions that flip the state field (our own dispatches carry
 * `setDialogueBlock` and would double-process otherwise).
 */
const upperCaseFilter = EditorState.transactionFilter.of((tr) =>
{
    if (!tr.docChanged) return tr;
    const blk = tr.startState.field(dialogueBlock, false);
    if (!blk || !blk.active || blk.casing !== "upper") return tr;
    for (const e of tr.effects)
    {
        if (e.is(setDialogueBlock)) return tr;
    }
    /** @type {Array<{from: number, to: number, insert: string}>} */
    const newChanges = [];
    let touched = false;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) =>
    {
        const txt = inserted.toString();
        const upper = txt.toUpperCase();
        if (txt && upper !== txt)
        {
            touched = true;
            newChanges.push({ from: fromA, to: toA, insert: upper });
        }
        else
        {
            newChanges.push({ from: fromA, to: toA, insert: txt });
        }
    });
    if (!touched) return tr;
    return [{
        changes: newChanges,
        selection: tr.selection,
        effects: tr.effects,
        scrollIntoView: tr.scrollIntoView,
        annotations: tr.annotations
    }];
});

/** @param {string} t */
function isPanelLine(t)
{
    return /^Panel\s+\d+(\s*\[[^\]]*\])*\s*$/.test(t);
}

/** @param {string} t */
function isPageLine(t)
{
    return /^# Page\b.*/.test(t);
}

/** @param {string} t */
function isParentheticalLine(t)
{
    return /^\s*\(.*\)\s*$/.test(t);
}

/**
 * Enter handler — multiplexes by current line shape and dialogue-block state.
 *
 * @param {EditorView} view
 * @returns {boolean}
 */
function handleEnter(view)
{
    const state = view.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const blk = state.field(dialogueBlock);

    // 1. Enter while in dialogue block — keep block active, drop to indented
    //    line. Casing transitions "upper" → "mixed" on first Enter; if
    //    already "mixed", stays "mixed" (more dialogue assumed).
    //
    //    Special case: if the current line is a parenthetical (e.g.
    //    `    (whispering|)` with cursor between `(` and `)`), splitting at
    //    the cursor would orphan the close paren on its own line. Jump the
    //    insertion point to the END of the line first so the paren stays
    //    intact, then drop to a fresh dialogue line.
    if (blk.active)
    {
        const insertText = "\n    ";
        const insertAt = isParentheticalLine(line.text) ? line.to : head;
        view.dispatch({
            changes: { from: insertAt, insert: insertText },
            selection: EditorSelection.cursor(insertAt + insertText.length),
            effects: setDialogueBlock.of({ active: true, casing: "mixed" }),
            scrollIntoView: true
        });
        return true;
    }

    // 2. Case-normalize `# PAGE X` / `# page X` -> `# Page X` and run the
    //    same Panel-1 autoinsert as the canonical-case branch below. Single
    //    dispatch keeps caret math atomic.
    const PAGE_CASE_RE = /^# (PAGE|page)(\s|$)/;
    if (PAGE_CASE_RE.test(line.text))
    {
        const normalized = "# Page" + line.text.slice(6);
        const totalLines = state.doc.lines;
        let alreadyHasPanel = false;
        for (let n = line.number + 1; n <= Math.min(line.number + 2, totalLines); n++)
        {
            const t = state.doc.line(n).text;
            if (/^Panel\s+\d/.test(t)) { alreadyHasPanel = true; break; }
        }
        const insertSuffix = alreadyHasPanel ? "" : "\n\nPanel 1";
        const finalText = normalized + insertSuffix;
        view.dispatch({
            changes: { from: line.from, to: line.to, insert: finalText },
            selection: EditorSelection.cursor(line.from + finalText.length),
            scrollIntoView: true
        });
        return true;
    }

    // 3. Enter on a `# Page N` line — insert `\n\nPanel 1` after the line,
    //    cursor at end of `Panel 1`. Skip if the next non-empty content is
    //    already `Panel \d`.
    if (isPageLine(line.text))
    {
        const totalLines = state.doc.lines;
        let alreadyHasPanel = false;
        for (let n = line.number + 1; n <= Math.min(line.number + 2, totalLines); n++)
        {
            const t = state.doc.line(n).text;
            if (/^Panel\s+\d/.test(t)) { alreadyHasPanel = true; break; }
        }
        if (alreadyHasPanel) return false;

        const insertText = "\nPanel 1";
        view.dispatch({
            changes: { from: line.to, insert: insertText },
            selection: EditorSelection.cursor(line.to + insertText.length),
            scrollIntoView: true
        });
        return true;
    }

    // 4. SFX colon normalization. `SFX BOOM` -> `SFX: BOOM`; case-
    //    insensitive on the prefix. Body preserved as-typed (spec only
    //    mandates caps on the prefix). Only fires at end-of-line.
    const SFX_NO_COLON_RE = /^sfx\s+(\S.*)$/i;
    const sfxMatch = line.text.match(SFX_NO_COLON_RE);
    if (sfxMatch && head === line.to)
    {
        const normalized = "SFX: " + sfxMatch[1];
        const insertText = normalized + "\n";
        view.dispatch({
            changes: { from: line.from, to: line.to, insert: insertText },
            selection: EditorSelection.cursor(line.from + insertText.length),
            scrollIntoView: true
        });
        return true;
    }

    // 5. Transition case normalization. `cut to:` -> `CUT TO:`,
    //    `fade out.` -> `FADE OUT.`, `fade in:` -> `FADE IN:`.
    const TRANSITION_RE = /^(?:cut|dissolve|smash|match|jump|slam|wipe|iris|fade)\s+(?:to:|out\.|in:)\s*$/i;
    if (TRANSITION_RE.test(line.text) && line.text !== line.text.toUpperCase() && head === line.to)
    {
        const upper = line.text.toUpperCase();
        const nextLineText = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : "";
        const trailingNewlines = nextLineText.trim() === "" ? "\n" : "\n\n";
        const insertText = upper + trailingNewlines;
        view.dispatch({
            changes: { from: line.from, to: line.to, insert: insertText },
            selection: EditorSelection.cursor(line.from + insertText.length),
            scrollIntoView: true
        });
        return true;
    }

    // 6. Scene heading case normalization. `int. kitchen - day` ->
    //    `INT. KITCHEN - DAY`. Matches the same slug list as the
    //    Lezer tokenizer.
    const SCENE_HEADING_RE = /^(int\.|ext\.|est\.|int\.\/ext\.|int\/ext|i\/e)\b/i;
    if (SCENE_HEADING_RE.test(line.text) && line.text !== line.text.toUpperCase() && head === line.to)
    {
        const upper = line.text.toUpperCase();
        const nextLineText = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : "";
        const trailingNewlines = nextLineText.trim() === "" ? "\n" : "\n\n";
        const insertText = upper + trailingNewlines;
        view.dispatch({
            changes: { from: line.from, to: line.to, insert: insertText },
            selection: EditorSelection.cursor(line.from + insertText.length),
            scrollIntoView: true
        });
        return true;
    }

    // 7. Unindented ALL-CAPS cue at column 0 (e.g. user typed `CID` then
    //    Enter). Auto-indent the cue to 4 spaces, drop caret onto a fresh
    //    4-space-indented dialogue line, and activate the dialogue block in
    //    mixed casing so the next Enter keeps the indent. Guards against
    //    scene headings and title cards which are also all-caps.
    const CUE_LINE_RE = /^[A-Z][A-Z0-9 ()./\-]*$/;
    const SCENE_PREFIX_RE = /^(INT|EXT|EST|INT\.\/EXT\.|INT\/EXT|I\/E)\b/;
    const TITLE_PREFIX_RE = /^TITLE\b/;
    if (
        CUE_LINE_RE.test(line.text)
        && !SCENE_PREFIX_RE.test(line.text)
        && !TITLE_PREFIX_RE.test(line.text)
    )
    {
        const indentedCue = "    " + line.text;
        const insertText = indentedCue + "\n    ";
        view.dispatch({
            changes: { from: line.from, to: line.to, insert: insertText },
            selection: EditorSelection.cursor(line.from + insertText.length),
            effects: setDialogueBlock.of({ active: true, casing: "mixed" }),
            scrollIntoView: true
        });
        return true;
    }

    // 8. Enter on a `Panel N` line — insert blank action line below.
    if (isPanelLine(line.text))
    {
        const insertText = "\n\n";
        view.dispatch({
            changes: { from: line.to, insert: insertText },
            selection: EditorSelection.cursor(line.to + insertText.length),
            scrollIntoView: true
        });
        return true;
    }

    return false;
}

/**
 * Tab handler — multiplexes by line shape.
 *
 *   - Blank line, column 0 → indent + enter CHARACTER mode (upper).
 *   - Blank indented line under a dialogue line → wrap to `    ()` (mixed).
 *     Refuses if the previous line is already a parenthetical (guard).
 *
 * @param {EditorView} view
 * @returns {boolean}
 */
function handleTab(view)
{
    const state = view.state;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const head = sel.head;
    const line = state.doc.lineAt(head);
    const text = line.text;

    // Case 0: line is exactly `#` and cursor at end — expand the page
    //   snippet inline. CM6's autocompletion won't auto-activate on `#`
    //   (non-word char) so this Tab handler covers the snippet path too.
    if (text === "#" && head === line.to)
    {
        expandHashPage(view, null, line.from, head);
        return true;
    }

    // Case A: blank line whose previous non-empty line is an indented
    //   dialogue/CHARACTER cue line (`    foo`) — single Tab wraps to
    //   `    ()` directly (skip the CHARACTER-mode detour). Guard: if the
    //   previous non-empty line is itself a parenthetical, refuse so we
    //   don't stack `()` lines.
    if (text === "" && head === line.from)
    {
        const prevNonEmpty = findPrevNonEmptyLine(state, line.number);
        if (prevNonEmpty && /^ {4}\S/.test(prevNonEmpty))
        {
            if (isParentheticalLine(prevNonEmpty)) return false;
            const insertText = "    ()";
            const cursorOffset = line.from + 5; // between ( and )
            view.dispatch({
                changes: { from: line.from, to: line.to, insert: insertText },
                selection: EditorSelection.cursor(cursorOffset),
                effects: setDialogueBlock.of({ active: true, casing: "mixed" }),
                scrollIntoView: true
            });
            return true;
        }
    }

    // Case B: blank line at column 0 (no prior indented dialogue context) —
    //   enter CHARACTER mode.
    if (text === "" && head === line.from)
    {
        const insertText = "    ";
        view.dispatch({
            changes: { from: head, insert: insertText },
            selection: EditorSelection.cursor(head + insertText.length),
            effects: setDialogueBlock.of({ active: true, casing: "upper" }),
            scrollIntoView: true
        });
        return true;
    }

    // Case C: line is `    ` (4 spaces, nothing else) with cursor at end —
    //   parenthetical wrap (legacy path: e.g. CHARACTER-mode Tab landed here
    //   and user pressed Tab again). Guard against double parens.
    if (/^ {4}$/.test(text) && head === line.to)
    {
        if (line.number > 1)
        {
            const prev = state.doc.line(line.number - 1).text;
            if (isParentheticalLine(prev)) return false;
        }
        const insertText = "    ()";
        const cursorOffset = line.from + 5; // between ( and )
        view.dispatch({
            changes: { from: line.from, to: line.to, insert: insertText },
            selection: EditorSelection.cursor(cursorOffset),
            effects: setDialogueBlock.of({ active: true, casing: "mixed" }),
            scrollIntoView: true
        });
        return true;
    }

    // Case D: default — let active autocomplete handle Tab; otherwise insert
    //   4 spaces at the cursor (soft-tab fallback for cursor-on-text).
    if (completionStatus(state) === "active") return false;
    view.dispatch({
        changes: { from: head, insert: "    " },
        selection: EditorSelection.cursor(head + 4),
        scrollIntoView: true
    });
    return true;
}

/**
 * Shift+Tab handler — converts a parenthetical line back to a column-0
 * action line by stripping the indent and the parens.
 *
 *   `    (thought)`  →  `thought`
 *
 * Exits the dialogue block. Returns false on non-parenthetical lines so
 * other Shift+Tab bindings (e.g. CodeMirror's indentLess) still fire.
 *
 * @param {EditorView} view
 * @returns {boolean}
 */
function handleShiftTab(view)
{
    const state = view.state;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const line = state.doc.lineAt(sel.head);
    if (!isParentheticalLine(line.text)) return false;

    const trimmed = line.text.trim();
    const inner = trimmed.replace(/^\((.*)\)$/, "$1").trim();
    view.dispatch({
        changes: { from: line.from, to: line.to, insert: inner },
        selection: EditorSelection.cursor(line.from + inner.length),
        effects: setDialogueBlock.of({ active: false, casing: "mixed" }),
        scrollIntoView: true
    });
    return true;
}

/**
 * Walk backwards from `fromLineNumber - 1` and return the text of the first
 * line whose content is not entirely whitespace. Returns null if none found.
 *
 * @param {EditorState} state
 * @param {number} fromLineNumber
 * @returns {string | null}
 */
function findPrevNonEmptyLine(state, fromLineNumber)
{
    for (let n = fromLineNumber - 1; n >= 1; n--)
    {
        const t = state.doc.line(n).text;
        if (t.trim() !== "") return t;
    }
    return null;
}

/**
 * Esc handler — exits the dialogue block to a fresh column-0 line. Returns
 * false when not in a dialogue block so other Esc bindings (e.g. close
 * autocomplete popup) still fire.
 *
 * @param {EditorView} view
 * @returns {boolean}
 */
function handleEscape(view)
{
    const state = view.state;
    const blk = state.field(dialogueBlock);
    if (!blk.active) return false;
    const head = state.selection.main.head;
    view.dispatch({
        changes: { from: head, insert: "\n" },
        selection: EditorSelection.cursor(head + 1),
        effects: setDialogueBlock.of({ active: false, casing: "mixed" }),
        scrollIntoView: true
    });
    return true;
}

/**
 * Selection-watch update listener — when the selection moves to a line that
 * isn't an indented continuation (`    `-prefixed) and the change wasn't a
 * doc edit we just dispatched, clear the dialogue block. Triggered by clicks
 * / arrow keys / programmatic moves.
 */
const selectionWatch = EditorView.updateListener.of((update) =>
{
    if (!update.selectionSet || update.docChanged) return;
    const blk = update.state.field(dialogueBlock, false);
    if (!blk || !blk.active) return;
    const head = update.state.selection.main.head;
    const line = update.state.doc.lineAt(head);
    if (/^ {4}/.test(line.text)) return;
    update.view.dispatch({
        effects: setDialogueBlock.of({ active: false, casing: "mixed" })
    });
});

/**
 * `#` handler — when the user presses `#` while the current line is already
 * exactly the single character `#` (i.e. they typed `#` then another `#`),
 * expand to `# Page <next> ` where `<next>` is one greater than the highest
 * existing `# Page N` heading in the document. Range form (`# Page 1-3`)
 * uses the END of the range. Falls back to `# Page 1` when no headings exist.
 *
 * Triggers ONLY when the line content up to the cursor is exactly `"#"` and
 * the cursor sits at column 1 — typing `##` mid-paragraph in an action line
 * passes through (return false → default `#` insertion).
 *
 * Cursor lands one space after the page number so the user can immediately
 * type a scene heading continuation OR press Enter to bypass and create
 * Panel 1.
 *
 * @param {EditorView} view
 * @returns {boolean}
 */
function handleHash(view)
{
    const state = view.state;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const head = sel.head;
    const line = state.doc.lineAt(head);
    const beforeCursor = line.text.slice(0, head - line.from);

    // Trigger only when this `#` keystroke will turn the line from `#` into
    // `##` — i.e. there is exactly one `#` between line-start and cursor.
    if (beforeCursor !== "#") return false;

    // Walk the entire doc finding the highest existing page number. Accepts
    // `# Page N`, `# PAGE N`, `# page N`, ranges (`# Page 1-3` → uses 3).
    const doc = state.doc.toString();
    const PAGE_RE = /^# [Pp][Aa][Gg][Ee]\s+(\d+)(?:\s*-\s*(\d+))?/gm;
    let highest = 0;
    let m;
    while ((m = PAGE_RE.exec(doc)) !== null)
    {
        const end = m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10);
        if (Number.isFinite(end) && end > highest) highest = end;
    }
    const next = highest + 1;

    // Replace the current `#` (line.from..head, one char) with the heading +
    // trailing space. Cursor lands at the end of the insertion.
    const insertText = `# Page ${next} `;
    view.dispatch({
        changes: { from: line.from, to: head, insert: insertText },
        selection: EditorSelection.cursor(line.from + insertText.length),
        scrollIntoView: true
    });
    return true;
}

/**
 * `[` handler — auto-close note brackets. When the user types `[`
 * immediately after another `[` (so the doc up to cursor reads `[[`),
 * insert ` ]]` and place caret between the spaces, producing `[[ | ]]`.
 *
 * Guards against typing a third bracket (`[[[`) — bails when the char
 * two positions back is also `[`.
 *
 * @param {EditorView} view
 * @returns {boolean}
 */
function handleOpenBracket(view)
{
    const state = view.state;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const head = sel.head;
    if (head === 0) return false;
    const charBefore = state.doc.sliceString(head - 1, head);
    if (charBefore !== "[") return false;
    if (head >= 2 && state.doc.sliceString(head - 2, head - 1) === "[") return false;

    const insertText = "[  ]]";
    const cursorOffset = head + 2;
    view.dispatch({
        changes: { from: head, insert: insertText },
        selection: EditorSelection.cursor(cursorOffset),
        scrollIntoView: true
    });
    return true;
}

/**
 * `*` handler — auto-close boneyard comments. When the user types `*`
 * immediately after `/` (so the doc up to cursor reads `/` + `*`), insert
 * `  ` + `*` + `/` and place caret between the spaces, producing
 * `/` + `*` + ` | ` + `*` + `/`.
 *
 * @param {EditorView} view
 * @returns {boolean}
 */
function handleStar(view)
{
    const state = view.state;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const head = sel.head;
    if (head === 0) return false;
    const charBefore = state.doc.sliceString(head - 1, head);
    if (charBefore !== "/") return false;
    const line = state.doc.lineAt(head);
    // Only fire when the `/` is at the very start of the line (boneyards
    // are conventionally column-0 per the Lezer tokenizer).
    if (head - 1 !== line.from) return false;

    const insertText = "*  */";
    const cursorOffset = head + 2;
    view.dispatch({
        changes: { from: head, insert: insertText },
        selection: EditorSelection.cursor(cursorOffset),
        scrollIntoView: true
    });
    return true;
}

/**
 * High-priority keymap. `Prec.high()` ensures our handlers win against the
 * default Enter / Tab / Escape bindings when they return true; returning
 * false falls through cleanly to the existing keymaps.
 *
 * @returns {import("@codemirror/state").Extension[]}
 */
export function editorTypingAutos()
{
    return [
        dialogueBlock,
        upperCaseFilter,
        selectionWatch,
        Prec.high(keymap.of([
            { key: "Enter", run: handleEnter },
            { key: "Tab", run: handleTab },
            { key: "Shift-Tab", run: handleShiftTab },
            { key: "Escape", run: handleEscape },
            { key: "#", run: handleHash },
            { key: "[", run: handleOpenBracket },
            { key: "*", run: handleStar }
        ]))
    ];
}
