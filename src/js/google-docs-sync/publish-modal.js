// @ts-check
/**
 * publish-modal.js — six-slot "Publish to Google Docs" modal.
 *
 * Slide track slots (left → right): gate / picker / form / progress / end / collab.
 * Sliding between slots is purely CSS — we toggle `data-panel` on the
 * track and let the CSS translateX handle the rest.
 *
 * The `gate` slot contains TWO stacked substates — spinner and sign-in —
 * that cross-fade via opacity. The modal opens on `gate` (spinner
 * visible) and runs a preflight `getAccessToken()` check. On success it
 * slides to `form`; on failure the gate cross-fades from spinner to
 * sign-in (no slide — sign-in is NOT in the slide path, eliminating
 * compositor flicker during later progress→end slides). The spinner is
 * shown for at least 1.0s so the transition isn't jarring, with no upper
 * cap.
 *
 * Real publish work is delegated to the `PublishStateMachine`. Real worker
 * implementations come from `publish-workers.js`. This file only handles:
 *   - building the four slots' DOM (gate hosts spinner + sign-in inside),
 *   - the preflight gate + sign-in flow,
 *   - collecting form values,
 *   - wiring the state machine's `onTransition` to the progress UI,
 *   - showing the success / error variants of the end panel,
 *   - preserving form values for "Try Again".
 *
 * Reuses the `.settings-backdrop` + `.settings-dialog` styling pattern
 * from `export-screenplay-modal.js` so the modal feels at home next to
 * the existing Settings + Export modals.
 */


import { icon } from "../panes/icons.js";
import { openModal } from "../modals/modal-shell.js";
import { t } from "../adapters/tauri-i18n.js";
import { PublishStateMachine } from "./publish-state-machine.js";
import { buildPublishWorkers } from "./publish-workers.js";
import { plainLanguageError, stemFor, _initialValues } from "./publish-modal-helpers.js";
import {
    _buildGatePanel,
    _buildFormPanel,
    _buildProgressPanel,
    _buildEndPanel,
    _buildPickerPanel,
    _buildCollabPanel,
    _buildFolderPanel,
} from "./publish-modal-panels.js";

// `plainLanguageError` is part of this module's public surface (imported by
// end-panel rendering + possibly other call sites); re-export it from the
// entry point so importers keep resolving after the helpers extraction.
export { plainLanguageError };

/**
 * Open the Publish modal. Resolves with `{ docId, docUrl }` on successful
 * publish, or `null` on cancel / unrecovered error.
 *
 * @param {{
 *   script: any,
 *   scriptFormat: "mangaplay"|"fountain"|"superscript"|"general-text"|string,
 *   sourceText: string,
 *   basename: string,
 *   localPath: string,
 *   projectId?: string,
 *   projectPath?: string,
 *   scriptRelPath?: string,
 *   userName?: string,
 *   clientId?: string,
 *   authClient?: { getAccessToken: (opts?: { allowRefresh?: boolean }) => Promise<string|null> },
 *   workersOverride?: object
 * }} ctx
 * @returns {Promise<{ docId: string, docUrl: string } | null>}
 */
