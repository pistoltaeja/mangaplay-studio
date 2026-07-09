import { state } from "./state.js";
import { icon } from "../panes/icons.js";
import { refreshTooltipFor } from "../tooltip/tooltip.js";
import {
    LEFT_PANE_MIN,
    LEFT_PANE_MAX,
    STORYBOARD_MIN,
    EDITOR_MIN,
} from "../boot/shell-restore.js";
import { queueAppSettingsSave } from "../app.js";

/**
 * Set the workspace view mode and update DOM.
 * @param {'dual' | 'solo-mangaplay' | 'solo-storyboard' | 'solo-screenplay'} mode
 */
export function setViewMode(mode) {
    state.viewMode = mode;
    const ws = document.querySelector(".workspace");
    if (ws) ws.setAttribute("data-view-mode", mode);

    // Show / hide the individual view children. The CSS view-mode rules
    // also enforce visibility, but the HTML `hidden` attribute beats CSS
    // and must be cleared explicitly for the child to render at all.
    const editorEl = document.querySelector("mps-editor-host");

    // View 1 (editor) is visible in dual + solo-mangaplay
    if (editorEl) editorEl.hidden = !(mode === "dual" || mode === "solo-mangaplay");

    // View 2 children (mps-canvas / mps-screenplay) live inside
    // .right-pane-slider and their visibility is driven entirely by the
    // slider's [data-active] + CSS transforms — we no longer toggle
    // `hidden` on them here. Sync the slider's data-active based on which
    // solo mode is current.
    const showScreenplay =
        mode === "solo-screenplay" ||
        (mode === "dual" && state.lastSoloMode === "solo-screenplay");
    const slider = document.querySelector(".right-pane-slider");
    if (slider)
    {
        slider.setAttribute("data-active", showScreenplay ? "screenplay" : "storyboard");
        state.renderTopbarPagination?.();
    }

    // Track lastSoloMode for restore
    if (mode === "solo-storyboard" || mode === "solo-screenplay") {
        state.lastSoloMode = mode;
    }

    // Persist to app settings (shell layout is app-wide).
    queueAppSettingsSave({ viewMode: mode, lastSoloMode: state.lastSoloMode });
}

/** Toggle between dual and solo-mangaplay */
export function flipView() {
    // Add animation class
    document.documentElement.classList.add("view-flipping");

    if (state.viewMode === "dual") {
        setViewMode("solo-mangaplay");
    } else {
        // Restore last View 2 mode
        setViewMode(state.lastSoloMode);
    }

    // Remove animation class after transition
    setTimeout(() => {
        document.documentElement.classList.remove("view-flipping");
    }, 420);
}

/** Set View 2 solo mode */
/**
 * Storyboard / Screenplay toggle. Only swaps which View 2 child is active.
 * - If we're in `dual` mode, keep `dual` and just update lastSoloMode so the
 *   right child shows on the right pane.
 * - If we're in a solo View 2 mode, jump to the other solo View 2 mode.
 * - If we're in solo-mangaplay (editor only), switch to the chosen View 2.
 */
export function switchSolo(mode) {
    if (mode !== "solo-storyboard" && mode !== "solo-screenplay") return;
    document.documentElement.classList.add("view-flipping");
    state.lastSoloMode = mode;
    if (state.viewMode === "dual") {
        // Stay in dual; setViewMode("dual") will re-evaluate which child shows.
        setViewMode("dual");
    } else {
        setViewMode(mode);
    }
    setTimeout(() => {
        document.documentElement.classList.remove("view-flipping");
    }, 420);
}

