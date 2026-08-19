// @ts-check
/**
 * Strict-Fountain external line tokenizer for Lezer.
 *
 * One token per line. Token type is decided by the first significant
 * character(s) on the line plus a few suffix checks (the `TO:` transition
 * tail). Block-level only — inline emphasis (*…*, **…**, ***…***, _…_) is
 * not tokenized here; the line container is one of the broad types below
 * and the CM6 highlight layer styles the line as a whole.
 *
 * Token order intentionally matches the .grammar file:
 *   TitlePageEntryTok, SceneHeadingTok, CharacterCueTok, DialogueTok,
 *   ParentheticalTok, TransitionTok, CenteredTok, LyricTok, NoteTok,
 *   BoneyardTok, PageBreakTok, SectionTok, SynopsisTok, ActionTok,
 *   ForcedActionTok, blank
 *
 * Term IDs are imported from the generated terms file.
 */

import { ExternalTokenizer } from "@lezer/lr";
import {
    TitlePageEntryTok,
    SceneHeadingTok,
    CharacterCueTok,
    DialogueTok,
    ParentheticalTok,
    TransitionTok,
    CenteredTok,
    LyricTok,
    NoteTok,
    BoneyardTok,
    PageBreakTok,
    SectionTok,
    SynopsisTok,
    ActionTok,
    ForcedActionTok,
    blank,
} from "./fountain.grammar.terms.js";
import { isUpper, isLower, isLetter, isDigit, isSpace } from "./char-classes.js";

/**
 * Returns true when the line is a Fountain title-page entry:
 *   `Key: value` at column 0, key is alpha-only, key not all uppercase
 *   (avoids matching `SPEAKER:` as a title-page entry).
 *
 * @param {(off:number)=>number} peek
 * @param {number} lineLen
 */
function looksLikeTitlePageEntry(peek, lineLen)
{
    let i = 0;
    let sawLower = false;
    while (i < lineLen)
    {
        const c = peek(i);
        if (c === 58)
        {
            // Colon found. Require at least one char of key.
            return i > 0 && sawLower;
        }
        if (isLower(c)) sawLower = true;
        if (!isLetter(c) && c !== 32 && c !== 9) return false;
        i++;
    }
    return false;
}

/**
 * Returns true when the entire run [0, lineLen) is uppercase-or-allowed
 * (digits, spaces, dots, parens, hyphens, slashes). Used for character cues.
 *
 * @param {(off:number)=>number} peek
 * @param {number} lineLen
 */
function isAllCapsLine(peek, lineLen)
{
    let hasLetter = false;
    for (let i = 0; i < lineLen; i++)
    {
        const c = peek(i);
        if (isUpper(c)) { hasLetter = true; continue; }
        if (isSpace(c)) continue;
        if (isDigit(c)) continue;
        if (c === 40 || c === 41 || c === 46 || c === 45 || c === 47) continue;
        return false;
    }
    return hasLetter;
}

