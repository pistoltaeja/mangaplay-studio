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
 * @param {{ settings?: { skin?: string, colorScheme?: string, leftPaneWidth?: number | null, storyboardWidth?: number | null, leftPaneCollapsed?: boolean, storyboardCollapsed?: boolean, viewMode?: string, lastSoloMode?: string, activeSubview?: string } } | undefined} [options]
 *   App-wide settings. Drives shell layout, plus stamps `<html data-skin>`
 *   as a redundant FOUC guarantee in case `skins.js`'s `applySkin` hasn't
 *   run yet. If a legacy `colorScheme` field is present (upgrade from a
 *   pre-skins build) it is migrated one-shot to `skin` and persisted so
 *   the sanitiser drops the unknown key on next save.
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

    // Mobile / tablet UX modes hide the left-pane collapse-toggle button
    // entirely, so the user has no way to un-collapse the left pane. Force
    // it collapsed. The STORYBOARD pane on mobile is driven by the FAB
    // view-toggle now (solo-mangaplay ↔ solo-storyboard) — force-collapsing
    // it here would hide the storyboard even when the user selected it via
    // the FAB, because data-storyboard-collapsed translates the stack
    // off-screen with opacity 0 regardless of view-mode.
    const forceCollapsedForMobile = (root.getAttribute("data-ux-mode") === "mobile"
        || root.getAttribute("data-ux-mode") === "tablet");
    if (chrome && (settings.leftPaneCollapsed === true || forceCollapsedForMobile))
    {
        chrome.setAttribute("data-left-pane-collapsed", "");
    }
    if (chrome && settings.storyboardCollapsed === true && !forceCollapsedForMobile)
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

    /** @type {string | null} */
    let appliedLastSolo = null;
    if (settings.lastSoloMode === "solo-screenplay" || settings.lastSoloMode === "solo-storyboard")
    {
        appliedLastSolo = settings.lastSoloMode;
    }

    // Active subview — stamp on #left-pane pre-paint so the subview panels
    // don't flash the wrong one. Strict enum validation happens later in
    // app.js's boot path; here we accept any non-empty string.
    if (typeof settings.activeSubview === "string" && settings.activeSubview.length > 0)
    {
        const leftPane = document.getElementById("left-pane");
        if (leftPane)
        {
            leftPane.setAttribute("data-subview", settings.activeSubview);
        }
    }

    // Settings: stamp <html data-skin> as a redundant FOUC guarantee. The
    // actual <link> swap is in skins.js's applySkin which boot calls earlier;
    // this just stamps the attribute in case it hasn't run.
    //
    // One-shot migration for upgraders — if `skin` is absent AND the legacy
    // `colorScheme` is set, map light→default / dark→night, stamp the
    // attribute, and persist through Tauri so the sanitiser drops the
    // unknown `colorScheme` key on the next save. The migration path is
    // deliberately narrow — it never runs again once `settings.skin` is set.
    let effectiveSkin = null;
    if (typeof settings.skin === "string" && settings.skin.length > 0)
    {
        effectiveSkin = settings.skin;
    }
    else if (typeof settings.colorScheme === "string")
    {
        effectiveSkin = settings.colorScheme === "dark" ? "night" : "default";
        // Fire-and-forget persist. Any failure here just means the migration
        // re-runs on the next boot — harmless.
        try
        {
            // @ts-ignore — dynamic import to avoid pulling Tauri into the
            // shell-restore module's static graph (kept small for jsdom tests).
            import("@tauri-apps/api/core")
                .then((mod) => mod.invoke("app_settings_set", { value: { skin: effectiveSkin } }))
                .catch(() => {});
        }
        catch (_) { /* not in Tauri — jsdom test etc. */ }
    }
    if (effectiveSkin !== null)
    {
        document.documentElement.setAttribute("data-skin", effectiveSkin);
    }

    return { viewMode: appliedViewMode, lastSoloMode: appliedLastSolo };
}