export function wireLeftPaneResize()
{
    const handle = /** @type {HTMLElement|null} */ (document.querySelector(".left-pane-resize-handle"));
    const pane = document.getElementById("left-pane");
    if (!handle || !pane) return;

    let dragging = false;

    handle.addEventListener("pointerdown", (e) =>
    {
        dragging = true;
        handle.setPointerCapture(e.pointerId);
        // Suppress the .left-pane flex-basis transition during the drag so the
        // pane tracks the cursor instantly (mirrors the seam-resize behaviour).
        document.getElementById("app-chrome")?.setAttribute("data-resizing-left", "");
        e.preventDefault();
    });

    handle.addEventListener("pointermove", (e) =>
    {
        if (!dragging) return;
        const rect = pane.getBoundingClientRect();
        const next = Math.min(LEFT_PANE_MAX, Math.max(LEFT_PANE_MIN, e.clientX - rect.left));
        document.documentElement.style.setProperty("--left-pane-width", next + "px");
    });

    handle.addEventListener("pointerup", (e) =>
    {
        if (!dragging) return;
        dragging = false;
        handle.releasePointerCapture(e.pointerId);
        document.getElementById("app-chrome")?.removeAttribute("data-resizing-left");
        const px = parseInt(
            getComputedStyle(document.documentElement)
                .getPropertyValue("--left-pane-width"),
            10
        );
        if (Number.isFinite(px))
        {
            queueAppSettingsSave({ leftPaneWidth: px });
        }
    });
}

/**
 * Toggle `data-narrow-topbar` on #app-chrome when the storyboard pane is
 * narrow enough that the absolute-positioned [C]/[D] action buttons would
 * crowd against #topbar-storyboard-pagination's natural in-flow position. CSS reacts
 * by fading pagination + divider out so they don't half-overlap the buttons.
 *
 * Threshold derived empirically from button positions: at 280px storyboard
 * width, [C].right just clears pagination.left in the topbar.
 * @param {number} storyboardWidth
 */
export function syncNarrowTopbar(storyboardWidth)
{
    const chrome = document.getElementById("app-chrome");
    if (!chrome) return;
    if (storyboardWidth < 280)
    {
        chrome.setAttribute("data-narrow-topbar", "");
    }
    else
    {
        chrome.removeAttribute("data-narrow-topbar");
    }
}

export function wireSeamResize()
{
    const seam = /** @type {HTMLElement|null} */ (document.querySelector(".workspace-seam"));
    const workspace = document.querySelector(".workspace");
    if (!seam || !workspace) return;

    // Sync the narrow-topbar attribute against the current storyboard width
    // on boot, before the user drags anything.
    const chromeEl = document.getElementById("app-chrome");
    if (chromeEl)
    {
        const initialWidth = parseInt(
            getComputedStyle(chromeEl).getPropertyValue("--storyboard-width"),
            10
        );
        if (Number.isFinite(initialWidth)) syncNarrowTopbar(initialWidth);
    }

    let dragging = false;

    seam.addEventListener("pointerdown", (e) =>
    {
        dragging = true;
        seam.setPointerCapture(e.pointerId);
        // Tell CSS to suppress the 220ms flex-basis transition on the column
        // (and the right-offset transition on anchored buttons) so the seam
        // tracks the cursor in real time.
        document.getElementById("app-chrome")?.setAttribute("data-resizing", "");
        e.preventDefault();
    });

    seam.addEventListener("pointermove", (e) =>
    {
        if (!dragging) return;
        const rect = workspace.getBoundingClientRect();
        // Right pane (storyboard/screenplay) grows up to workspace.width - EDITOR_MIN
        // so the editor side keeps at least EDITOR_MIN px. The right pane itself
        // still respects STORYBOARD_MIN as its own floor.
        const max = Math.max(STORYBOARD_MIN, rect.width - EDITOR_MIN);
        const next = Math.min(max, Math.max(STORYBOARD_MIN, rect.right - e.clientX));
        document.getElementById("app-chrome")
            .style.setProperty("--storyboard-width", next + "px");
        syncNarrowTopbar(next);
    });

    seam.addEventListener("pointerup", (e) =>
    {
        if (!dragging) return;
        dragging = false;
        seam.releasePointerCapture(e.pointerId);
        document.getElementById("app-chrome")?.removeAttribute("data-resizing");
        const chrome = document.getElementById("app-chrome");
        const px = parseInt(
            getComputedStyle(chrome).getPropertyValue("--storyboard-width"),
            10
        );
        if (Number.isFinite(px))
        {
            queueAppSettingsSave({ storyboardWidth: px });
        }
    });
}