export async function openPublishModal(ctx)
{
    // Persist values across Try Again so the form panel stays populated.
    const stem = stemFor(ctx.basename || "Untitled");
    const initialValues = _initialValues(ctx, stem);
    const authClient = ctx.authClient || _stubAuthClient();

    return openModal({
        variantClass: "publish-modal-backdrop",
        cancelValue: null,
        build: ({ backdrop, resolveWith: rawResolveWith, cancel: rawCancel }) =>
        {
            // Wrap the shell's teardown hooks so the gate panel gets a
            // chance to detach its document-level `mps:authChanged`
            // listener before the DOM is destroyed. Leaked listeners
            // would accumulate one-per-modal-open, each retaining the
            // panel's closure and writing into detached DOM on every
            // future auth-state change.
            /** @type {{ dispose?: () => void } | null} */
            let panelGateRef = null;
            const runDispose = () =>
            {
                if (panelGateRef && typeof panelGateRef.dispose === "function")
                {
                    try { panelGateRef.dispose(); } catch (_) { /* best-effort */ }
                    panelGateRef = null;
                }
            };
            /** @type {(v: any) => void} */
            const resolveWith = (v) => { runDispose(); rawResolveWith(v); };
            const cancel = () => { runDispose(); rawCancel(); };

            const dialog = document.createElement("div");
            dialog.className = "settings-dialog publish-modal";
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            dialog.setAttribute("aria-label",
                t("mangaplay-studio.googleDocsSync.publish.modalTitle", "Publish to Google Docs™"));

            // Pre-resolved titlebar strings — `setPanel(name)` swaps
            // between them whenever the active slide changes.
            const publishTitle = t(
                "mangaplay-studio.googleDocsSync.publish.modalTitle", "Publish to Google Docs™");
            const collabTitle = t(
                "mangaplay-studio.googleDocsSync.publish.modalTitleCollaboration", "Collaboration");

            // ── Titlebar ───────────────────────────────────────────────
            const titlebar = document.createElement("div");
            titlebar.className = "settings-titlebar publish-titlebar";
            const titleText = document.createElement("div");
            titleText.className = "publish-title";
            titleText.textContent = publishTitle;
            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className = "settings-close";
            closeBtn.setAttribute("aria-label",
                t("mangaplay-studio.googleDocsSync.publish.cancel", "Cancel"));
            closeBtn.insertAdjacentHTML("afterbegin", icon("x", { size: 16 }));
            closeBtn.addEventListener("click", () => cancel());
            titlebar.appendChild(titleText);
            titlebar.appendChild(closeBtn);

            // ── Track + five panels ────────────────────────────────────
            const track = document.createElement("div");
            track.className = "publish-track";
            track.dataset.panel = "gate";

            /**
             * Slide the modal to a named panel AND update the titlebar text
             * so the collab flow can show "Collaboration" while every other
             * slide keeps the default "Publish to Google Docs" title.
             *
             * @param {"gate"|"picker"|"form"|"progress"|"end"|"collab"|"folder"} name
             */
            const setPanel = (name) =>
            {
                track.dataset.panel = name;
                titleText.textContent = name === "collab" ? collabTitle : publishTitle;
            };

            // Tracks which form panel (publish vs collaborate) opened the
            // folder picker so onBack/onSelect return to the right place.
            /** @type {{ setChosenFolder: (args: { folderId: string, name: string, fullPath: string }) => void } | null} */
            let folderReturnPanel = null;
            /** @type {"form"|"collab"} */
            let folderReturnSlot = "form";

            const panelForm = _buildFormPanel(initialValues, ctx, {
                onPublish: () => startPublish(),
                onCancel:  () => { setPanel("picker"); }
            }, "publish");
            const panelGate = _buildGatePanel({
                onSignedIn: () =>
                {
                    setPanel("picker");
                }
            });
            panelGateRef = panelGate;
            const panelPicker = _buildPickerPanel({
                onPublish: () =>
                {
                    initialValues.intent = "publish";
                    setPanel("form");
                    panelForm.enableChooseFolder();
                    panelForm.preloadFolderPickerToken();
                },
                onCollaborate: () =>
                {
                    initialValues.intent = "collaborate";
                    setPanel("collab");
                    panelCollab.enableChooseFolder();
                    panelCollab.preloadFolderPickerToken();
                }
            });
            const panelProgress = _buildProgressPanel();
            const panelEnd = _buildEndPanel({
                onTryAgain: () => resetToForm(),
                onDone:     () => { resolveWith({ docId: lastDocId, docUrl: lastDocUrl }); },
                onCancel:   () => cancel()
            });
            const panelCollab = _buildCollabPanel(initialValues, ctx, {
                onSubmit: () => startCollabPublish(),
                onBack:   () => { setPanel("picker"); }
            });
            const panelFolder = _buildFolderPanel({
                onBack: () =>
                {
                    setPanel(folderReturnSlot);
                },
                onSelect: ({ folderId, name, fullPath }) =>
                {
                    const target = folderReturnPanel || panelForm;
                    target.setChosenFolder({ folderId, name, fullPath });
                    setPanel(folderReturnSlot);
                }
            });

            // The Choose Google Folder pill on either form slides the modal
            // into the folder panel. Lazy-mount the FolderPicker on first
            // entry using the token the form panel preloaded.
            panelForm.setOnChooseFolder(() =>
            {
                folderReturnPanel = panelForm;
                folderReturnSlot = "form";
                setPanel("folder");
                void panelFolder.prepare(() => panelForm.getPreloadedTokenPromise());
            });
            panelCollab.setOnChooseFolder(() =>
            {
                folderReturnPanel = panelCollab;
                folderReturnSlot = "collab";
                setPanel("folder");
                void panelFolder.prepare(() => panelCollab.getPreloadedTokenPromise());
            });

            track.appendChild(panelGate.root);
            track.appendChild(panelPicker.root);
            track.appendChild(panelForm.root);
            track.appendChild(panelProgress.root);
            track.appendChild(panelEnd.root);
            track.appendChild(panelCollab.root);
            track.appendChild(panelFolder.root);

            dialog.appendChild(titlebar);
            dialog.appendChild(track);
            backdrop.appendChild(dialog);

            // ── Preflight gate ─────────────────────────────────────────
            // Kick off the access-token check immediately. Spinner stays
            // visible for at least 1.0s; if the call takes longer the
            // spinner stays until it resolves (no upper cap).
            (async () =>
            {
                const t0 = performance.now();
                let token = null;
                /** @type {unknown} */
                let preflightErr = null;
                try
                {
                    token = await authClient.getAccessToken({ allowRefresh: true });
                }
                catch (e)
                {
                    preflightErr = e;
                }
                const wait = Math.max(0, 1000 - (performance.now() - t0));
                if (wait > 0) await new Promise((r) => setTimeout(r, wait));

                if (token)
                {
                    setPanel("picker");
                }
                else
                {
                    // Token null OR threw. Cross-fade the gate slot from
                    // spinner to sign-in. The error box stays hidden on
                    // first show — the common case is just "not signed in
                    // yet", not a real error.
                    panelGate.showSignIn();
                    if (preflightErr)
                    {
                        // Don't expose to the user on first show, but log
                        // it so we can debug if needed.
                        console.warn("[publish-modal] preflight getAccessToken threw:", preflightErr);
                    }
                }
            })();

            // ── State plumbing ─────────────────────────────────────────
            /** @type {string} */
            let lastDocId = "";
            /** @type {string} */
            let lastDocUrl = "";

            // Tracks the panel + slot to return to from Try Again, so the
            // collab and publish flows each slide back to their own form.
            /** @type {"form"|"collab"} */
            let lastSubmitSlot = "form";

            /**
             * Drive the publish state machine from a given form panel's
             * collected values. Both the Publish form and the Collaborate
             * form funnel through here — the state machine branches on
             * `formValues.intent`.
             *
             * @param {{ collect: () => any }} sourcePanel
             * @param {"form"|"collab"} sourceSlot
             */
            function runStateMachine(sourcePanel, sourceSlot)
            {
                lastSubmitSlot = sourceSlot;
                const values = sourcePanel.collect();

                setPanel("progress");
                panelProgress.reset();

                const workers = ctx.workersOverride || buildPublishWorkers({
                    authClient
                });

                const sm = new PublishStateMachine({
                    formValues: values,
                    workers,
                    onTransition: ({ state, pct, payload }) =>
                    {
                        if (state === "success")
                        {
                            lastDocId  = (payload && payload.docId)  || "";
                            lastDocUrl = (payload && payload.docUrl) || "";
                            panelEnd.showSuccess({
                                title: values.title,
                                docUrl: lastDocUrl
                            });
                            setPanel("end");
                            return;
                        }
                        if (state === "error")
                        {
                            panelEnd.showError({
                                title: values.title,
                                failedStep: (payload && payload.failedStep) || "",
                                errorClass: (payload && payload.errorClass) || "fatal.unknown",
                                diagnostic: (payload && payload.diagnostic) || ""
                            });
                            setPanel("end");
                            return;
                        }
                        // Progress / preflight state.
                        panelProgress.update({
                            state, pct,
                            warnings: sm.warnings
                        });
                    }
                });

                void sm.run();
            }

            function startPublish()
            {
                runStateMachine(panelForm, "form");
            }

            function startCollabPublish()
            {
                runStateMachine(panelCollab, "collab");
            }

            function resetToForm()
            {
                // Try Again — slide back to whichever form started this run,
                // preserving its inputs.
                panelProgress.reset();
                panelEnd.reset();
                setPanel(lastSubmitSlot);
            }
        }
    });
}
/**
 * Stub auth client used when callers don't supply one. Always returns null
 * so preflight surfaces the sign-in panel cleanly.
 *
 * The real desktop wiring passes a concrete authClient sourced from
 * `src/auth/google-oauth.js` via the menu onSelect in app.js.
 */
function _stubAuthClient()
{
    return {
        async getAccessToken() { return null; }
    };
}
