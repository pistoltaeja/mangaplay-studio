// @ts-check
/**
 * update-content-modal.js — four-panel modal that drives the Update Content
 * (push-to-Google-Docs) flow.
 *
 * Replaces the previous silent footer `_runPush` toast plumbing. The modal owns its own state
 * machine (`UpdateStateMachine`); the four panels mirror the publish-modal
 * end-panel idiom:
 *
 *   P1 — progress     (.publish-panel-end + .publish-spinner + per-step heading)
 *   P2 — confirmForceTake (only shown when checkingLock → locked-by-other / stale)
 *   P3 — success       (.publish-end-success — checkmark + "Content updated" + Done)
 *   P4 — error         (.publish-end-error  — error icon + plain language + Done)
 *
 * Panels are stacked in DOM and toggled via the `hidden` attribute. No
 * horizontal-slide animation — the update flow is fast and doesn't benefit
 * from the publish modal's gate/picker/form/end carousel.
 *
 * Lifecycle: appends a backdrop to document.body on open, removes on done /
 * cancel / error-acknowledge. Returns a Promise that:
 *   - resolves with { newRevisionId } on success Done click;
 *   - rejects with a `UserCancelled` error on Cancel / Esc / backdrop click;
 *   - rejects with the classified error payload on error Done click.
 */

import { openModal } from "../modals/modal-shell.js";
import { t } from "../adapters/tauri-i18n.js";
import {
    filesGet,
    filesUpdate as driveFilesUpdate
} from "../../../../core/google-docs/index.js";
import {
    lock as lockEngineLock
} from "./lock-engine.js";
import { push as pushWorker } from "./push-pull.js";
import { evaluateLockState } from "./lock-engine.js";
import { preflightNetwork as _preflightNetwork, preflightToken as _preflightToken } from "./preflight.js";
import { UpdateStateMachine, STEPS } from "./update-state-machine.js";
import { getCurrentProfile } from "../auth/google-oauth.js";
import { getSyncEntry as projectGetSyncEntry } from "../project/project.js";

/**
 * Resolve a step → localised heading for the progress panel.
 *
 * @param {string} state
 * @returns {string}
 */
function progressLabel(state)
{
    switch (state)
    {
        case "preflight.network":
            return t("mangaplay-studio.googleDocsSync.update.progress.network", "Checking connection…");
        case "preflight.token":
            return t("mangaplay-studio.googleDocsSync.update.progress.token", "Checking sign-in…");
        case "preflight.fileAccess":
            return t("mangaplay-studio.googleDocsSync.update.progress.fileAccess", "Checking Google access…");
        case "checkingLock":
            return t("mangaplay-studio.googleDocsSync.update.progress.lock", "Checking lock…");
        case "forceTaking":
            return t("mangaplay-studio.googleDocsSync.update.progress.forceTaking", "Taking over lock…");
        case "lifting":
            return t("mangaplay-studio.googleDocsSync.update.progress.lift", "Suspending lock…");
        case "writing":
            return t("mangaplay-studio.googleDocsSync.update.progress.write", "Updating content…");
        case "reapplying":
            return t("mangaplay-studio.googleDocsSync.update.progress.reapply", "Re-applying lock…");
        default:
            return "";
    }
}

/**
 * Map classified-error class → plain-language explanation for the error
 * panel. Falls back to a generic "see console" message.
 *
 * @param {string} errorClass
 * @param {string} errorName
 * @returns {string}
 */
function plainLanguageError(errorClass, errorName)
{
    if (errorName === "PermissionError" || errorClass === "permissions.doc_access_revoked")
    {
        return t("mangaplay-studio.googleDocsSync.update.error.missingAccess",
            "Google has revoked access to this Doc. Re-share it or re-publish.");
    }
    if (errorName === "MissingTabIdInCache")
    {
        return t("mangaplay-studio.googleDocsSync.update.error.missingTabIdInCache",
            "This Doc was published before sync improvements landed — please re-publish to enable updates.");
    }
    return t("mangaplay-studio.googleDocsSync.update.error.generic",
        "See console for details.");
}

/**
 * Build the worker set the update state machine consumes. Wires preflight,
 * the file-access check, lock-state read, force-take, and the push wrapper.
 *
 * @param {{ getAuthToken: () => Promise<string|null>, projectPath?: string, scriptRelPath?: string }} ctx
 */
