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

    // Panel headings: keep tokenizer-driven styling minimal — colour
    // only, no size or weight bump. The H3 visual styling lives on the
    // `.cm-mp-panel-confirmed` class emitted by editor-page-region.js,
    // which gates the bump on "cursor is NOT on this row" so the user
    // doesn't see the line jitter while typing `Panel 1`.
    { tag: tags.heading2, color: "var(--cm-mp-panel-color)" },

    // Title cards: italic, accent purple
    { tag: tags.heading3, fontStyle: "italic", color: "#6a1b9a" },

    // Character cues: NO styling from the tokenizer-driven highlight —
    // it fires on any column-0 ALL-CAPS line, including mid-typed ones
    // (`D`, `DE`, `DEL` of `DELHI`), which jitter visually. The bold +
    // near-black H3 styling is applied by editor-page-region.js via
    // the `cm-mp-cue-confirmed` class, gated on "line shape matches the
    // canonical 4-space-indented cue form" — only fires once the
    // promote has run (Enter committed the cue).
    { tag: tags.keyword, textTransform: "uppercase" },

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
 * Three visual categories distinguished at a glance:
 *   .cm-mp-error  — red wavy underline (objective error)
 *   .cm-mp-style  — orange dotted underline (case/style nit)
 *   .cm-mp-hint   — green wavy underline (low-priority canonical-form hint)
 *
 * Light + dark variants via CSS custom properties on `.cm-content`. The dark
 * variant kicks in when the host page sets [data-theme="dark"] on either
 * <html> or the editor root.
 */
