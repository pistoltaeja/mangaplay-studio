// @ts-check
/**
 * <mps-mascot> — Reusable two-part mascot component.
 *
 * Renders two absolutely-positioned <img> layers (head + body) at 1024×1024
 * intrinsic. Head + body are separate elements so future animations can move
 * them independently (head-bob, body-lean).
 *
 * Both images are registered with the skins subsystem so a runtime skin
 * swap updates both parts in place — no re-mount, no flicker.
 *
 * Public API (all methods return a Promise that resolves on animation end):
 *   enter(direction)           — animate the mascot on-screen from off-screen
 *   exit(direction)            — animate off-screen
 *   moveTo(x, y, opts)         — translate to a new position
 *   setPose(name)              — Phase 1 stub; sets data-pose attribute only
 *
 * All animations are single-flight — a second call while one is in-flight
 * awaits the first, then runs. The active animation is reflected on the
 * element via data-mascot-motion = "entering"|"exiting"|"moving"|"idle".
 */

import { getSkin, getCurrentSkinId, registerSkinnedImage } from "../boot/skins.js";

class MpsMascot extends HTMLElement
{
    constructor()
    {
        super();
        this._motion = "idle";
        this._pose = "default";
        // Deterministic counter for tests — increments each talk() even when
        // reduced-motion collapses the animation. Tests assert `> 0` without
        // racing on pixel polls.
        this._talkCount = 0;
        // Serialise concurrent animation requests — chain them off a single
        // promise so callers don't race. A late enter() after an exit()
        // just queues.
        this._chain = Promise.resolve();
    }

    _isReducedMotion()
    {
        try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
        catch (_) { return false; }
    }

    /**
     * Publish the mascot's current bounding rect as CSS custom properties on
     * `document.documentElement`. Satellite UI (<mps-dialogue>) reads these
     * via `calc(var(--ob-mascot-x))` to position without JS coupling.
     */
    _publishRootVars()
    {
        const r = this.getBoundingClientRect();
        const root = document.documentElement;
        root.style.setProperty("--ob-mascot-x", r.left + "px");
        root.style.setProperty("--ob-mascot-y", r.top + "px");
        root.style.setProperty("--ob-mascot-size", r.width + "px");
    }

    /**
     * Talking head rotation. Adds `.talking` to head, awaits `cycles*300ms`,
     * removes it. Increments `_talkCount` for test assertions. Reduced-motion:
     * still increments counter but resolves immediately.
     * @param {number} [cycles=3]
     * @returns {Promise<void>}
     */
    talk(cycles = 3)
    {
        this._talkCount++;
        const head = this.querySelector(".mps-mascot-head");
        if (!head) return Promise.resolve();
        if (this._isReducedMotion()) return Promise.resolve();
        head.classList.remove("mouth-open", "mouth-close");
        head.classList.add("talking");
        const duration = 300 * Math.max(1, Number(cycles) || 3);
        return new Promise((resolve) =>
        {
            setTimeout(() =>
            {
                head.classList.remove("talking");
                resolve();
            }, duration);
        });
    }

    /**
     * Open the mouth and hold it open. Class stays applied on completion.
     * @returns {Promise<void>}
     */
    openMouth()
    {
        const head = this.querySelector(".mps-mascot-head");
        if (!head) return Promise.resolve();
        head.classList.remove("talking", "mouth-close");
        head.classList.add("mouth-open");
        if (this._isReducedMotion()) return Promise.resolve();
        return new Promise((resolve) =>
        {
            const handler = () =>
            {
                head.removeEventListener("animationend", handler);
                resolve();
            };
            head.addEventListener("animationend", handler, { once: true });
            setTimeout(resolve, 300);
        });
    }

    /**
     * Close the mouth and hold it closed.
     * @returns {Promise<void>}
     */
    closeMouth()
    {
        const head = this.querySelector(".mps-mascot-head");
        if (!head) return Promise.resolve();
        head.classList.remove("talking", "mouth-open");
        head.classList.add("mouth-close");
        if (this._isReducedMotion()) return Promise.resolve();
        return new Promise((resolve) =>
        {
            const handler = () =>
            {
                head.removeEventListener("animationend", handler);
                resolve();
            };
            head.addEventListener("animationend", handler, { once: true });
            setTimeout(resolve, 300);
        });
    }

