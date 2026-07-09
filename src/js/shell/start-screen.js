import { state } from "./state.js";
import { loadRecent, removeRecent, pickProjectFolder, createNewProject } from "../project/project.js";
import { renameProject, renameFolder, moveFolder, revealInExplorer } from "../project/project.js";
import { getLastProjectPathInvalid } from "../project/user-settings.js";
import { wireDeclarativeTooltips } from "../tooltip/tooltip.js";
import { confirmModal } from "../modals/confirm-modal.js";
import { t } from "../adapters/tauri-i18n.js";

/**
 * Render the picker shell and wait for the user to pick a project.
 * Resolves with the chosen project path (string) or "" if the user took an
 * action that doesn't pick anything (eg. cancelled the OS folder picker).
 *
 * The shell is the single dark surface that replaces the old loading +
 * start-screen pair. It handles its own context menu, modals, missing-folder
 * states, and the language drop-down internally.
 *
 * Right-pane lifecycle events surface via CustomEvents on the host:
 *   mps-picker-pick           → resolve with the path
 *   mps-picker-new            → run new-project flow, resolve with new path
 *   mps-picker-open           → run open-folder flow, resolve with the path
 *   mps-picker-remove         → removeRecent + refresh list
 *   mps-picker-rename-project → renameProject + refresh list
 *   mps-picker-rename-folder  → renameFolder (refuses if open here) + refresh
 *   mps-picker-move-folder    → ask for new parent → moveFolder + refresh
 *   mps-picker-reveal         → app_reveal_in_explorer
 */
export function renderStartScreen() {
    return new Promise((resolve) => {
        const shell = /** @type {any} */ (document.getElementById("picker-shell"));
        if (!shell) {
            console.error("[picker] #picker-shell not in DOM");
            resolve("");
            return;
        }
        shell.setRecent(state.recentProjects || []);
        shell.setLastPathInvalid(getLastProjectPathInvalid());
        shell.setPhase("picker");
        // Tooltip wiring — picker uses its own affordances; tooltips for
        // the close button still need this.
        wireDeclarativeTooltips();

        const refreshRecent = async () =>
        {
            try
            {
                state.recentProjects = await loadRecent();
                shell.setRecent(state.recentProjects);
            }
            catch { /* ignore */ }
        };

        shell.addEventListener("mps-picker-pick", (e) =>
        {
            resolve(e.detail?.path || "");
        });

        shell.addEventListener("mps-picker-new", () =>
        {
            shell.showCreatePanel();
        });

        shell.addEventListener("mps-picker-create-back", () =>
        {
            shell.hideCreatePanel();
        });

        shell.addEventListener("mps-picker-create-browse", async () =>
        {
            try
            {
                const parent = await pickProjectFolder();
                if (!parent) return;
                shell.setCreatePanel({ parentPath: parent });
            }
            catch (err) { console.error("Browse parent folder failed:", err); }
        });

        shell.addEventListener("mps-picker-create-submit", async (e) =>
        {
            const { parent, name } = e.detail || {};
            if (!parent || !name) return;
            try
            {
                const created = await createNewProject(parent, name);
                resolve(created);
            }
            catch (err)
            {
                console.error("New project failed:", err);
                const msg = String(err?.message || err);
                await confirmModal({ title: t("mangaplay-studio.picker.error.title"), body: msg, confirm: "OK" });
            }
        });

        shell.addEventListener("mps-picker-open", async () =>
        {
            try
            {
                const path = await pickProjectFolder();
                if (!path) return;
                resolve(path);
            }
            catch (err) { console.error("Open folder failed:", err); }
        });

        shell.addEventListener("mps-picker-remove", async (e) =>
        {
            const path = e.detail?.path;
            if (!path) return;
            try { await removeRecent(path); }
            catch (err) { console.warn("removeRecent failed:", err); }
            await refreshRecent();
        });

        shell.addEventListener("mps-picker-rename-project", async (e) =>
        {
            const { path, displayName, scope } = e.detail || {};
            if (!path) return;
            try { await renameProject(path, displayName, scope); }
            catch (err) { console.warn("renameProject failed:", err); }
            await refreshRecent();
        });

        shell.addEventListener("mps-picker-rename-folder", async (e) =>
        {
            const { path, newBasename } = e.detail || {};
            if (!path || !newBasename) return;
            // currentlyOpen is false here — we're on the picker, no project
            // is mounted in this window.
            try
            {
                await renameFolder(path, newBasename, false);
            }
            catch (err)
            {
                const msg = String(err?.message || err);
                console.warn("renameFolder failed:", msg);
                await confirmModal({ title: t("mangaplay-studio.picker.error.title"), body: msg, confirm: "OK" });
            }
            await refreshRecent();
        });

        shell.addEventListener("mps-picker-move-folder", async (e) =>
        {
            const path = e.detail?.path;
            if (!path) return;
            try
            {
                const newParent = await pickProjectFolder();
                if (!newParent) return;
                await moveFolder(path, newParent, false);
            }
            catch (err)
            {
                const msg = String(err?.message || err);
                console.warn("moveFolder failed:", msg);
                await confirmModal({ title: t("mangaplay-studio.picker.error.title"), body: msg, confirm: "OK" });
            }
            await refreshRecent();
        });

        shell.addEventListener("mps-picker-reveal", async (e) =>
        {
            const path = e.detail?.path;
            if (!path) return;
            try { await revealInExplorer(path); }
            catch (err) { console.warn("reveal failed:", err); }
        });
    });
}

