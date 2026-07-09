// @ts-check
/**
 * editor-line-regexes.js — shared line-shape regexes used across the editor
 * extensions. Single source of truth so the page-fold service, the
 * page-region decorator, the meta-region decorator, and the fold-persistence
 * walker can never drift apart.
 */

/** Strict page heading — `# Page N` (case-insensitive on `page`). */
export const PAGE_LINE_RE = /^# [Pp][Aa][Gg][Ee]\b/;
