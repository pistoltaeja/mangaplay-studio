// @ts-check
/**
 * state-machine.js — declared FSM with per-mode transition tables.
 *
 * Replaces the implicit FSM that lived in app.js (a free-form string +
 * ~15 ad-hoc setAppState() calls). Each state declares its allowed next
 * states; transitions outside the table throw — caught early so flow
 * bugs surface during dev, not at user-report time.
 *
 * ─── HOW TO ADD A NEW STATE ────────────────────────────────────────────
 *   1. Add the state name to the STATES const at the top.
 *   2. Add an entry to STATE_HANDLERS keyed by the state name. The
 *      handler receives `ctx` and may return a Promise.
 *   3. For each existing state that should be able to enter the new one,
 *      list the new state in DESKTOP_TRANSITIONS[from] (and
 *      MOBILE_TRANSITIONS if mobile should also reach it).
 *   4. Add the user-visible caption to `boot.state.<your-state>` in
 *      en.json + 13 sister locales (parity check enforces this).
 *   5. If the state has its own DOM (e.g. a fullscreen view), add the
 *      markup to index.html and gate visibility off
 *      `[data-app-state="..."]`.
 * ───────────────────────────────────────────────────────────────────────
 */

import { isMobileLike } from "./ux-mode.js";

export const STATES = Object.freeze({
    APP_INIT:        "app-init",         // pre-paint, Rust setup() running
    LOADING:         "loading",          // boot-screen visible, app.js parsing / settings / iap/analytics/account
    ONBOARDING:      "onboarding",       // first-run / --onboarding override — picker-shell in onboarding phase
    RECENT_PROJECTS: "recent-projects",  // desktop picker (mobile skips)
    OPENING_PROJECT: "opening-project",  // openProject() in flight
    PROJECT:         "project",          // ready, editor mounted
    ERROR:           "error",            // fatal — overlay shown
});

// Desktop flow: app-init → loading → (recent-projects if no auto-resume) → opening-project → project
const DESKTOP_TRANSITIONS = {
    [STATES.APP_INIT]:        [STATES.LOADING, STATES.ERROR],
    [STATES.LOADING]:         [STATES.ONBOARDING, STATES.RECENT_PROJECTS, STATES.OPENING_PROJECT, STATES.LOADING, STATES.ERROR],
    [STATES.ONBOARDING]:      [STATES.OPENING_PROJECT, STATES.RECENT_PROJECTS, STATES.ERROR],
    [STATES.RECENT_PROJECTS]: [STATES.OPENING_PROJECT, STATES.LOADING, STATES.ERROR],
    [STATES.OPENING_PROJECT]: [STATES.PROJECT, STATES.RECENT_PROJECTS, STATES.ERROR],
    [STATES.PROJECT]:         [STATES.LOADING, STATES.OPENING_PROJECT, STATES.ERROR],
    [STATES.ERROR]:           [STATES.ONBOARDING, STATES.RECENT_PROJECTS, STATES.LOADING, STATES.OPENING_PROJECT],
};

// Mobile flow: app-init → loading → opening-project → project (no picker, ever)
const MOBILE_TRANSITIONS = {
    [STATES.APP_INIT]:        [STATES.LOADING, STATES.ERROR],
    [STATES.LOADING]:         [STATES.ONBOARDING, STATES.OPENING_PROJECT, STATES.LOADING, STATES.ERROR],
    [STATES.ONBOARDING]:      [STATES.OPENING_PROJECT, STATES.RECENT_PROJECTS, STATES.ERROR],
    [STATES.OPENING_PROJECT]: [STATES.PROJECT, STATES.ERROR],
    [STATES.PROJECT]:         [STATES.LOADING, STATES.OPENING_PROJECT, STATES.ERROR],
    [STATES.ERROR]:           [STATES.ONBOARDING, STATES.LOADING, STATES.OPENING_PROJECT],
};

let currentState = STATES.APP_INIT;
let transitionPromise = Promise.resolve();
/** @type {Set<(to: string, from: string, ctx: any) => void>} */
const subscribers = new Set();

/** @returns {string} */
export function getState() { return currentState; }

/**
 * @param {(to: string, from: string, ctx: any) => void} fn
 * @returns {() => void}
 */
export function subscribe(fn)
{
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

/**
 * Transition to a new state. Rejected if not in the per-mode transition
 * table. Serialised — a second transition() while one is in flight queues
 * behind it. ERROR is always reachable as a safety valve regardless of
 * the table.
 *
 * @param {string} to — STATES.* target
 * @param {object} [ctx={}] — handler-specific context
 * @returns {Promise<void>}
 */
export function transition(to, ctx = {})
{
    transitionPromise = transitionPromise.then(async () =>
    {
        const table = isMobileLike() ? MOBILE_TRANSITIONS : DESKTOP_TRANSITIONS;
        const allowed = table[currentState] || [];
        if (!allowed.includes(to) && to !== STATES.ERROR)
        {
            // Throw early so flow bugs surface in dev. Production catches
            // this at the boot-path level and routes through reportError.
            throw new Error(`FSM: ${currentState} → ${to} not allowed (mode=${isMobileLike() ? "mobile" : "desktop"})`);
        }
        const from = currentState;
        currentState = to;
        try { document.documentElement.setAttribute("data-app-state", to); } catch (_) {}
        for (const fn of subscribers)
        {
            try { fn(to, from, ctx); }
            catch (e) { console.warn("[fsm] subscriber threw:", e); }
        }
        const handler = STATE_HANDLERS[to];
        if (handler) await handler(ctx);
    });
    return transitionPromise;
}

/** @type {Record<string, (ctx: any) => Promise<void>|void>} */
const STATE_HANDLERS = {
    [STATES.APP_INIT]: () => {}, // pre-paint, no JS work
    [STATES.LOADING]: (ctx) =>
    {
        const splash = /** @type {any} */ (window).__mpsSplash;
        if (splash && typeof splash.update === "function")
        {
            splash.update(ctx?.stage || "bundle", ctx?.message);
        }
    },
    // Onboarding: fade the #boot-screen so the picker-shell (already mounted
    // by shell/boot.js) becomes visible, AND clear the 15s watchdog timer set
    // in the inline boot IIFE — otherwise the watchdog fires 15s in and
    // surfaces "Took longer than expected." over a perfectly-working picker.
    // The mascot's entrance animation runs on top of the picker-shell surface
    // once #boot-screen fades.
    [STATES.ONBOARDING]: () =>
    {
        const splash = /** @type {any} */ (window).__mpsSplash;
        if (splash && typeof splash.done === "function") splash.done();
    },
    [STATES.RECENT_PROJECTS]: () => {},   // owned by app.js renderStartScreen for now
    [STATES.OPENING_PROJECT]: () => {},   // owned by app.js for now
    [STATES.PROJECT]: () =>
    {
        const splash = /** @type {any} */ (window).__mpsSplash;
        if (splash && typeof splash.done === "function") splash.done();
    },
    // ERROR: fade the splash BEFORE the error-router paints. The error
    // overlay lives at z=10000 above #boot-screen (z=9999), so leaving the
    // splash visible bleeds the mascot through any transparent error chrome.
    // Explicit done() also clears the watchdog timer set in the inline shim.
    [STATES.ERROR]: () =>
    {
        const splash = /** @type {any} */ (window).__mpsSplash;
        if (splash && typeof splash.done === "function") splash.done();
    },
};
