// @ts-check
/**
 * system-locale-detector.js — one-shot resolver that picks the seed value
 * for `userSettings.spellcheckLanguage` on first launch.
 *
 * Decoupled from the i18n adapter on purpose: the language the menus run
 * in and the language we spellcheck against are independent concerns.
 * Tries the Tauri OS-locale plugin first (authoritative), then falls back
 * to `navigator.language` / `navigator.languages`, then `en-US`.
 *
 * English dialect resolution maps `en-GB`, `en-AU`, `en-NZ`, `en-IE`,
 * `en-IN`, `en-ZA` to `en-GB`; everything else `en-*` (including
 * `en-CA`) collapses to `en-US`. Chinese resolution: `zh-TW`, `zh-HK`,
 * `zh-MO`, or anything containing `Hant` → `zh-TW`; everything else
 * `zh-*` → `zh-CN`.
 */

const SUPPORTED = new Set([
    "en-US", "en-GB",
    "ja", "es", "id", "ko", "fr", "it", "pt", "ru", "th", "zh-CN", "zh-TW", "de", "vi"
]);

const EN_GB_REGIONS = new Set(["GB", "AU", "NZ", "IE", "IN", "ZA"]);

/**
 * Resolve a single BCP-47-ish tag to one of the 15 supported spellcheck
 * language values, or `null` if the tag matches none.
 * @param {string} raw
 * @returns {string | null}
 */
function mapTag(raw)
{
    const bcp = String(raw).replace("_", "-");
    const parts = bcp.split("-");
    const primary = parts[0] || "";
    const region = parts[1] || "";
    const lo = primary.toLowerCase();

    if (lo === "en")
    {
        return region && EN_GB_REGIONS.has(region.toUpperCase()) ? "en-GB" : "en-US";
    }
    if (lo === "zh")
    {
        const r = region.toUpperCase();
        if (r === "TW" || r === "HK" || r === "MO" || /Hant/i.test(bcp)) return "zh-TW";
        return "zh-CN";
    }
    if (lo === "pt") return "pt"; // no dialect split in v1
    if (SUPPORTED.has(lo)) return lo;
    return null;
}

/**
 * Detect the best-fit spellcheck locale for this OS / WebView. Async
 * because the Tauri OS-locale call goes over IPC. Never throws — falls
 * back to `en-US` if every source fails.
 * @returns {Promise<string>}
 */
export async function detectSystemSpellcheckLocale()
{
    /** @type {string[]} */
    const candidates = [];

    try
    {
        // Dynamic import so the module can be loaded in a jsdom test
        // environment that doesn't have the Tauri plugin runtime.
        const mod = await import("@tauri-apps/plugin-os");
        if (mod && typeof mod.locale === "function")
        {
            const v = await mod.locale();
            if (v) candidates.push(v);
        }
    }
    catch (_) { /* plugin unavailable; fall through */ }

    if (typeof navigator !== "undefined")
    {
        if (navigator.language) candidates.push(navigator.language);
        if (Array.isArray(navigator.languages))
        {
            for (const tag of navigator.languages) candidates.push(tag);
        }
    }

    for (const raw of candidates)
    {
        if (!raw) continue;
        const m = mapTag(raw);
        if (m) return m;
    }

    return "en-US";
}
