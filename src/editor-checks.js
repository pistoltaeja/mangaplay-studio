// @ts-check
/**
 * editor-checks.js — Editor-side grammar checks that the parser does NOT emit.
 *
 * Pure functions. Take a parsed AST (and, for unknownPanelTags, the raw source)
 * and return ParseWarning-shaped objects. The linter merges these with the
 * parser's own warnings into a single Diagnostic stream.
 *
 * Why not in the parser:
 *   The parser is a re-export shim from @fountain-plus/storyboard, shared across
 *   the website, the extension, and the desktop app. These checks are desktop-
 *   editor heuristics — out-of-order numbering and tag-typo correction — that
 *   only make sense as live editing aids.
 */

import { extractTags, classifyTags } from "../../core/parser/tag-classifier.js";

/**
 * @typedef {Object} EditorWarning
 * @property {string} code            - 'EDITOR_PAGE_OUT_OF_ORDER' | 'EDITOR_PANEL_OUT_OF_ORDER' | 'EDITOR_PAGE_DUPLICATE' | 'EDITOR_PANEL_DUPLICATE' | 'EDITOR_UNKNOWN_PANEL_TAG' | 'EDITOR_CHARACTER_CASE'
 * @property {Array<string|number>} args
 * @property {number} line            - 0-based line number
 * @property {number} [column]        - 0-based column
 * @property {number} [length]        - Length of offending text
 * @property {'warning' | 'info'} severity
 */

/**
 * Classify a page-id suffix into all possible {roman, letter, numeric}
 * interpretations with their ordinal values (1-based). Returns an array
 * of candidates — usually length 1, but length 2 for single characters
 * that are both a letter A-Z AND a roman digit (I, V, X, L, C, D, M).
 *
 * Empty array means the suffix doesn't match any known progression
 * (e.g. "COVER", "FRONT").
 *
 * Examples:
 *   "I"   → [{kind:"letter", value:9}, {kind:"roman", value:1}]
 *   "IV"  → [{kind:"roman", value:4}]
 *   "A"   → [{kind:"letter", value:1}]
 *   "C"   → [{kind:"letter", value:3}, {kind:"roman", value:100}]
 *   "3"   → [{kind:"numeric", value:3}]
 *   "COVER" → []
 *
 * @param {string} suffix
 * @returns {Array<{ kind: "roman"|"letter"|"numeric", value: number }>}
 */
function classifySuffix(suffix)
{
    if (typeof suffix !== "string" || suffix.length === 0) return [];
    if (/^\d+$/.test(suffix)) return [{ kind: "numeric", value: parseInt(suffix, 10) }];
    const upper = suffix.toUpperCase();
    const isSingleLetter = /^[A-Z]$/.test(upper);
    const isRomanOnly    = /^[IVXLCDM]+$/.test(upper);
    /** @type {Array<{ kind: "roman"|"letter"|"numeric", value: number }>} */
    const out = [];
    if (isSingleLetter)
    {
        out.push({ kind: "letter", value: upper.charCodeAt(0) - 64 });
    }
    if (isRomanOnly)
    {
        const v = romanToNumber(upper);
        if (v !== null) out.push({ kind: "roman", value: v });
    }
    return out;
}

/**
 * From a list of suffix candidates, pick the one that continues the
 * previous group (same kind, value = previous + 1). Returns null if no
 * candidate continues the group.
 *
 * @param {Array<{ kind: string, value: number }>} candidates
 * @param {{ kind: string, value: number } | null} prev
 * @returns {{ kind: string, value: number } | null}
 */
function pickContinuation(candidates, prev)
{
    if (!prev) return null;
    for (const c of candidates)
    {
        if (c.kind === prev.kind && c.value === prev.value + 1) return c;
    }
    return null;
}

/**
 * From a list of suffix candidates, pick the "best" first-of-group entry
 * when there's no prior context. Prefers roman over letter when both are
 * available — roman page IDs (`0-I, 0-II`) are the convention in manga,
 * letter IDs (`1-A, 1-B`) tend to start with `A` which is unambiguous.
 *
 * @param {Array<{ kind: string, value: number }>} candidates
 * @returns {{ kind: string, value: number } | null}
 */
function pickFirst(candidates)
{
    if (candidates.length === 0) return null;
    const roman = candidates.find(c => c.kind === "roman");
    if (roman) return roman;
    return candidates[0];
}

/**
 * Convert a roman numeral string (uppercase) to its integer value.
 * Validates that the input is a well-formed roman numeral — returns
 * null for malformed inputs like "IIII" or "VV".
 *
 * @param {string} s
 * @returns {number | null}
 */
