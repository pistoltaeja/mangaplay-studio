// @ts-check
/**
 * mangaplay-highlight.js — Highlight style mapping for .mangaplay elements.
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const mangaplayHighlightStyle = HighlightStyle.define([
    // Page headings: H1-scale, bold, black. Colour themable via
    // --cm-mp-page-color (default #000000). Declared in the mangaplayLintTheme
    // baseTheme `&` block below.
    //
    // No `marginTop` here: an extra top margin on the line gets added/removed
    // as the chevron mounts/unmounts mid-typing, causing layout jitter. The
    // visual gap above a page break comes from the natural line-height of the
    // 1.8em heading text instead.
    { tag: tags.heading1, fontWeight: "bold", fontSize: "1.275em", color: "var(--cm-mp-page-color)" },

    // Panel headings: slightly larger than body, bold, black (themable).
    { tag: tags.heading2, fontWeight: "500", fontSize: "1.025em", color: "var(--cm-mp-panel-color)" },

    // Title cards: italic, accent purple
    { tag: tags.heading3, fontStyle: "italic", color: "#6a1b9a" },

    // Character cues: uppercase brown
    { tag: tags.keyword, textTransform: "uppercase", color: "#5d4037", fontWeight: "600" },

    // Dialogue: dark grey
    { tag: tags.string, color: "#212121" },

    // Parenthetical: italic mid-grey
    { tag: tags.meta, fontStyle: "italic", color: "#616161" },

    // Action: dark grey
    { tag: tags.content, color: "#212121" },

    // SFX: red caps (themable via --cm-mp-sfx-color).
    { tag: tags.emphasis, color: "var(--cm-mp-sfx-color)", textTransform: "uppercase", fontWeight: "600" },

    // Transitions: subtle slate
    { tag: tags.controlKeyword, color: "#455a64", fontStyle: "italic" },

    // Notes: muted
    { tag: tags.comment, color: "#9e9e9e", fontStyle: "italic" },

    // Centered / lyrics
    { tag: tags.contentSeparator, color: "#546e7a", fontStyle: "italic" },

    // Page breaks: subtle
    { tag: tags.lineComment, color: "#bdbdbd" },

    // Title page keys: bold amber
    { tag: tags.definitionKeyword, color: "#b8860b", fontWeight: "600" },
]);

/**
 * Lint-decoration theme for .mangaplay diagnostics.
 *
 * Two visual categories distinguished at a glance:
 *   .cm-mp-error  — red wavy underline (objective error)
 *   .cm-mp-style  — orange dotted underline (case/style nit)
 *
 * Light + dark variants via CSS custom properties on `.cm-content`. The dark
 * variant kicks in when the host page sets [data-theme="dark"] on either
 * <html> or the editor root.
 */