function buildUpdateWorkers(ctx)
{
    const authClient = {
        async getAccessToken(_opts = {})
        {
            return await ctx.getAuthToken();
        }
    };

    async function preflightNetwork()
    {
        return await _preflightNetwork({});
    }

    async function preflightToken()
    {
        return await _preflightToken({ authClient });
    }

    /**
     * @param {{ token: string, docId: string }} args
     */
    async function preflightFileAccess({ token, docId })
    {
        console.debug("[mps:gdocs:update] filesGet capabilities", { docId });
        try
        {
            const meta = await filesGet({
                token,
                fileId: docId,
                fields: "id,name,capabilities(canEdit),appProperties"
            });
            const canEdit = !!(meta && meta.capabilities && meta.capabilities.canEdit);
            console.debug("[mps:gdocs:update] filesGet capabilities ok", { canEdit });
            return { canEdit };
        }
        catch (e)
        {
            const ee = /** @type {any} */ (e);
            console.warn("[mps:gdocs:update] filesGet capabilities failed",
                { status: ee && ee.status, name: ee && ee.name, message: ee && ee.message });
            // 404 / 403 propagates to the state machine and classifies.
            throw e;
        }
    }

    /**
     * @param {{ token: string, docId: string, ourLockToken: string|null, ourSub: string|null }} args
     */
    async function readLockState({ token, docId, ourLockToken, ourSub })
    {
        const meta = await filesGet({
            token,
            fileId: docId,
            fields: "appProperties,headRevisionId"
        });
        const appProps = (meta && meta.appProperties) || {};
        const headRevisionId = meta && meta.headRevisionId ? String(meta.headRevisionId) : null;
        const lockState = evaluateLockState({ appProperties: appProps, ourLockToken, ourSub });
        return { lockState, appProps, headRevisionId };
    }

    /**
     * @param {{ token: string, docId: string, userName: string, clientId: string, lockedBySub: string|null }} args
     */
    async function forceTake({ token, docId, userName, clientId, lockedBySub })
    {
        // lock-engine.lock() uses last-writer-wins on Drive — writing our
        // appProperties overwrites the previous account's lock identity.
        return await lockEngineLock({
            token,
            docId,
            userName,
            clientId,
            lockedBySub,
            driveClient: { filesUpdate: driveFilesUpdate, filesGet }
        });
    }

    /**
     * Wrapper around push-pull.js push() that loads the cache entry for the
     * stored tabIds and surfaces a classified MissingTabIdInCache error if
     * the cache hasn't been updated since tab-id tracking landed.
     *
     * @param {{ token: string, docId: string, hasOwnLock: boolean, userName: string, format: "mangaplay"|"fountain"|"text", sourceText: string, localPath: string, expectedRevisionId: string|null }} args
     */
    async function runPush(args)
    {
        const entry = ctx.projectPath && ctx.scriptRelPath
            ? await projectGetSyncEntry(ctx.projectPath, ctx.scriptRelPath)
            : null;
        const rootTabId = entry && /** @type {any} */ (entry).rootTabId;
        const screenplayTabId = entry && /** @type {any} */ (entry).screenplayTabId;
        if (!entry || !rootTabId)
        {
            const e = new Error(
                "This Doc was published before sync improvements landed — please re-publish to enable updates.");
            e.name = "MissingTabIdInCache";
            throw e;
        }
        const { newRevisionId } = await pushWorker({
            token: args.token,
            docId: args.docId,
            format: args.format,
            localSourceText: args.sourceText,
            expectedRevisionId: args.expectedRevisionId,
            localPath: args.localPath,
            rootTabId,
            screenplayTabId: screenplayTabId || null,
            hasOwnLock: args.hasOwnLock,
            userName: args.userName
        });
        return { newRevisionId: newRevisionId || "" };
    }

    return {
        preflightNetwork,
        preflightToken,
        preflightFileAccess,
        readLockState,
        forceTake,
        runPush
    };
}

/**
 * @typedef {Object} UpdateModalCtx
 * @property {string} docId
 * @property {string} [docUrl]
 * @property {string} [projectPath]
 * @property {string} [scriptRelPath]
 * @property {"mangaplay"|"fountain"|"text"} format
 * @property {string} sourceText
 * @property {string} localPath
 * @property {string|null} expectedRevisionId
 * @property {() => Promise<string|null>} getAuthToken
 * @property {string} [userName]
 * @property {string} [clientId]
 * @property {string|null} [ourLockToken]
 */

