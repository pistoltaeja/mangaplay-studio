// @ts-check
/**
 * combined-linter.js — single CM6 linter() source that merges parser
 * diagnostics (sync) with spellcheck diagnostics (async, racing a 300ms
 * budget). Replaces the previous two-linter wiring which was vulnerable to
 * `batchResults` dropping the parser source when spellcheck's async
 * callback hung.
 */

import { linter, forEachDiagnostic } from "@codemirror/lint";
import { hoverTooltip, closeHoverTooltips } from "@codemirror/view";
import { runParserLinter } from "./editor-linter.js";

// spellcheck-linter.js + harper-linter.js + harper.js (~1.5 MB combined)
// are pulled in via dynamic import inside the spell lint callback so the
// boot chunk stays slim. First lint pass after editor mount fetches the
// chunk; subsequent lint passes reuse the module-cached promise. The
// parser branch above is sync and surfaces diagnostics on every pass
// regardless of whether the spell chunk has landed yet.
/** @type {Promise<typeof import("../spellcheck/spellcheck-linter.js")>|null} */
let spellModulePromise = null;
function loadSpellModule()
{
    if (!spellModulePromise)
    {
        spellModulePromise = import("../spellcheck/spellcheck-linter.js");
    }
    return spellModulePromise;
}

/**
 * Build the diagnostic <li> in a manner that mirrors @codemirror/lint's
 * own renderDiagnostic() so existing .cm-diagnostic / .cm-diagnosticText /
 * .cm-diagnosticAction / .cm-diagnosticSource CSS still applies.
 *
 * @param {import("@codemirror/view").EditorView} view
 * @param {import("@codemirror/lint").Diagnostic} d
 * @param {number} from
 * @param {number} to
 */
function renderDiagItem(view, d, from, to)
{
    const li = document.createElement("li");
    li.className = "cm-diagnostic cm-diagnostic-" + d.severity;

    const text = document.createElement("span");
    text.className = "cm-diagnosticText";
    text.textContent = d.renderMessage ? "" : d.message;
    if (d.renderMessage)
    {
        const rendered = d.renderMessage(view);
        if (rendered instanceof Node) text.appendChild(rendered);
        else text.textContent = String(rendered);
    }
    li.appendChild(text);

    if (d.actions)
    {
        for (const action of d.actions)
        {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "cm-diagnosticAction" + (action.markClass ? " " + action.markClass : "");
            btn.textContent = action.name;
            btn.setAttribute("aria-label", ` Action: ${action.name}.`);
            let fired = false;
            const click = (e) =>
            {
                e.preventDefault();
                if (fired) return;
                fired = true;
                // Hide our visible chrome on the same frame so the user
                // gets instant feedback — the action.apply() doc-change
                // pipeline (lint debounce 250ms + re-render) would
                // otherwise leave the popup visible for a noticeable
                // beat. closeHoverTooltips() drops it from CM6's state
                // properly; we also blank visibility in case the
                // dispatch is microtask-deferred.
                action.apply(view, from, to);
                // closeHoverTooltips is a StateEffect VALUE, not a callable
                // — must be dispatched as a transaction effect.
                view.dispatch({ effects: closeHoverTooltips });
                const host = btn.closest(".cm-tooltip-hover, .cm-tooltip");
                if (host instanceof HTMLElement) host.style.visibility = "hidden";
            };
            btn.onclick = click;
            btn.onmousedown = click;
            li.appendChild(btn);
        }
    }

    if (d.source)
    {
        const src = document.createElement("div");
        src.className = "cm-diagnosticSource";
        src.textContent = d.source;
        li.appendChild(src);
    }

    return li;
}

/**
 * Custom hover tooltip that re-implements the lint extension's hover popup
 * with a TooltipView `offset` so the popup sits clear of the squiggled
 * line. The native lint tooltip is hidden via CSS
 * (.cm-tooltip-lint:not(.cm-tooltip-lint-offset)).
 */
