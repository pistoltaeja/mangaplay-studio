// @ts-check
/**
 * footer-bar.js — pure helpers for the Google Docs sync UI.
 *
 * History: this module used to mount a full-width `<footer class="editor-footer">`
 * under `.right-pane-stack`. The App Footer (200×30 bottom-right of #app-chrome)
 * has since absorbed the sync gear, so `mountFooterBar()` is gone. The pure
 * helpers — sync-state humanisation, relative-time formatting, and the lock
 * SVG factory — are still imported by sync-popover.js + footer-bootstrap.js
 * and live on here.
 */

import { t } from "../adapters/tauri-i18n.js";

/**
 * @typedef {"unsynced"|"idle"|"checking"|"local-ahead"|"remote-ahead"|"error"} SyncState
 * @typedef {"unsynced"|"unlocked"|"locked-by-me"|"locked-by-other"|"stale"} LockState
 */

const RELATIVE_TIME_THRESHOLDS = [
    { limit: 60_000,         div: 1000,         unit: "second" },
    { limit: 3_600_000,      div: 60_000,       unit: "minute" },
    { limit: 86_400_000,     div: 3_600_000,    unit: "hour"   },
    { limit: 7 * 86_400_000, div: 86_400_000,   unit: "day"    }
];

/**
 * Format an ISO timestamp as a relative-time string (e.g. "3 min ago",
 * "just now"). Falls back to a plain ISO when Intl.RelativeTimeFormat is
 * unavailable.
 *
 * @param {string|null} iso
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatRelativeTime(iso, nowMs)
{
    if (!iso) return "";
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return "";
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    const deltaMs = now - ts;
    if (deltaMs < 5_000) return t("mangaplay-studio.googleDocsSync.footer.justNow", "just now");

    let rtf;
    try
    {
        rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
    }
    catch (_)
    {
        return iso;
    }

    for (const { limit, div, unit } of RELATIVE_TIME_THRESHOLDS)
    {
        if (Math.abs(deltaMs) < limit)
        {
            const value = -Math.round(deltaMs / div);
            return rtf.format(value, /** @type {Intl.RelativeTimeFormatUnit} */ (unit));
        }
    }
    return rtf.format(-Math.round(deltaMs / (7 * 86_400_000)), "week");
}

/**
 * Humanise a sync state into a localised footer string.
 *
 * @param {Object} args
 * @param {SyncState} args.state
 * @param {string|null} [args.lastCheckedAt]
 * @param {LockState} [args.lockState]
 * @param {string} [args.lockedBy]
 * @param {string} [args.lockedAt]
 * @returns {string}
 */
export function humaniseSyncState({ state, lastCheckedAt, lockState, lockedBy, lockedAt })
{
    // Lock-by-other supplants the sync status when shown.
    if (lockState === "locked-by-other")
    {
        const tpl = t("mangaplay-studio.googleDocsSync.footer.lockedBy", "Locked by {name} {relative}");
        const rel = formatRelativeTime(lockedAt || null);
        return tpl
            .replace("{name}", lockedBy || "")
            .replace("{relative}", rel || "");
    }

    switch (state)
    {
        case "unsynced":
            return t("mangaplay-studio.googleDocsSync.footer.notSynced", "Not synced");
        case "checking":
            return t("mangaplay-studio.googleDocsSync.footer.reconnecting", "Reconnecting…");
        case "local-ahead":
            return t("mangaplay-studio.googleDocsSync.footer.locallyEdited",
                "Locally edited — not pushed");
        case "remote-ahead":
            return t("mangaplay-studio.googleDocsSync.footer.remoteChanges",
                "Remote changes available");
        case "error":
            return t("mangaplay-studio.googleDocsSync.footer.syncError",
                "Sync error — click for details");
        case "idle":
        default:
        {
            const rel = formatRelativeTime(lastCheckedAt || null);
            if (!rel || rel === t("mangaplay-studio.googleDocsSync.footer.justNow", "just now"))
            {
                return t("mangaplay-studio.googleDocsSync.footer.syncedJustNow", "Synced just now");
            }
            const tpl = t("mangaplay-studio.googleDocsSync.footer.syncedAgo", "Synced {relative}");
            return tpl.replace("{relative}", rel);
        }
    }
}

/**
 * Render an inline SVG for the lock icon. Lucide's `Lock` / `Unlock` aren't
 * registered in icons.js (no upstream import), so we inline the path here.
 *
 * @param {LockState} state
 * @returns {string}
 */
export function lockSvg(state)
{
    const open = state === "unlocked" || state === "unsynced";
    const stalePrefix = state === "stale" ? "⚠ " : "";
    // Compact lucide-style paths.
    const path = open
        ? `<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>`
        + `<path d="M7 11V7a5 5 0 0 1 9.9-1"/>`
        : `<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>`
        + `<path d="M7 11V7a5 5 0 0 1 10 0v4"/>`;
    return `${stalePrefix}<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" `
         + `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" `
         + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}
