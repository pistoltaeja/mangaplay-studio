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
import { editorLinter } from "./editor-linter.js";
import { editorSnippets } from "./editor-snippets.js";
import { editorTypingAutos } from "./editor-typing-autos.js";
import { editorPageFold } from "./editor-page-fold.js";
import { editorFoldPersistence } from "./editor-fold-persistence.js";
import { editorLineIndent } from "./editor-line-indent.js";
import { editorPanelTagStyle } from "./editor-panel-tag-style.js";
import { editorPageRegion } from "./editor-page-region.js";

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
 * @param {EditorFormat} format
 * @returns {import("@codemirror/state").Extension[]}
 */
export function languageExtensionsFor(format)
{
    if (format === "general-text" || format === "superscript-bin")
    {
        return [];
    }
    if (format === "fountain")
    {
        return [fountain(), mangaplayHighlighting()];
    }
    // mangaplay + superscript share the Mangaplay grammar + highlight today.
    // editorSnippets() bundles the `#` page snippet AND the character/vocab
    // autocomplete that used to live in mangaplayAutocomplete() — they share
    // a single autocompletion() config because CM6's `override` facet only
    // honours the last-applied value.
    return [
        mangaplay(),
        mangaplayHighlighting(),
        editorSnippets(),
        editorLinter(),
        ...editorTypingAutos(),
        ...editorPageFold(),
        editorFoldPersistence(),
        ...editorLineIndent(),
        ...editorPanelTagStyle(),
        ...editorPageRegion()
    ];
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
