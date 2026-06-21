// @ts-check
/**
 * editor-snippets.js — CM6 snippet completion source for .mangaplay structural
 * markers. Currently offers a single snippet:
 *
 *   `#` at column 0 → `# Page ${1:N}` (cursor lands on N, Tab confirms)
 *
 * Triggers automatically while typing (activateOnTyping: true) so the user can
 * see the suggestion the moment they type `#`. Tab accepts the snippet; Esc /
 * any printable character dismisses (default CM6 autocomplete behaviour).
 *
 * Co-resident with `mangaplayCompletions` from completion-sources.js: CM6's
 * autocompletion config facet only keeps the last-applied `override` array,
 * so this extension bundles BOTH sources (snippet + character/vocab) into a
 * single autocompletion() call. lang-registry no longer registers
 * `mangaplayAutocomplete()` separately — see [lang-registry.js].
 */

import { autocompletion, snippet } from "@codemirror/autocomplete";
import { mangaplayCompletions } from "./completion-sources.js";

/**
 * Completion source — fires only when the cursor is right after a `#` at
 * column 0. Returning `null` short-circuits the picker for every other
 * context, leaving room for the character/vocab source below.
 *
 * @param {import("@codemirror/autocomplete").CompletionContext} context
 * @returns {import("@codemirror/autocomplete").CompletionResult | null}
 */
function pageSnippetSource(context)
{
    const line = context.state.doc.lineAt(context.pos);
    const beforeCursor = line.text.slice(0, context.pos - line.from);

    // Only fire when the line so far is exactly `#` and we are at column 1.
    if (beforeCursor !== "#") return null;

    return {
        from: line.from,
        to: context.pos,
        options: [
            {
                label: "# Page",
                detail: "page heading",
                type: "keyword",
                apply: snippet("# Page ${1:N}")
            }
        ]
    };
}

/**
 * CM6 extension: snippet + character/vocab completions for `.mangaplay`.
 *
 * @returns {import("@codemirror/state").Extension}
 */
export function editorSnippets()
{
    return autocompletion({
        override: [pageSnippetSource, mangaplayCompletions()],
        activateOnTyping: true,
        defaultKeymap: true,
        maxRenderedOptions: 20
    });
}