/**
 * Render a single recent-project card into the list. Missing folders
 * (exists === false from Rust) get muted styling + a "Not found" caption;
 * clicking a missing entry opens a lean confirm-popup to remove it. Every
 * entry has a hover-revealed ✕ button that removes it after inline confirm.
 *
 * @param {HTMLElement} list      — the #recent-list container
 * @param {any} r                  — entry from app_recent: { name, path, exists }
 * @param {(path: string) => void} resolve — resolves the renderStartScreen promise
 */
function renderRecentItem(list, r, resolve)
{
    const missing = r.exists === false;
    const btn = document.createElement("button");
    btn.className = "recent-item" + (missing ? " is-missing" : "");
    btn.dataset.path = r.path;

    const main = document.createElement("div");
    main.className = "recent-main";
    const name = document.createElement("div");
    name.className = "recent-name";
    name.textContent = r.name || r.path;
    const path = document.createElement("div");
    path.className = "recent-path";
    path.textContent = r.path;
    main.appendChild(name);
    main.appendChild(path);
    if (missing)
    {
        const tag = document.createElement("div");
        tag.className = "recent-not-found";
        tag.textContent = "Folder not found";
        main.appendChild(tag);
    }
    btn.appendChild(main);

    // Hover-revealed remove (✕). Lives in the DOM always — CSS reveals on hover.
    const removeBtn = document.createElement("span");
    removeBtn.className = "recent-remove";
    removeBtn.setAttribute("role", "button");
    removeBtn.setAttribute("aria-label", "Remove from recent");
    removeBtn.textContent = "✕"; // ✕
    removeBtn.addEventListener("click", (e) =>
    {
        e.stopPropagation();
        showRecentConfirm(btn, "Remove from recent?", async () =>
        {
            await removeRecent(r.path).catch(() => {});
            btn.remove();
        });
    });
    btn.appendChild(removeBtn);

    btn.addEventListener("click", () =>
    {
        if (missing)
        {
            showRecentConfirm(btn, "Project not found. Remove from list?", async () =>
            {
                await removeRecent(r.path).catch(() => {});
                btn.remove();
            });
            return;
        }
        resolve(r.path);
    });

    list.appendChild(btn);
}

/**
 * Lean inline confirm anchored to a recent-item card. Replaces the card's
 * content with a "<message> [Remove] [Cancel]" row until the user picks.
 * Cancel restores the original card.
 *
 * @param {HTMLElement} card
 * @param {string} message
 * @param {() => (void | Promise<void>)} onConfirm
 */
function showRecentConfirm(card, message, onConfirm)
{
    if (card.querySelector(".recent-confirm")) return; // already prompting
    card.classList.add("is-confirming");

    const confirm = document.createElement("div");
    confirm.className = "recent-confirm";

    const msg = document.createElement("div");
    msg.className = "recent-confirm-msg";
    msg.textContent = message;

    const actions = document.createElement("div");
    actions.className = "recent-confirm-actions";

    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "recent-confirm-yes";
    yes.textContent = "Remove";

    const no = document.createElement("button");
    no.type = "button";
    no.className = "recent-confirm-no";
    no.textContent = "Cancel";

    actions.appendChild(yes);
    actions.appendChild(no);
    confirm.appendChild(msg);
    confirm.appendChild(actions);
    card.appendChild(confirm);

    yes.addEventListener("click", async (e) =>
    {
        e.stopPropagation();
        await onConfirm();
    });
    no.addEventListener("click", (e) =>
    {
        e.stopPropagation();
        confirm.remove();
        card.classList.remove("is-confirming");
    });
}
