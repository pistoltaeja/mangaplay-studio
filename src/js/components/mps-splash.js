// @ts-check
/**
 * <mps-splash> — unified loading surface.
 *
 * Replaces three drifting UIs (native Rust splash, inline #boot-screen,
 * mps-picker-shell opening card) with a single web component that owns every
 * loading frame from Rust splash close through workspace mount.
 *
 * Boot ordering contract:
 *   1. index.html paints `#boot-screen` inline (pre-JS).
 *   2. Inline shim `window.__mpsSplash` mutates that DOM directly AND queues
 *      each call. This covers pre-parse callers (boot-placeholders.js) that
 *      run before app.js finishes evaluating.
 *   3. app.js evaluates -> customElements.define("mps-splash", ...) fires ->
 *      component upgrades the `#boot-screen` element in place, drains the
 *      queue, and replaces the shim's methods with direct component calls.
 *   4. All subsequent boot / opening-project / restore captions go through
 *      the shim, which now forwards to the component.
 *
 * The component adopts the existing `#boot-screen` DOM — no unmount, no
 * remount. This keeps the mascot bounding box stable across the hand-off.
 *
 * API:
 *   splash.update(stage, msg)  — set caption and (if stage is known) progress
 *   splash.setProgress(p)      — set progress bar fill fraction 0..1
 *   splash.done()              — fade out and remove
 *   splash.show()              — un-hide after done() (for opening-project re-show)
 */

// Stage -> progress fraction. Mirrors the inline shim in index.html.
const STAGE_PROGRESS = {
    paint:         0.05,
    bundle:        0.30,
    settings:      0.45,
    userData:      0.55,
    iapInit:       0.55,
    analyticsInit: 0.55,
    accountInit:   0.55,
    project:       0.85,
    opening:       0.85
};

// Readability floors — must match the inline shim in index.html.
const SPLASH_MIN_TOTAL_MS = 2000;
const SPLASH_MIN_STAGE_MS = 250;

class MpsSplash extends HTMLElement
{
    constructor()
    {
        super();
        this._progress = 0;
        this._done = false;
        this._lastUpdateAt = 0;
        this._pendingTimer = null;
        this._pendingArgs = null;
    }

    connectedCallback()
    {
        // Adopt the existing inline markup if it's already present (id +
        // boot-* class names from index.html). Otherwise render fresh — this
        // path is used when the shim's done() has already removed the
        // #boot-screen and we're re-showing for OPENING_PROJECT.
        //
        // Detection: presence of `.boot-splash` child means the inline shell
        // is still here. Adopt attribute-by-attribute rather than replacing
        // innerHTML so the browser doesn't drop-in a fresh <img> and force
        // a re-decode / bounding-rect jump.
        const existingSplash = this.querySelector("#boot-screen .boot-splash, .boot-splash");
        if (existingSplash)
        {
            existingSplash.classList.add("mps-splash-mascot");
        }
        const existingProgress = this.querySelector("#boot-progress");
        if (existingProgress)
        {
            existingProgress.classList.add("mps-splash-progress");
        }
        const existingFill = this.querySelector("#boot-progress-fill");
        if (existingFill)
        {
            existingFill.classList.add("mps-splash-progress-fill");
        }
        const existingCaption = this.querySelector("#boot-caption");
        if (existingCaption)
        {
            existingCaption.classList.add("mps-splash-caption");
        }

    }

    /**
     * Update caption and (if stage is known) advance the progress bar.
     * Throttled by SPLASH_MIN_STAGE_MS so each caption stays readable —
     * updates arriving faster than that are coalesced (latest wins) and
     * flushed once the gap is satisfied.
     * @param {string} stage
     * @param {string} [msg]
     */
    update(stage, msg)
    {
        const now = performance.now();
        const gap = now - this._lastUpdateAt;
        if (this._lastUpdateAt === 0 || gap >= SPLASH_MIN_STAGE_MS)
        {
            this._applyUpdate(stage, msg);
            return;
        }
        this._pendingArgs = [stage, msg];
        if (this._pendingTimer) return;
        this._pendingTimer = setTimeout(() =>
        {
            this._pendingTimer = null;
            const args = this._pendingArgs;
            this._pendingArgs = null;
            if (args) this._applyUpdate(args[0], args[1]);
        }, SPLASH_MIN_STAGE_MS - gap);
    }

    _applyUpdate(stage, msg)
    {
        const cap = this.querySelector(".mps-splash-caption, #boot-caption");
        if (cap && msg) cap.textContent = msg;
        const p = STAGE_PROGRESS[stage];
        if (typeof p === "number") this.setProgress(p);
        this._lastUpdateAt = performance.now();
    }

