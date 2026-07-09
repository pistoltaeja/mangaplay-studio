// @ts-check
/**
 * src/structural-fixer.js — pure source-text fixers for the "Fix
 * Structural Issues" button. Operates on the raw text of the source
 * buffer, not the AST, so the fixes propagate through the existing
 * source→AST→Text/Visual sync without any extra glue.
 *
 * Two formats supported today: "mangaplay" and "fountain". All other
 * formats short-circuit to "no fixes available". The button in app.js
 * uses this contract:
 *
 *   import { hasFixableIssues, fixIssues } from "./structural-fixer.js";
 *   const dirty = hasFixableIssues(format, sourceText);
 *   if (dirty) viewDispatchReplaceAll(fixIssues(format, sourceText));
 *
 * Both functions are O(lines) and safe to call on every render.
 *
 * ── Mangaplay convention contract ────────────────────────────────
 *
 * Mangaplay supports three indent styles:
 *
 *   A  (CANONICAL — DEFAULT TARGET): panels at 4 spaces, dialogue cue
 *      and body at 8 spaces. The fixer normalises to this style.
 *   B  (relaxed): panels at column 0, dialogue at 4 spaces.
 *   C  (relaxed): panels at column 0, dialogue at column 0.
 *
 * Panel description prose ("action lines") is always emitted at
 * column 0 regardless of style (see formatter INDENT_STYLES).
 *
 * Today the fixer always targets A. The exported `MANGAPLAY_FIXER_CONFIG`
 * leaves a hook for a future user-facing setting that swaps the target
 * convention — when wired through Settings UI it should override
 * `targetConvention` at call time. For now A is hard-default.
 */

import { parseScript } from "@mangaplay-studio/core";

/**
 * Per-format fixer configuration. The mangaplay block is the only one
 * exposed today; fountain has no convention to choose between.
 *
 * The default target is convention **B** — panels at column 0,
 * dialogue at 4 spaces, action at column 0. The user can override via
 * the `manga_settings.structuralFixTargetConvention` setting (see
 * `tauri-storage.js` STORAGE_DEFAULTS.MANGA_SETTINGS). Until that
 * Settings UI lands, callers can mutate `MANGAPLAY_FIXER_CONFIG.targetConvention`
 * directly — `setMangaplayTargetConvention()` does this safely.
 *
 * @typedef {"A" | "B" | "C"} MangaplayConvention
 *
 * @typedef {Object} MangaplayFixerConfig
 * @property {MangaplayConvention} targetConvention   Indent style the
 *     fixer normalises panel + dialogue indentation to. Default "B".
 */

/** @type {MangaplayFixerConfig} */
export const MANGAPLAY_FIXER_CONFIG = {
    targetConvention: "B",
};

/**
 * Set the active mangaplay target convention. Rejects unknown values.
 *
 * @param {string} convention
 */
export function setMangaplayTargetConvention(convention)
{
    if (convention === "A" || convention === "B" || convention === "C")
    {
        MANGAPLAY_FIXER_CONFIG.targetConvention = convention;
    }
}

/**
 * Indent widths for each convention. Action lines are always col 0.
 */
const INDENT_WIDTHS = {
    A: { panel: 4, dialogue: 8 },
    B: { panel: 0, dialogue: 4 },
    C: { panel: 0, dialogue: 0 },
};

/**
 * Produce a leading-whitespace string of length `n`.
 * @param {number} n
 * @returns {string}
 */
function spaces(n) { return " ".repeat(n); }

/* ─────────────────────── public surface ─────────────────────── */

/**
 * @param {string} format          One of "mangaplay" | "fountain" | other.
 * @param {string} sourceText      Current source buffer text.
 * @returns {boolean}              True if at least one fixable issue exists.
 */
export function hasFixableIssues(format, sourceText)
{
    if (typeof sourceText !== "string" || sourceText.length === 0) return false;
    if (format === "mangaplay") return mangaplayHasFixable(sourceText);
    if (format === "fountain")  return fountainHasFixable(sourceText);
    return false;
}

/**
 * @param {string} format
 * @param {string} sourceText
 * @returns {string}               Fixed source text. Returns the input
 *                                  verbatim when no fixes apply.
 */
export function fixIssues(format, sourceText)
{
    if (typeof sourceText !== "string" || sourceText.length === 0) return sourceText;
    if (format === "mangaplay") return mangaplayFix(sourceText);
    if (format === "fountain")  return fountainFix(sourceText);
    return sourceText;
}