const offsetLintHover = hoverTooltip((view, pos, side) =>
{
    /** @type {{ d: import("@codemirror/lint").Diagnostic, from: number, to: number }[]} */
    const hits = [];
    forEachDiagnostic(view.state, (d, from, to) =>
    {
        if (pos >= from && pos <= to &&
            (from === to || ((pos > from || side > 0) && (pos < to || side < 0))))
        {
            hits.push({ d, from, to });
        }
    });
    if (!hits.length) return null;

    const start = hits[0].from;
    const end = hits[0].to;

    return {
        pos: start,
        end: end,
        above: true,
        create()
        {
            const ul = document.createElement("ul");
            ul.className = "cm-tooltip-lint cm-tooltip-lint-offset";
            // CM6 wraps our UL in a <div class="cm-tooltip-hover"> and
            // positions THAT div — not our UL. The wrapper is what slides
            // between measure passes, so cursor / pointer-events on the UL
            // never reach the actual hit surface. We tag the UL here and
            // use a mount() callback below to walk up to the wrapper and
            // style it directly.
            ul.style.pointerEvents = "none";
            ul.style.userSelect = "none";
            ul.style.cursor = "default";
            /** @type {HTMLButtonElement[]} */
            const btns = [];
            for (const h of hits)
            {
                const li = renderDiagItem(view, h.d, h.from, h.to);
                const btn = li.querySelector(".cm-diagnosticAction");
                if (btn instanceof HTMLElement)
                {
                    btn.style.pointerEvents = "none";
                    btn.style.cursor = "default";
                    btns.push(/** @type {HTMLButtonElement} */(btn));
                }
                ul.appendChild(li);
            }
            return {
                dom: ul,
                // y:0 leaves no visual gap — tooltip sits flush above the
                // squiggle. Avoids the "user moves through the gap and
                // tooltip vanishes" problem entirely. The flicker that
                // motivated the non-zero offset originally is now solved
                // by the visibility:hidden mount() hack below.
                offset: { x: 0, y: 0 },
                mount()
                {
                    // Walk up to the .cm-tooltip-hover wrapper that CM6
                    // creates around us — that's the element CM6 positions
                    // and the one the cursor actually hit-tests against.
                    // Hide it during the two-pass position settle, then
                    // reveal. Also disable pointer-events / cursor so even
                    // after reveal the cursor never reacts to the box.
                    const host = ul.closest(".cm-tooltip-hover, .cm-tooltip");
                    if (host instanceof HTMLElement)
                    {
                        host.style.visibility = "hidden";
                        host.style.pointerEvents = "none";
                        host.style.cursor = "default";
                        host.style.userSelect = "none";
                        setTimeout(() =>
                        {
                            host.style.visibility = "visible";
                            for (const b of btns)
                            {
                                b.style.pointerEvents = "auto";
                                b.style.cursor = "pointer";
                            }
                        }, 80);
                    }
                }
            };
        }
    };
}, { hoverTime: 300, hideOnChange: true });

/**
 * @param {() => { tier: string, dialect?: any, hunspellId?: string }} getCfg
 * @param {string} [format] - Document format hint passed to runParserLinter.
 * @returns {import("@codemirror/state").Extension}
 */
export function combinedLinter(getCfg, format = "mangaplay")
{
    // Split parser and spell into TWO separate linter extensions so the
    // parser diagnostics surface immediately on each lint pass even when
    // the spell pipeline (Harper) is still warming up. CM6 merges the
    // diagnostic sets from multiple linter() extensions into one set.
    //
    // Previously this was a single source that raced spell against a
    // 300ms timeout; if Harper missed the window we returned EMPTY for
    // the whole pass (parser AND spell), and CM6's `set=false` guard
    // then suppressed re-fire until the next docChanged — flaky boot
    // lint, with up to 40% of boots showing no diagnostics at all.
    const parserExt = linter((view) => runParserLinter(view, format),
        { delay: 250, hoverTime: 300 });
    const spellExt = buildSpellExt(getCfg, 250);

    return [parserExt, spellExt, offsetLintHover];
}

/**
 * Build a CM6 linter extension that defers to the lazy-loaded Harper spell
 * pipeline. Shared by `combinedLinter()` and `lazySpellcheckLinter()`.
 *
 * @param {() => { tier: string, dialect?: any, hunspellId?: string }} getCfg
 * @param {number} delay
 * @returns {import("@codemirror/state").Extension}
 */
function buildSpellExt(getCfg, delay)
{
    return linter(async (view) =>
    {
        try
        {
            const mod = await loadSpellModule();
            return await mod.runSpellcheckLinter(getCfg, view);
        }
        catch (_) { return []; }
    }, { delay, hoverTime: 300 });
}

/**
 * Build a spell-only linter extension (no parser branch). Used by the
 * Fountain branch of lang-registry, which has no mangaplay-specific parser
 * warnings to combine with. Same lazy spell-chunk load as combinedLinter().
 * @param {() => { tier: string, dialect?: any, hunspellId?: string }} getCfg
 * @returns {import("@codemirror/state").Extension}
 */
export function lazySpellcheckLinter(getCfg)
{
    return buildSpellExt(getCfg, 400);
}