export const lineTokens = new ExternalTokenizer((input) =>
{
    if (input.next < 0) return;

    // Run of blank lines.
    if (input.next === 10)
    {
        let len = 1;
        while (input.peek(len) === 10) len++;
        input.acceptToken(blank, len);
        return;
    }

    // Compute the length of this line (including the trailing \n if any).
    let len = 0;
    while (input.peek(len) !== 10 && input.peek(len) >= 0) len++;
    if (input.peek(len) === 10) len++;
    if (len === 0) return;

    const lineLen = input.peek(len - 1) === 10 ? len - 1 : len;
    const peek = (off) => input.peek(off);
    const ch0 = peek(0);
    const ch1 = peek(1);
    const ch2 = peek(2);

    // Note: [[…]]
    if (ch0 === 91 && ch1 === 91)
    {
        input.acceptToken(NoteTok, len);
        return;
    }

    // Boneyard: /* … */
    if (ch0 === 47 && ch1 === 42)
    {
        input.acceptToken(BoneyardTok, len);
        return;
    }

    // Section: leading `#`, `##`, `###` …
    if (ch0 === 35)
    {
        input.acceptToken(SectionTok, len);
        return;
    }

    // Synopsis: leading `= ` (not `===` which is a page break).
    if (ch0 === 61)
    {
        // Count run of '=' to disambiguate from PageBreak.
        let eqCount = 0;
        while (eqCount < lineLen && peek(eqCount) === 61) eqCount++;
        if (eqCount >= 3)
        {
            input.acceptToken(PageBreakTok, len);
            return;
        }
        input.acceptToken(SynopsisTok, len);
        return;
    }

    // Centered: leading `>` (Transition forced is also `>` — disambiguate by
    // trailing `<`). When the line ends in `<` (ignoring whitespace) it's
    // Centered; otherwise it's a forced Transition.
    if (ch0 === 62)
    {
        // Walk back from end-of-line to find the last non-space char.
        let last = lineLen - 1;
        while (last > 0 && isSpace(peek(last))) last--;
        if (peek(last) === 60)
        {
            input.acceptToken(CenteredTok, len);
            return;
        }
        input.acceptToken(TransitionTok, len);
        return;
    }

    // Lyric: leading `~`
    if (ch0 === 126)
    {
        input.acceptToken(LyricTok, len);
        return;
    }

    // Forced action: leading `!`
    if (ch0 === 33)
    {
        input.acceptToken(ForcedActionTok, len);
        return;
    }

    // Forced scene heading: leading `.` followed by a non-`.` char (so we
    // don't catch `...`-style action lines).
    if (ch0 === 46 && ch1 !== 46)
    {
        input.acceptToken(SceneHeadingTok, len);
        return;
    }

    // Forced character cue: leading `@`
    if (ch0 === 64)
    {
        input.acceptToken(CharacterCueTok, len);
        return;
    }

    // Scene heading slugs: INT., EXT., EST., INT./EXT., I/E
    if ((ch0 === 73 || ch0 === 69) && lineLen >= 2)
    {
        // Read the first whitespace-delimited word, uppercased.
        let pos = 0;
        let word = "";
        while (pos < lineLen && !isSpace(peek(pos)))
        {
            word += String.fromCharCode(peek(pos));
            pos++;
        }
        const upper = word.toUpperCase();
        if (upper === "INT." || upper === "EXT." || upper === "EST." ||
            upper === "INT./EXT." || upper === "I/E")
        {
            input.acceptToken(SceneHeadingTok, len);
            return;
        }
    }

    // Parenthetical: leading `(` (optionally indented). Per Fountain,
    // parentheticals appear inside a dialogue block; we recognise the line
    // shape and let the highlight layer style it.
    if (ch0 === 40)
    {
        input.acceptToken(ParentheticalTok, len);
        return;
    }

    // Indented dialogue (some authors / converters use leading spaces).
    if (ch0 === 32)
    {
        let sp = 0;
        while (sp < lineLen && peek(sp) === 32) sp++;
        if (sp >= 2)
        {
            input.acceptToken(DialogueTok, len);
            return;
        }
    }
    if (ch0 === 9)
    {
        input.acceptToken(DialogueTok, len);
        return;
    }

    // Transition: line ending in `TO:` (case-insensitive). Fountain also
    // accepts `FADE OUT.` and `FADE IN:` as transition-like markers.
    if (lineLen >= 3)
    {
        const c1 = peek(lineLen - 1);
        const c2 = peek(lineLen - 2);
        const c3 = peek(lineLen - 3);
        // ":" + upper "O" + upper "T" → TO:
        if (c1 === 58 && (c2 === 79 || c2 === 111) && (c3 === 84 || c3 === 116))
        {
            // Confirm uppercase line (Fountain transitions are all-caps).
            if (isAllCapsLine(peek, lineLen))
            {
                input.acceptToken(TransitionTok, len);
                return;
            }
        }
    }
    if (lineLen >= 9)
    {
        let line = "";
        for (let i = 0; i < lineLen; i++) line += String.fromCharCode(peek(i));
        const upper = line.toUpperCase();
        if (upper.includes("FADE OUT.") || upper.startsWith("FADE IN:"))
        {
            input.acceptToken(TransitionTok, len);
            return;
        }
    }

    // Title-page entry: `Key: value` style. Must come BEFORE character cue
    // so `Title: My Movie` doesn't get tokenized as a cue.
    if (isLetter(ch0) && looksLikeTitlePageEntry(peek, lineLen))
    {
        input.acceptToken(TitlePageEntryTok, len);
        return;
    }

    // Character cue: all-caps line at column 0. Cues may have a trailing
    // `(O.S.)` / `(V.O.)` / `(CONT'D)` modifier — isAllCapsLine permits
    // parens, dots, hyphens, digits.
    if (isUpper(ch0) && isAllCapsLine(peek, lineLen))
    {
        input.acceptToken(CharacterCueTok, len);
        return;
    }

    // Default: action.
    input.acceptToken(ActionTok, len);
});
