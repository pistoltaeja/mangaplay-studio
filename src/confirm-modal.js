// @ts-check
/**
 * confirm-modal.js — Minimal yes/no confirmation modal.
 *
 * Used by the explorer's delete-active path (warns when the file being
 * trashed is currently open in the editor) and by the trash-unavailable
 * fallback ("Delete permanently?").
 *
 * Backdrop + lifecycle (Esc, click-outside, singleton, fade) live in
 * modal-shell.js — this file owns the dialog body only.
 */

import { icon } from "./icons.js";
import { openModal, setModalKeydown } from "./modal-shell.js";

/**
 * @param {{ title: string, body: string, confirm: string, cancel?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function confirmModal(opts)
{
    const cancelLabel = opts.cancel ?? "Cancel";

    return openModal({
        variantClass: "confirm-modal",
        cancelValue: false,
        build: ({ backdrop, resolveWith, cancel }) =>
        {
            // Dialog uses its OWN class (NOT settings-dialog) so the settings
            // modal's fixed 840×560 sizing doesn't bleed in. confirm-modal-dialog
            // is sized to content with 12px corners + border matching the rest
            // of the chrome.
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
            closeBtn.addEventListener("click", cancel);
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

            const cancelBtn = mkButton(cancelLabel, "mps-btn-secondary");
            cancelBtn.addEventListener("click", cancel);

            const confirmBtn = mkButton(opts.confirm, "mps-btn-primary confirm-modal-confirm");
            if (opts.danger) confirmBtn.classList.add("is-danger");
            confirmBtn.addEventListener("click", () => resolveWith(true));

            actions.appendChild(cancelBtn);
            actions.appendChild(confirmBtn);

            body.appendChild(heading);
            body.appendChild(desc);
            body.appendChild(actions);

            dialog.appendChild(titlebar);
            dialog.appendChild(body);
            backdrop.appendChild(dialog);

            // Enter activates the confirm button.
            setModalKeydown((ev) =>
            {
                if (ev.key === "Enter") resolveWith(true);
            });

            // Focus the confirm button so Enter / Space works immediately.
            // Danger confirms still require an explicit click for safety
            // (the focused button is the primary affordance, but the user
            // must reach for it).
            requestAnimationFrame(() => { try { confirmBtn.focus(); } catch {} });
        },
    });
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