/* ─────────────────────── mangaplay rules ────────────────────── */

// Captures `# Page` or `# page` / `# PAGE` etc. — group 2 is the word.
const RE_PAGE_LINE  = /^(#\s*)(page)(\s+\S.*)$/i;
// `Panel N` at column 0 (mangaplay convention) — group 1 is the word.
const RE_PANEL_LINE = /^(panel)(\s+\d.*)$/i;

/**
 * Compute the fixed mangaplay source. Mirrors the legacy AST-based
 * `_fixStructuralIssues()` but edits the source string directly.
 *
 * @param {string} src
 * @returns {string}
 */
function mangaplayFix(src)
{
    const ops = collectMangaplayOps(src);
    if (ops.length === 0) return src;
    return applyLineOps(src, ops);
}

/**
 * Return true on the first detected fixable issue.
 *
 * @param {string} src
 * @returns {boolean}
 */
function mangaplayHasFixable(src)
{
    const lines = src.split("\n");
    const target = INDENT_WIDTHS[MANGAPLAY_FIXER_CONFIG.targetConvention];
    // Cheap pre-scan: page/panel word case, mis-indented Panel lines.
    for (const line of lines)
    {
        const pm = line.match(RE_PAGE_LINE);
        if (pm && pm[2] !== "Page") return true;
        const panelAtAny = line.match(/^(\s*)(panel\s+\d.*)$/i);
        if (panelAtAny)
        {
            if (panelAtAny[1].length !== target.panel) return true;
            // Panel word case (matches column-0 panels only since
            // RE_PANEL_LINE is anchored).
            const nm = line.match(RE_PANEL_LINE);
            if (nm && nm[1] !== "Panel") return true;
        }
    }
    // Col-0 ALL-CAPS cue pre-scan (only meaningful when target dialogue
    // indent is > 0; for convention C col-0 cues are canonical).
    if (target.dialogue > 0)
    {
        for (let i = 0; i < lines.length; i++)
        {
            const raw = lines[i];
            if (/^\s/.test(raw)) continue;
            const trimmed = raw.trim();
            if (trimmed.length === 0 || trimmed.length > 30) continue;
            if (!/^[A-Z][A-Z0-9 '\-\.]*$/.test(trimmed)) continue;
            if (/^(PAGE|PANEL|SFX|TITLE|FADE|CUT|DISSOLVE)\b/.test(trimmed)) continue;
            if (trimmed.split(/\s+/).length > 4) continue;
            if (i + 1 < lines.length && lines[i + 1].trim() !== ""
                && !/^\s/.test(lines[i + 1]))
            {
                return true;
            }
        }
    }
    // Fall back to the full collector for renumber / cue-case / cue-indent issues.
    return collectMangaplayOps(src).length > 0;
}

/**
 * Walk the source + AST to build a list of line-level edits. Each op is
 * `{ line, transform }` where `line` is the 0-based source line index
 * and `transform` returns the new line text.
 *
 * @typedef {{ line: number, transform: (line: string) => string }} LineOp
 *
 * @param {string} src
 * @returns {LineOp[]}
 */
function collectMangaplayOps(src)
{
    /** @type {LineOp[]} */
    const ops = [];
    const lines = src.split("\n");

    // Parse for page/panel line numbers + suffix continuation.
    /** @type {any} */
    let ast = null;
    try { ast = parseScript(src); }
    catch (_) { ast = null; }

    // 1. Page renumbering (preserve suffix groups).
    if (ast && Array.isArray(ast.pages))
    {
        let nextBase = 1;
        let prevOldBase = null;
        let prevNewBase = null;
        for (const page of ast.pages)
        {
            const oldBase = typeof page.baseNumber === "number" ? page.baseNumber : null;
            const suffix = typeof page.suffix === "string" ? page.suffix : "";
            let myBase;
            if (suffix && prevOldBase !== null && oldBase === prevOldBase)
            {
                // Sub-page continuation — inherit previous base.
                myBase = prevNewBase;
            }
            else
            {
                myBase = nextBase++;
                prevOldBase = oldBase;
                prevNewBase = myBase;
            }
            if (oldBase !== null && oldBase !== myBase
                && typeof page.lineNumber === "number")
            {
                const ln = page.lineNumber;
                const newBase = myBase;
                ops.push({
                    line: ln,
                    transform: (text) => renumberPageLine(text, newBase)
                });
            }
        }

        // 2. Panel renumbering within each page.
        for (const page of ast.pages)
        {
            const panels = Array.isArray(page.panels) ? page.panels : [];
            for (let i = 0; i < panels.length; i++)
            {
                const panel = panels[i];
                const want = i + 1;
                if (typeof panel.displayNumber === "number"
                    && panel.displayNumber !== want
                    && typeof panel.lineNumber === "number")
                {
                    ops.push({
                        line: panel.lineNumber,
                        transform: (text) => renumberPanelLine(text, want)
                    });
                }
            }
        }
    }

    // 3. Page / Panel word-case (always). Walk all lines so we catch them
    // even when the parser is unhappy.
    for (let i = 0; i < lines.length; i++)
    {
        const line = lines[i];
        const pm = line.match(RE_PAGE_LINE);
        if (pm && pm[2] !== "Page")
        {
            ops.push({
                line: i,
                transform: (text) =>
                {
                    const m = text.match(RE_PAGE_LINE);
                    return m ? `${m[1]}Page${m[3]}` : text;
                }
            });
            continue;
        }
        const nm = line.match(RE_PANEL_LINE);
        if (nm && nm[1] !== "Panel")
        {
            ops.push({
                line: i,
                transform: (text) =>
                {
                    const m = text.match(RE_PANEL_LINE);
                    return m ? `Panel${m[2]}` : text;
                }
            });
        }
    }

    // 3b. Normalise `Panel N` indentation to the target convention's
    // panel indent (4 for A, 0 for B and C). Catches both over-indented
    // and under-indented panel lines.
    const targetPanelIndent = INDENT_WIDTHS[MANGAPLAY_FIXER_CONFIG.targetConvention].panel;
    for (let i = 0; i < lines.length; i++)
    {
        const line = lines[i];
        const m = line.match(/^(\s*)(panel\s+\d.*)$/i);
        if (!m) continue;
        const currentIndent = m[1].length;
        if (currentIndent === targetPanelIndent) continue;
        const target = targetPanelIndent;
        ops.push({
            line: i,
            transform: (text) =>
            {
                const mm = text.match(/^\s*(panel)(\s+\d.*)$/i);
                return mm ? `${spaces(target)}Panel${mm[2]}` : text;
            }
        });
    }

    // 4. Character cue case — conservative heuristic on source lines.
    //
    // Two cue shapes are recognised:
    //   - Indented:      `    NARRATION` (mangaplay convention, 2+ spaces)
    //   - Forced (`@`):  `@hero`         (Fountain-style forced cue at
    //                    column 0; the parser preserves character case
    //                    as-typed, so we must surface it as a fix target
    //                    when the name has lowercase letters).
    for (let i = 0; i < lines.length; i++)
    {
        const raw = lines[i];
        const forced = raw.match(/^(@)([A-Za-z][A-Za-z0-9_'\-\. ]*?)\s*$/);
        if (forced)
        {
            const cue = forced[2];
            if (!/[a-z]/.test(cue)) continue;
            // Next non-blank line must be the dialogue body (any indent).
            let next = "";
            for (let j = i + 1; j < lines.length; j++)
            {
                if (lines[j].trim() === "") continue;
                next = lines[j];
                break;
            }
            if (next === "") continue;
            // Skip if next line is structural — would mean this isn't a cue.
            if (/^#\s*Page\b/i.test(next)) continue;
            if (/^Panel\s+\d/i.test(next)) continue;
            if (/^SFX:?\s/i.test(next)) continue;
            const upper = cue.toUpperCase();
            ops.push({
                line: i,
                transform: () => `@${upper}`
            });
            continue;
        }
        const m = raw.match(/^(\s{2,})([A-Za-z][A-Za-z0-9_'\-\. ]*?)\s*$/);
        if (!m) continue;
        const cue = m[2];
        // Cue-shape filter — without this, mid-sentence body lines like
        // "        Dorothy can see them all." would match the regex
        // above (period and space are inside the char class) and get
        // uppercased as if they were cue names. A real cue:
        //   - Has at most 4 words (DOROTHY, NARRATION, DOROTHY (O.S.))
        //   - Doesn't end with sentence punctuation
        //   - Doesn't contain an internal period followed by a space-letter
        //     pattern (the "stop-then-new-word" shape of a sentence).
        const cueTrimmed = cue.trim();
        if (cueTrimmed.length === 0) continue;
        if (cueTrimmed.length > 30) continue;
        if (cueTrimmed.split(/\s+/).length > 4) continue;
        if (/[.!?]$/.test(cueTrimmed)) continue;
        if (/\.\s+[A-Za-z]/.test(cueTrimmed)) continue;
        // Find the indented body line.
        let nextIdx = -1;
        let next = "";
        for (let j = i + 1; j < lines.length; j++)
        {
            if (lines[j].trim() === "") continue;
            next = lines[j];
            nextIdx = j;
            break;
        }
        if (!/^\s{2,}\S/.test(next)) continue;
        // Reject SFX / TITLE keywords (not character cues).
        if (/^SFX:?\s/i.test(cue) || /^TITLE\b/i.test(cue)) continue;
        // Reject `Panel N` shape (could match the regex when read as a
        // 2-word "Panel 2" cue but it's actually a structural marker).
        if (/^Panel\s+\d/i.test(cueTrimmed)) continue;
        const indent = m[1];
        const upper = cue.toUpperCase();
        const indentDepth = indent.length;
        const needCaseFix = upper !== cue;
        const targetDialogueIndent = INDENT_WIDTHS[
            MANGAPLAY_FIXER_CONFIG.targetConvention
        ].dialogue;
        const needIndentFix = indentDepth !== targetDialogueIndent;
        if (!needCaseFix && !needIndentFix) continue;
        ops.push({
            line: i,
            transform: () => `${spaces(targetDialogueIndent)}${upper}`
        });
        // If the body line is at a different indent than the target,
        // also normalise. We only adjust if the body is currently
        // indented (i.e. recognized as dialogue body) so we don't
        // accidentally indent unrelated column-0 action lines.
        if (nextIdx >= 0)
        {
            const bodyMatch = next.match(/^(\s+)(.*)$/);
            if (bodyMatch && bodyMatch[1].length !== targetDialogueIndent)
            {
                ops.push({
                    line: nextIdx,
                    transform: (t) =>
                    {
                        const bm = t.match(/^(\s+)(.*)$/);
                        return bm
                            ? `${spaces(targetDialogueIndent)}${bm[2]}`
                            : t;
                    }
                });
            }
        }
    }

    // 5. A column-0 ALL-CAPS short line followed by a column-0 non-blank
    //    line is recognised as a CUE + DIALOGUE pair that the user
    //    forgot to indent. Indent both to the target dialogue indent.
    //    No-op when the target convention is C (dialogue at col 0).
    for (let i = 0; i < lines.length; i++)
    {
        const raw = lines[i];
        // Cue shape: column-0, no leading whitespace, ALL-CAPS letter content.
        if (/^\s/.test(raw)) continue;
        const trimmed = raw.trim();
        if (trimmed.length === 0 || trimmed.length > 30) continue;
        // Pure word check: ALL-CAPS letters + spaces only, length 1-4 words.
        if (!/^[A-Z][A-Z0-9 '\-\.]*$/.test(trimmed)) continue;
        const wc = trimmed.split(/\s+/).length;
        if (wc > 4) continue;
        // Filter out structural keywords that look like cues.
        if (/^(PAGE|PANEL|SFX|TITLE|FADE|CUT|DISSOLVE)\b/.test(trimmed)) continue;
        // Previous line must be blank OR an action line at col 0.
        // (Block when prev is `# Page` / `Panel N` — the line would be part
        // of those headings.)
        let prev = "";
        for (let j = i - 1; j >= 0; j--)
        {
            if (lines[j].trim() === "") continue;
            prev = lines[j];
            break;
        }
        if (/^#\s*Page\b/i.test(prev)) continue;
        if (/^Panel\s+\d/i.test(prev)) continue;
        // Note: prev can be ANY of: blank, action at col 0, or indented
        // dialogue from a previous beat. A blank line between this cue
        // and the prior dialogue is implied because we walked backward
        // through any blank lines to find prev; the line immediately
        // above this one is necessarily blank or this scan wouldn't
        // have considered the line a cue (cue lines need a blank above
        // is too strict — see the docstring above for the spec).
        // Next non-blank line must be column-0 non-blank (the body).
        let nextIdx = -1;
        for (let j = i + 1; j < lines.length; j++)
        {
            if (lines[j].trim() === "") continue;
            nextIdx = j;
            break;
        }
        if (nextIdx < 0) continue;
        const next = lines[nextIdx];
        if (/^\s/.test(next)) continue;
        if (next.trim().length === 0) continue;
        // Reject obvious scene-shape rejections.
        if (/^#\s*Page\b/i.test(next)) continue;
        if (/^Panel\s+\d/i.test(next)) continue;
        if (/^SFX:?\s/i.test(next)) continue;
        const targetDi = INDENT_WIDTHS[
            MANGAPLAY_FIXER_CONFIG.targetConvention
        ].dialogue;
        // Convention C wants col 0 — no transformation needed.
        if (targetDi === 0) continue;
        // Indent BOTH the cue and the body to the target dialogue indent.
        ops.push({
            line: i,
            transform: () => `${spaces(targetDi)}${trimmed}`
        });
        ops.push({
            line: nextIdx,
            transform: () => `${spaces(targetDi)}${next}`
        });
    }

    return ops;
}

/**
 * Renumber the page-number digit token in a `# Page N…` line.
 *
 * @param {string} line
 * @param {number} newBase
 * @returns {string}
 */
function renumberPageLine(line, newBase)
{
    // Match `# Page <digits>` (case-insensitive on the word `Page`).
    return line.replace(/^(\s*#\s*page\s+)(\d+)/i, (_m, head, _digits) =>
        `${head}${newBase}`);
}

/**
 * Renumber the digit token in a `Panel N…` line.
 *
 * @param {string} line
 * @param {number} want
 * @returns {string}
 */
function renumberPanelLine(line, want)
{
    const indent = INDENT_WIDTHS[MANGAPLAY_FIXER_CONFIG.targetConvention].panel;
    return line.replace(/^\s*panel\s+\d+/i, () => `${spaces(indent)}Panel ${want}`);
}

/* ─────────────────────── fountain rules ────────────────────── */

// Slug detector for case + missing-period + tab fixups. Captures the slug
// token in group 1, the separator (space or tab) in group 2.
const RE_FOUNTAIN_SLUG = /^(\s*)(int\.\/ext\.|int\/ext|ext\.\/int\.|ext\/int|i\/e|e\/i|int|ext|est)(\.?)([ \t]+)(.+)$/i;
// Slash-form slugs that should NOT receive an extra period after them
// (either they have no period at all, like `INT/EXT`, or the periods are
// internal to the token, like `INT./EXT.`).
const SLASH_SLUGS = new Set([
    "INT/EXT", "EXT/INT", "I/E", "E/I",
    "INT./EXT.", "EXT./INT."
]);

/**
 * @param {string} src
 * @returns {string}
 */
function fountainFix(src)
{
    const ops = collectFountainOps(src);
    if (ops.length === 0) return src;
    return applyLineOps(src, ops);
}

/**
 * @param {string} src
 * @returns {boolean}
 */
function fountainHasFixable(src)
{
    return collectFountainOps(src).length > 0;
}

/**
 * @param {string} src
 * @returns {LineOp[]}
 */
function collectFountainOps(src)
{
    /** @type {LineOp[]} */
    const ops = [];
    const lines = src.split("\n");

    // Where does the title page end? Fountain spec: first blank line
    // terminates title page. We only consider lines AFTER that boundary
    // for scene-heading / cue fixups (the title page has `Key: Value`
    // shapes that would false-positive a cue check).
    const bodyStart = findFountainBodyStart(lines);

    for (let i = 0; i < lines.length; i++)
    {
        const line = lines[i];
        // Scene-heading detection (case-insensitive).
        const m = line.match(RE_FOUNTAIN_SLUG);
        if (m)
        {
            const indent = m[1];
            const slugRaw = m[2];
            const period = m[3];
            const sep = m[4];
            const rest = m[5];
            const slugUpper = slugRaw.toUpperCase();
            const isSlash = SLASH_SLUGS.has(slugUpper);
            const wantPeriod = !isSlash && period !== ".";
            const wantUppercaseLine = !isAllUpperLine(line);
            const wantTabFix = sep.includes("\t");
            if (wantPeriod || wantUppercaseLine || wantTabFix)
            {
                const newPeriod = isSlash ? "" : ".";
                const newSep = " ";
                // Always uppercase body when any of the three fixes apply —
                // a slug line is canonical ALL-CAPS in fountain.
                const body = `${slugUpper}${newPeriod}${newSep}${rest}`.toUpperCase();
                const rebuilt = `${indent}${body}`;
                ops.push({ line: i, transform: () => rebuilt });
                continue;
            }
        }

        // Character cue mixed-case (only in body).
        if (i >= bodyStart && looksLikeMixedCaseCue(lines, i))
        {
            const raw = lines[i];
            const upper = uppercaseFountainCue(raw);
            if (upper !== raw)
            {
                ops.push({ line: i, transform: () => upper });
            }
        }
    }

    return ops;
}

/**
 * Return the 0-based index of the first body line — i.e. the line after
 * the title page's terminating blank line. If the file has no title page
 * (no `Key:` shape on line 0), returns 0.
 *
 * @param {string[]} lines
 * @returns {number}
 */
function findFountainBodyStart(lines)
{
    if (lines.length === 0) return 0;
    // Heuristic: title page exists if line 0 matches `Key: value`.
    if (!/^[A-Za-z][A-Za-z ]*:\s/.test(lines[0])) return 0;
    for (let i = 0; i < lines.length; i++)
    {
        if (lines[i].trim() === "") return i + 1;
    }
    return lines.length;
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isAllUpperLine(line)
{
    return line === line.toUpperCase();
}

/**
 * Conservative cue detector. Requires a blank line above (or start of
 * body), a non-blank line below, and a short word-shape cue.
 *
 * @param {string[]} lines
 * @param {number} i
 * @returns {boolean}
 */
function looksLikeMixedCaseCue(lines, i)
{
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 30) return false;
    // Blank above?
    if (i > 0 && lines[i - 1].trim() !== "") return false;
    // Non-blank below?
    if (i + 1 >= lines.length || lines[i + 1].trim() === "") return false;
    // No leading whitespace allowed at cue line itself.
    if (/^\s/.test(raw)) return false;
    // Drop trailing parenthetical for the shape check.
    const parenMatch = trimmed.match(/^(.+?)(\s*\([^)]*\))\s*$/);
    const head = (parenMatch ? parenMatch[1] : trimmed).trim();
    // Word count 1-4.
    const words = head.split(/\s+/);
    if (words.length < 1 || words.length > 4) return false;
    // Has lowercase letter?
    if (!/[a-z]/.test(head)) return false;
    // First word starts uppercase?
    if (!/^[A-Z]/.test(words[0])) return false;
    // No sentence punctuation at end of head.
    if (/[.!?]$/.test(head)) return false;
    // No Fountain control char at start of trimmed line.
    if (/^[@>=~!.\(\[]/.test(trimmed)) return false;
    // Don't match scene-heading slugs.
    if (RE_FOUNTAIN_SLUG.test(raw)) return false;
    // Don't match title-page-key shape (`Title: …`).
    if (/^[A-Za-z][A-Za-z ]*:\s/.test(raw)) return false;
    return true;
}

/**
 * Uppercase the cue line, preserving a trailing parenthetical wrapper but
 * also uppercasing its content (e.g. `Hero (cont'd)` → `HERO (CONT'D)`).
 *
 * @param {string} line
 * @returns {string}
 */
function uppercaseFountainCue(line)
{
    return line.toUpperCase();
}

/* ─────────────────────── line-op applier ────────────────────── */

/**
 * Apply a set of `{ line, transform }` ops to the source. Multiple ops on
 * the same line chain in order. Lines not referenced pass through.
 *
 * @param {string} src
 * @param {LineOp[]} ops
 * @returns {string}
 */
function applyLineOps(src, ops)
{
    const lines = src.split("\n");
    /** @type {Map<number, Array<(s: string) => string>>} */
    const byLine = new Map();
    for (const op of ops)
    {
        if (typeof op.line !== "number" || op.line < 0 || op.line >= lines.length) continue;
        let list = byLine.get(op.line);
        if (!list) { list = []; byLine.set(op.line, list); }
        list.push(op.transform);
    }
    for (const [ln, fns] of byLine)
    {
        let cur = lines[ln];
        for (const fn of fns) cur = fn(cur);
        lines[ln] = cur;
    }
    return lines.join("\n");
}