    /**
     * Face a direction — swaps `.facing-*` class on host. CSS rotates the
     * container via `rotateY()`. Awaits `transitionend` on the container.
     * @param {"left"|"center"|"right"} direction
     * @returns {Promise<void>}
     */
    face(direction)
    {
        const dir = String(direction || "center");
        this.classList.remove("facing-left", "facing-center", "facing-right");
        this.classList.add(`facing-${dir}`);
        if (this._isReducedMotion()) return Promise.resolve();
        const container = this.querySelector(".mps-mascot-container");
        if (!container) return Promise.resolve();
        return new Promise((resolve) =>
        {
            const handler = () =>
            {
                container.removeEventListener("transitionend", handler);
                resolve();
            };
            container.addEventListener("transitionend", handler, { once: true });
            // Safety timeout — transitionend can miss during tab throttling.
            setTimeout(resolve, 500);
        });
    }

    /**
     * Vertical bounce. Applied to HOST — bobbles the badge too, matching the
     * website's behaviour.
     * @returns {Promise<void>}
     */
    bobble()
    {
        // Force reflow so a rapid second bobble() restarts the animation.
        this.classList.remove("bobbling");
        void this.offsetWidth;
        this.classList.add("bobbling");
        if (this._isReducedMotion())
        {
            this.classList.remove("bobbling");
            return Promise.resolve();
        }
        return new Promise((resolve) =>
        {
            const handler = () =>
            {
                this.classList.remove("bobbling");
                this.removeEventListener("animationend", handler);
                resolve();
            };
            this.addEventListener("animationend", handler, { once: true });
            setTimeout(() =>
            {
                this.classList.remove("bobbling");
                resolve();
            }, 500);
        });
    }

    /**
     * Show / hide the "Pistol Taeja" name pin inside the mascot. Synchronous.
     * Pass `""` or falsy to remove.
     * @param {string} name
     */
    setBadge(name)
    {
        const label = String(name || "");
        let pin = this.querySelector(".mascot-name-pin");
        if (!label)
        {
            if (pin) pin.remove();
            return;
        }
        // Mount INSIDE the body layer so the pin inherits every transform
        // the body carries — entrance translateX, bobble translateY, future
        // body-lean. The host-mounted variant desynced during entrance
        // (host doesn't move, container does) and during the docked-state
        // face rotation (rotateY on container, badge stayed flat).
        const bodyLayer = this.querySelector(".mps-mascot-body");
        const targetParent = bodyLayer || this;
        let fadeInFresh = false;
        if (!pin)
        {
            pin = document.createElement("div");
            pin.className = "mascot-name-pin";
            // Start invisible so the CSS transition can carry it to 1.
            // Double-rAF below commits the opacity:0 initial state before
            // we remove the inline style, ensuring the transition runs.
            pin.style.opacity = "0";
            targetParent.appendChild(pin);
            fadeInFresh = true;
        }
        else if (pin.parentElement !== targetParent)
        {
            // Migrate from an older parent (e.g. host from a prior Phase 2
            // build) — remove + re-append so the new anchor takes effect.
            pin.remove();
            targetParent.appendChild(pin);
        }
        pin.textContent = label;
        if (fadeInFresh)
        {
            const target = pin;
            requestAnimationFrame(() => requestAnimationFrame(() =>
            {
                target.style.opacity = "";
            }));
        }
    }

    connectedCallback()
    {
        if (!this.querySelector(".mps-mascot-container"))
        {
            this._render();
        }
        this.setAttribute("data-mascot-motion", this._motion);
        this.setAttribute("data-mascot-pose", this._pose);
    }

    _render()
    {
        const entry = getSkin(getCurrentSkinId());
        const base = entry.baseUrl;
        const headFile = entry.manifest.mascotHeadFile;
        const bodyFile = entry.manifest.mascotBodyFile;
        // Body renders BEHIND head — separate layers, both fill the container.
        // Head + body are <div> wrappers around <img> layers so the body div
        // can host the .mascot-name-pin child (an <img> is a void element and
        // can't contain other elements).
        this.innerHTML = `
            <div class="mps-mascot-container">
                <div class="mps-mascot-body">
                    <img class="mps-mascot-img" src="${base + bodyFile}" alt="" draggable="false">
                </div>
                <div class="mps-mascot-head">
                    <img class="mps-mascot-img" src="${base + headFile}" alt="" draggable="false">
                </div>
            </div>
        `;
        // Register the <img> children (not the wrapper divs) — the skin
        // subsystem swaps `src` on img elements.
        const headImg = this.querySelector(".mps-mascot-head .mps-mascot-img");
        const bodyImg = this.querySelector(".mps-mascot-body .mps-mascot-img");
        if (headImg) registerSkinnedImage(headImg, "mascotHead");
        if (bodyImg) registerSkinnedImage(bodyImg, "mascotBody");
    }

