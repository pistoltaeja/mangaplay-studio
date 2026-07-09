/**
 * quick-toggle-tooltip-mirror.js — Mirror `data-tooltip-text` onto `data-tooltip`
 * for `mps-quick-toggle-sidebar` descendants.
 *
 * The sidebar component (from the website) ships its own tooltip system that
 * doesn't fit the desktop's global `[data-tooltip]` badge. We hide the
 * component's local `.quick-toggle-tooltip` in CSS and mirror its authored
 * `data-tooltip-text` values onto `data-tooltip` so the global delegator
 * (`wireDeclarativeTooltips`) lights up naturally.
 *
 * Idempotent: `wireQuickToggleTooltipMirror()` is safe to call multiple times.
 */

let wired = false;

/**
 * Copy an element's `data-tooltip-text` value to `data-tooltip` if they differ.
 * The guard prevents redundant DOM writes; we never touch `data-tooltip-text`,
 * so the observer's `attributeFilter` cannot refire on our writes.
 *
 * @param {Element} el
 */
function mirrorOne(el)
{
    const text = /** @type {HTMLElement} */ (el).dataset.tooltipText;
    if (text && /** @type {HTMLElement} */ (el).dataset.tooltip !== text)
    {
        /** @type {HTMLElement} */ (el).dataset.tooltip = text;
    }
}

/**
 * Walk an added Element (and its subtree) and mirror any `data-tooltip-text`
 * carriers, but only if the node is inside an `mps-quick-toggle-sidebar`.
 *
 * @param {Element} node
 */
function mirrorAddedElement(node)
{
    if (!node.closest || !node.closest("mps-quick-toggle-sidebar")) return;
    if (/** @type {HTMLElement} */ (node).dataset && /** @type {HTMLElement} */ (node).dataset.tooltipText)
    {
        mirrorOne(node);
    }
    if (node.querySelectorAll)
    {
        for (const inner of node.querySelectorAll("[data-tooltip-text]"))
        {
            mirrorOne(inner);
        }
    }
}

export function wireQuickToggleTooltipMirror()
{
    if (wired) return;
    if (!document.body) return;
    wired = true;

    const observer = new MutationObserver((mutations) =>
    {
        for (const m of mutations)
        {
            if (m.type === "childList")
            {
                for (const node of m.addedNodes)
                {
                    if (node.nodeType === 1) mirrorAddedElement(/** @type {Element} */ (node));
                }
            }
            else if (m.type === "attributes" && m.attributeName === "data-tooltip-text")
            {
                const target = /** @type {Element} */ (m.target);
                if (target.closest && target.closest("mps-quick-toggle-sidebar"))
                {
                    mirrorOne(target);
                }
            }
        }
    });

    observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-tooltip-text"],
    });

    // Initial pass: mirror anything already in the DOM.
    for (const el of document.querySelectorAll("mps-quick-toggle-sidebar [data-tooltip-text]"))
    {
        mirrorOne(el);
    }
}
