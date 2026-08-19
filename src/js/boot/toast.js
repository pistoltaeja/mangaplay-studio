// @ts-check
/**
 * toast.js — Minimal top-center toast for transient, single-line notices.
 *
 * Used by the multi-window `project-fs-changed` listener to surface external
 * rename / delete events. Auto-dismisses after 4 seconds; clicking dismisses
 * immediately. Multiple concurrent toasts stack vertically.
 */

let container = null;

/** Ensure the shared, module-local toast container exists and is attached. */
function ensureContainer()
{
    if (!container)
    {
        container = document.createElement("div");
        container.className = "mps-toast-container";
        container.style.cssText =
            "position:fixed;top:16px;left:50%;transform:translateX(-50%);" +
            "z-index:99999;display:flex;flex-direction:column;gap:8px;" +
            "pointer-events:none;";
        document.body.appendChild(container);
    }
    return container;
}

/**
 * @param {string} msg
 */
export function showBanner(msg)
{
    if (typeof document === "undefined") return;
    ensureContainer();
    const el = document.createElement("div");
    el.className = "mps-toast";
    el.textContent = msg;
    el.style.cssText =
        "background:rgba(20,20,20,0.92);color:#fff;font-size:13px;" +
        "padding:8px 14px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.3);" +
        "pointer-events:auto;cursor:pointer;max-width:480px;text-align:center;";
    el.addEventListener("click", () => dismiss(el));
    container.appendChild(el);
    setTimeout(() => dismiss(el), 4000);
}

/** @param {HTMLElement} el */
function dismiss(el)
{
    if (!el.parentNode) return;
    try { el.remove(); } catch {}
}

/**
 * A toast with an inline action button — used for undoable operations (e.g.
 * soft-delete). Shares the same top-center container and stacking as
 * {@link showBanner}. Auto-dismisses after `duration`; clicking the action
 * button runs `onAction` then dismisses; clicking elsewhere on the toast
 * dismisses WITHOUT running the action. All dismissal paths are idempotent.
 *
 * @param {string} msg — the message text.
 * @param {{ actionLabel?: string, onAction?: () => void, duration?: number }} [opts]
 *   `actionLabel` — the button label. `onAction` — invoked on button click.
 *   `duration` — auto-dismiss delay in ms (default 5000).
 * @returns {{ dismiss: () => void }} handle whose `dismiss()` flushes the toast
 *   early (idempotent).
 */
export function showUndoToast(msg, { actionLabel, onAction, duration = 5000 } = {})
{
    if (typeof document === "undefined") return { dismiss() {} };
    ensureContainer();

    const el = document.createElement("div");
    el.className = "mps-toast mps-undo-toast";
    el.style.cssText =
        "background:rgba(20,20,20,0.92);color:#fff;font-size:13px;" +
        "padding:8px 14px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.3);" +
        "pointer-events:auto;cursor:pointer;max-width:480px;" +
        "display:flex;align-items:center;";

    const label = document.createElement("span");
    label.textContent = msg;
    el.appendChild(label);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mps-undo-toast-action";
    btn.textContent = actionLabel ?? "";
    btn.style.cssText =
        "font-weight:700;color:#6ea8ff;background:transparent;border:none;" +
        "cursor:pointer;padding:4px 8px;margin-left:12px;font-size:13px;";
    el.appendChild(btn);

    let done = false;
    let timer = null;
    function close()
    {
        if (done) return;
        done = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        dismiss(el);
    }

    btn.addEventListener("click", (ev) =>
    {
        ev.stopPropagation();
        onAction?.();
        close();
    });
    el.addEventListener("click", () => close());

    container.appendChild(el);
    timer = setTimeout(close, duration);

    return { dismiss: close };
}
