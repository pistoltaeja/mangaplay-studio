// @ts-check
/**
 * conflict-toast.test.js — DOM smoke tests for the conflict toast.
 *
 * Verifies that:
 *   - Render produces the three action buttons + the close X.
 *   - The toast message interpolates `{title}`.
 *   - Each button invokes its callback.
 *   - "Keep mine" / "Keep theirs" auto-dismiss; "Open both" doesn't.
 *   - Re-opening the toast dismisses the previous instance (singleton).
 *
 * Uses JSDOM via dynamic import so the test file is portable across the
 * root `bun run test` (no preload) and the package-local one (jsdom preload).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

let JSDOM = null;
try
{
    ({ JSDOM } = require("jsdom"));
}
catch
{
    // Skip the suite if jsdom isn't installed at this layer.
}

// Lazy bind — `globalThis.document` must exist BEFORE conflict-toast.js
// touches `document.head` / `document.createElement`.
/** @type {any} */
let showConflictToast = null;
/** @type {any} */
let dismissConflictToast = null;

async function loadModule()
{
    const mod = await import("./conflict-toast.js");
    showConflictToast = mod.showConflictToast;
    dismissConflictToast = mod.dismissConflictToast;
}

describe("conflict-toast — DOM render + button wiring", () =>
{
    let savedDocument;
    let savedWindow;

    beforeEach(async () =>
    {
        if (!JSDOM) return;
        const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
        savedDocument = globalThis.document;
        savedWindow = globalThis.window;
        // @ts-ignore
        globalThis.document = dom.window.document;
        // @ts-ignore
        globalThis.window = dom.window;
        await loadModule();
    });

    afterEach(() =>
    {
        if (!JSDOM) return;
        if (dismissConflictToast) dismissConflictToast();
        // @ts-ignore
        globalThis.document = savedDocument;
        // @ts-ignore
        globalThis.window = savedWindow;
    });

    test("renders three action buttons + close button + message", () =>
    {
        if (!JSDOM) return;
        showConflictToast({ title: "Dorothy Chapter 01" });

        const toast = document.querySelector(".gds-conflict-toast");
        expect(toast).not.toBe(null);

        const msg = toast.querySelector(".gds-conflict-toast-message");
        expect(msg).not.toBe(null);
        expect(msg.textContent).toContain("Dorothy Chapter 01");

        const btns = toast.querySelectorAll(".gds-conflict-toast-btn");
        expect(btns.length).toBe(3);

        const close = toast.querySelector(".gds-conflict-toast-close");
        expect(close).not.toBe(null);
    });

    test("Keep my version fires onKeepMine and dismisses", () =>
    {
        if (!JSDOM) return;
        let fired = false;
        showConflictToast({
            title: "X",
            onKeepMine: () => { fired = true; }
        });

        const btns = document.querySelectorAll(".gds-conflict-toast-btn");
        /** @type {any} */ (btns[0]).click();
        expect(fired).toBe(true);

        // Auto-dismiss is async because the click handler resolves a Promise.
        // The dispatch synchronously schedules the dismiss, so we await a
        // microtask flush via Promise.resolve before asserting.
        return Promise.resolve().then(() =>
        {
            expect(document.querySelector(".gds-conflict-toast")).toBe(null);
        });
    });

    test("Keep their version fires onKeepTheirs and dismisses", () =>
    {
        if (!JSDOM) return;
        let fired = false;
        showConflictToast({
            title: "X",
            onKeepTheirs: () => { fired = true; }
        });

        const btns = document.querySelectorAll(".gds-conflict-toast-btn");
        /** @type {any} */ (btns[1]).click();
        expect(fired).toBe(true);
        return Promise.resolve().then(() =>
        {
            expect(document.querySelector(".gds-conflict-toast")).toBe(null);
        });
    });

    test("Open both fires onOpenBoth and does NOT auto-dismiss", () =>
    {
        if (!JSDOM) return;
        let fired = false;
        showConflictToast({
            title: "X",
            onOpenBoth: () => { fired = true; }
        });

        const btns = document.querySelectorAll(".gds-conflict-toast-btn");
        /** @type {any} */ (btns[2]).click();
        expect(fired).toBe(true);
        return Promise.resolve().then(() =>
        {
            expect(document.querySelector(".gds-conflict-toast")).not.toBe(null);
        });
    });

    test("close X dismisses the toast", () =>
    {
        if (!JSDOM) return;
        showConflictToast({ title: "X" });
        const close = document.querySelector(".gds-conflict-toast-close");
        /** @type {any} */ (close).click();
        expect(document.querySelector(".gds-conflict-toast")).toBe(null);
    });

    test("re-opening dismisses the previous instance (singleton)", () =>
    {
        if (!JSDOM) return;
        showConflictToast({ title: "First" });
        showConflictToast({ title: "Second" });
        const all = document.querySelectorAll(".gds-conflict-toast");
        expect(all.length).toBe(1);
        const msg = document.querySelector(".gds-conflict-toast-message");
        expect(msg.textContent).toContain("Second");
    });
});
