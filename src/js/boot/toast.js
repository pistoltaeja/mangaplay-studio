// @ts-check
/**
 * toast.js — Minimal top-center toast for transient, single-line notices.
 *
 * Used by the multi-window `project-fs-changed` listener to surface external
 * rename / delete events. Auto-dismisses after 4 seconds; clicking dismisses
 * immediately. Multiple concurrent toasts stack vertically.
 */

let container = null;

/**
 * @param {string} msg
 */
export function showBanner(msg)
{
    if (typeof document === "undefined") return;
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
