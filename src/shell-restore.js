// @ts-check
/**
 * shell-restore.js — Pre-paint DOM application for persisted shell meta.
 *
 * Extracted from app.js so it can be unit-tested in jsdom without booting
 * the full app pipeline. Pure-ish: mutates DOM (its job) and returns
 * derived state so the caller can update its own `viewMode` / `lastSoloMode`
 * module-level locals.
 */

export const LEFT_PANE_MIN = 200;
export const LEFT_PANE_MAX = 600;
export const LEFT_PANE_DEFAULT = 240;
/** Storyboard pane: floor at 200px; default initial width 520px. */
export const STORYBOARD_MIN = 200;
export const STORYBOARD_DEFAULT = 520;
/**
 * Minimum editor-side width when dragging the workspace seam. Smaller than
 * STORYBOARD_MIN because the text editor stays readable at narrow widths and
 * the user often wants to grow the storyboard at the editor's expense.
 */
export const EDITOR_MIN = 200;

/**
 * Clamp a number against `[lo, hi]`. Returns `null` for non-finite or
 * out-of-range input — callers fall through to the default in that case.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number | null}
 */
export function clampOrNull(v, lo, hi)
{
    if (!Number.isFinite(v)) return null;
    if (v < lo || v > hi) return null;
    return v;
}

/**
 * Apply persisted layout to the still-hidden `#app-chrome` before the first
 * paint, so the user never sees a jitter from default layout to restored
 * layout. Shell layout (pane widths, collapse flags, view mode, active
 * subview) lives in app-wide `settings.json`; the `meta` argument is kept
 * only to remain backwards-compatible at the call site if needed.
 *
 * @param {object | null | undefined} _meta
 *   Unused. Shell layout fields now live in app settings.
 * @param {{ settings?: { colorScheme?: string, leftPaneWidth?: number | null, storyboardWidth?: number | null, leftPaneCollapsed?: boolean, storyboardCollapsed?: boolean, viewMode?: string, lastSoloMode?: string, activeSubview?: string } } | undefined} [options]
 *   App-wide settings. Drives shell layout, plus stamps `<html data-theme>`
 *   as a redundant FOUC guarantee in case `theme.js`'s `applyColorScheme`
 *   hasn't run yet.
 * @returns {{ viewMode: string | null, lastSoloMode: string | null }}
 *   Derived state for the caller to merge into its own locals.
 */
export function applyMetaBeforeFirstPaint(_meta, options = {})
{
    const settings = (options && options.settings) || null;
    if (!settings)
    {
        return { viewMode: null, lastSoloMode: null };
    }
    const chrome = document.getElementById("app-chrome");
    const root = document.documentElement;

    // Left pane width — clamp against MIN/MAX, fall through to default if invalid.
    const lp = clampOrNull(settings.leftPaneWidth, LEFT_PANE_MIN, LEFT_PANE_MAX);
    if (lp !== null)
    {
        root.style.setProperty("--left-pane-width", lp + "px");
    }

    // Storyboard width — can't clamp against workspace bounds yet (not laid out),
    // so just apply if it satisfies the lower bound. Upper bound is re-checked on
    // first rAF after chrome is visible.
    if (Number.isFinite(settings.storyboardWidth) && settings.storyboardWidth >= STORYBOARD_MIN && chrome)
    {
        chrome.style.setProperty("--storyboard-width", settings.storyboardWidth + "px");
    }

    if (settings.leftPaneCollapsed === true && chrome)
    {
        chrome.setAttribute("data-left-pane-collapsed", "");
    }
    if (settings.storyboardCollapsed === true && chrome)
    {
        chrome.setAttribute("data-storyboard-collapsed", "");
    }

    // View mode
    /** @type {string | null} */
    let appliedViewMode = null;
    const ws = document.querySelector(".workspace");
    if (ws)
    {
        const mode = (settings.viewMode === "dual"
            || settings.viewMode === "solo-mangaplay"
            || settings.viewMode === "solo-storyboard"
            || settings.viewMode === "solo-screenplay") ? settings.viewMode : null;
        if (mode !== null)
        {
            ws.setAttribute("data-view-mode", mode);
            appliedViewMode = mode;
        }
    }

    if (settings.activeSubview === "bookmarks")
    {
        const lpEl = document.getElementById("left-pane");
        if (lpEl) lpEl.setAttribute("data-subview", "bookmarks");
    }

    /** @type {string | null} */
    let appliedLastSolo = null;
    if (settings.lastSoloMode === "solo-screenplay" || settings.lastSoloMode === "solo-storyboard")
    {
        appliedLastSolo = settings.lastSoloMode;
    }

    // Settings: stamp <html data-theme> as a redundant FOUC guarantee. The
    // actual <link> swap is in theme.js's applyColorScheme which boot calls
    // earlier; this just stamps the attribute in case it hasn't run.
    if (typeof settings.colorScheme === "string")
    {
        const c = settings.colorScheme === "dark" ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", c);
    }

    return { viewMode: appliedViewMode, lastSoloMode: appliedLastSolo };
}