const mangaplayLintTheme = EditorView.baseTheme({
    "&": {
        "--cm-mp-error": "#E03E3E",
        "--cm-mp-style": "#E08600",
        "--cm-mp-tooltip-bg": "#ffffff",
        "--cm-mp-tooltip-fg": "#1a1a1a",
        "--cm-mp-tooltip-border": "#d0d4dc",
        "--cm-mp-page-color": "#000000",
        "--cm-mp-panel-color": "#000000",
        "--cm-mp-sfx-color": "#c62828"
    },

    // Reserve a left strip in the content column so the chevron can sit in
    // it without pushing real text right. All non-indented lines (Page,
    // Panel, Action) share the same left edge inside this padded column.
    ".cm-content": {
        paddingLeft: "1.8em",
        fontFamily: "var(--mps-font-editor-body, var(--mps-font-app))"
    },

    // CM6's base StyleModule puts `font-family` on .cm-scroller (not
    // .cm-content), so an unscoped .cm-content rule wouldn't actually
    // change the rendered glyphs — the scroller's family inherits down
    // unless we override it here as well.
    ".cm-scroller": {
        fontFamily: "var(--mps-font-editor-body, var(--mps-font-app))"
    },

    // Class-based fallback for the page heading. The Lezer tokenizer in
    // mangaplay-tokens.js only emits PageHeadingTok for canonical `# Page N`
    // (i.e. requires a digit after `# Page `). Until the user has typed the
    // digit, mid-typed lines (`#`, `# `, `# P`, `# Pa`, ...) fall through to
    // `ActionTok` and would paint as #212121 dark grey, jittering up to H1
    // black the moment the digit arrives.
    //
    // The chevron decoration mounts as soon as the line matches `^#(\s|$)`
    // (see editor-page-fold.js), so anchoring the H1 styling to chevron
    // presence via :has() gives a stable visual from the first keystroke. No
    // marginTop here — it would expand/collapse with the chevron and jitter
    // layout. Same selector also covers uppercase `# PAGE` / lowercase
    // `# page` fixtures where the tokenizer skips PageHeadingTok.
    ".cm-line:has(.cm-mp-page-chevron)": {
        fontSize: "1.275em",
        fontWeight: "600",
        color: "var(--cm-mp-page-color)"
    },

    // Caret colour. CM6's default caret uses border-left with currentColor,
    // which on a light background can render near-white from dampened body
    // text. Force black so the cursor is always visible against the page.
    // Dark variant overrides this in `mangaplayLintThemeDark` below.
    ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "#000000",
        borderLeftWidth: "2px"
    },
    ".cm-mp-error": {
        textDecoration: "wavy underline",
        textDecorationColor: "var(--cm-mp-error)",
        textDecorationSkipInk: "none"
    },
    ".cm-mp-style": {
        borderBottom: "1px dotted var(--cm-mp-style)",
        textDecoration: "none"
    },
    ".cm-tooltip-lint": {
        backgroundColor: "var(--cm-mp-tooltip-bg)",
        color: "var(--cm-mp-tooltip-fg)",
        border: "1px solid var(--cm-mp-tooltip-border)",
        borderRadius: "6px",
        padding: "8px 10px",
        fontSize: "13px",
        lineHeight: "1.4",
        maxWidth: "480px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.12)"
    },
    ".cm-diagnostic": {
        padding: "2px 4px",
        borderLeftWidth: "3px"
    },
    ".cm-diagnostic-error": { borderLeftColor: "var(--cm-mp-error)" },
    ".cm-diagnostic-warning": { borderLeftColor: "var(--cm-mp-error)" },
    ".cm-diagnostic-info": { borderLeftColor: "var(--cm-mp-style)" },

    // Page-heading chevron (replaces leading `# ` via Decoration.replace).
    // Zero-width inline container — sits exactly where `# ` used to be, but
    // its glyph is absolute-positioned into the .cm-content left padding so
    // the remaining `Page N` text stays flush with all other column-0 lines
    // (Panel, action, etc).
    ".cm-line": {
        position: "relative"
    },
    ".cm-mp-page-chevron": {
        display: "inline-block",
        width: "0",
        userSelect: "none",
        cursor: "pointer",
        color: "var(--cm-mp-page-color)",
        position: "relative"
    },
    ".cm-mp-page-chevron > .cm-mp-page-chevron-glyph": {
        position: "absolute",
        // Anchor in pixels — the parent .cm-line scales for page headings,
        // so em-based offsets would drift with font size. Pixels keep the
        // chevron at a fixed distance from the text edge.
        left: "-26px",
        top: "0",
        opacity: "1",
        lineHeight: "1",
        display: "inline-flex",
        alignItems: "center",
        // Vertical-centre the 20px SVG against the page heading text.
        transform: "translateY(0.35em)"
    },
    ".cm-mp-page-chevron > .cm-mp-page-chevron-glyph > svg": {
        display: "block"
    },
    ".cm-mp-page-chevron:hover > .cm-mp-page-chevron-glyph": { opacity: "1.0" },

    // CM6 fold placeholder — unobtrusive ellipsis after a folded page.
    ".cm-foldPlaceholder": {
        backgroundColor: "transparent",
        border: "none",
        color: "#9e9e9e",
        margin: "0 0.25em",
        padding: "0",
        fontStyle: "italic"
    },

    // Character cue / dialogue body whole-line indents. Emitted by
    // editor-line-indent.js as `Decoration.line` so they apply to the
    // entire line box (not just the inline text). Anchored from the
    // .cm-content padded edge — the 4-space prefix is preserved in the
    // doc; the padding-left simply shifts the line visually further in.
    ".cm-mp-line-cue": {
        paddingLeft: "2.5em"
    },
    ".cm-mp-line-dialogue": {
        paddingLeft: "1.5em"
    },

    // Bracketed Panel tags (`[BLEED]`, `[L]`, `[H]`...). Painted purple
    // from editor-panel-tag-style.js. Weight 600 keeps the tags legible
    // against the Panel-heading scale.
    ".cm-mp-panel-tag": {
        color: "#7c4dff",
        fontWeight: "600"
    },

    // Page-region borders. Emitted by editor-page-region.js as line
    // decorations. The collapsed variant draws a complete box around
    // the single visible heading row; the start/mid/end variants stitch
    // a multi-line box around the expanded region. `--rule` is the
    // canonical subtle-border token defined in app.css.
    ".cm-mp-page-region-start": {
        borderTop: "1px solid var(--rule)",
        borderLeft: "1px solid var(--rule)",
        borderRight: "1px solid var(--rule)"
    },
    ".cm-mp-page-region-mid": {
        borderLeft: "1px solid var(--rule)",
        borderRight: "1px solid var(--rule)"
    },
    ".cm-mp-page-region-end": {
        borderBottom: "1px solid var(--rule)",
        borderLeft: "1px solid var(--rule)",
        borderRight: "1px solid var(--rule)",
        marginBottom: "12px"
    },
    ".cm-mp-page-region-collapsed": {
        border: "1px solid var(--rule)",
        marginBottom: "12px"
    }
});

