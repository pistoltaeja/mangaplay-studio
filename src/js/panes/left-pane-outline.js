// @ts-check
/**
 * left-pane-outline.js — Outline subview for the left pane.
 *
 * Subscribes to the runtime store's `script` + `scriptFormat` signals (the
 * SAME signals mps-canvas / mps-screenplay consume) and renders a flat list
 * of scene rows from the screenplay outline. Each row is bold (per spec),
 * visually styled like a file-explorer row, and carries data-line +
 * data-scene-idx for the click handler.
 *
 * For .txt / superscript-bin the list is hidden and a centred placeholder
 * message is shown.
 *
 * The click handler is supplied by the caller (app.js owns jumpToScene so it
 * can branch on the active editor mode — Source/Text scroll vs. Visual page
 * jump).
 */

import { computeStatistics } from "@fountain-plus/statistics";
import { t, subscribe as subscribeI18n } from "../adapters/tauri-i18n.js";
import { getRuntimeStorage } from "@mangaplay-studio/core/state";
import { screenplayBundleForPane } from "../util/screenplay-bundle.js";

/**
 * @typedef {{ text: string, line: number, sceneIdx: number, elementIdx: number }} OutlineScene
 */

/**
 * Memoised: same script identity returns the same scene list. Big-Fish
 * recomputes are O(tokens) but still ~5–10ms — caching keeps the subview
 * effectively free when the user types but no scene boundaries move.
 * @type {{ script: any, fmt: string|null, scenes: OutlineScene[]|null }}
 */
let cache = { script: null, fmt: null, scenes: null };

/**
 * Build a flat scene list from a Screenplay (Fountain) or ScriptAST (Mangaplay).
 * @param {any} script
 * @param {string|null} fmt
 * @returns {OutlineScene[]|null}
 */
function buildScenesFor(script, fmt)
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
        console.warn("[outline] computeStatistics failed:", e);
        return null;
    }
    /** @type {OutlineScene[]} */
    const out = [];
    /**
     * @param {Array<any>} nodes
     */
    const walk = (nodes) =>
    {
        if (!Array.isArray(nodes)) return;
        for (const n of nodes)
        {
            if (n && n.type === "scene")
            {
                const sceneText = String(n.text || "").trim();
                // Skip the parser's implicit "scene zero" for pre-INT/EXT
                // content (Fountain emits a scene with heading="" wrapping
                // anything before the first slug — FADE IN, opening V.O.,
                // etc). The engine still counts it for runtime / character
                // totals, but it has no name to display and used to render
                // as a blank clickable row at the top of the list.
                if (sceneText !== "")
                {
                    out.push({
                        text: sceneText,
                        line: Number.isFinite(n.line) ? n.line : 0,
                        sceneIdx: Number.isFinite(n.sceneIdx) ? n.sceneIdx : 0,
                        elementIdx: Number.isFinite(n.elementIdx) ? n.elementIdx : 0,
                    });
                }
            }
            if (n && Array.isArray(n.children) && n.children.length)
            {
                walk(n.children);
            }
        }
    };
    walk(stats.outline || []);
    return out;
}

/**
 * Mount the Outline subview into its container divs.
 * @param {{ onJump: (info: { line: number, sceneIdx: number }) => void }} opts
 * @returns {{ destroy: () => void, getScenes: () => OutlineScene[]|null }}
 */
