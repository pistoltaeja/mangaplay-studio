/**
 * tooltip.js — Badge tooltip web component for the desktop app.
 *
 * Singleton <mps-badge-tooltip> mounted in <body>; shown via showTooltip(target, text,
 * { side }) or declaratively by adding `data-tooltip="…"` (+ optional `data-tooltip-side`)
 * to any element and calling wireDeclarativeTooltips() once at boot.
 *
 * Sides: "top" | "right" | "bottom" | "left". Falls back to the opposite side if the
 * tooltip would overflow the viewport on the requested side.
 *
 * Shadow DOM is used to isolate styling from the host app.
 */

const SIDES = new Set(["top", "right", "bottom", "left"]);
const SHOW_DELAY_MS = 1000;
const HIDE_DELAY_MS = 80;

class BadgeTooltip extends HTMLElement
{
    constructor()
    {
        super();
        this.attachShadow({ mode: "open" });
        this.shadowRoot.innerHTML = `
            <style>
                :host
                {
                    position: fixed;
                    top: 0;
                    left: 0;
                    z-index: 9999;
                    pointer-events: none;
                    opacity: 0;
                    transform: translate3d(-9999px, -9999px, 0);
                    transition: opacity 120ms ease;
                    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                }
                :host([data-visible])
                {
                    opacity: 1;
                }
                /* === Tooltip line-count strategy ===
                 * Default (single-line): comfortable vertical padding +
                 * 1.4 line-height. setText() detects "\n" in the incoming
                 * text and flips :host[data-multi] which clamps padding to
                 * 2px top/bottom and line-height to 1.25 so two stacked
                 * lines hug the badge instead of looking like two separate
                 * boxes. One badge, one caller API, visual rhythm picks
                 * itself based on content. */
                .badge
                {
                    position: relative;
                    background: #2a2d34;
                    color: #fff;
                    padding: 6px 12px;         /* single-line default */
                    border-radius: 4px;
                    line-height: 1.25;
                    /* pre-line so multi-line text (data-tooltip="line1\nline2")
                     * renders with real line breaks. Single-line callers wrap
                     * naturally without nowrap forcing them onto one line. */
                    white-space: pre-line;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
                }
                :host([data-multi]) .badge
                {
                    /* Multi-line gets slightly tighter vertical so two stacked
                     * lines don't look like two boxes glued together. */
                    padding: 4px 12px;
                    line-height: 1.3;
                }
                .arrow
                {
                    position: absolute;
                    width: 8px;
                    height: 8px;
                    background: #2a2d34;
                    transform: rotate(45deg);
                }
                :host([data-side="top"])    .arrow { bottom: -3px; left: 50%; margin-left: -4px; }
                :host([data-side="bottom"]) .arrow { top: -3px;    left: 50%; margin-left: -4px; }
                :host([data-side="left"])   .arrow { right: -3px;  top: 50%;  margin-top: -4px;  }
                :host([data-side="right"])  .arrow { left: -3px;   top: 50%;  margin-top: -4px;  }
            </style>
            <div class="badge"><span class="label"></span><span class="arrow"></span></div>
        `;
        this._badge = this.shadowRoot.querySelector(".badge");
        this._label = this.shadowRoot.querySelector(".label");
    }

    setText(text)
    {
        this._label.textContent = text;
        // Auto-detect single vs multi-line so the badge can pick the right
        // vertical rhythm without per-call opt-in. \n in source → multi.
        if (typeof text === "string" && text.indexOf("\n") >= 0)
        {
            this.setAttribute("data-multi", "");
        }
        else
        {
            this.removeAttribute("data-multi");
        }
    }

    /**
     * Position relative to a target rect on a given side. Re-tries the opposite side
     * if the badge would overflow the viewport on the requested side.
     */
    placeNear(targetRect, side)
    {
        if (!SIDES.has(side)) side = "bottom";

        // Force a layout read with the host at (0,0) so we get an accurate badge size.
        this.style.transform = "translate3d(0, 0, 0)";
        const r = this._badge.getBoundingClientRect();
        const w = r.width;
        const h = r.height;
        const gap = 8;

        let x = 0, y = 0;
        switch (side)
        {
            case "top":
                x = targetRect.left + (targetRect.width - w) / 2;
                y = targetRect.top - h - gap;
                break;
            case "bottom":
                x = targetRect.left + (targetRect.width - w) / 2;
                y = targetRect.bottom + gap;
                break;
            case "left":
                x = targetRect.left - w - gap;
                y = targetRect.top + (targetRect.height - h) / 2;
                break;
            case "right":
                x = targetRect.right + gap;
                y = targetRect.top + (targetRect.height - h) / 2;
                break;
        }

        // Flip to the opposite side if off-viewport.
        if (side === "top"    && y < 0)                                  return this.placeNear(targetRect, "bottom");
        if (side === "bottom" && y + h > window.innerHeight)             return this.placeNear(targetRect, "top");
        if (side === "left"   && x < 0)                                  return this.placeNear(targetRect, "right");
        if (side === "right"  && x + w > window.innerWidth)              return this.placeNear(targetRect, "left");

        this.setAttribute("data-side", side);
        this.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    }

    show() { this.setAttribute("data-visible", ""); }
    hide() { this.removeAttribute("data-visible"); }
}

customElements.define("mps-badge-tooltip", BadgeTooltip);

let singleton = null;
let showTimer = 0;
let hideTimer = 0;
let lastTarget = null;
// Element that the user just clicked / right-clicked. While the cursor stays
// on this element, no new tooltip will schedule. Cleared on mouseout of the
// suppressed target — so the user has to physically unhover then re-hover for
// the full 1s before the tooltip can reappear. UX requirement: a tooltip is a
// hint for idle hover, not a thing that flashes back as soon as the menu opens.
let suppressedTarget = null;

