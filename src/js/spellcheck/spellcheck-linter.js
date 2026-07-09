// @ts-check
/**
 * spellcheck-linter.js — CM6 `linter()` source that drives Harper over
 * the prose-bearing ranges of the active document.
 *
 * Tier A (en-US / en-GB):
 *   - Walks the Lezer tree via `proseRanges(state)`.
 *   - Concatenates the prose into one string with `\n` separators and
 *     keeps an offset table so Harper's relative spans can be mapped
 *     back to absolute doc positions.
 *   - Calls `lintEnglish(text, dialect)` and surfaces each result as a
 *     CM6 `Diagnostic` with quick-fix `actions` (top 5 suggestions).
 *
 * Tier B (de, es, fr, it, pt, ru, vi, ko):
 *   v1 returns `[]`. The `contenteditable spellcheck="true"` on source
 *   and visual modes carries spelling for these locales; retext-spell +
 *   Hunspell dictionaries are deliberately deferred — they would add
 *   ~6 MB to the bundle and the native WebView2 spellchecker covers the
 *   common case. Tracked as a follow-up in `desktop-spellcheck-grammar.md`.
 *
 * Tier C, D, OFF:
 *   No-op (`[]`).
 *
 * Debounce: 400 ms via CM6's `delay` option — coarser than the parser
 * linter (250 ms) because Harper's worker bounce + WASM cost dwarfs the
 * keystroke cadence.
 */

import { proseRanges } from "../editor/lezer-prose-ranges.js";
import { parseScript } from "../../../../core/parser/fountain-plus-mangaplay-parser.js";

// harper-linter.js (which imports the 1.5 MB harper.js bundle + WASM) is
// lazy-loaded inside runSpellcheckLinter so the bundle never lands until
// a Tier-A lint pass actually fires. Cached as a module-level promise so
// repeat passes don't re-import.
/** @type {Promise<typeof import("./harper-linter.js")>|null} */
let harperModulePromise = null;
function loadHarperModule()
{
    if (!harperModulePromise)
    {
        harperModulePromise = import("./harper-linter.js");
    }
    return harperModulePromise;
}

/**
 * Gather every word that should NOT be flagged as a spelling error:
 *   - ast.metadata.characters  (title-page `Characters:` list)
 *   - ast.metadata.vocabulary  (title-page `Vocabulary:` list)
 *   - every detected character cue (panel.dialogue[].character)
 *   - the author's name (title-page `Author:` / `Writer:` / `By:`)
 *
 * Multi-word names are split on whitespace AND hyphens so `Pistol Taeja` →
 * `Pistol`, `Taeja` and `Truck-kun` → `Truck`, `kun`. Tokens shorter than
 * two characters are dropped (Harper's dictionary already covers `a` / `I`,
 * and one-letter tokens are usually punctuation artefacts).
 *
 * @param {any} ast
 * @returns {string[]}
 */
function collectVocabulary(ast)
{
    /** @type {Set<string>} */
    const out = new Set();
    const push = (s) =>
    {
        if (!s) return;
        for (const part of String(s).split(/[\s\-]+/))
        {
            const w = part.trim();
            if (w.length >= 2) out.add(w);
        }
    };
    const meta = ast?.metadata || {};
    if (Array.isArray(meta.characters)) for (const c of meta.characters) push(c);
    if (Array.isArray(meta.vocabulary)) for (const v of meta.vocabulary) push(v);
    // Author from title-page metadata — never flag the author's own name.
    if (typeof meta.author === "string") push(meta.author);
    // Auto-detect cues from dialogue across every parsed panel.
    for (const page of (ast?.pages || []))
    {
        for (const panel of (page.panels || []))
        {
            for (const d of (panel.dialogue || []))
            {
                if (d?.character) push(String(d.character).replace(/^@/, ""));
            }
        }
    }
    return [...out];
}

/**
 * Decide the CM6 severity + markClass for a Harper lint result. Harper's
 * `LintKind` enum has 20 categories; we collapse them into three buckets:
 *   - Spelling / Typo  → error (red squiggle)
 *   - Readability / Style → info (orange dotted)
 *   - everything else  → warning (orange dotted)
 * @param {any} lint
 * @returns {{ severity: "error"|"warning"|"info", markClass: string }}
 */
function severityFor(lint)
{
    let kind = "";
    try { kind = String(lint?.lint_kind?.() || ""); }
    catch (_) { kind = ""; }
    if (kind === "Spelling" || kind === "Typo") return { severity: "error", markClass: "cm-mp-error" };
    if (kind === "Readability" || kind === "Style") return { severity: "info", markClass: "cm-mp-style" };
    return { severity: "warning", markClass: "cm-mp-style" };
}

/**
 * Pull the Harper span (start/end character offsets within the lint payload).
 * `Span` exposes `start` / `end` as numeric fields, not methods.
 * @param {any} lint
 * @returns {{ start: number, end: number } | null}
 */
