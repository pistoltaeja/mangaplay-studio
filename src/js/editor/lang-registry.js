// @ts-check
/**
 * lang-registry.js — map a filename to a format ID and the CM6 language
 * extensions to load for that format.
 *
 * Static imports because `initEditor` is called synchronously from app.js.
 * A "general-text" branch still returns an empty array so unknown file
 * types skip the grammar attachment entirely.
 */

import { mangaplay } from "./codemirror-lang-mangaplay.js";
import { fountain } from "./codemirror-lang-fountain.js";
import { mangaplayHighlighting } from "./mangaplay-highlight.js";
import { combinedLinter, lazySpellcheckLinter } from "./combined-linter.js";
import { editorSnippets } from "./editor-snippets.js";
import { editorTypingAutos } from "./editor-typing-autos.js";
import { editorPageFold } from "./editor-page-fold.js";
import { editorFoldPersistence } from "./editor-fold-persistence.js";
import { editorLineIndent } from "./editor-line-indent.js";
import { editorPanelTagStyle } from "./editor-panel-tag-style.js";
import { editorBracketMatch } from "./editor-bracket-match.js";
import { editorPageRegion } from "./editor-page-region.js";
import { editorMetaRegion } from "./editor-meta-region.js";
import { editorInlineEmphasis } from "./editor-inline-emphasis.js";
import { editorStylePreview } from "./editor-style-preview.js";
import { editorStyleTags } from "./editor-style-tags.js";
import { getSpellcheckConfig } from "../spellcheck/spellcheck-state.js";
// spellcheck-linter.js / harper-linter.js / harper.js are deliberately NOT
// imported here — combinedLinter() and lazySpellcheckLinter() both
// dynamic-import them inside the lint callback. The Fountain branch uses
// lazySpellcheckLinter (spell-only, no parser warnings — Fountain isn't
// .mangaplay), the Mangaplay branch uses combinedLinter (parser + spell).

/**
 * @typedef {"mangaplay" | "fountain" | "superscript" | "superscript-bin" | "general-text"} EditorFormat
 */

/**
 * Classify a filename by extension.
 *
 *   *.sup.md            → "superscript"
 *   *.sup               → "superscript-bin"  (binary; not editable in place)
 *   *.mangaplay.md / *.mangaplay → "mangaplay"
 *   *.fountain.md / *.fountain   → "fountain"
 *   anything else       → "general-text"
 *
 * @param {string | null | undefined} name
 * @returns {EditorFormat}
 */
export function formatForFilename(name)
{
    const n = (name || "").toLowerCase();
    if (n.endsWith(".sup.md")) return "superscript";
    if (n.endsWith(".sup")) return "superscript-bin";
    if (n.endsWith(".mangaplay.md") || n.endsWith(".mangaplay")) return "mangaplay";
    if (n.endsWith(".fountain.md") || n.endsWith(".fountain")) return "fountain";
    return "general-text";
}

/**
 * Return the CM6 language extensions array for `format`.
 *
 * SuperScript reuses the Mangaplay highlight grammar for v1 — the surface
 * syntax overlaps enough (PAGE / Panel / all-caps cues / indented dialogue)
 * that highlighting is approximately correct. A native SuperScript Lezer
 * grammar can replace this later without breaking the routing.
 *
 * Thin delegator to `buildEditorExtensions(format, "hot")`. Behaviour is
 * byte-identical to the pre-refactor implementation.
 *
 * @param {EditorFormat} format
 * @returns {import("@codemirror/state").Extension[]}
 */
export function languageExtensionsFor(format)
{
    return buildEditorExtensions(format, "hot");
}

/**
 * Return the CM6 extension array for `format` at a given `role`.
 *
 * `"hot"` returns the full interactive set (grammar + highlight + linter +
 * snippets + typing-autos + all decoration/fold/region plugins). Byte-
 * identical to the previous `languageExtensionsFor(format)` output.
 *
 * `"warm"` returns the presentation-only subset: grammar, highlighting,
 * page-fold, meta-region, page-region, panel-tag-style, inline-emphasis,
 * line-indent view plugin, fold persistence. Drops linter, snippets, and
 * typing-autos — interactive extensions that need focus to fire.
 *
 * The aggregate view wraps the full extension list in a CM6 Compartment so
 * hot ↔ warm transitions can swap via `compartment.reconfigure(...)`
 * without destroying the EditorView. Single-file mode does not use
 * compartments — it calls this with role="hot" once at build time.
 *
 * Extension order is preserved across roles for CM6 precedence stability.
 *
 * @param {EditorFormat} format
 * @param {"hot" | "warm"} [role]
 * @returns {import("@codemirror/state").Extension[]}
 */
export function buildEditorExtensions(format, role = "hot")
{
    if (format === "general-text" || format === "superscript-bin")
    {
        return [];
    }
    const isHot = role === "hot";
    if (format === "fountain")
    {
        /** @type {import("@codemirror/state").Extension[]} */
        const out = [
            fountain(),
            mangaplayHighlighting()
        ];
        if (isHot)
        {
            out.push(lazySpellcheckLinter(getSpellcheckConfig));
        }
        out.push(...editorInlineEmphasis());
        out.push(...editorStylePreview());
        out.push(...editorStyleTags());
        return out;
    }
    // mangaplay + superscript share the Mangaplay grammar + highlight today.
    /** @type {import("@codemirror/state").Extension[]} */
    const out = [
        mangaplay(),
        mangaplayHighlighting()
    ];
    if (isHot)
    {
        out.push(editorSnippets());
        out.push(combinedLinter(getSpellcheckConfig, format));
        out.push(...editorTypingAutos(format));
    }
    out.push(...editorPageFold());
    out.push(editorFoldPersistence());
    out.push(...editorLineIndent());
    out.push(...editorPanelTagStyle());
    out.push(...editorBracketMatch());
    out.push(...editorPageRegion());
    out.push(...editorMetaRegion());
    out.push(...editorInlineEmphasis());
    out.push(...editorStylePreview());
    out.push(...editorStyleTags());
    return out;
}

/**
 * Strip the format-revealing extension suffix(es) from a filename basename
 * so it can be used as a display label.
 *
 *   "salaryman.mangaplay.md"      → "salaryman"
 *   "salaryman.mangaplay"         → "salaryman"
 *   "Big-Fish.fountain"           → "Big-Fish"
 *   "Big-Fish.fountain.md"        → "Big-Fish"
 *   "scratch.sup.md"              → "scratch"
 *   "scratch.sup"                 → "scratch"
 *   "untitled.txt"                → "untitled" (single trailing extension stripped)
 *   "untitled"                    → "untitled"
 *   ""                            → ""
 *
 * @param {string | null | undefined} basename
 * @returns {string}
 */
export function stripFormatExtensions(basename)
{
    if (!basename) return "";
    const n = String(basename);
    // Strip recognised double extensions first.
    const doubles = [".mangaplay.md", ".fountain.md", ".sup.md"];
    for (const ext of doubles)
    {
        if (n.toLowerCase().endsWith(ext))
        {
            return n.slice(0, n.length - ext.length);
        }
    }
    // Strip recognised single extensions.
    const singles = [".mangaplay", ".fountain", ".sup", ".md", ".txt"];
    for (const ext of singles)
    {
        if (n.toLowerCase().endsWith(ext))
        {
            return n.slice(0, n.length - ext.length);
        }
    }
    return n;
}
