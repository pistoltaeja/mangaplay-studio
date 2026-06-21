// @ts-check
/**
 * tooltip-i18n — Resolve `[data-i18n-tooltip]` attributes into the
 * canonical `data-tooltip` attribute that the tooltip subsystem reads.
 *
 * `index.html` carries both `data-tooltip="…"` (fallback / static text)
 * AND `data-i18n-tooltip="<key>"`. At boot we walk every element with
 * the i18n attr and overwrite `data-tooltip` with the localised value.
 * On `mps-lang-change`, we re-walk and re-resolve so the visible
 * tooltips update without a reload.
 */

import { t, subscribe } from "./adapters/tauri-i18n.js";

/**
 * Resolve every `[data-i18n-tooltip]` under `root` and write the
 * localised value to `data-tooltip`.
 * @param {ParentNode} [root]
 */
export function applyTooltipI18n(root = document)
{
    for (const el of root.querySelectorAll("[data-i18n-tooltip]"))
    {
        const key = el.getAttribute("data-i18n-tooltip");
        if (!key) continue;
        const value = t(key);
        if (value) el.setAttribute("data-tooltip", value);
    }
}

/**
 * Boot-time wiring: apply once now, then re-apply on every language
 * change. Idempotent — safe to call multiple times (subscribe returns
 * a fresh handle each call; the caller manages teardown if needed).
 */
export function wireTooltipI18nLiveUpdates()
{
    applyTooltipI18n();
    subscribe(() => applyTooltipI18n());
}
