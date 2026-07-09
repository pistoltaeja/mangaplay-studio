// @ts-check
/**
 * left-pane-statistics.js — Statistics subview for the left pane.
 *
 * Renders "Estimated Runtime" + a per-character list (lines spoken + words
 * spoken). Driven by the same store signals as the Outline; cache keyed on
 * script identity so re-renders are O(1) when the script hasn't changed.
 *
 * For .txt / general-text a compact row of raw-text counts (words, chars,
 * lines, spaces, tabs) is shown instead. For superscript-bin a placeholder
 * message is shown.
 */

import { computeStatistics, computeTextFileStatistics } from "@fountain-plus/statistics";
import { t, subscribe as subscribeI18n } from "../adapters/tauri-i18n.js";
import { getRuntimeStorage } from "@mangaplay-studio/core/state";
import { screenplayBundleForPane } from "../util/screenplay-bundle.js";

/**
 * @typedef {{ duration: { totalSeconds: number }, characters: Array<{ name: string, displayName: string, speakingParts: number, wordsSpoken: number }> }} StatsSummary
 */

/** @type {{ script: any, fmt: string|null, stats: StatsSummary|null }} */
let cache = { script: null, fmt: null, stats: null };

/**
 * Format a duration in seconds to "H:MM:SS" or "MM:SS".
 * @param {number} secs
 */
