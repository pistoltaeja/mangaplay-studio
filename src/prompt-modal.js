// @ts-check
/**
 * prompt-modal.js — Text-input prompt modal.
 *
 * Drop-in replacement for window.prompt(), which is broken on macOS
 * WKWebView (returns null silently). Same chrome as confirm-modal.js
 * (backdrop + dialog), but with a text input instead of a description.
 */

import { icon } from "./icons.js";

/** @type {HTMLElement | null} */
let modalRoot = null;
/** @type {((v: string | null) => void) | null} */
let pendingResolve = null;

/**
 * @param {{ title: string, defaultValue?: string, placeholder?: string, confirm?: string, cancel?: string }} opts
 * @returns {Promise<string | null>}
 */
export function promptModal(opts)
{
    if (modalRoot && pendingResolve)
    {
        try { pendingResolve(null); } catch {}
        destroyModal();
    }

    return new Promise((resolve) =>
    {
        pendingResolve = resolve;
        modalRoot = buildModal(opts, resolve);
        document.body.appendChild(modalRoot);
        requestAnimationFrame(() =>
        {
            if (modalRoot) modalRoot.classList.add("visible");
        });
    });
}

/**
 * @param {{ title: string, defaultValue?: string, placeholder?: string, confirm?: string, cancel?: string }} opts
 * @param {(v: string | null) => void} resolve
 * @returns {HTMLElement}
 */
function buildModal(opts, resolve)
{
    const confirmLabel = opts.confirm ?? "OK";
    const cancelLabel = opts.cancel ?? "Cancel";

    const backdrop = document.createElement("div");
    backdrop.className = "settings-backdrop prompt-modal";
    backdrop.setAttribute("role", "presentation");

    const dialog = document.createElement("div");
    dialog.className = "confirm-modal-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", opts.title);

    const titlebar = document.createElement("div");
    titlebar.className = "confirm-modal-titlebar";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "settings-close confirm-modal-close";
    closeBtn.setAttribute("aria-label", cancelLabel);
    closeBtn.insertAdjacentHTML("afterbegin", icon("x", { size: 16 }));
    closeBtn.addEventListener("click", () => onCancel(resolve));
    titlebar.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "confirm-modal-body";

    const heading = document.createElement("h2");
    heading.className = "confirm-modal-heading";
    heading.textContent = opts.title;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "prompt-modal-input";
    input.value = opts.defaultValue || "";
    input.placeholder = opts.placeholder || "";

    const actions = document.createElement("div");
    actions.className = "confirm-modal-actions";

    const cancelBtn = mkButton(cancelLabel, "settings-btn-secondary");
    cancelBtn.addEventListener("click", () => onCancel(resolve));

    const confirmBtn = mkButton(confirmLabel, "settings-btn-primary confirm-modal-confirm");
    confirmBtn.addEventListener("click", () =>
    {
        resolve(input.value.trim());
        destroyModal();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    body.appendChild(heading);
    body.appendChild(input);
    body.appendChild(actions);

    dialog.appendChild(titlebar);
    dialog.appendChild(body);
    backdrop.appendChild(dialog);

    // Backdrop click → cancel. Clicks on the dialog don't bubble cancel.
    backdrop.addEventListener("click", (ev) =>
    {
        if (ev.target === backdrop) onCancel(resolve);
    });

    /** @type {(ev: KeyboardEvent) => void} */
    const onKey = (ev) =>
    {
        if (ev.key === "Escape") onCancel(resolve);
        else if (ev.key === "Enter")
        {
            resolve(input.value.trim());
            destroyModal();
        }
    };
    document.addEventListener("keydown", onKey);
    /** @type {any} */ (backdrop).__promptOnKey = onKey;

    // Focus the input and select all text so the default value is highlighted.
    requestAnimationFrame(() => { try { input.focus(); input.select(); } catch {} });

    return backdrop;
}

/**
 * @param {string} label
 * @param {string} cls
 * @returns {HTMLButtonElement}
 */
function mkButton(label, cls)
{
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    return b;
}

/** @param {(v: string | null) => void} resolve */
function onCancel(resolve)
{
    resolve(null);
    destroyModal();
}

function destroyModal()
{
    if (!modalRoot) return;
    const root = modalRoot;
    const handler = /** @type {any} */ (root).__promptOnKey;
    if (handler) document.removeEventListener("keydown", handler);
    root.classList.remove("visible");
    setTimeout(() => { try { root.remove(); } catch {} }, 200);
    modalRoot = null;
    pendingResolve = null;
}
