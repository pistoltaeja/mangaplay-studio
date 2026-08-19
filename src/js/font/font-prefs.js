// @ts-check
/**
 * font-prefs.js — runtime user-font override for the screenplay surface.
 *
 * The website sets --mps-font-screenplay-body to its Courier Prime stack via
 * shared CSS. This module lets the user pick an explicit override (currently
 * "default" or "courier-new") which writes the chosen stack onto :root,
 * shadowing the website's default.
 *
 * Called by:
 *  - boot, with settings.screenplayFont, BEFORE the right pane paints.
 *  - the settings modal's Appearance dropdown, on change.
 */

const SCREENPLAY_STACKS = {
    "default":     '"Courier Prime", "Courier New", Courier, monospace',
    "courier-new": '"Courier New", Courier, "Liberation Mono", "DejaVu Sans Mono", monospace',
};

/**
 * Editor-font stacks for the CM6 left pane. "default" inherits the app's
 * Inter stack — the .mangaplay editor is a prose surface, not a code one.
 */
const EDITOR_STACKS = {
    "default":            'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    "courier-prime-sans": '"Courier Prime Sans", "Courier Prime", "Courier New", Courier, monospace',
};

/**
 * Apply the user's screenplay font preference.
 * @param {string} name "default" | "courier-new"
 */
export function applyScreenplayFont(name)
{
    const key = SCREENPLAY_STACKS[name] ? name : "default";
    document.documentElement.style.setProperty(
        "--mps-font-screenplay-body",
        SCREENPLAY_STACKS[key]
    );
    document.documentElement.setAttribute("data-screenplay-font", key);
    dispatchFontChange("screenplay", key);
}

/**
 * Apply the user's text-editor (CM6) font preference. Writes
 * --mps-font-editor-body on :root; the CM6 base-theme rule on .cm-content
 * and the app.css rule on .cm-scroller pick it up.
 * @param {string} name "default" | "courier-prime-sans"
 */
export function applyEditorFont(name)
{
    const key = EDITOR_STACKS[name] ? name : "default";
    document.documentElement.style.setProperty(
        "--mps-font-editor-body",
        EDITOR_STACKS[key]
    );
    document.documentElement.setAttribute("data-editor-font", key);
    dispatchFontChange("editor", key);
}

/**
 * Notify observers (currently the aggregate view's height-cache generation
 * bumper) that a font stack changed. Fires on window so listeners scoped
 * to a specific pane can attach without walking the DOM tree.
 *
 * Suppressed during boot before `document.body` exists (font-prefs is
 * called from the pre-body inline stamper in `index.html`); listeners
 * that need to hear those pre-body applies are expected to poll on
 * connect. Currently only aggregate-view.js listens and it can't mount
 * before the DOM is ready anyway, so the pre-body silence is fine.
 * @param {"editor"|"screenplay"} kind
 * @param {string} value
 */
function dispatchFontChange(kind, value)
{
    if (typeof window === "undefined" || !document.body) return;
    try
    {
        window.dispatchEvent(new CustomEvent("mps:font-change", {
            detail: { kind, value }
        }));
    }
    catch (_) { /* CustomEvent unavailable — non-fatal */ }
}