function romanToNumber(s)
{
    const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let total = 0;
    for (let i = 0; i < s.length; i++)
    {
        const cur = map[s[i]];
        const nxt = map[s[i + 1]];
        if (!cur) return null;
        if (nxt && cur < nxt) { total += nxt - cur; i++; }
        else total += cur;
    }
    // Round-trip check: re-serialise and compare to detect malformed
    // inputs like "IIII" (should be IV) or "VV" (should be X).
    if (numberToRoman(total) !== s) return null;
    return total;
}

/**
 * Convert an integer to its canonical uppercase roman numeral.
 * @param {number} n
 * @returns {string}
 */
function numberToRoman(n)
{
    if (n <= 0 || n >= 4000) return "";
    const table = [
        [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
        [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
        [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]
    ];
    let out = "";
    for (const [v, sym] of table)
    {
        while (n >= v) { out += sym; n -= v; }
    }
    return out;
}

/**
 * Walk ast.pages[] and flag any page whose `baseNumber` is not previous + 1.
 * Ranges (`# Page 1-3`) are treated as starting at baseNumber and "consuming"
 * up through the suffix end (e.g. 1-3 → next expected page is 4).
 *
 * Roman / letter suffix subsequences within the same baseNumber are
 * recognised as valid continuations: `# Page 0-I → 0-II → 0-III` produces
 * zero warnings; the next expected page is 1. Skipping inside a subsequence
 * (`0-I → 0-III`) flags an out-of-order warning at the skipped page.
 * Mixing suffix kinds (`0-I → 0-A`) also flags.
 *
 * @param {any} ast
 * @returns {EditorWarning[]}
 */
export function sequentialPages(ast)
{
    /** @type {EditorWarning[]} */
    const out = [];
    if (!ast || !Array.isArray(ast.pages)) return out;

    /** @type {number|null} */
    let expectedBase = null;
    /** @type {{ baseNumber: number, kind: string, value: number } | null} */
    let lastSuffixGroup = null;
    /** @type {{ baseNumber: number, suffix: string } | null} */
    let prevPageId = null;

    for (const page of ast.pages)
    {
        if (typeof page.baseNumber !== "number") continue;
        const actual = page.baseNumber;
        const rawSuffix = typeof page.suffix === "string" ? page.suffix : "";
        const candidates = page.suffix ? classifySuffix(page.suffix) : [];

        // Magnitude rule for numeric suffixes: `# Page N-M`
        //   - M > N  → range (`Page 1-3` = pages 1, 2, 3). Advances cursor.
        //   - M ≤ N  → sub-page (`Page 10-1` = sub-page 1 of page 10).
        //              Doesn't advance cursor; opens a numeric-subpage group
        //              so `Page 10-2` can continue cleanly.
        // The `numeric-subpage` and `numeric` (range) kinds are disambiguated
        // here based on (suffix value, baseNumber) — `classifySuffix` returns
        // `numeric` for any digit string and we re-tag it.
        const reclassifiedCandidates = candidates.map((c) =>
        {
            if (c.kind === "numeric" && c.value <= actual)
            {
                return { kind: "numeric-subpage", value: c.value };
            }
            return c;
        });

        // Duplicate detection: identical baseNumber + suffix as previous page.
        // Emits EDITOR_PAGE_DUPLICATE (no [Change] action) and short-circuits
        // the out-of-order check so the user isn't shown two warnings on
        // the same line.
        const isDuplicate = prevPageId
            && actual === prevPageId.baseNumber
            && rawSuffix.toUpperCase() === prevPageId.suffix.toUpperCase();

        if (isDuplicate)
        {
            out.push({
                code: "EDITOR_PAGE_DUPLICATE",
                args: [actual],
                line: typeof page.lineNumber === "number" ? page.lineNumber : 0,
                column: 0,
                length: 0,
                severity: "warning"
            });
            prevPageId = { baseNumber: actual, suffix: rawSuffix };
            continue;
        }

        // Continuation of an EXISTING suffix group (e.g. `10-I → 10-II`,
        // `10-1 → 10-2`, `10-A → 10-B`). Same baseNumber as the open group
        // and next-value in the same kind.
        const continuation = (lastSuffixGroup && actual === lastSuffixGroup.baseNumber)
            ? pickContinuation(reclassifiedCandidates, lastSuffixGroup)
            : null;

        const isSuffixContinuation = continuation !== null;

        // OPENING a NEW sub-page group after a plain base page. This is the
        // user's exact case: `Page 10 → Page 10-1`. After plain `Page 10`,
        // expectedBase was bumped to 11 and no group was opened. The next
        // page is `10-1` (or `10-I`, `10-A`) — baseNumber 10, NOT 11. Allow
        // this WITHOUT an out-of-order warning when:
        //   - actual is exactly one less than expectedBase, AND
        //   - the current page has a sub-page-form suffix (roman / letter /
        //     numeric-subpage), AND
        //   - there's no OPEN suffix group at this base (otherwise this is
        //     a skip within the group like 10-I → 10-III, which should warn
        //     via the continuation check).
        const subPageKinds = new Set(["roman", "letter", "numeric-subpage"]);
        // Prefer roman > letter > numeric-subpage when a suffix is ambiguous
        // (e.g. "I" is both letter#9 AND roman#1). pickFirst already prefers
        // roman; filter to sub-page kinds first so we don't pick "numeric".
        const firstSubPage = pickFirst(reclassifiedCandidates.filter((c) => subPageKinds.has(c.kind)));
        const groupAtThisBase = lastSuffixGroup
            && lastSuffixGroup.baseNumber === actual;
        const isSubPageOfPrevBase = !isSuffixContinuation
            && !groupAtThisBase
            && expectedBase !== null
            && actual === expectedBase - 1
            && firstSubPage !== undefined;

        // SKIP within an OPEN suffix group: `10-I → 10-III` (missing II).
        // Continuation is null because III ≠ II, but we have an open group
        // at base 10. Flag as out-of-order so the user sees the gap.
        const isInGroupSkip = !isSuffixContinuation
            && groupAtThisBase
            && firstSubPage !== undefined;

        if (isInGroupSkip)
        {
            // Skip within a sub-page group (e.g. 10-I → 10-III missed II).
            // Args: expected next value in the group, actual value.
            out.push({
                code: "EDITOR_PAGE_OUT_OF_ORDER",
                args: [lastSuffixGroup.value + 1, firstSubPage.value],
                line: typeof page.lineNumber === "number" ? page.lineNumber : 0,
                column: 0,
                length: 0,
                severity: "warning"
            });
        }
        else if (expectedBase !== null
            && actual !== expectedBase
            && !isSuffixContinuation
            && !isSubPageOfPrevBase)
        {
            out.push({
                code: "EDITOR_PAGE_OUT_OF_ORDER",
                args: [expectedBase, actual],
                line: typeof page.lineNumber === "number" ? page.lineNumber : 0,
                column: 0,
                length: 0,
                severity: "warning"
            });
        }

        if (isSuffixContinuation)
        {
            // Stay within the open group; bump only the suffix tracker.
            lastSuffixGroup = {
                baseNumber: actual,
                kind: continuation.kind,
                value: continuation.value
            };
            // expectedBase stays put.
        }
        else if (isInGroupSkip)
        {
            // Treat the skip as a forward jump within the same group so
            // subsequent pages continue from the new position rather than
            // re-flagging every step. Match the kind of the suffix the
            // user actually wrote, in case the group kind drifted.
            lastSuffixGroup = {
                baseNumber: actual,
                kind: firstSubPage.kind,
                value: firstSubPage.value
            };
            // expectedBase stays put.
        }
        else if (isSubPageOfPrevBase)
        {
            // Open a new sub-page group anchored at the prev base. Don't
            // bump expectedBase — sub-pages don't consume a page number.
            lastSuffixGroup = {
                baseNumber: actual,
                kind: firstSubPage.kind,
                value: firstSubPage.value
            };
        }
        else
        {
            // Start a new suffix group at the current base, OR a range, OR
            // a plain page with no suffix. Advance expectedBase past the
            // consumed range.
            const firstSuffix = pickFirst(reclassifiedCandidates);
            let consumedTo = actual;
            // Only the RANGE form (numeric M > N) consumes additional base
            // numbers; numeric-subpage does not.
            if (firstSuffix && firstSuffix.kind === "numeric")
            {
                if (firstSuffix.value > consumedTo) consumedTo = firstSuffix.value;
            }
            expectedBase = consumedTo + 1;

            // Open a sub-page group if the suffix is sub-page-shaped
            // (roman / letter / numeric-subpage). Numeric-range (`1-3`)
            // does NOT open a group — it just advances expectedBase.
            if (firstSuffix && subPageKinds.has(firstSuffix.kind))
            {
                lastSuffixGroup = {
                    baseNumber: actual,
                    kind: firstSuffix.kind,
                    value: firstSuffix.value
                };
            }
            else
            {
                lastSuffixGroup = null;
            }
        }

        prevPageId = { baseNumber: actual, suffix: rawSuffix };
    }

    return out;
}

/**
 * For each page, walk panels[] and flag any panel whose `displayNumber` is not
 * previous + 1. Ranges like `Panel 1-3` advance the cursor to 4.
 *
 * @param {any} ast
 * @returns {EditorWarning[]}
 */
export function sequentialPanels(ast)
{
    /** @type {EditorWarning[]} */
    const out = [];
    if (!ast || !Array.isArray(ast.pages)) return out;

    for (const page of ast.pages)
    {
        if (!Array.isArray(page.panels)) continue;
        let expected = null;
        let prevDisplayNumber = null;
        for (const panel of page.panels)
        {
            const actual = panel.displayNumber;
            if (typeof actual !== "number") continue;

            // Duplicate detection: identical displayNumber as the previous
            // panel in this page. Emits EDITOR_PANEL_DUPLICATE (no [Change]
            // action) and short-circuits the out-of-order check.
            if (prevDisplayNumber !== null && actual === prevDisplayNumber)
            {
                out.push({
                    code: "EDITOR_PANEL_DUPLICATE",
                    args: [actual],
                    line: typeof panel.lineNumber === "number" ? panel.lineNumber : 0,
                    column: 0,
                    length: 0,
                    severity: "warning"
                });
                prevDisplayNumber = actual;
                continue;
            }

            if (expected !== null && actual !== expected)
            {
                out.push({
                    code: "EDITOR_PANEL_OUT_OF_ORDER",
                    args: [expected, actual],
                    line: typeof panel.lineNumber === "number" ? panel.lineNumber : 0,
                    column: 0,
                    length: 0,
                    severity: "warning"
                });
            }
            expected = actual + 1;
            prevDisplayNumber = actual;
        }
    }

    return out;
}

/**
 * Detect dialogue character cues that aren't ALL-CAPS. Mangaplay convention
 * is ALL-CAPS speakers (NARRATOR, DOROTHY). The parser accepts mixed-case
 * via the Fountain forced-cue path, but the visual editor surfaces this as
 * a fixable structural issue.
 *
 * @param {any} ast
 * @returns {EditorWarning[]}
 */
export function characterCueCase(ast)
{
    /** @type {EditorWarning[]} */
    const out = [];
    if (!ast || !Array.isArray(ast.pages)) return out;
    for (const page of ast.pages)
    {
        const panels = page.panels ?? [];
        for (const panel of panels)
        {
            const dialogue = panel.dialogue ?? [];
            for (const d of dialogue)
            {
                const name = (d && typeof d.character === "string") ? d.character : "";
                if (!name) continue;
                // Has any lowercase letter? Then it's not canonical.
                if (/[a-z]/.test(name))
                {
                    out.push({
                        code: "EDITOR_CHARACTER_CASE",
                        args: [name, name.toUpperCase()],
                        line: typeof panel.lineNumber === "number" ? panel.lineNumber : 0,
                        column: 0,
                        length: 0,
                        severity: "warning"
                    });
                }
            }
        }
    }
    return out;
}

/**
 * Scan the source for `Panel N [tags]` lines, extract bracketed tags, and run
 * them through classifyTags(). Any tag flagged `unknown-tag` becomes an
 * EDITOR_UNKNOWN_PANEL_TAG warning. The classifier also gives us a "did you
 * mean" suggestion when one is available.
 *
 * We work off the raw source rather than the AST because the AST loses the
 * original tag spelling (it normalises aliases away).
 *
 * @param {any} _ast        - Currently unused; signature kept for symmetry.
 * @param {string} source   - Raw .mangaplay document text.
 * @returns {EditorWarning[]}
 */
export function unknownPanelTags(_ast, source)
{
    /** @type {EditorWarning[]} */
    const out = [];
    if (typeof source !== "string" || source.length === 0) return out;

    const lines = source.split("\n");
    // Detect any line shaped like "Panel N" with bracketed tags after it.
    // We deliberately do not anchor to a strict indent — Convention A and B
    // both produce panel lines we want to check.
    const PANEL_TAG_LINE = /^\s*Panel\s+\d+(?:-\d+)?\s*((?:\s*\[[^\[\]]+\])+)/;

    for (let i = 0; i < lines.length; i++)
    {
        const line = lines[i];
        const m = line.match(PANEL_TAG_LINE);
        if (!m) continue;
        const tagBlock = m[1];

        const tags = extractTags(tagBlock);
        if (tags.length === 0) continue;

        const classified = classifyTags(tags);
        if (!classified || !Array.isArray(classified.warnings)) continue;

        for (const w of classified.warnings)
        {
            if (w.code !== "unknown-tag") continue;
            const offending = w.offendingTag || "";
            // Locate the column of the bracketed offender in the original line
            // (case-insensitive — the classifier upper-cases for matching).
            const idx = offending
                ? line.toUpperCase().indexOf("[" + offending + "]")
                : -1;
            out.push({
                code: "EDITOR_UNKNOWN_PANEL_TAG",
                args: [
                    offending ? `[${offending}]` : "",
                    w.suggestion ? `[${w.suggestion}]` : ""
                ],
                line: i,
                column: idx >= 0 ? idx : 0,
                length: idx >= 0 ? offending.length + 2 : 0,
                severity: "warning"
            });
        }
    }

    return out;
}
