// @ts-check
/**
 * render-screenplay.js — Convert .mangaplay source to formatted screenplay text.
 *
 * Strategy: walk the source line-by-line and produce a plain-text representation
 * of the formatted screenplay, with style annotations for CM6 decorations.
 *
 * Page headings → large/bold, Panel headings → blue/bold,
 * Character cues → uppercase/brown, Dialogue → indented,
 * Parentheticals → italic/grey, SFX → red/caps,
 * Action → normal text, Notes → hidden/muted,
 * Transitions → italic/grey, etc.
 */

/**
 * @typedef {object} RenderedLine
 * @property {string} text — display text
 * @property {string} style — CSS class / decoration key
 * @property {number} indent — indent level (0-4)
 * @property {string} [prefix] — optional prefix (e.g., bullet, marker)
 */

/**
 * Line-by-line regex-based renderer for .mangaplay source.
 * Handles both flat Fountain-like format and markdown-heading variants.
 *
 * @param {string} source — raw .mangaplay.md text
 * @returns {RenderedLine[]}
 */
export function renderScreenplay(source) {
    if (!source) return [];
    const lines = source.split("\n");
    /** @type {RenderedLine[]} */
    const output = [];

    let inDialogue = false;
    let inBoneyard = false;
    let inNote = false;

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const trimmed = line.trim();

        // Multi-line boneyard tracking
        if (inBoneyard) {
            output.push({ text: line, style: "boneyard", indent: 0 });
            if (trimmed.includes("*/")) inBoneyard = false;
            continue;
        }

        // Multi-line note tracking
        if (inNote) {
            output.push({ text: line, style: "note", indent: 0 });
            if (trimmed.endsWith("]]")) inNote = false;
            continue;
        }

        // Blank line — ends dialogue block
        if (trimmed === "") {
            output.push({ text: "", style: "blank", indent: 0 });
            inDialogue = false;
            continue;
        }

        // Page heading: # Page N [scene heading]
        // Also handles "## Page N" variant
        if (/^#{1,2}\s*Page\s+\d+/i.test(trimmed)) {
            const pageNumMatch = trimmed.match(/^#{1,2}\s*Page\s+(\d+)/i);
            const pageNum = pageNumMatch ? pageNumMatch[1] : "";
            const rest = trimmed.replace(/^#{1,2}\s*Page\s+\d+\s*/i, "");
            output.push({
                text: rest || `Page ${pageNum}`,
                style: "page-heading",
                indent: 0,
                prefix: `Page ${pageNum}`,
            });
            // If there's a scene heading after the page number, emit it
            if (rest && /^(INT\.|EXT\.|EST\.|INT\.\/EXT\.|I\/E)\s/i.test(rest)) {
                output.push({
                    text: rest,
                    style: "scene-heading",
                    indent: 0,
                });
            }
            inDialogue = false;
            continue;
        }

        // Panel heading: ## Panel N or Panel N
        if (/^#{1,2}\s*Panel\s+\d+/i.test(trimmed) || /^Panel\s+\d+/i.test(trimmed)) {
            const display = trimmed.replace(/^#{1,2}\s*/, "");
            output.push({ text: display, style: "panel-heading", indent: 0 });
            inDialogue = false;
            continue;
        }

        // SFX
        if (/^SFX:?\s/i.test(trimmed)) {
            output.push({ text: trimmed, style: "sfx", indent: 0 });
            inDialogue = false;
            continue;
        }

        // Scene heading standalone (INT./EXT./etc.)
        if (/^(INT\.|EXT\.|EST\.|INT\.\/EXT\.|I\/E)\s/i.test(trimmed)) {
            output.push({ text: trimmed, style: "scene-heading", indent: 0 });
            inDialogue = false;
            continue;
        }

        // Camera direction: CLOSE ON, ANGLE ON, etc.
        if (/^(CLOSE\s+ON|ANGLE\s+ON|POV|WIDE\s+SHOT|MEDIUM\s+SHOT|TIGHT\s+ON)/i.test(trimmed)) {
            output.push({ text: trimmed, style: "transition", indent: 0 });
            inDialogue = false;
            continue;
        }

        // Transition
        if (/(TO:|FADE\s+(OUT|IN)\.?)$/i.test(trimmed) ||
            /^(CUT|DISSOLVE|WIPE|FADE|SMASH|MATCH)\s/i.test(trimmed)) {
            output.push({ text: trimmed, style: "transition", indent: 0 });
            inDialogue = false;
            continue;
        }

        // Boneyard start: /* ... */
        if (trimmed.startsWith("/*")) {
            inBoneyard = !trimmed.includes("*/");
            output.push({ text: line, style: "boneyard", indent: 0 });
            continue;
        }

        // Note: [[ ... ]]
        if (trimmed.startsWith("[[")) {
            inNote = !trimmed.endsWith("]]");
            output.push({ text: line, style: "note", indent: 0 });
            continue;
        }

        // Title page: Key: Value (single word key with colon)
        if (/^[A-Z][a-zA-Z]+:\s/.test(trimmed)) {
            output.push({ text: trimmed, style: "title-key", indent: 0 });
            continue;
        }

        // Character cue: = NAME (Markdown-style)
        if (/^=\s+[A-Z][A-Z0-9\s_().,\-]{0,60}$/.test(trimmed)) {
            const name = trimmed.replace(/^=\s+/, "").toUpperCase();
            output.push({ text: name, style: "character-cue", indent: 0 });
            inDialogue = true;
            continue;
        }

        // Character cue: ALL CAPS at column 0 (traditional Fountain)
        if (/^[A-Z][A-Z0-9\s_]{1,40}$/.test(trimmed)) {
            output.push({ text: trimmed, style: "character-cue", indent: 0 });
            inDialogue = true;
            continue;
        }

        // Parenthetical — must be before dialogue fallback
        if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
            output.push({ text: trimmed, style: "parenthetical", indent: 0 });
            continue;
        }

        // Dialogue: if inDialogue mode and not matched by any other rule
        if (inDialogue && trimmed.length > 0) {
            // Strip leading whitespace for display
            const clean = line.replace(/^\s+/, "");
            output.push({ text: clean, style: "dialogue", indent: line.length - line.trimStart().length || 2 });
            continue;
        }

        // Indented text (4 spaces or tab) — explicit dialogue
        if (line.startsWith("    ") || line.startsWith("\t")) {
            output.push({ text: line.replace(/^\s+/, ""), style: "dialogue", indent: 4 });
            continue;
        }

        // Centered: > ... <
        if (trimmed.startsWith(">") && trimmed.endsWith("<")) {
            output.push({ text: trimmed.slice(1, -1).trim(), style: "centered", indent: 0 });
            continue;
        }

        // Lyric: ~ ...
        if (trimmed.startsWith("~")) {
            output.push({ text: trimmed.slice(1).trim(), style: "lyric", indent: 0 });
            continue;
        }

        // Page break: ===
        if (/^===+$/.test(trimmed)) {
            output.push({ text: "\u2014 page break \u2014", style: "page-break", indent: 0 });
            continue;
        }

        // Comment
        if (trimmed.startsWith("//")) {
            output.push({ text: line, style: "comment", indent: 0 });
            continue;
        }

        // Forced action: !...
        if (trimmed.startsWith("!")) {
            output.push({ text: trimmed.slice(1), style: "action", indent: 0 });
            continue;
        }

        // Forced cue: @...
        if (trimmed.startsWith("@")) {
            output.push({ text: trimmed.slice(1).toUpperCase(), style: "character-cue", indent: 0 });
            inDialogue = true;
            continue;
        }

        // Title card
        if (/^TITLE\s/i.test(trimmed)) {
            output.push({ text: trimmed, style: "title-card", indent: 0 });
            continue;
        }

        // Action: default
        output.push({ text: trimmed, style: "action", indent: 0 });
        inDialogue = false;
    }

    return output;
}

/**
 * Convert rendered lines to a display string for CM6.
 * @param {RenderedLine[]} rendered
 * @returns {string}
 */
export function renderedToText(rendered) {
    return rendered
        .map((r) => {
            let line = "";
            if (r.prefix) line += r.prefix + " ";
            if (r.indent > 0) line += " ".repeat(r.indent);
            line += r.text;
            return line;
        })
        .join("\n");
}

/**
 * Generate CM6 decoration ranges from rendered lines.
 * @param {RenderedLine[]} rendered
 * @returns {Array<{from: number, to: number, style: string}>}
 */
export function renderedToDecorations(rendered) {
    /** @type {Array<{from: number, to: number, style: string}>} */
    const decorations = [];
    let offset = 0;

    for (const r of rendered) {
        let lineStart = offset;
        if (r.prefix) {
            lineStart += r.prefix.length + 1; // prefix + space
        }
        if (r.indent > 0) {
            lineStart += r.indent;
        }

        const lineEnd = lineStart + r.text.length;
        if (r.text.length > 0) {
            decorations.push({ from: lineStart, to: lineEnd, style: r.style });
        }

        offset += r.prefix ? r.prefix.length + 1 : 0;
        offset += r.indent;
        offset += r.text.length;
        offset += 1; // newline
    }

    return decorations;
}
