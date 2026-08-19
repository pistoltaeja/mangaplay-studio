import { state } from "./state.js";
import { mountOutline } from "../panes/left-pane-outline.js";
import { mountStatistics } from "../panes/left-pane-statistics.js";
import { EditorView } from "@codemirror/view";
import { queueAppSettingsSave } from "../app.js";

/**
 * Mount the Outline + Statistics subviews. Called once on first project mount;
 * idempotent (re-mounts are skipped because the modules subscribe to the
 * runtime store, which persists across project swaps).
 */
export function wireLeftSubviews()
{
    if (!state.outlineView)
    {
        try { state.outlineView = mountOutline({ onJump: jumpToScene }); }
        catch (e) { console.warn("[outline] mount failed:", e); }
    }
    if (!state.statisticsView)
    {
        try { state.statisticsView = mountStatistics(); }
        catch (e) { console.warn("[statistics] mount failed:", e); }
    }
}

/**
 * Scroll the active editor (or canvas) to a scene's source line.
 * Branches on the current editor mode — Source / Text scroll the CM view;
 * Visual jumps to the page that contains the scene's line.
 *
 * @param {{ line: number, sceneIdx: number }} info
 */
export function jumpToScene(info)
{
    const slot = state.slotManager?.getActive();
    if (!slot) return;
    /** @type {string} */
    const mode = /** @type {any} */ (state.modeToggleEl)?.mode || "wysiwyg";
    if (mode === "easy")
    {
        const canvasEl = /** @type {any} */ (document.querySelector("mps-canvas"));
        let pageIndex = 0;
        if (canvasEl && typeof canvasEl.findPageIndexByLine === "function")
        {
            try { pageIndex = canvasEl.findPageIndexByLine(info.line) || 0; }
            catch (e) { console.warn("[jumpToScene] findPageIndexByLine threw:", e); }
        }
        document.dispatchEvent(new CustomEvent("page-change", {
            detail: { pageIndex, direction: 0 }
        }));
        document.dispatchEvent(new CustomEvent("screenplay-scroll-to-page", {
            detail: { pageIndex }
        }));
        return;
    }
    const view = slot.view;
    if (!view) return;
    try
    {
        const totalLines = view.state.doc.lines;
        const target = Math.min(Math.max(info.line + 1, 1), totalLines);
        const lineObj = view.state.doc.line(target);
        view.dispatch({
            selection: { anchor: lineObj.from },
            effects: EditorView.scrollIntoView(lineObj.from, { y: "start", yMargin: 8 })
        });
        view.focus();
    }
    catch (e)
    {
        console.warn("[jumpToScene] dispatch failed:", e);
    }
}

export async function switchSubview(name)
{
    const pane = document.getElementById("left-pane");
    if (!pane) return;
    if (pane.dataset.subview === name) return;

    // Stick the click instantly — flip aria-pressed before any await so the button
    // highlight responds immediately rather than waiting for the 300ms cross-fade.
    document.querySelectorAll(".top-bar-subview").forEach(b =>
    {
        b.setAttribute("aria-pressed",
            b.dataset.subview === name ? "true" : "false");
    });

    const outgoingName = pane.dataset.subview;
    const outgoingEl = document.getElementById(`subview-${outgoingName}`);
    const incomingEl = document.getElementById(`subview-${name}`);
    if (!incomingEl) return;

    // Fade outgoing
    if (outgoingEl)
    {
        outgoingEl.style.opacity = "0";
        await new Promise(r => setTimeout(r, 150));
        outgoingEl.style.display = "none";
        outgoingEl.style.opacity = "";
    }

    // Reveal incoming. Clear the inline display so the stylesheet drives
    // (some subviews need `display: flex` for internal scroll-host sizing;
    // hard-coding "block" here would override that and break their layout).
    incomingEl.style.display = "";
    incomingEl.style.opacity = "0";
    void incomingEl.offsetHeight;               // force reflow
    incomingEl.style.opacity = "1";
    await new Promise(r => setTimeout(r, 150));
    incomingEl.style.opacity = "";

    pane.dataset.subview = name;

    queueAppSettingsSave({ activeSubview: name });
}

// Instantaneous variant — used on restore so there's no 150ms flash.
export function applySubview(name)
{
    const pane = document.getElementById("left-pane");
    if (!pane) return;
    pane.dataset.subview = name;

    for (const sub of ["folder", "outline", "statistics"])
    {
        const el = document.getElementById(`subview-${sub}`);
        if (!el) continue;
        el.style.display = (sub === name) ? "" : "none";
        el.style.opacity = "";
    }

    document.querySelectorAll(".top-bar-subview").forEach(b =>
    {
        b.setAttribute("aria-pressed",
            b.dataset.subview === name ? "true" : "false");
    });
}
