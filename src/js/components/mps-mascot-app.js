// @ts-check
/**
 * mps-mascot-app.js — App-scoped mascot singleton.
 *
 * The <mps-mascot> web component is the reusable animatable mascot. This
 * module owns THE mascot instance that lives directly on <body>, sits at
 * `position: fixed` in the viewport, and stays mounted across FSM
 * transitions (onboarding → workspace → error → …). Any feature that
 * wants to animate the mascot calls `getAppMascot()` and drives the
 * returned element's public API (enter/exit/moveTo/setPose).
 *
 * Why a singleton on <body>, not per-view:
 *   - `position: fixed` on <body> means the mascot's `translateX(120vw)`
 *     off-screen base state doesn't extend any ancestor's scrollable
 *     overflow — the browser doesn't paint a horizontal scrollbar during
 *     the fly-in.
 *   - The mascot is a first-class app character that persists across
 *     views — mounting it on each view would replay the entrance every
 *     time and force skin re-registration.
 *   - One `<mps-mascot>` element means one head + body pair registered
 *     with the skin subsystem — no duplicate image registrations to
 *     prune, no risk of a skin swap missing a stale instance.
 */

import "./mps-mascot.js";

const ID = "app-mascot";

/**
 * Ensure the app-level mascot exists on <body> and return it. Idempotent:
 * safe to call repeatedly; the same element is returned every time.
 * @returns {HTMLElement & { enter?: Function, exit?: Function, moveTo?: Function, setPose?: Function }}
 */
export function getAppMascot()
{
    let el = /** @type {any} */ (document.getElementById(ID));
    if (!el)
    {
        el = document.createElement("mps-mascot");
        el.id = ID;
        // Initial visibility state — off-screen right, invisible. The
        // component's own CSS pre-positions the container at
        // translateX(120vw) so nothing renders until a caller invokes
        // `enter(...)`.
        document.body.appendChild(el);
    }
    return el;
}
