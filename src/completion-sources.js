// @ts-check
/**
 * completion-sources.js — Characters and Vocabulary autocomplete for CM6.
 */

import { autocompletion } from "@codemirror/autocomplete";

/**
 * Extract declared characters from the document text.
 * @param {string} text
 * @returns {string[]}
 */
function extractCharacters(text) {
    const match = text.match(/^Characters:\s*(.+)$/m);
    if (!match) return [];
    return match[1].split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Extract vocabulary from the document text.
 * @param {string} text
 * @returns {string[]}
 */
function extractVocabulary(text) {
    const match = text.match(/^Vocabulary:\s*(.+)$/m);
    if (!match) return [];
    return match[1].split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Read characters + vocabulary from a parsed Screenplay object.
 * Preferred over raw-regex extraction once a Screenplay is available
 * (parser already split + trimmed + filtered).
 *
 * @param {{ characters?: string[], vocabulary?: string[] }} screenplay
 * @returns {{ characters: string[], vocabulary: string[] }}
 */
export function extractFromScreenplay(screenplay) {
    return {
        characters: screenplay?.characters ?? [],
        vocabulary: screenplay?.vocabulary ?? []
    };
}

/**
 * Create a mangaplay completion source.
 * @param {object} [opts]
 * @returns {import("@codemirror/autocomplete").CompletionSource}
 */
export function mangaplayCompletions(opts = {}) {
    return (context) => {
        const doc = context.state.doc.toString();
        const characters = extractCharacters(doc);
        const vocabulary = extractVocabulary(doc);
        const word = context.matchBefore(/\w+/);
        if (!word) return null;

        const options = [];

        // Suggest characters when at start of line (no indent)
        const lineStart = context.state.doc.lineAt(context.pos);
        const beforeCursor = lineStart.text.slice(0, context.pos - lineStart.from);
        if (!beforeCursor.trim()) {
            for (const char of characters) {
                if (char.toLowerCase().startsWith(word.text.toLowerCase())) {
                    options.push({ label: char, type: "keyword", detail: "character" });
                }
            }
        }

        // Suggest vocabulary words
        for (const vocab of vocabulary) {
            if (vocab.toLowerCase().startsWith(word.text.toLowerCase())) {
                options.push({ label: vocab, type: "text", detail: "vocabulary" });
            }
        }

        return options.length > 0 ? { from: word.from, options } : null;
    };
}

/**
 * CM6 extension: mangaplay autocomplete.
 * @returns {import("@codemirror/autocomplete").Extension}
 */
export function mangaplayAutocomplete() {
    return autocompletion({
        override: [mangaplayCompletions()],
        maxRenderedOptions: 20,
    });
}
