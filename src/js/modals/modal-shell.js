// @ts-check
/**
 * modal-shell.js — Shared lifecycle for backdrop-style modals.
 *
 * confirm-modal.js (and any future backdrop modal) needs: singleton state,
 * backdrop + dialog scaffolding, mount/visible animation, Esc-to-cancel
 * keydown, backdrop-click-to-cancel, and a fade-out destroy that removes the
 * element after the CSS transition. This module owns all of that so each
 * modal only has to build its own dialog body.
 */

/** @typedef {{ resolve: (v: any) => void, cancelValue: any, onKeydown?: (ev: KeyboardEvent) => void, busy?: boolean }} ModalState */

/** @type {{ root: HTMLElement, state: ModalState } | null} */
let active = null;

/**
 * Open a modal. Resolves with whatever the caller's `build()` resolves the
 * returned promise with; resolves with `cancelValue` on Esc / backdrop click
 * / a second openModal() call while this one is still open.
 *
 * @template T
 * @param {object} opts
 * @param {string} opts.variantClass — extra class added to the backdrop (e.g. "confirm-modal").
 * @param {T} opts.cancelValue — value to resolve with on cancel.
 * @param {(ctx: { backdrop: HTMLElement, resolveWith: (v: T) => void, cancel: () => void }) => void} opts.build
 *     — caller fills the backdrop with its dialog. May attach extra keydown
 *       behaviour by reading `ctx.backdrop` and adding listeners.
 * @returns {Promise<T>}
 */
export function openModal(opts)
{
    // Singleton: any in-flight modal is resolved with its own cancelValue
    // before the new one mounts. Matches the prior per-modal behaviour.
    if (active)
    {
        try { active.state.resolve(active.state.cancelValue); } catch {}
        teardown();
    }

    return new Promise((resolve) =>
    {
        const backdrop = document.createElement("div");
        backdrop.className = `settings-backdrop ${opts.variantClass}`;
        backdrop.setAttribute("role", "presentation");

        const state = /** @type {ModalState} */ ({ resolve, cancelValue: opts.cancelValue, busy: false });
        active = { root: backdrop, state };

        /** @type {(v: any) => void} */
        const resolveWith = (v) =>
        {
            if (!active) return;
            const r = active.state.resolve;
            teardown();
            r(v);
        };
        const cancel = () => resolveWith(opts.cancelValue);

        // Backdrop click → cancel (clicks inside the dialog don't bubble cancel).
        // Busy modals swallow the click so an accidental backdrop-tap during an
        // in-flight operation doesn't abort it.
        backdrop.addEventListener("click", (ev) =>
        {
            if (state.busy) return;
            if (ev.target === backdrop) cancel();
        });

        // Esc → cancel. Stored on state so teardown removes it cleanly.
        // Busy modals ignore Escape entirely — non-Escape keys still forward
        // to the caller-supplied onKeydown so busy mode doesn't wedge input.
        /** @type {(ev: KeyboardEvent) => void} */
        const onKey = (ev) =>
        {
            if (ev.key === "Escape")
            {
                if (state.busy) return;
                cancel();
            }
            else if (state.onKeydown) state.onKeydown(ev);
        };
        document.addEventListener("keydown", onKey);
        /** @type {any} */ (backdrop).__modalShellOnKey = onKey;

        opts.build({ backdrop, resolveWith, cancel });

        document.body.appendChild(backdrop);
        requestAnimationFrame(() =>
        {
            if (active && active.root === backdrop) backdrop.classList.add("visible");
        });
    });
}

/**
 * Attach an extra keydown handler (e.g. Enter → confirm). Must be called
 * during `build()` from inside `openModal`. Multiple calls overwrite the
 * previous handler.
 *
 * @param {(ev: KeyboardEvent) => void} fn
 */
export function setModalKeydown(fn)
{
    if (active) active.state.onKeydown = fn;
}

/**
 * Toggle busy mode on the active modal. While busy, backdrop-clicks and
 * Escape are ignored — the caller must provide its own in-dialog exit.
 * Adds/removes an `is-busy` class on the backdrop for CSS hooks.
 *
 * @param {boolean} busy
 */
export function setModalBusy(busy)
{
    if (!active) return;
    active.state.busy = !!busy;
    active.root.classList.toggle("is-busy", !!busy);
}

function teardown()
{
    if (!active) return;
    const root = active.root;
    const handler = /** @type {any} */ (root).__modalShellOnKey;
    if (handler) document.removeEventListener("keydown", handler);
    root.classList.remove("visible");
    setTimeout(() => { try { root.remove(); } catch {} }, 200);
    active = null;
}
