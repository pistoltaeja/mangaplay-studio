// @ts-check
/**
 * folder-options-modal.js — Folder Options popup.
 *
 * Radio group with four mutually-exclusive options: Default / Storyboard
 * Folder / Screenplay Folder / Text Folder. Fires `onChange(newType)`
 * immediately when the user picks a different option and then closes.
 * Esc / backdrop click / close button close without firing.
 *
 * Chrome (dialog frame, titlebar, close button) reuses the confirm-modal
 * classes from app-modals.css. Layout-specific styling for the 4-column
 * pip grid lives under `.folder-options-modal` in app-modals.css.
 */

import { icon } from "../panes/icons.js";
import { openModal, setModalKeydown } from "./modal-shell.js";
import { t } from "../adapters/tauri-i18n.js";

/**
 * Escape a string for safe insertion into an HTML text context. The folder
 * name comes from user data (arbitrary filenames on disk) so it MUST be
 * escaped before landing in the DOM.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s)
{
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * @param {object} ctx
 * @param {string} ctx.uuid
 * @param {string} ctx.folderName
 * @param {"default"|"storyboard"|"screenplay"|"text"} ctx.currentType
 * @param {(newType: "default"|"storyboard"|"screenplay"|"text") => void} ctx.onChange
 * @returns {void}
 */
export function openFolderOptionsModal(ctx)
{
    const closeLabel = t("mangaplay-studio.folderOptions.close");
    const titleLabel = t("mangaplay-studio.folderOptions.title");

    /** @type {Array<{ value: "default"|"storyboard"|"screenplay"|"text", name: string, hint: string }>} */
    const options = [
        {
            value: "default",
            name: t("mangaplay-studio.folderOptions.default"),
            hint: t("mangaplay-studio.folderOptions.defaultHint"),
        },
        {
            value: "storyboard",
            name: t("mangaplay-studio.folderOptions.storyboard"),
            hint: t("mangaplay-studio.folderOptions.storyboardHint"),
        },
        {
            value: "screenplay",
            name: t("mangaplay-studio.folderOptions.screenplay"),
            hint: t("mangaplay-studio.folderOptions.screenplayHint"),
        },
        {
            value: "text",
            name: t("mangaplay-studio.folderOptions.text"),
            hint: t("mangaplay-studio.folderOptions.textHint"),
        },
    ];

    // Unique radio group name so multiple modals (in theory) wouldn't collide.
    const groupName = `folder-options-${ctx.uuid || "unknown"}`;

    openModal({
        variantClass: "confirm-modal folder-options-modal",
        cancelValue: false,
        build: ({ backdrop, resolveWith, cancel }) =>
        {
            const dialog = document.createElement("div");
            dialog.className = "confirm-modal-dialog";
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            dialog.setAttribute("aria-label", titleLabel);

            const titlebar = document.createElement("div");
            titlebar.className = "confirm-modal-titlebar";

            // Title text on the LEFT of the titlebar. Folder name is
            // user-controlled — escape before landing in the DOM.
            const titleText = document.createElement("div");
            titleText.className = "folder-options-title";
            titleText.innerHTML = `${escapeHtml(titleLabel)}: ${escapeHtml(ctx.folderName || "")}`;

            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className = "settings-close confirm-modal-close";
            closeBtn.setAttribute("aria-label", closeLabel);
            closeBtn.insertAdjacentHTML("afterbegin", icon("x", { size: 16 }));
            closeBtn.addEventListener("click", cancel);

            titlebar.appendChild(titleText);
            titlebar.appendChild(closeBtn);

            const body = document.createElement("div");
            body.className = "confirm-modal-body";

            const list = document.createElement("div");
            list.className = "folder-options-grid";

            /** @type {HTMLInputElement | null} */
            let firstInput = null;

            for (const opt of options)
            {
                const label = document.createElement("label");
                label.className = "folder-options-pip";
                if (ctx.currentType === opt.value)
                {
                    label.classList.add("is-selected");
                }

                const input = document.createElement("input");
                input.type = "radio";
                input.name = groupName;
                input.value = opt.value;
                input.checked = ctx.currentType === opt.value;
                input.className = "folder-options-pip-radio";
                if (!firstInput) firstInput = input;

                const name = document.createElement("div");
                name.className = "folder-options-pip-name";
                name.textContent = opt.name;

                const hint = document.createElement("div");
                hint.className = "folder-options-pip-hint";
                hint.textContent = opt.hint;

                label.appendChild(input);
                label.appendChild(name);
                label.appendChild(hint);

                input.addEventListener("change", () =>
                {
                    if (!input.checked) return;
                    // Reflect selection visually on all pips in the group.
                    const allPips = list.querySelectorAll(".folder-options-pip");
                    allPips.forEach((p) => p.classList.remove("is-selected"));
                    label.classList.add("is-selected");

                    // Fire onChange only when the user picked something new.
                    // Selecting the already-current value is a no-op except
                    // for closing the modal.
                    if (opt.value !== ctx.currentType)
                    {
                        try { ctx.onChange(opt.value); }
                        catch (e) { console.warn("folder-options onChange threw:", e); }
                    }
                    resolveWith(true);
                });

                list.appendChild(label);
            }

            const actions = document.createElement("div");
            actions.className = "confirm-modal-actions";

            const closeBtnBottom = document.createElement("button");
            closeBtnBottom.type = "button";
            closeBtnBottom.className = "mps-btn-secondary";
            closeBtnBottom.textContent = closeLabel;
            closeBtnBottom.addEventListener("click", cancel);
            actions.appendChild(closeBtnBottom);

            body.appendChild(list);
            body.appendChild(actions);

            dialog.appendChild(titlebar);
            dialog.appendChild(body);
            backdrop.appendChild(dialog);

            // Extra keydown wiring — Esc is already handled by modal-shell.
            setModalKeydown((_ev) => { /* no-op for now */ });

            // Focus the checked radio so keyboard users can arrow between.
            requestAnimationFrame(() =>
            {
                try
                {
                    const checked = /** @type {HTMLInputElement | null} */ (
                        dialog.querySelector(`input[name="${groupName}"]:checked`)
                    );
                    (checked || firstInput)?.focus();
                }
                catch {}
            });
        },
    });
}
