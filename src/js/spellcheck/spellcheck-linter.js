// @ts-check
/**
 * spellcheck-linter.js — CM6 linter source that drives Harper over the
 * prose-bearing ranges of the active document.
 *
 * Architecture (read this before adding features)
 * ------------------------------------------------
 * The spellcheck pipeline has four layers, each with a single job:
 *
 *   1. lezer-prose-ranges.js  — walks the Lezer syntax tree and yields
 *      only the node types that contain user prose (Action, Dialogue,
 *      Parenthetical, Centered, Lyric, TitlePageEntry). Structural
 *      nodes (page/panel headings, character cues, scene slugs, SFX,
 *      transitions, notes, boneyard) are excluded here so Harper never
 *      sees them. If a new structural node type is added to the grammar,
 *      add it to PROSE_NODE_NAMES there — not here.
 *
 *   2. this file (spellcheck-linter.js) — concatenates the prose ranges
 *      into one string, sends it to Harper, maps Harper's spans back to
 *      absolute CM6 document positions, and applies screenplay-aware
 *      post-filters before emitting CM6 Diagnostics.
 *
 *   3. harper-linter.js — owns the singleton Harper WorkerLinter (WASM).
 *      Handles dialect resolution, worker lifecycle, user-dictionary
 *      injection, and benchmark stamping. This file is lazy-loaded
 *      (~1.5 MB) so the boot chunk stays slim.
 *
 *   4. combined-linter.js — wires the parser linter (sync, 250 ms) and
 *      spell linter (async, 400 ms) as two separate CM6 linter()
 *      extensions so parser diagnostics surface immediately even while
 *      Harper is still warming up.
 *
 * Where to make changes
 * ---------------------
 * - New screenplay-safe words: if they come from the script (character
 *   names, title-page Vocabulary), add them via collectVocabulary() →
 *   ensureDictionary(). Harper's user dictionary handles these.
 *
 * - Entire classes of false positives (e.g. ALL CAPS prop introductions):
 *   add a post-filter in the `for (const lint of lints)` loop below.
 *   This is the right layer because we have both the flagged text and
 *   the Harper lint metadata (kind, message, suggestions).
 *
 * - New node types that should/shouldn't be linted: change
 *   PROSE_NODE_NAMES in lezer-prose-ranges.js.
 *
 * - Harper config (enable/disable rules): use setLintConfig() on the
 *   WorkerLinter instance in harper-linter.js. Rule names are
 *   Record<string, boolean | null> — never hard-code rule existence,
 *   Harper adds rules across versions.
 *
 * Known upstream limitations (Harper v2.x)
 * ----------------------------------------
 * - ALL CAPS words produce bad spelling suggestions and may be
 *   misidentified as acronyms (Automattic/harper#939, #1419). We
 *   filter these out in the lint loop below.
 * - Spell suggestions for title-case and all-caps variants of the same
 *   word can suggest each other recursively (#2661).
 * - Harper's LintConfig is Record<string, boolean | null>; rule names
 *   are not guaranteed stable across versions.
 *
 * Tier system
 * -----------
 *   Tier A (en-US / en-GB): Harper — spelling + grammar + style.
 *   Tier B (de, es, fr, it, pt, ru, vi, ko): deferred retext-spell +
 *     Hunspell. v1 returns []; native WebView2 spellcheck carries load.
 *   Tier C (id): native browser spellcheck only.
 *   Tier D (ja, zh-CN, zh-TW, th): limited / no spellcheck model.
 *   OFF: master toggle disabled.
 */

import { forceLinting } from "@codemirror/lint";
import { proseRanges } from "../editor/lezer-prose-ranges.js";
import { parseScript } from "../../../../core/parser/fountain-plus-mangaplay-parser.js";
import { isIgnored, personalDictWords } from "./spellcheck-store.js";
import { scanStyleTagTokens } from "../../../../core/parser/style-tag-scanner.js";

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
        const merged = [...words, ...personalDictWords()];
        if (merged.length > 0) await harper.ensureDictionary(merged);
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

        // Screenplay convention: ALL CAPS words in prose denote prop
        // introductions, emphasis, or inline SFX ("She grabs the KNIFE").
        // Harper mishandles all-caps text (Automattic/harper#939, #1419).
        const flaggedText = concat.slice(span.start, span.end);
        if (flaggedText.length >= 2 && /^[A-Z]+$/.test(flaggedText)) continue;
        if (isIgnored(flaggedText)) continue;

        // Style-tag body filter: suppress any diagnostic whose doc range
        // falls entirely inside a [[~...]] open tag or [[~]] close tag.
        // These are syntax — not user prose — so Harper squiggles inside
        // them are always false positives.
        {
            const docLine = view.state.doc.lineAt(from);
            const lineTokens = scanStyleTagTokens(docLine.text, docLine.from);
            const insideTag = lineTokens.some(
                (tok) => from >= tok.from && to <= tok.to
            );
            if (insideTag) continue;
        }

        const { severity, markClass } = severityFor(lint);

        let message = "";
        try { message = String(lint?.message?.() || ""); }
        catch (_) { message = ""; }

        const suggestions = suggestionsFor(lint, 5);

        /** @type {import("@codemirror/lint").Action[]} */
        const actions = [];
        for (const replacement of suggestions)
        {
            actions.push({
                name: replacement,
                apply(v, aFrom, aTo)
                {
                    v.dispatch({ changes: { from: aFrom, to: aTo, insert: replacement } });
                }
            });
        }

        // "Add to personal dictionary" — lazy-loads harper module (already
        // cached after a lint pass has run, so no extra 1.5 MB fetch).
        actions.push({
            name: "Add to dictionary",
            apply(v, aFrom, aTo)
            {
                const word = v.state.doc.sliceString(aFrom, aTo);
                loadHarperModule().then((m) =>
                {
                    m.addToDictionary(word);
                    forceLinting(v);
                }).catch(() => {});
            }
        });

        // "Always correct to X" — one action per suggestion.
        for (const sugg of suggestions)
        {
            const captured = sugg;
            actions.push({
                name: `Always correct to "${captured}"`,
                apply(v, aFrom, aTo)
                {
                    const word = v.state.doc.sliceString(aFrom, aTo);
                    v.dispatch({ changes: { from: aFrom, to: aTo, insert: captured } });
                    import("../project/user-settings.js").then(({ getUserSetting, saveUserSettings }) =>
                    {
                        const existing = getUserSetting("autoCorrections", []);
                        if (!existing.some((r) => r.from === word && r.to === captured))
                        {
                            saveUserSettings({ autoCorrections: [...existing, { from: word, to: captured }] });
                        }
                    }).catch(() => {});
                }
            });
        }

        diagnostics.push({
            from,
            to,
            severity,
            message: message || "Spelling",
            markClass,
            actions,
            mpsSpellSuggestion: markClass === "cm-mp-error" && actions.length > 0,
        });
    }

    return diagnostics;
}