// Dark-theme overrides. Defined as a baseTheme scoped via `[data-theme="dark"]`
// on the host <html>/<body>. CM6's `EditorView.theme(..., { dark: true })` flag
// does NOT auto-gate the rules to the host's data-theme attribute — it merely
// marks the theme as dark. Without an explicit host-attribute selector, both
// light and dark vars would coexist and the later-defined dark vars would
// overwrite the light vars unconditionally (the bug that left Panel headings
// painted #e8e8e8 grey instead of #000000 black in light mode).
const mangaplayLintThemeDark = EditorView.baseTheme({
    "html[data-theme=\"dark\"] &, body[data-theme=\"dark\"] &": {
        "--cm-mp-error": "#FF6B6B",
        "--cm-mp-style": "#FFB454",
        "--cm-mp-tooltip-bg": "#1f2228",
        "--cm-mp-tooltip-fg": "#e8e8e8",
        "--cm-mp-tooltip-border": "#3a3f48",
        "--cm-mp-page-color": "#e8e8e8",
        "--cm-mp-panel-color": "#e8e8e8",
        "--cm-mp-sfx-color": "#FF6B6B"
    },
    "html[data-theme=\"dark\"] & .cm-mp-page-chevron, body[data-theme=\"dark\"] & .cm-mp-page-chevron": {
        color: "#e8e8e8"
    },
    "html[data-theme=\"dark\"] & .cm-foldPlaceholder, body[data-theme=\"dark\"] & .cm-foldPlaceholder": {
        color: "#777"
    },
    "html[data-theme=\"dark\"] & .cm-cursor, body[data-theme=\"dark\"] & .cm-cursor, html[data-theme=\"dark\"] & .cm-dropCursor, body[data-theme=\"dark\"] & .cm-dropCursor": {
        borderLeftColor: "#e8e8e8"
    }
});

export function mangaplayHighlighting() {
    return [
        syntaxHighlighting(mangaplayHighlightStyle),
        mangaplayLintTheme,
        mangaplayLintThemeDark
    ];
}