    setPose(name)
    {
        this._pose = String(name || "default");
        this.setAttribute("data-mascot-pose", this._pose);
    }

    /**
     * Animate mascot in from off-screen. `direction` is where the mascot
     * enters FROM. CSS keyframes named `mps-mascot-enter-<direction>` handle
     * the actual transform. Component sets `data-mascot-motion` so the CSS
     * knows when to run.
     * @param {"right"|"left"|"top"|"bottom"} direction
     * @returns {Promise<void>}
     */
    enter(direction = "right")
    {
        return this._runMotion("entering", "enter", direction);
    }

    /**
     * Animate mascot off-screen in `direction`.
     * @param {"right"|"left"|"top"|"bottom"} direction
     * @returns {Promise<void>}
     */
    exit(direction = "right")
    {
        return this._runMotion("exiting", "exit", direction);
    }

    /**
     * Translate mascot to (x, y) in viewport units — Phase 1 stub, uses a
     * CSS transition on transform. Later phases can swap to WAAPI for path
     * animation.
     * @param {number} x
     * @param {number} y
     * @param {{duration?: number, easing?: string}} [opts]
     * @returns {Promise<void>}
     */
    moveTo(x, y, opts = {})
    {
        const duration = Number.isFinite(opts.duration) ? opts.duration : 600;
        const easing = opts.easing || "cubic-bezier(0.4, 0, 0.2, 1)";
        this._chain = this._chain.then(() => new Promise((resolve) =>
        {
            this._motion = "moving";
            this.setAttribute("data-mascot-motion", "moving");
            // Publish root vars FIRST so dialogue's own `transition: left,
            // top` starts tracking in the same frame as the mascot's move.
            const size = this.getBoundingClientRect().width || 98;
            const root = document.documentElement.style;
            root.setProperty("--ob-mascot-x", x + "px");
            root.setProperty("--ob-mascot-y", y + "px");
            root.setProperty("--ob-mascot-size", size + "px");
            // Viewport-absolute px — inline styles override the top/left
            // centring calc in mps-mascot.css.
            this.style.transition = `left ${duration}ms ${easing}, top ${duration}ms ${easing}`;
            this.style.left = x + "px";
            this.style.top = y + "px";
            const done = () =>
            {
                this.removeEventListener("transitionend", done);
                this._motion = "idle";
                this.setAttribute("data-mascot-motion", "idle");
                this.style.transition = "";
                resolve();
            };
            this.addEventListener("transitionend", done, { once: true });
            // Safety timeout — transitionend can be swallowed by tab
            // background throttling. duration + 200ms buffer.
            setTimeout(done, duration + 200);
        }));
        return this._chain;
    }

    _runMotion(motionState, kind, direction)
    {
        this._chain = this._chain.then(() => new Promise((resolve) =>
        {
            this._motion = motionState;
            this.setAttribute("data-mascot-motion", motionState);
            this.setAttribute("data-mascot-kind", kind);
            this.setAttribute("data-mascot-direction", direction);
            const container = this.querySelector(".mps-mascot-container") || this;
            let settled = false;
            const done = () =>
            {
                if (settled) return;
                settled = true;
                container.removeEventListener("animationend", done);
                // Post-animation resting state depends on the motion kind:
                //   entering → "docked"  (pinned at centre, visible)
                //   exiting  → "idle"    (off-screen at base CSS state)
                // Without this distinction, swapping back to "idle" after
                // an entrance would remove the animation entirely — CSS
                // `animation-fill-mode: both` only persists WHILE the
                // animation is applied — and the container would snap
                // back to the base `translateX(120vw); opacity: 0`
                // off-screen state.
                const restState = kind === "enter" ? "docked" : "idle";
                this._motion = restState;
                this.setAttribute("data-mascot-motion", restState);
                this.removeAttribute("data-mascot-kind");
                // Publish initial docked coords so dialogue's CSS calc()
                // has a live anchor from frame 1 of the docked state.
                if (restState === "docked")
                {
                    this._publishRootVars();
                }
                resolve();
            };
            container.addEventListener("animationend", done, { once: true });
            // Safety timeout — animationend rarely misses but tab-background
            // throttling can defer it. 1500ms covers the longest keyframe
            // we ship in Phase 1 (800ms enter + slack).
            setTimeout(done, 1500);
        }));
        return this._chain;
    }
}

if (!customElements.get("mps-mascot"))
{
    customElements.define("mps-mascot", MpsMascot);
}

export { MpsMascot };