    /**
     * Set progress bar fill fraction. Never moves backwards.
     * @param {number} p — 0..1
     */
    setProgress(p)
    {
        if (typeof p !== "number") return;
        if (p < this._progress) return;
        this._progress = Math.min(1, p);
        const fill = this.querySelector(".mps-splash-progress-fill, #boot-progress-fill");
        if (fill)
        {
            /** @type {HTMLElement} */ (fill).style.width = (this._progress * 100).toFixed(1) + "%";
        }
    }

    /**
     * Fade out and remove. Idempotent.
     * Returns a Promise that resolves AFTER remove() runs — callers can
     * `await splash.done()` to sequence workspace reveal against the fade.
     * @returns {Promise<void>}
     */
    done()
    {
        if (this._done)
        {
            return this._donePromise || Promise.resolve();
        }
        this._done = true;
        // Flush any pending throttled update so the final caption isn't lost.
        if (this._pendingTimer)
        {
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
            if (this._pendingArgs)
            {
                this._applyUpdate(this._pendingArgs[0], this._pendingArgs[1]);
                this._pendingArgs = null;
            }
        }
        this.setProgress(1);
        const startAt = /** @type {number} */ (window.__splashStartAt) || 0;
        const elapsed = startAt ? (performance.now() - startAt) : SPLASH_MIN_TOTAL_MS;
        const wait = Math.max(0, SPLASH_MIN_TOTAL_MS - elapsed);
        this._donePromise = new Promise((resolve) =>
        {
            setTimeout(() =>
            {
                this.style.opacity = "0";
                setTimeout(() =>
                {
                    try { this.remove(); } catch (_) {}
                    resolve();
                }, 260);
            }, wait);
        });
        return this._donePromise;
    }

    /** Re-show after done() for OPENING_PROJECT paths. */
    show()
    {
        this._done = false;
        this.style.opacity = "1";
        this.hidden = false;
    }
}

if (!customElements.get("mps-splash"))
{
    customElements.define("mps-splash", MpsSplash);
}

/**
 * Attach the component to the DOM and drain the inline shim's queue.
 *
 * Called from app.js after top-level imports settle. Idempotent — safe to
 * call after the shim has already fired done() and removed #boot-screen.
 */
export function installSplashComponent()
{
    // Two paths:
    //   A) #boot-screen still exists (normal boot): promote it to <mps-splash>
    //      by replacing the tag in place, preserving children.
    //   B) #boot-screen was already removed (rare — done() fired before
    //      app.js reached this line): create a fresh <mps-splash>, keep it
    //      hidden until show() is called.
    let splashEl = /** @type {any} */ (document.querySelector("mps-splash"));
    if (splashEl) return _wireShim(splashEl);

    const boot = document.getElementById("boot-screen");
    if (boot)
    {
        // Promote in place. Create a fresh <mps-splash>, move all children
        // across, then swap.
        splashEl = document.createElement("mps-splash");
        splashEl.id = "boot-screen";
        while (boot.firstChild) splashEl.appendChild(boot.firstChild);
        // Copy inline transition state (done() may have started).
        splashEl.style.cssText = boot.style.cssText;
        boot.replaceWith(splashEl);
    }
    else
    {
        // Fresh element (opening-project re-show path).
        splashEl = document.createElement("mps-splash");
        splashEl.id = "boot-screen";
        splashEl.hidden = true;
        document.body.appendChild(splashEl);
    }

    _wireShim(splashEl);
    return splashEl;
}

function _wireShim(splashEl)
{
    const shim = /** @type {any} */ (window).__mpsSplash;
    if (!shim) return splashEl;

    // Drain any queued calls. The shim's own DOM mutations have already run,
    // so replay just ensures the component's internal state (progress, etc.)
    // reflects the pre-upgrade calls.
    const queued = typeof shim.__drain === "function" ? shim.__drain() : [];
    for (const [method, ...args] of queued)
    {
        if (method === "update" && typeof splashEl.update === "function") splashEl.update(...args);
        else if (method === "setProgress" && typeof splashEl.setProgress === "function") splashEl.setProgress(...args);
        else if (method === "done" && typeof splashEl.done === "function") splashEl.done();
    }

    // Rewire shim methods to forward directly to the component.
    shim.update = (stage, msg) => splashEl.update(stage, msg);
    shim.setProgress = (p) => splashEl.setProgress(p);
    // done() returns the component's Promise so awaiters resolve after
    // the element is removed. If the shim's own done() already ran
    // pre-upgrade (queued + DOM mutated), its stored promise carries the
    // resolution and this forward re-uses it via the component's
    // idempotent _donePromise.
    const originalShimDone = typeof shim.done === "function" ? shim.done : null;
    shim.done = () =>
    {
        // Chain original inline shim done() so it still clears the boot watchdog timer defined in index.html.
        if (originalShimDone) { try { originalShimDone(); } catch (_) {} }
        return splashEl.done();
    };
    shim.show = () => splashEl.show();
    shim.__el = splashEl;

    return splashEl;
}