function spanFor(lint)
{
    try
    {
        const s = lint?.span?.();
        if (!s) return null;
        const start = s.start;
        const end = s.end;
        if (typeof start !== "number" || typeof end !== "number") return null;
        return { start, end };
    }
    catch (_) { return null; }
}

/**
 * Read top-N suggestion replacement texts. Honours `SuggestionKind.Remove`
 * (kind === 1) — those return an empty `get_replacement_text()` but the
 * empty string IS the valid replacement (delete the span).
 * @param {any} lint
 * @param {number} max
 * @returns {string[]}
 */
function suggestionsFor(lint, max)
{
    /** @type {string[]} */
    const out = [];
    try
    {
        const list = lint?.suggestions?.() || [];
        for (let i = 0; i < list.length && out.length < max; i++)
        {
            const s = list[i];
            if (!s || typeof s.get_replacement_text !== "function") continue;
            const text = s.get_replacement_text();
            if (typeof text !== "string") continue;
            // SuggestionKind.Remove (1) legitimately returns "" — accept it.
            let kind = 0;
            try { kind = typeof s.kind === "function" ? s.kind() : 0; }
            catch (_) { kind = 0; }
            if (text.length === 0 && kind !== 1) continue;
            out.push(text);
        }
    }
    catch (_) { /* ignore */ }
    return out;
}

/**
 * Run the spellcheck pipeline once and return Diagnostic[]. Designed so
 * combined-linter.js can race this against a deadline inside a single
 * CM6 lint source.
 *
 * @param {() => { tier: string, dialect?: any, hunspellId?: string }} getCfg
 * @param {import("@codemirror/view").EditorView} view
 * @returns {Promise<import("@codemirror/lint").Diagnostic[]>}
 */
export async function runSpellcheckLinter(getCfg, view)
{
    let cfg;
    try { cfg = getCfg(); }
    catch (_) { return []; }

    if (!cfg || cfg.tier === "OFF" || cfg.tier === "C" || cfg.tier === "D")
    {
        return [];
    }
    // Tier B — retext+Hunspell wiring is deferred. See module header.
    if (cfg.tier === "B") return [];

    // Tier A — Harper. Lazy-load the harper module on first lint.
    /** @type {typeof import("./harper-linter.js")} */
    let harper;
    try { harper = await loadHarperModule(); }
    catch (_) { return []; }

    // Register script-specific vocabulary (character cues, title-page
    // Characters:/Vocabulary: lists, author name) on Harper's user
    // dictionary before linting so proper nouns and honorifics aren't
    // flagged as spelling errors. Idempotent — ensureDictionary() dedupes
    // on the worker side.
    try
    {
        const source = view.state.doc.toString();
        const ast = parseScript(source);
        const words = collectVocabulary(ast);
        if (words.length > 0) await harper.ensureDictionary(words);
    }
    catch (_) { /* fail open — at worst we get more false positives */ }

    const ranges = proseRanges(view.state);
    if (ranges.length === 0) return [];

    // Build the concat string + an offset table so Harper spans map
    // back to absolute doc positions. Each entry: { concatStart,
    // concatEnd, absStart }. We use "\n" as the separator so Harper
    // still sees paragraph breaks.
    let concat = "";
    /** @type {Array<{ concatStart: number, concatEnd: number, absStart: number }>} */
    const offsets = [];
    for (let i = 0; i < ranges.length; i++)
    {
        const r = ranges[i];
        const start = concat.length;
        concat += r.text;
        offsets.push({ concatStart: start, concatEnd: concat.length, absStart: r.from });
        if (i < ranges.length - 1) concat += "\n";
    }

    /** @type {any[]} */
    let lints;
    try { lints = await harper.lintEnglish(concat, cfg.dialect); }
    catch (_) { return []; }

    /** @type {import("@codemirror/lint").Diagnostic[]} */
    const diagnostics = [];

    for (const lint of lints)
    {
        const span = spanFor(lint);
        if (!span) continue;

        // Map concat span back to absolute doc range. The entry whose
        // [concatStart, concatEnd] covers `span.start` is our hit.
        let entry = null;
        for (const e of offsets)
        {
            if (span.start >= e.concatStart && span.start <= e.concatEnd)
            {
                entry = e;
                break;
            }
        }
        if (!entry) continue;

        const from = entry.absStart + (span.start - entry.concatStart);
        const to = entry.absStart + (span.end - entry.concatStart);
        if (to <= from) continue;

        const { severity, markClass } = severityFor(lint);

        let message = "";
        try { message = String(lint?.message?.() || ""); }
        catch (_) { message = ""; }

        /** @type {import("@codemirror/lint").Action[]} */
        const actions = [];
        for (const replacement of suggestionsFor(lint, 5))
        {
            actions.push({
                name: replacement,
                apply(v, aFrom, aTo)
                {
                    v.dispatch({ changes: { from: aFrom, to: aTo, insert: replacement } });
                }
            });
        }

        diagnostics.push({
            from,
            to,
            severity,
            message: message || "Spelling",
            markClass,
            actions
        });
    }

    return diagnostics;
}

