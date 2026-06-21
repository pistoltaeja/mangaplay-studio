// @ts-check
/**
 * migration-modal.js — Blocker modal that surfaces when openProject detects
 * a legacy layout OR a crashed previous migration. Reuses the
 * settings-modal.js chrome (backdrop + dialog) without taking a dependency
 * on its tab framework.
 *
 * Three resolutions:
 *   { status: "migrated", project }  → caller proceeds as if openProject ok
 *   { status: "readonly", projectPath } → caller mounts in read-only mode
 *   { status: "cancelled" }          → caller bails to the picker
 *
 * The modal is intentionally NOT idempotent — a second call while a modal
 * is already mounted resolves the previous promise with `cancelled` and
 * starts a fresh modal. In practice openProject is the only caller and the
 * boot/auto-resume flow is serialised, so this case only arises in tests.
 */

import { icon } from "./icons.js";
import { migrateLegacyLayout, openProject } from "./project.js";

/** @type {HTMLElement | null} */
let modalRoot = null;
/** @type {((v: any) => void) | null} */
let pendingResolve = null;

/**
 * @param {{ projectPath: string, layoutInfo: { layout: string, crash_recovery: boolean } }} opts
 * @returns {Promise<{ status: "migrated", project: any } | { status: "readonly", projectPath: string } | { status: "cancelled" }>}
 */
export function showMigrationModal(opts)
{
    if (modalRoot && pendingResolve)
    {
        // Resolve the previous one then start fresh.
        try { pendingResolve({ status: "cancelled" }); } catch {}
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
 * @param {{ projectPath: string, layoutInfo: { layout: string, crash_recovery: boolean } }} opts
 * @param {(v: any) => void} resolve
 */
function buildModal(opts, resolve)
{
    const crash = !!opts.layoutInfo?.crash_recovery;

    const backdrop = document.createElement("div");
    backdrop.className = "settings-backdrop migration-modal";
    backdrop.setAttribute("role", "presentation");

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog";
    dialog.style.maxWidth = "560px";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Migrate project layout");

    // Title bar with close (close routes to Cancel).
    const titlebar = document.createElement("div");
    titlebar.className = "settings-titlebar";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "settings-close";
    closeBtn.setAttribute("aria-label", "Cancel");
    closeBtn.insertAdjacentHTML("afterbegin", icon("x", { size: 16 }));
    closeBtn.addEventListener("click", () => onCancel(resolve));
    titlebar.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "settings-body migration-modal-body";
    body.style.padding = "24px";
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.gap = "16px";

    const heading = document.createElement("h2");
    heading.className = "migration-modal-heading";
    heading.style.margin = "0";
    heading.style.fontSize = "18px";
    heading.textContent = crash
        ? "Resume interrupted migration"
        : "Migrate project layout";

    const desc = document.createElement("p");
    desc.className = "migration-modal-desc";
    desc.style.margin = "0";
    desc.style.fontSize = "13px";
    desc.style.lineHeight = "1.5";
    desc.textContent = crash
        ? "An earlier migration was interrupted. Resume to complete it. The original files are still on disk."
        : "This project was made with an older layout. Migrating moves your script files into `project/` and your drawings into `storyboard/`. The originals are preserved during migration; nothing is deleted.";

    const pathLine = document.createElement("div");
    pathLine.className = "migration-modal-path";
    pathLine.style.fontFamily = "monospace";
    pathLine.style.fontSize = "12px";
    pathLine.style.opacity = "0.75";
    pathLine.style.wordBreak = "break-all";
    pathLine.textContent = opts.projectPath;

    /** @type {HTMLDivElement} */
    const errorRow = document.createElement("div");
    errorRow.className = "migration-modal-error";
    errorRow.style.display = "none";
    errorRow.style.fontSize = "12px";
    errorRow.style.color = "var(--danger-fg, #c62828)";
    errorRow.style.whiteSpace = "pre-wrap";

    const actions = document.createElement("div");
    actions.className = "migration-modal-actions";
    actions.style.display = "flex";
    actions.style.flexDirection = "row";
    actions.style.gap = "8px";
    actions.style.justifyContent = "flex-end";

    const cancelBtn = mkButton(crash ? "Cancel" : "Cancel", "settings-btn-secondary");
    cancelBtn.addEventListener("click", () => onCancel(resolve));

    const readonlyBtn = mkButton("Open read-only", "settings-btn-secondary");
    readonlyBtn.addEventListener("click", () =>
    {
        resolve({ status: "readonly", projectPath: opts.projectPath });
        destroyModal();
    });

    const migrateBtn = mkButton(
        crash ? "Resume Migration" : "Migrate now",
        "settings-btn-primary"
    );

    migrateBtn.addEventListener("click", async () =>
    {
        errorRow.style.display = "none";
        errorRow.textContent = "";
        migrateBtn.disabled = true;
        readonlyBtn.disabled = true;
        cancelBtn.disabled = true;
        const prevLabel = migrateBtn.textContent;
        migrateBtn.textContent = "Migrating…";

        try
        {
            await migrateLegacyLayout(opts.projectPath);
            // On success, retry openProject; bubble its result back.
            const project = await openProject(opts.projectPath);
            resolve({ status: "migrated", project });
            destroyModal();
        }
        catch (err)
        {
            const code = String(err?.message ?? err ?? "unknown");
            errorRow.textContent = `Migration failed: ${code}`;
            errorRow.style.display = "block";

            // Add a one-shot "Copy error" link so the user can paste into a
            // bug report. We append it to errorRow so it disappears with the
            // next attempt.
            const copyBtn = document.createElement("button");
            copyBtn.type = "button";
            copyBtn.className = "migration-modal-copy-error";
            copyBtn.style.marginLeft = "8px";
            copyBtn.style.fontSize = "11px";
            copyBtn.style.background = "transparent";
            copyBtn.style.border = "1px solid currentColor";
            copyBtn.style.color = "inherit";
            copyBtn.style.cursor = "pointer";
            copyBtn.textContent = "Copy error";
            copyBtn.addEventListener("click", () =>
            {
                try { navigator.clipboard.writeText(code); } catch {}
            });
            errorRow.appendChild(copyBtn);

            migrateBtn.textContent = prevLabel ?? "";
            migrateBtn.disabled = false;
            readonlyBtn.disabled = false;
            cancelBtn.disabled = false;
        }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(readonlyBtn);
    actions.appendChild(migrateBtn);

    body.appendChild(heading);
    body.appendChild(desc);
    body.appendChild(pathLine);
    body.appendChild(errorRow);
    body.appendChild(actions);

    dialog.appendChild(titlebar);
    dialog.appendChild(body);
    backdrop.appendChild(dialog);

    // Esc on the document → cancel. Stored on backdrop so destroyModal can
    // remove it cleanly.
    /** @type {(ev: KeyboardEvent) => void} */
    const onKey = (ev) =>
    {
        if (ev.key === "Escape") onCancel(resolve);
    };
    document.addEventListener("keydown", onKey);
    /** @type {any} */ (backdrop).__migrationOnKey = onKey;

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

/** @param {(v: any) => void} resolve */
function onCancel(resolve)
{
    resolve({ status: "cancelled" });
    destroyModal();
}

function destroyModal()
{
    if (!modalRoot) return;
    const root = modalRoot;
    const handler = /** @type {any} */ (root).__migrationOnKey;
    if (handler) document.removeEventListener("keydown", handler);
    root.classList.remove("visible");
    setTimeout(() => { try { root.remove(); } catch {} }, 200);
    modalRoot = null;
    pendingResolve = null;
}