/**
 * Module-scope mirror of the storyboard-collapse button's visual state.
 * Both the click handler (in `wireStoryboardCollapse`) and `restoreShellMeta`
 * call this so the DOM and the persisted setting stay in lock-step.
 * @param {boolean} collapsed
 */
export function applyStoryboardCollapseState(collapsed)
{
    const btn = /** @type {HTMLElement|null} */ (document.getElementById("btn-storyboard-collapse"));
    const chrome = document.getElementById("app-chrome");
    if (!btn || !chrome) return;
    if (collapsed)
    {
        chrome.setAttribute("data-storyboard-collapsed", "");
        btn.setAttribute("data-state", "collapsed");
        btn.setAttribute("aria-pressed", "true");
        btn.setAttribute("aria-label", "Expand Storyboard/Screenplay");
        btn.setAttribute("data-tooltip", "Expand");
        btn.innerHTML = icon("panel-left-close", { size: 16, class: "icon" });
    }
    else
    {
        chrome.removeAttribute("data-storyboard-collapsed");
        btn.setAttribute("data-state", "expanded");
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", "Collapse Storyboard/Screenplay");
        btn.setAttribute("data-tooltip", "Collapse");
        btn.innerHTML = icon("columns-2", { size: 16, class: "icon" });
    }
    // If the tooltip is currently visible for this button, refresh in place
    // so the new label appears without a 350ms re-show delay.
    refreshTooltipFor(btn);
}

export function wireStoryboardCollapse()
{
    const btn = /** @type {HTMLElement|null} */ (document.getElementById("btn-storyboard-collapse"));
    const chrome = document.getElementById("app-chrome");
    if (!btn || !chrome) return;

    btn.addEventListener("click", () =>
    {
        // "View 2 visible" now means viewMode is NOT solo-mangaplay
        // (children always present in DOM; visibility driven by view-mode CSS).
        const anyVisible = state.viewMode !== "solo-mangaplay";

        if (!anyVisible)
        {
            // First click on a project with no View 2 visible: open it.
            // setViewMode("dual") respects lastSoloMode so the user's previous
            // choice (or the default solo-storyboard) determines which child shows.
            setViewMode("dual");
            // We just made it visible — make sure it's NOT in the collapsed state.
            applyStoryboardCollapseState(false);
            queueAppSettingsSave({ storyboardCollapsed: false });
            return;
        }

        // Normal toggle path — column is visible, so this click collapses or
        // un-collapses it.
        const next = !chrome.hasAttribute("data-storyboard-collapsed");
        applyStoryboardCollapseState(next);
        queueAppSettingsSave({ storyboardCollapsed: next });
    });
}

/**
 * Module-scope mirror of the left-pane-toggle button's visual state.
 * @param {boolean} collapsed
 */
export function applyLeftPaneCollapsedState(collapsed)
{
    const btn = /** @type {HTMLElement|null} */ (document.getElementById("btn-left-pane-toggle"));
    const chrome = document.getElementById("app-chrome");
    if (!btn || !chrome) return;
    if (collapsed)
    {
        chrome.setAttribute("data-left-pane-collapsed", "");
        btn.setAttribute("aria-pressed", "true");
        btn.setAttribute("aria-label", "Expand left pane");
        btn.setAttribute("data-tooltip", "Expand");
        btn.innerHTML = icon("panel-left-open", { size: 16, class: "icon" });
    }
    else
    {
        chrome.removeAttribute("data-left-pane-collapsed");
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", "Collapse left pane");
        btn.setAttribute("data-tooltip", "Collapse");
        btn.innerHTML = icon("panel-left-close", { size: 16, class: "icon" });
    }
    refreshTooltipFor(btn);
}

export function wireLeftPaneToggle()
{
    const btn = /** @type {HTMLElement|null} */ (document.getElementById("btn-left-pane-toggle"));
    const chrome = document.getElementById("app-chrome");
    if (!btn || !chrome) return;

    btn.addEventListener("click", () =>
    {
        const next = !chrome.hasAttribute("data-left-pane-collapsed");
        applyLeftPaneCollapsedState(next);
        queueAppSettingsSave({ leftPaneCollapsed: next });
    });
}