function formatDuration(secs)
{
    if (!Number.isFinite(secs) || secs <= 0) return "00:00";
    const s = Math.round(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0
        ? `${h}:${pad(m)}:${pad(r)}`
        : `${pad(m)}:${pad(r)}`;
}

/**
 * @param {number} n
 */
function formatThousands(n)
{
    if (!Number.isFinite(n)) return "0";
    // Use Intl when available; fall back to a manual grouping otherwise.
    try { return new Intl.NumberFormat().format(Math.round(n)); }
    catch { return String(Math.round(n)); }
}

/**
 * @param {any} script
 * @param {string|null} fmt
 * @returns {StatsSummary|null}
 */
function buildStatsFor(script, fmt)
{
    const bundle = screenplayBundleForPane(script, fmt);
    if (!bundle) return null;
    const { tokens, titlePage } = bundle;
    let stats;
    try
    {
        stats = computeStatistics(tokens, {
            isMangaplay: fmt === "mangaplay",
            hasTitlePage: !!titlePage,
        });
    }
    catch (e)
    {
        console.warn("[statistics] compute failed:", e);
        return null;
    }
    return {
        duration: { totalSeconds: Number(stats?.duration?.totalSeconds || 0) },
        characters: Array.isArray(stats?.characters) ? stats.characters : [],
    };
}

/**
 * Mount the Statistics subview.
 * @returns {{ destroy: () => void, getStats: () => StatsSummary|null }}
 */
export function mountStatistics()
{
    const contentEl = /** @type {HTMLElement|null} */ (
        document.querySelector("#subview-statistics .statistics-content")
    );
    const disabledEl = /** @type {HTMLElement|null} */ (
        document.querySelector("#subview-statistics .statistics-disabled")
    );
    if (!contentEl || !disabledEl)
    {
        return { destroy: () => {}, getStats: () => null };
    }

    /** @type {StatsSummary|null} */
    let currentStats = null;

    function renderDisabled()
    {
        contentEl.hidden = true;
        disabledEl.hidden = false;
        disabledEl.replaceChildren();
        const msg = document.createElement("p");
        msg.className = "statistics-placeholder";
        msg.textContent = t(
            "mangaplay-studio.statistics.unavailableForFileType",
            "Statistics aren't available for this file type."
        );
        disabledEl.appendChild(msg);
    }

    /**
     * @param {StatsSummary} stats
     */
    function renderStats(stats)
    {
        contentEl.hidden = false;
        disabledEl.hidden = true;
        contentEl.replaceChildren();

        const runtimeSection = document.createElement("section");
        runtimeSection.className = "statistics-section";
        const runtimeLabel = document.createElement("div");
        runtimeLabel.className = "statistics-label";
        runtimeLabel.textContent = t(
            "mangaplay-studio.statistics.estimatedRuntime",
            "Estimated Runtime"
        );
        const runtimeValue = document.createElement("div");
        runtimeValue.className = "statistics-runtime";
        runtimeValue.textContent = formatDuration(stats.duration.totalSeconds);
        runtimeSection.appendChild(runtimeLabel);
        runtimeSection.appendChild(runtimeValue);
        contentEl.appendChild(runtimeSection);

        const hr = document.createElement("hr");
        hr.className = "statistics-divider";
        contentEl.appendChild(hr);

        const charSection = document.createElement("section");
        charSection.className = "statistics-section";
        const charHeading = document.createElement("div");
        charHeading.className = "statistics-label";
        charHeading.textContent = t(
            "mangaplay-studio.statistics.characters",
            "Characters"
        );
        charSection.appendChild(charHeading);

        if (!stats.characters.length)
        {
            const empty = document.createElement("p");
            empty.className = "statistics-placeholder";
            empty.textContent = t(
                "mangaplay-studio.statistics.noCharactersYet",
                "No dialogue yet."
            );
            charSection.appendChild(empty);
        }
        else
        {
            const list = document.createElement("div");
            list.className = "statistics-character-list";
            const linesLabel = t("mangaplay-studio.statistics.linesAbbrev", "{n} lines");
            const wordsLabel = t("mangaplay-studio.statistics.wordsAbbrev", "{n} words");
            for (const c of stats.characters)
            {
                const row = document.createElement("div");
                row.className = "statistics-character-row";
                row.dataset.character = c.displayName || c.name || "";
                row.dataset.lines = String(c.speakingParts || 0);
                row.dataset.words = String(c.wordsSpoken || 0);

                const name = document.createElement("span");
                name.className = "statistics-character-name";
                name.textContent = c.displayName || c.name || "";

                const counts = document.createElement("span");
                counts.className = "statistics-character-counts";
                const lines = linesLabel.replace("{n}", formatThousands(c.speakingParts || 0));
                const words = wordsLabel.replace("{n}", formatThousands(c.wordsSpoken || 0));
                counts.textContent = `${lines} · ${words}`;

                row.appendChild(name);
                row.appendChild(counts);
                list.appendChild(row);
            }
            charSection.appendChild(list);
        }
        contentEl.appendChild(charSection);
    }

    /**
     * @param {string} sourceText
     */
    function renderTextStats(sourceText)
    {
        const s = computeTextFileStatistics(sourceText);
        contentEl.hidden = false;
        disabledEl.hidden = true;
        contentEl.replaceChildren();

        const section = document.createElement("section");
        section.className = "statistics-section statistics-text-file";

        /** @type {Array<[string, string, number]>} */
        const rows = [
            ["mangaplay-studio.statistics.wordCount", "Word Count", s.words],
            ["mangaplay-studio.statistics.characterCount", "Character Count", s.characters],
            ["mangaplay-studio.statistics.lineCount", "Line Count", s.lines],
            ["mangaplay-studio.statistics.spaceCount", "Spaces Count", s.spaces],
            ["mangaplay-studio.statistics.tabCount", "Tab Count", s.tabs],
        ];
        for (const [key, fallback, value] of rows)
        {
            const row = document.createElement("div");
            row.className = "statistics-text-row";
            const label = document.createElement("span");
            label.className = "statistics-text-label";
            label.textContent = t(key, fallback);
            const num = document.createElement("span");
            num.className = "statistics-text-value";
            num.textContent = formatThousands(value);
            row.appendChild(label);
            row.appendChild(num);
            section.appendChild(row);
        }
        contentEl.appendChild(section);
    }

    function render()
    {
        const state = getRuntimeStorage().state || {};
        const fmt = state.scriptFormat || null;
        const script = state.script || null;
        if (fmt === "text" || fmt === "general-text")
        {
            currentStats = null;
            renderTextStats(typeof state.scriptSourceText === "string" ? state.scriptSourceText : "");
            return;
        }
        if (fmt === "superscript-bin")
        {
            currentStats = null;
            renderDisabled();
            return;
        }
        if (!script
            || (fmt !== "mangaplay" && fmt !== "fountain" && fmt !== "superscript"))
        {
            currentStats = null;
            // Just an empty content area (no doc open / unknown format).
            contentEl.hidden = false;
            disabledEl.hidden = true;
            contentEl.replaceChildren();
            return;
        }
        // Cache by script identity.
        if (cache.script !== script || cache.fmt !== fmt)
        {
            cache = { script, fmt, stats: buildStatsFor(script, fmt) };
        }
        currentStats = cache.stats;
        if (!currentStats)
        {
            renderDisabled();
            return;
        }
        renderStats(currentStats);
    }

    const store = getRuntimeStorage();
    let unsubScript = () => {};
    let unsubFormat = () => {};
    let unsubSourceText = () => {};
    try { unsubScript = store.select((s) => s.script, () => render()); }
    catch (e) { console.warn("[statistics] subscribe script failed:", e); }
    try { unsubFormat = store.select((s) => s.scriptFormat, () => render()); }
    catch (e) { console.warn("[statistics] subscribe scriptFormat failed:", e); }
    try { unsubSourceText = store.select((s) => s.scriptSourceText, () => render()); }
    catch (e) { console.warn("[statistics] subscribe scriptSourceText failed:", e); }
    const unsubI18n = subscribeI18n(() => render());

    render();

    return {
        destroy()
        {
            try { unsubScript(); } catch {}
            try { unsubFormat(); } catch {}
            try { unsubSourceText(); } catch {}
            try { unsubI18n(); } catch {}
        },
        getStats()
        {
            return currentStats;
        }
    };
}