/**
 * Open the Update Content modal. Returns a Promise that resolves on success
 * (Done click) with `{ newRevisionId }`, or rejects with a `UserCancelled`
 * named error on cancel / Esc, or with the classified error payload on
 * error Done click.
 *
 * @param {UpdateModalCtx} ctx
 * @returns {Promise<{ newRevisionId: string }>}
 */
export function openUpdateContentModal(ctx)
{
    return new Promise((resolve, reject) =>
    {
        const cancelErr = new Error("Update Content cancelled by user.");
        cancelErr.name = "UserCancelled";

        /** @type {UpdateStateMachine|null} */
        let machine = null;

        void openModal({
            variantClass: "publish-modal-backdrop update-content-modal-backdrop",
            cancelValue: "cancel",
            build: ({ backdrop, resolveWith }) =>
            {
                const dialog = document.createElement("div");
                dialog.className = "settings-dialog publish-modal update-content-modal";
                dialog.setAttribute("role", "dialog");
                dialog.setAttribute("aria-modal", "true");
                dialog.setAttribute("aria-label",
                    t("mangaplay-studio.googleDocsSync.update.title", "Update Content"));

                // ── Titlebar ───────────────────────────────────────────
                const titlebar = document.createElement("div");
                titlebar.className = "settings-titlebar publish-titlebar";
                const titleText = document.createElement("div");
                titleText.className = "publish-title";
                titleText.textContent = t(
                    "mangaplay-studio.googleDocsSync.update.title", "Update Content");
                const closeBtn = document.createElement("button");
                closeBtn.type = "button";
                closeBtn.className = "settings-close";
                closeBtn.setAttribute("aria-label",
                    t("mangaplay-studio.googleDocsSync.update.confirmForceTake.cancel", "Cancel"));
                closeBtn.textContent = "×";   // ×
                closeBtn.addEventListener("click", () =>
                {
                    // If the machine is mid-pause on confirmForceTake, cancel
                    // it so run() proceeds to the cancelled state.
                    if (machine) machine.cancel();
                    resolveWith("cancel");
                    reject(cancelErr);
                });
                titlebar.appendChild(titleText);
                titlebar.appendChild(closeBtn);

                // ── Panels container ───────────────────────────────────
                // NOT `.publish-panel` — that class hardcodes width: 14.2857%
                // for the publish-track horizontal slider, which we don't use
                // here. The `.update-content-panels` rule below gives this
                // container full-width column flex so the visible (non-hidden)
                // child fills the dialog body and its own centring rules apply.
                const panels = document.createElement("div");
                panels.className = "update-content-panels";

                // P1 — progress
                const progressPanel = document.createElement("div");
                progressPanel.className = "publish-end-success update-progress";
                const spinner = document.createElement("div");
                spinner.className = "publish-spinner";
                spinner.setAttribute("aria-hidden", "true");
                const progressHeading = document.createElement("h2");
                progressHeading.className = "publish-heading";
                progressHeading.textContent = t(
                    "mangaplay-studio.googleDocsSync.update.progress.network", "Checking connection…");
                progressPanel.appendChild(spinner);
                progressPanel.appendChild(progressHeading);

                // P2 — confirmForceTake
                const confirmPanel = document.createElement("div");
                confirmPanel.className = "publish-end-success update-confirm-force-take";
                confirmPanel.hidden = true;
                const confirmHeading = document.createElement("h2");
                confirmHeading.className = "publish-heading";
                confirmHeading.textContent = t(
                    "mangaplay-studio.googleDocsSync.update.confirmForceTake.heading",
                    "This document is locked.");
                const confirmBody = document.createElement("p");
                confirmBody.className = "publish-body";
                const confirmStale = document.createElement("p");
                confirmStale.className = "publish-body";
                confirmStale.hidden = true;
                const confirmActions = document.createElement("div");
                confirmActions.className = "publish-footer";
                const cancelBtn = document.createElement("button");
                cancelBtn.type = "button";
                cancelBtn.className = "mps-btn-secondary";
                cancelBtn.textContent = t(
                    "mangaplay-studio.googleDocsSync.update.confirmForceTake.cancel", "Cancel");
                cancelBtn.addEventListener("click", () =>
                {
                    if (machine) machine.cancel();
                    resolveWith("cancel");
                    reject(cancelErr);
                });
                const forceBtn = document.createElement("button");
                forceBtn.type = "button";
                forceBtn.className = "mps-btn-primary update-force-update-btn";
                forceBtn.textContent = t(
                    "mangaplay-studio.googleDocsSync.update.confirmForceTake.confirm", "Force Update Now");
                forceBtn.addEventListener("click", () =>
                {
                    if (machine) machine.confirmForceTake();
                });
                confirmActions.appendChild(cancelBtn);
                confirmActions.appendChild(forceBtn);
                const confirmWarn = document.createElement("p");
                confirmWarn.className = "publish-body update-confirm-warn";
                confirmWarn.setAttribute("aria-live", "polite");
                confirmWarn.textContent = t(
                    "mangaplay-studio.googleDocsSync.update.confirmForceTake.warningLine",
                    "This will take over the lock and overwrite their version.");
                confirmPanel.appendChild(confirmHeading);
                confirmPanel.appendChild(confirmBody);
                confirmPanel.appendChild(confirmStale);
                confirmPanel.appendChild(confirmActions);
                confirmPanel.appendChild(confirmWarn);

                // P3 — success
                const successPanel = document.createElement("div");
                successPanel.className = "publish-end-success";
                successPanel.hidden = true;
                const checkmark = document.createElement("div");
                checkmark.className = "publish-checkmark";
                checkmark.innerHTML = `
                    <svg viewBox="0 0 52 52" width="64" height="64" aria-hidden="true">
                        <circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="2" />
                        <path d="M14 27 L23 36 L40 18" fill="none" stroke="currentColor" stroke-width="3"
                              stroke-linecap="round" stroke-linejoin="round" />
                    </svg>`;
                const successHeading = document.createElement("h2");
                successHeading.className = "publish-heading";
                successHeading.textContent = t(
                    "mangaplay-studio.googleDocsSync.update.success.heading", "Content updated");
                const successActions = document.createElement("div");
                successActions.className = "publish-footer";
                const successDoneBtn = document.createElement("button");
                successDoneBtn.type = "button";
                successDoneBtn.className = "mps-btn-primary";
                successDoneBtn.textContent = t(
                    "mangaplay-studio.googleDocsSync.update.success.done", "Done");
                successActions.appendChild(successDoneBtn);
                successPanel.appendChild(checkmark);
                successPanel.appendChild(successHeading);
                successPanel.appendChild(successActions);

                // P4 — error
                const errorPanel = document.createElement("div");
                errorPanel.className = "publish-end-error";
                errorPanel.hidden = true;
                const errorIcon = document.createElement("div");
                errorIcon.className = "publish-error-icon";
                errorIcon.innerHTML = `
                    <svg viewBox="0 0 52 52" width="64" height="64" aria-hidden="true">
                        <circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="2" />
                        <path d="M17 17 L35 35 M35 17 L17 35" fill="none" stroke="currentColor"
                              stroke-width="3" stroke-linecap="round" />
                    </svg>`;
                const errorHeading = document.createElement("h2");
                errorHeading.className = "publish-heading";
                errorHeading.textContent = t(
                    "mangaplay-studio.googleDocsSync.update.error.heading", "Update failed");
                const errorBody = document.createElement("p");
                errorBody.className = "publish-error-body";
                const errorActions = document.createElement("div");
                errorActions.className = "publish-footer";
                const errorDoneBtn = document.createElement("button");
                errorDoneBtn.type = "button";
                errorDoneBtn.className = "mps-btn-primary";
                errorDoneBtn.textContent = t(
                    "mangaplay-studio.googleDocsSync.update.error.done", "Done");
                errorActions.appendChild(errorDoneBtn);
                errorPanel.appendChild(errorIcon);
                errorPanel.appendChild(errorHeading);
                errorPanel.appendChild(errorBody);
                errorPanel.appendChild(errorActions);

                panels.appendChild(progressPanel);
                panels.appendChild(confirmPanel);
                panels.appendChild(successPanel);
                panels.appendChild(errorPanel);

                dialog.appendChild(titlebar);
                dialog.appendChild(panels);
                backdrop.appendChild(dialog);

                /**
                 * Show exactly one panel.
                 * @param {"progress"|"confirm"|"success"|"error"} which
                 */
                function setPanel(which)
                {
                    progressPanel.hidden = which !== "progress";
                    confirmPanel.hidden = which !== "confirm";
                    successPanel.hidden = which !== "success";
                    errorPanel.hidden = which !== "error";
                }

                // ── Kick off the state machine ─────────────────────────
                const profile = getCurrentProfile();
                const workers = buildUpdateWorkers({
                    getAuthToken: ctx.getAuthToken,
                    projectPath: ctx.projectPath || "",
                    scriptRelPath: ctx.scriptRelPath || ""
                });

                /** @type {{ newRevisionId: string }} */
                let lastSuccess = { newRevisionId: "" };
                /** @type {any} */
                let lastError = null;

                machine = new UpdateStateMachine({
                    formValues: {
                        docId: ctx.docId,
                        projectPath: ctx.projectPath || "",
                        scriptRelPath: ctx.scriptRelPath || "",
                        format: ctx.format,
                        sourceText: ctx.sourceText || "",
                        localPath: ctx.localPath || "",
                        expectedRevisionId: ctx.expectedRevisionId || null,
                        userName: ctx.userName || (profile && profile.name) || "",
                        clientId: ctx.clientId || "",
                        ourLockToken: ctx.ourLockToken || null,
                        ourSub: (profile && profile.sub) || null
                    },
                    workers,
                    onTransition: ({ state, payload }) =>
                    {
                        if (state === "success")
                        {
                            lastSuccess = {
                                newRevisionId: (payload && payload.newRevisionId) || ""
                            };
                            setPanel("success");
                            return;
                        }
                        if (state === "error")
                        {
                            lastError = payload || { errorClass: "fatal.unknown" };
                            const message = plainLanguageError(
                                lastError.errorClass || "",
                                lastError.errorName || "");
                            errorBody.textContent = message;
                            setPanel("error");
                            return;
                        }
                        if (state === "cancelled")
                        {
                            // User cancelled via confirmForceTake — the close
                            // handler already rejected the outer Promise.
                            return;
                        }
                        if (state === "confirmForceTake")
                        {
                            const name = (payload && payload.lockedBy) || t(
                                "mangaplay-studio.googleDocsSync.update.confirmForceTake.fallbackName",
                                "another user");
                            let dateStr = "";
                            let timeStr = "";
                            if (payload && payload.lockedAt)
                            {
                                const d = new Date(payload.lockedAt);
                                if (!isNaN(d.getTime()))
                                {
                                    dateStr = d.toLocaleDateString();
                                    timeStr = d.toLocaleTimeString();
                                }
                            }
                            const tpl = t(
                                "mangaplay-studio.googleDocsSync.update.confirmForceTake.bodyTemplate",
                                "{name} locked this file on {date} at {time}.");
                            confirmBody.textContent = tpl
                                .replace("{name}", name)
                                .replace("{date}", dateStr)
                                .replace("{time}", timeStr);

                            if (payload && payload.isStale)
                            {
                                confirmStale.textContent = t(
                                    "mangaplay-studio.googleDocsSync.update.confirmForceTake.staleSuffix",
                                    "Their session may be inactive — the lock is older than 10 minutes.");
                                confirmStale.hidden = false;
                            }
                            else
                            {
                                confirmStale.hidden = true;
                            }
                            setPanel("confirm");
                            return;
                        }
                        // Progress / preflight state.
                        const heading = progressLabel(state);
                        if (heading) progressHeading.textContent = heading;
                        setPanel("progress");
                    }
                });

                successDoneBtn.addEventListener("click", () =>
                {
                    resolveWith("done");
                    resolve({ newRevisionId: lastSuccess.newRevisionId });
                });
                errorDoneBtn.addEventListener("click", () =>
                {
                    resolveWith("done");
                    const err = new Error(
                        (lastError && lastError.message) || "Update Content failed.");
                    err.name = (lastError && lastError.errorName) || "Error";
                    /** @type {any} */ (err).errorClass = lastError && lastError.errorClass;
                    /** @type {any} */ (err).diagnostic = lastError && lastError.diagnostic;
                    reject(err);
                });

                void machine.run();
            }
        }).then((result) =>
        {
            // Backdrop click / Esc → modal-shell resolves with cancelValue.
            // Only treat as cancellation when neither Done button has fired.
            if (result === "cancel")
            {
                if (machine) machine.cancel();
                reject(cancelErr);
            }
        });
    });
}