export function mountOutline(opts)
{
    const listEl = /** @type {HTMLElement|null} */ (
        document.querySelector("#subview-outline .outline-list")
    );
    const disabledEl = /** @type {HTMLElement|null} */ (
        document.querySelector("#subview-outline .outline-disabled")
    );
    if (!listEl || !disabledEl)
    {
        return { destroy: () => {}, getScenes: () => null };
    }

    /** @type {OutlineScene[]|null} */
    let currentScenes = null;

    function renderTextDisabled()
    {
        listEl.hidden = true;
        // Clear cached rows too — when the user flips from a fountain file to
        // a txt the previous scene list would otherwise stay parked in the
        // DOM (hidden but present). We don't want that for accessibility or
        // for future re-renders that might re-show the list.
        listEl.replaceChildren();
        disabledEl.hidden = false;
        disabledEl.replaceChildren();
        const msg = document.createElement("p");
        msg.className = "outline-placeholder";
        msg.textContent = t(
            "mangaplay-studio.outline.unavailableForTextFile",
            "Text Files do not support outlines at the moment"
        );
        disabledEl.appendChild(msg);
    }

    function renderEmpty()
    {
        listEl.hidden = false;
        disabledEl.hidden = true;
        listEl.replaceChildren();
        const msg = document.createElement("p");
        msg.className = "outline-placeholder";
        msg.textContent = t(
            "mangaplay-studio.outline.noScenesYet",
            "No scenes yet — write a scene heading (INT./EXT.) to populate."
        );
        listEl.appendChild(msg);
    }

    /**
     * @param {OutlineScene[]} scenes
     */
    function renderList(scenes)
    {
        listEl.hidden = false;
        disabledEl.hidden = true;
        listEl.replaceChildren();
        for (const s of scenes)
        {
            const row = document.createElement("div");
            row.className = "outline-row";
            row.setAttribute("role", "button");
            row.tabIndex = 0;
            row.dataset.line = String(s.line);
            row.dataset.sceneIdx = String(s.sceneIdx);
            const nameEl = document.createElement("span");
            nameEl.className = "outline-row-name";
            nameEl.textContent = s.text;
            row.appendChild(nameEl);
            row.addEventListener("click", () =>
            {
                try { opts.onJump({ line: s.line, sceneIdx: s.sceneIdx }); }
                catch (e) { console.warn("[outline] onJump failed:", e); }
            });
            row.addEventListener("keydown", (ev) =>
            {
                if (ev.key === "Enter" || ev.key === " ")
                {
                    ev.preventDefault();
                    try { opts.onJump({ line: s.line, sceneIdx: s.sceneIdx }); }
                    catch (e) { console.warn("[outline] onJump failed:", e); }
                }
            });
            listEl.appendChild(row);
        }
    }

    /**
     * @param {any} script
     * @param {string|null} fmt
     */
    function recompute(script, fmt)
    {
        // Cache hit on script identity — no re-tokenise.
        if (cache.script === script && cache.fmt === fmt)
        {
            currentScenes = cache.scenes;
            return;
        }
        const scenes = buildScenesFor(script, fmt);
        cache = { script, fmt, scenes };
        currentScenes = scenes;
    }

    function render()
    {
        const state = getRuntimeStorage().state || {};
        const fmt = state.scriptFormat || null;
        const script = state.script || null;
        if (fmt === "text" || fmt === "general-text")
        {
            currentScenes = null;
            renderTextDisabled();
            return;
        }
        recompute(script, fmt);
        if (!currentScenes || currentScenes.length === 0)
        {
            if (script && (fmt === "mangaplay" || fmt === "fountain" || fmt === "superscript"))
            {
                renderEmpty();
            }
            else
            {
                // Format we can't render an outline for (binary, unknown, no doc).
                listEl.hidden = false;
                disabledEl.hidden = true;
                listEl.replaceChildren();
            }
            return;
        }
        renderList(currentScenes);
    }

    const store = getRuntimeStorage();
    /** @type {() => void} */
    let unsubScript = () => {};
    /** @type {() => void} */
    let unsubFormat = () => {};
    try
    {
        unsubScript = store.select((s) => s.script, () => render());
    }
    catch (e) { console.warn("[outline] subscribe script failed:", e); }
    try
    {
        unsubFormat = store.select((s) => s.scriptFormat, () => render());
    }
    catch (e) { console.warn("[outline] subscribe scriptFormat failed:", e); }

    const unsubI18n = subscribeI18n(() =>
    {
        // Re-render placeholder text on locale change. List rows have screenplay
        // content (never translated) so we only need to refresh the disabled
        // / empty messages.
        render();
    });

    // Initial paint.
    render();

    return {
        destroy()
        {
            try { unsubScript(); } catch {}
            try { unsubFormat(); } catch {}
            try { unsubI18n(); } catch {}
        },
        getScenes()
        {
            return currentScenes;
        }
    };
}