function ensureSingleton()
{
    if (singleton) return singleton;
    singleton = document.createElement("mps-badge-tooltip");
    document.body.append(singleton);
    return singleton;
}

/**
 * Show the tooltip near `target` with `text`. Defaults to a 350ms hover delay;
 * pass { immediate: true } (used for focus) to skip the delay.
 */
export function showTooltip(target, text, { side = "bottom", immediate = false } = {})
{
    if (!target || !text) return;
    clearTimeout(hideTimer);
    lastTarget = target;
    const t = ensureSingleton();
    const run = () =>
    {
        if (lastTarget !== target) return;       // raced — a newer call took over
        t.setText(text);
        t.placeNear(target.getBoundingClientRect(), side);
        t.show();
    };
    if (immediate)
    {
        clearTimeout(showTimer);
        run();
    }
    else
    {
        clearTimeout(showTimer);
        showTimer = window.setTimeout(run, SHOW_DELAY_MS);
    }
}

export function hideTooltip()
{
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() =>
    {
        lastTarget = null;
        if (singleton) singleton.hide();
    }, HIDE_DELAY_MS);
}

/**
 * Hide right now (no 80ms grace) AND suppress further shows until the cursor
 * leaves `target`. Used when the user explicitly interacts (left- or right-
 * click): the tooltip was a hover-idle hint, the click means the user is
 * acting, so the hint isn't wanted any more.
 *
 * @param {Element | null} target  the element the user just clicked
 */
export function hideTooltipImmediate(target)
{
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    lastTarget = null;
    if (singleton) singleton.hide();
    suppressedTarget = target || null;
}

/**
 * If a tooltip is currently visible for `target`, refresh its text/side without
 * the 350ms delay. Used when a button's tooltip text changes while it's hovered
 * (e.g. [C] flipping between "Collapse" and "Expand").
 */
export function refreshTooltipFor(target)
{
    if (!target || lastTarget !== target || !singleton || !singleton.hasAttribute("data-visible")) return;
    const text = target.dataset?.tooltip;
    const side = target.dataset?.tooltipSide || "bottom";
    if (!text) return;
    singleton.setText(text);
    singleton.placeNear(target.getBoundingClientRect(), side);
}

/**
 * Wire delegated hover / focus handlers for every `[data-tooltip]` element.
 * Idempotent — safe to call multiple times.
 */
let declarativeWired = false;
export function wireDeclarativeTooltips()
{
    if (declarativeWired) return;
    declarativeWired = true;

    const findTarget = (ev) => ev.target?.closest?.("[data-tooltip]");

    // mouseover/mouseout bubble — cheaper than capturing mouseenter on every element.
    document.body.addEventListener("mouseover", (e) =>
    {
        const t = findTarget(e);
        if (!t) return;
        // Same target as before — let the existing 1s timer run to completion
        // instead of restarting it. Subtle but critical: mouseover bubbles
        // from descendants too, so jitter across SPAN children of a row would
        // otherwise repeatedly reset the timer and the tooltip would never
        // reach the 1s mark.
        if (lastTarget === t) return;
        // Suppressed: the user just clicked this element. No tooltip until
        // they leave and come back.
        if (suppressedTarget && (t === suppressedTarget || suppressedTarget.contains(t))) return;
        showTooltip(t, t.dataset.tooltip, { side: t.dataset.tooltipSide || "bottom" });
    });

    document.body.addEventListener("mouseout", (e) =>
    {
        const t = findTarget(e);
        if (!t) return;
        // Only hide if the related target is outside the tooltip's owner element.
        if (e.relatedTarget && t.contains(e.relatedTarget)) return;
        // Clear suppression once the cursor leaves the suppressed element —
        // the user has to re-hover for the next show.
        if (suppressedTarget && (t === suppressedTarget || suppressedTarget.contains(t)))
        {
            const into = /** @type {Node|null} */ (e.relatedTarget);
            if (!into || !suppressedTarget.contains(into)) suppressedTarget = null;
        }
        hideTooltip();
    });

    document.body.addEventListener("focusin", (e) =>
    {
        const t = findTarget(e);
        if (!t) return;
        // Honour click-suppression: if the user just clicked or right-clicked
        // this element, mousedown sets suppressedTarget. The browser then
        // focuses the element as part of the same click sequence, which
        // previously triggered an immediate tooltip flash before the menu
        // appeared. Suppression must apply here too.
        if (suppressedTarget && (t === suppressedTarget || suppressedTarget.contains(t))) return;
        showTooltip(t, t.dataset.tooltip, { side: t.dataset.tooltipSide || "bottom", immediate: true });
    });

    document.body.addEventListener("focusout", (e) =>
    {
        const t = findTarget(e);
        if (!t) return;
        hideTooltip();
    });

    // Hide on Escape — common UX expectation.
    document.addEventListener("keydown", (e) =>
    {
        if (e.key === "Escape") hideTooltip();
    });

    // Hide IMMEDIATELY on right-click or left-click — the tooltip is a
    // hover-idle hint, not something to sit on top of an open menu or to
    // flash back as the user works. Suppress further shows until the cursor
    // leaves the clicked element (so the user can't see it again without
    // explicitly re-hovering for the full 1s).
    //
    // Capture phase so we win against any leaf that calls stopPropagation
    // (mirrors the routeContextMenu listener in app.js).
    const onClickLike = (e) =>
    {
        const t = /** @type {Element|null} */ (findTarget(e));
        hideTooltipImmediate(t);
    };
    document.addEventListener("contextmenu", onClickLike, { capture: true });
    document.addEventListener("mousedown",   onClickLike, { capture: true });
}
