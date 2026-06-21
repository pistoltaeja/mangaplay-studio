// @ts-check
/**
 * confirm-modal.js — Minimal yes/no confirmation modal.
 *
 * Models its chrome after `migration-modal.js` (backdrop + dialog), but is
 * single-purpose: ask a yes/no question, resolve to `true` (confirm) or
 * `false` (cancel / Esc / backdrop click).
 *
 * Used by the explorer's delete-active path (warns when the file being
 * trashed is currently open in the editor) and by the trash-unavailable
 * fallback ("Delete permanently?").
 */

import { icon } from "./icons.js";

/** @type {HTMLElement | null} */
let modalRoot = null;
/** @type {((v: boolean) => void) | null} */
let pendingResolve = null;

/**
 * @param {{ title: string, body: string, confirm: string, cancel?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function confirmModal(opts)
{
    if (modalRoot && pendingResolve)
    {
        try { pendingResolve(false); } catch {}
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
 * @param {{ title: string, body: string, confirm: string, cancel?: string, danger?: boolean }} opts
 * @param {(v: boolean) => void} resolve
 * @returns {HTMLElement}
 */
function buildModal(opts, resolve)
{
    const cancelLabel = opts.cancel ?? "Cancel";

    // Backdrop reuses settings-backdrop for the dim + fade animation; the
    // dialog uses its OWN class (NOT settings-dialog) so the settings modal's
    // fixed 840×560 sizing doesn't bleed in. confirm-modal-dialog is sized to
    // content with the same 12px corners + border as the rest of the chrome.
    const backdrop = document.createElement("div");
    backdrop.className = "settings-backdrop confirm-modal";
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

    const desc = document.createElement("p");
    desc.className = "confirm-modal-desc";
    desc.textContent = opts.body;

    const actions = document.createElement("div");
    actions.className = "confirm-modal-actions";

    const cancelBtn = mkButton(cancelLabel, "settings-btn-secondary");
    cancelBtn.addEventListener("click", () => onCancel(resolve));

    const confirmBtn = mkButton(opts.confirm, "settings-btn-primary confirm-modal-confirm");
    if (opts.danger)
    {
        confirmBtn.classList.add("is-danger");
    }
    confirmBtn.addEventListener("click", () =>
    {
        resolve(true);
        destroyModal();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    body.appendChild(heading);
    body.appendChild(desc);
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
            // Enter activates the confirm button.
            resolve(true);
            destroyModal();
        }
    };
    document.addEventListener("keydown", onKey);
    /** @type {any} */ (backdrop).__confirmOnKey = onKey;

    // Focus the confirm button so Enter / Space works immediately. Danger
    // confirms still require an explicit click for safety (the focused button
    // is the primary affordance, but the user must reach for it).
    requestAnimationFrame(() => { try { confirmBtn.focus(); } catch {} });

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

/** @param {(v: boolean) => void} resolve */
function onCancel(resolve)
{
    resolve(false);
    destroyModal();
}

function destroyModal()
{
    if (!modalRoot) return;
    const root = modalRoot;
    const handler = /** @type {any} */ (root).__confirmOnKey;
    if (handler) document.removeEventListener("keydown", handler);
    root.classList.remove("visible");
    setTimeout(() => { try { root.remove(); } catch {} }, 200);
    modalRoot = null;
    pendingResolve = null;
}