const mangaplayLintTheme = EditorView.baseTheme({
    "&": {
        "--cm-mp-error": "#E03E3E",
        "--cm-mp-style": "#E08600",
        "--cm-mp-hint": "#8BC34A",
        "--cm-mp-tooltip-bg": "#ffffff",
        "--cm-mp-tooltip-fg": "#1a1a1a",
        "--cm-mp-tooltip-border": "#d0d4dc",
        "--cm-mp-page-color": "#000000",
        "--cm-mp-panel-color": "#000000",
        "--cm-mp-sfx-color": "#c62828",
        "--cm-mp-chevron-color": "#9ca3af"
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
        color: "var(--cm-mp-page-color)",
        // Pin the heading line-height so the .cm-line bounding box matches
        // its visual extent. With `line-height: normal` on a 1.275em font,
        // the browser distributes half-leading above + below the glyphs,
        // pushing the bounding box ~3-4px past the visible text. CM6's
        // posAtCoords then resolves clicks in that buffer zone back onto
        // the heading row, making the adjacent action line hard to hit.
        lineHeight: "1.3"
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
    ".cm-mp-hint": {
        textDecoration: "wavy underline",
        textDecorationColor: "var(--cm-mp-hint)",
        textDecorationSkipInk: "none"
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
    ".cm-diagnostic-info": { borderLeftColor: "var(--cm-mp-hint)" },

    // Quick-fix [Change] button inside info-severity diagnostic tooltips.
    // Green to match the wavy hint squiggle.
    ".cm-diagnostic-info .cm-diagnosticAction": {
        backgroundColor: "var(--cm-mp-hint)",
        color: "#ffffff",
        border: "none",
        borderRadius: "4px",
        padding: "2px 10px",
        marginLeft: "6px",
        fontSize: "12px",
        fontWeight: "500",
        cursor: "pointer"
    },
    ".cm-diagnostic-info .cm-diagnosticAction:hover": {
        filter: "brightness(1.1)"
    },

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
        color: "var(--cm-mp-chevron-color)",
        position: "relative"
    },
    ".cm-mp-page-chevron > .cm-mp-page-chevron-glyph": {
        position: "absolute",
        // Anchor in pixels — the parent .cm-line scales for page headings,
        // so em-based offsets would drift with font size. Pixels keep the
        // chevron at a fixed distance from the text edge.
        // The .cm-content reserves a 53px left gutter (app.css) for the
        // chevron. Card lines also apply 20px paddingLeft — the chevron
        // rides with the line, so we offset back into the gutter strip
        // far enough that the glyph sits OUTSIDE the card border.
        left: "-52px",
        // Centre the 24px glyph against the page-heading line box: top:50%
        // + translateY(-50%) ignores font-scale drift, so the chevron sits
        // mid-row regardless of the H1 line-height. The -2px marginTop
        // compensates for the lucide chevron's viewBox padding (the visible
        // mark sits ~2px below the SVG box centre).
        top: "50%",
        marginTop: "-2px",
        opacity: "1",
        lineHeight: "1",
        display: "inline-flex",
        alignItems: "center",
        transform: "translateY(-50%)"
    },
    ".cm-mp-page-chevron > .cm-mp-page-chevron-glyph > svg": {
        display: "block"
    },
    ".cm-mp-page-chevron:hover > .cm-mp-page-chevron-glyph": { opacity: "1.0" },

    // CM6 fold placeholder — hidden entirely. The chevron alone signals
    // fold state; no trailing ellipsis needed.
    ".cm-foldPlaceholder": {
        display: "none"
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
    // NOTE: spacing between cards is intentionally NOT done with
    // `margin-top` / `margin-bottom` on `.cm-line`. CM6's coordsAtPos and
    // the browser's hit-test disagree on whether the margin belongs to the
    // line above or below — clicks land one or two lines off-target. We
    // use inner padding instead, which is part of the line box for both
    // CM and the browser.
    ".cm-mp-page-region-start": {
        borderTop: "1px solid var(--rule)",
        borderLeft: "1px solid var(--rule)",
        borderRight: "1px solid var(--rule)",
        borderTopLeftRadius: "8px",
        borderTopRightRadius: "8px",
        paddingTop: "10px",
        paddingLeft: "20px",
        paddingRight: "20px"
    },
    ".cm-mp-page-region-mid": {
        borderLeft: "1px solid var(--rule)",
        borderRight: "1px solid var(--rule)",
        paddingLeft: "20px",
        paddingRight: "20px",
        // Taller row height for action / panel / dialogue lines without
        // bumping the font size. 1.55 leaves ~6px more breathing room per
        // line vs the default `normal` (~1.2) line-height.
        lineHeight: "1.55"
    },
    ".cm-mp-page-region-end": {
        borderBottom: "1px solid var(--rule)",
        borderLeft: "1px solid var(--rule)",
        borderRight: "1px solid var(--rule)",
        borderBottomLeftRadius: "8px",
        borderBottomRightRadius: "8px",
        paddingBottom: "10px",
        paddingLeft: "20px",
        paddingRight: "20px",
        lineHeight: "1.55"
    },
    ".cm-mp-page-region-collapsed": {
        border: "1px solid var(--rule)",
        borderRadius: "8px",
        padding: "10px 20px",
        // When a page is folded, the trailing blank that would normally
        // render as the inter-card gutter is swallowed by CM6's fold
        // range. Restore the visual gap with a 14px bottom margin on the
        // collapsed row itself.
        marginBottom: "14px"
    },
    // Blank lines between a `# Page` heading and its first child (or after
    // the last action line, before the next `# Page`) get hidden so the
    // card hugs its content. Source text is preserved on disk — only the
    // rendered row collapses.
    ".cm-mp-page-region-hidden": {
        display: "none"
    },
    // First non-blank line under a page heading (e.g. `Panel 1`). Add a
    // small top padding so the body has visual breathing room from the
    // heading without re-introducing the hidden blank row.
    ".cm-mp-page-region-first-body": {
        paddingTop: "4px"
    },
    // Confirmed Panel heading — H3 size + bold weight. The class is
    // applied by editor-page-region.js ONLY when the cursor is not on
    // this row, so typing `Panel 1` doesn't jitter the line height. The
    // styling snaps in once the user moves off via Enter or arrow keys.
    ".cm-mp-panel-confirmed": {
        fontSize: "1.125em",
        fontWeight: "bold"
    },
    // Confirmed CHARACTER cue — bold + near-black. Applied by
    // editor-page-region.js only when the line text matches the
    // canonical 4-space-indented all-caps form (i.e. after the
    // ALL-CAPS+Enter promote has run). Mid-typed column-0 ALL-CAPS
    // lines don't match the regex, so the styling stays out of the
    // typing flow.
    ".cm-mp-cue-confirmed": {
        fontWeight: "bold",
        color: "#1a1a1a"
    },
    // Inter-card gutter — blank line(s) AFTER the last non-blank line of a
    // page region, before the next `# Page` heading. Painted as a fixed
    // 14px-tall blank row with no border, no padding. Implemented as
    // padding (not margin) to preserve hit-test fidelity — `.cm-line`
    // margins cause CM6's coordsAtPos and the browser hit-test to
    // disagree, mis-routing clicks by one or two lines.
    ".cm-mp-page-region-gutter": {
        height: "14px",
        lineHeight: "14px",
        padding: "0",
        border: "none",
        // Hide any caret-blink the user might land on with arrow keys.
        // The blank line is still navigable; the cursor is just invisible
        // — matches the hidden-blank rows above/below the card content.
        color: "transparent",
        // Visually + functionally inert: the user must not be able to
        // drag-select into the gap between cards (it represents a doc
        // newline they didn't intend to touch). userSelect:none blocks
        // text-selection; pointerEvents:none routes clicks past the row
        // so they land on whichever card sits below.
        userSelect: "none",
        pointerEvents: "none"
    },
    // Suppress the native selection highlight on the gutter row itself —
    // the doc-position range can still SPAN the gutter (e.g. when the
    // user drag-selects from card A into card B), but the `::selection`
    // pseudo-element rendering must paint nothing on the gutter row.
    // Without this rule WebView2 paints the blue highlight band across
    // the empty 14px gap even though `user-select:none` blocks starting
    // a selection inside it.
    ".cm-mp-page-region-gutter::selection, .cm-mp-page-region-gutter *::selection": {
        backgroundColor: "transparent !important",
        color: "transparent !important"
    },

    // Title-page meta-region borders. Emitted by editor-meta-region.js.
    // Same `--rule` token and radius as the page-region cards.
    ".cm-mp-meta-region-start": {
        borderTop: "1px solid var(--rule)",
        borderLeft: "1px solid var(--rule)",
        borderRight: "1px solid var(--rule)",
        borderTopLeftRadius: "8px",
        borderTopRightRadius: "8px",
        paddingTop: "10px",
        paddingLeft: "20px",
        paddingRight: "20px"
    },
    ".cm-mp-meta-region-mid": {
        borderLeft: "1px solid var(--rule)",
        borderRight: "1px solid var(--rule)",
        paddingLeft: "20px",
        paddingRight: "20px"
    },
    ".cm-mp-meta-region-end": {
        borderBottom: "1px solid var(--rule)",
        borderLeft: "1px solid var(--rule)",
        borderRight: "1px solid var(--rule)",
        borderBottomLeftRadius: "8px",
        borderBottomRightRadius: "8px",
        paddingBottom: "10px",
        paddingLeft: "20px",
        paddingRight: "20px"
    },
    ".cm-mp-meta-region-collapsed": {
        border: "1px solid var(--rule)",
        borderRadius: "8px",
        padding: "10px 20px"
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
        "--cm-mp-hint": "#AED581",
        "--cm-mp-tooltip-bg": "#1f2228",
        "--cm-mp-tooltip-fg": "#e8e8e8",
        "--cm-mp-tooltip-border": "#3a3f48",
        "--cm-mp-page-color": "#e8e8e8",
        "--cm-mp-panel-color": "#e8e8e8",
        "--cm-mp-sfx-color": "#FF6B6B",
        "--cm-mp-chevron-color": "#6b7280"
    },
    "html[data-theme=\"dark\"] & .cm-cursor, body[data-theme=\"dark\"] & .cm-cursor, html[data-theme=\"dark\"] & .cm-dropCursor, body[data-theme=\"dark\"] & .cm-dropCursor": {
        borderLeftColor: "#e8e8e8"
    },
});


export function mangaplayHighlighting() {
    return [
        syntaxHighlighting(mangaplayHighlightStyle),
        mangaplayLintTheme,
        mangaplayLintThemeDark
    ];
}
