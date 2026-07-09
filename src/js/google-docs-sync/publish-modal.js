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
import { FolderPicker } from "./folder-picker.js";
import { PublishStateMachine, STEPS } from "./publish-state-machine.js";
import { buildPublishWorkers } from "./publish-workers.js";
import { driveClient as driveClientApi } from "../../../../core/google-docs/index.js";
import {
    signIn as authSignIn,
    isInteractiveSignInPending as authIsInteractiveSignInPending,
    abortInteractiveSignIn as authAbortInteractiveSignIn,
} from "../auth/google-oauth.js";
import { classifyAuthError } from "../auth/error-classifier.js";

/**
 * Map an `errorClass` → plain-language explanation string.
 * Falls back to the raw diagnostic when no key matches.
 *
 * @param {string} errorClass
 * @param {string} diagnostic
 * @returns {string}
 */
export function plainLanguageError(errorClass, diagnostic)
{
    switch (errorClass)
    {
        case "auth.network":
            return t("mangaplay-studio.googleDocsSync.publish.errors.network",
                "Looks like you're offline. Reconnect and try again.");
        case "auth.token_expired":
            return t("mangaplay-studio.googleDocsSync.publish.errors.tokenExpired",
                "Your Google sign-in needs renewing. Click Try Again to sign in.");
        case "auth.user_cancelled":
            return t("mangaplay-studio.googleDocsSync.publish.errors.userCancelled",
                "Sign-in was cancelled. Try Again to retry.");
        case "permissions.doc_access_revoked":
        case "permissions.doc_picker_denied":
            return t("mangaplay-studio.googleDocsSync.publish.errors.docAccessRevoked",
                "We don't have access to that folder anymore. Pick another.");
        case "fatal.config":
            return t("mangaplay-studio.googleDocsSync.publish.errors.fileMissing",
                "Your local file is missing. Did it get moved?");
        case "fatal.unknown":
            return t("mangaplay-studio.googleDocsSync.publish.errors.unknown",
                "Something unexpected went wrong. Try Again — if it keeps failing, restart the app.");
        default:
            return diagnostic || "";
    }
}

/**
 * Resolve a localised step label.
 * @param {string} stateKey  — e.g. "preflight.network" or "creating"
 * @returns {string}
 */
function stepLabel(stateKey)
{
    const map = /** @type {Record<string,string>} */ ({
        "preflight.network":  "network",
        "preflight.google":   "google",
        "preflight.token":    "token",
        "preflight.file":     "file",
        "preflight.dest":     "dest",
        "creating":           "creating",
        "writingTab1":        "writingTab1",
        "writingTab2":        "writingTab2",
        "applyProps":         "applyProps",
        "sharing":            "sharing",
        "locking":            "locking"
    });
    const key = map[stateKey];
    if (!key) return "";
    return t(`mangaplay-studio.googleDocsSync.publish.steps.${key}`, "");
}

/**
 * Strip known suffixes from the basename to get the stem (used as the
 * default doc title). Mirrors `stemFor` in export-screenplay-modal.js so
 * the two modals don't disagree.
 *
 * @param {string} name
 * @returns {string}
 */
function stemFor(name)
{
    if (!name) return "Untitled";
    const lower = name.toLowerCase();
    const doubles = [".mangaplay.md", ".fountain.md", ".sup.md"];
    for (const d of doubles) if (lower.endsWith(d)) return name.slice(0, -d.length);
    const singles = [".mangaplay", ".fountain", ".sup", ".txt", ".md"];
    for (const s of singles) if (lower.endsWith(s)) return name.slice(0, -s.length);
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Map a classified auth error to a shared
 * `mangaplay-studio.auth.errors.*` key. Covers all 8 classifier
 * classes; anything unrecognised falls through to `"unknown"`.
 *
 * Previously mapped to per-surface `publish.errors.*` keys with a
 * bug (`fatal.config` → `"fileMissing"`) and two missing classes
 * (`auth.scope_denied`, `auth.refresh_token_expired`) that silently
 * collapsed to the generic unknown copy.
 * @param {string} cls
 * @returns {string}
 */
function _errorLocaleKey(cls)
{
    switch (cls)
    {
        case "auth.user_cancelled":            return "cancelled";
        case "auth.network":                   return "network";
        case "auth.scope_denied":              return "scopeDenied";
        case "auth.token_expired":             return "tokenExpired";
        case "auth.refresh_token_expired":     return "refreshExpired";
        case "permissions.doc_access_revoked":
        case "permissions.doc_picker_denied":  return "revoked";
        case "fatal.config":                   return "config";
        default:                               return "unknown";
    }
}

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
                    console.warn("[mps:auth:TRACE] publish-modal picker → PUBLISH card clicked → panel=form, preloading folder-picker token");
                    initialValues.intent = "publish";
                    setPanel("form");
                    panelForm.enableChooseFolder();
                    panelForm.preloadFolderPickerToken();
                },
                onCollaborate: () =>
                {
                    console.warn("[mps:auth:TRACE] publish-modal picker → COLLABORATE card clicked → panel=collab, preloading folder-picker token");
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
                console.warn("[mps:auth:TRACE] publish-modal preflight gate → calling authClient.getAccessToken({allowRefresh:true})");
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
                    console.warn("[mps:auth:TRACE] publish-modal preflight → GOT TOKEN (len=" + token.length + "), routing to PICKER panel");
                    setPanel("picker");
                }
                else
                {
                    console.warn("[mps:auth:TRACE] publish-modal preflight → NO TOKEN, routing to SIGN-IN gate (user must click Sign In to open browser). preflightErr=", preflightErr);
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
                console.warn("[mps:auth:TRACE] publish-modal runStateMachine() ENTRY slot=", sourceSlot);
                lastSubmitSlot = sourceSlot;
                const values = sourcePanel.collect();
                console.warn("[mps:auth:TRACE] publish-modal runStateMachine() collected values: intent=", values.intent,
                    " title=", values.title, " folderId=", values.folderId, " sharing=", values.sharing);

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
                        console.warn("[mps:auth:TRACE] publish-modal SM transition → state=", state,
                            " pct=", pct, " payload=", payload ? Object.keys(payload) : null);
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
 * @param {any} ctx
 * @param {string} stem
 */
function _initialValues(ctx, stem)
{
    const fmt = ctx.scriptFormat === "mangaplay"
        ? "mangaplay"
        : (ctx.scriptFormat === "fountain" ? "fountain" : "text");
    return {
        // Default intent — the Picker overwrites this when the user clicks
        // Publish vs Collaborate. We default to "publish" so any code path
        // that bypasses the Picker (defensive) gets the safer no-link
        // behaviour.
        intent: /** @type {"publish"|"collaborate"} */ ("publish"),
        title: stem,
        localPath: ctx.localPath || "",
        format: /** @type {"mangaplay"|"fountain"|"text"} */ (fmt),
        sourceText: ctx.sourceText || "",
        folderId: /** @type {string|null} */ (null),
        folderPath: "",
        sharing: /** @type {"private"|"viewLink"|"commentLink"|"specific"} */ ("private"),
        sharingEmails: /** @type {Array<string>} */ ([]),
        lockOnPublish: true,
        userName: ctx.userName || "",
        clientId: ctx.clientId || "",
        projectId: ctx.projectId || "",
        projectPath: ctx.projectPath || "",
        scriptRelPath: ctx.scriptRelPath || ""
    };
}

/**
 * Gate panel — the FIRST slot of the slide track. Contains two stacked
 * substates: spinner (default) and sign-in (revealed only when the
 * preflight `getAccessToken()` returns null). The two substates cross-fade
 * via opacity; the sign-in substate is `display:none` until activated so
 * it never participates in layout when the common path (token in hand)
 * succeeds.
 *
 * Returns `{ root, showSpinner, showSignIn }` so the caller can drive the
 * substate transitions.
 *
 * @param {{ onSignedIn: () => void }} handlers
 */
function _buildGatePanel(handlers)
{
    const root = document.createElement("section");
    root.className = "publish-panel publish-panel-gate";

    // ── Spinner substate ───────────────────────────────────────────────
    const spinner = document.createElement("div");
    spinner.className = "publish-gate-spinner is-shown";

    const spinnerRing = document.createElement("div");
    spinnerRing.className = "publish-spinner";
    spinnerRing.setAttribute("aria-hidden", "true");

    const spinnerLabel = document.createElement("div");
    spinnerLabel.className = "publish-spinner-label";
    spinnerLabel.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.preflight.checking",
        "Checking Google Docs™…");

    spinner.appendChild(spinnerRing);
    spinner.appendChild(spinnerLabel);

    // ── Sign-in substate ───────────────────────────────────────────────
    const signin = document.createElement("div");
    signin.className = "publish-gate-signin";

    const heading = document.createElement("h2");
    heading.className = "publish-heading";
    heading.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.signIn.title",
        "Please sign in to Google Docs™");

    const body = document.createElement("p");
    body.className = "publish-body";
    body.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.signIn.body",
        "Sign in to publish your script as a Google Docs™.");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mps-btn-primary publish-signin-btn";
    btn.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.signIn.button", "Sign In");

    // Cancel button — mounted alongside the Sign-In button, `hidden` by
    // default. `showWaiting()` swaps the label + reveals it; the natural
    // `mps:authChanged` fired when the sign-in flow ends returns the
    // panel to the idle Sign-In state.
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "mps-btn-secondary publish-signin-cancel";
    cancelBtn.textContent = t("mangaplay-studio.auth.errors.cancelButton", "Cancel");
    cancelBtn.hidden = true;
    cancelBtn.addEventListener("click", async () =>
    {
        // Idempotent server-side, but disable to prevent rapid re-invokes.
        cancelBtn.disabled = true;
        let aborted = false;
        try { aborted = await authAbortInteractiveSignIn(); }
        catch (_) { /* best-effort */ }
        // Re-enable when the abort was a no-op (spawn race or mobile
        // transport with no loopback id) — the flow keeps running with
        // no re-render forthcoming, so leaving the button disabled would
        // strand the user.
        if (!aborted) cancelBtn.disabled = false;
    });

    // Permanently-mounted inline error slot. Empty by default so
    // `:empty { margin-top: 0 }` collapses it — no dead zone under
    // the sign-in button in the common (no-error) case. `aria-live=polite`
    // announces the sentence when a failed sign-in populates it;
    // deliberately NOT `role=alert` (which implies aria-live=assertive) —
    // combining them is contradictory.
    const errorBox = document.createElement("div");
    errorBox.className = "publish-signin-error";
    errorBox.setAttribute("aria-live", "polite");

    // Idle-state Sign-In label so `showSignIn` can restore it after a
    // Waiting state ends without re-reading the locale table (which
    // would introduce a subscription order dependency).
    const idleBtnLabel = btn.textContent;

    btn.addEventListener("click", async () =>
    {
        console.warn("[mps:auth:TRACE] publish-modal gate Sign-In button CLICKED → will call authSignIn({interactive:true})");
        btn.disabled = true;
        errorBox.textContent = "";
        try
        {
            const profile = await authSignIn({ interactive: true });
            // authSignIn returns null on cancel (both the primary flow
            // and the join-in-flight path). Don't advance to picker
            // without a token; surface the cancelled sentence in the
            // error slot so the user sees what happened. Success path
            // does NOT clear errorBox — `showSignIn`/`showWaiting` reset
            // it on their own transitions.
            if (profile)
            {
                handlers.onSignedIn();
            }
            else
            {
                errorBox.textContent = t(
                    "mangaplay-studio.auth.errors.cancelled",
                    "Sign-in was cancelled — you can try again.");
            }
        }
        catch (e)
        {
            const cls = classifyAuthError(e);
            const errKey = _errorLocaleKey(cls.class);
            errorBox.textContent = t(
                `mangaplay-studio.auth.errors.${errKey}`,
                cls.diagnostic || "");
        }
        finally
        {
            btn.disabled = false;
        }
    });

    signin.appendChild(heading);
    signin.appendChild(body);
    signin.appendChild(btn);
    signin.appendChild(cancelBtn);
    signin.appendChild(errorBox);

    root.appendChild(spinner);
    root.appendChild(signin);

    /**
     * Swap the Sign-In substate into the Waiting affordance —
     * button reads "Waiting for browser sign-in…" (disabled), the
     * secondary Cancel button appears next to it. Called by
     * `showSignIn()` when `isInteractiveSignInPending()` is true on
     * entry, and by the `mps:authChanged` subscriber below when the
     * flow starts in the background.
     */
    function showWaiting()
    {
        btn.disabled = true;
        btn.textContent = t("mangaplay-studio.auth.errors.waiting", "Waiting for browser sign-in…");
        cancelBtn.hidden = false;
        cancelBtn.disabled = false;
        errorBox.textContent = "";
        // Ensure the sign-in substate is actually visible in case we
        // were still on the spinner when the flow kicked off.
        spinner.classList.remove("is-shown");
        signin.classList.add("is-active");
        requestAnimationFrame(() => { signin.classList.add("is-shown"); });
    }

    /**
     * Restore the idle Sign-In label + hide Cancel. Called when the
     * flow ends (mps:authChanged fires with pending===false) so a
     * user who cancelled or errored can retry from the same panel.
     */
    function restoreIdleSignIn()
    {
        btn.disabled = false;
        btn.textContent = idleBtnLabel;
        cancelBtn.hidden = true;
        cancelBtn.disabled = false;
    }

    // Live-update the panel when an interactive sign-in starts or ends
    // OUTSIDE of the panel's own button click (e.g. user clicks Sign In
    // in Settings→Account with the publish modal already showing the
    // sign-in substate). The natural authChanged emit at the end of
    // signIn() flips us back to the idle button.
    //
    // Gated on `signin.classList.contains("is-active")` — we don't
    // want to yank the preflight spinner off the screen if a background
    // sign-in kicked off while preflight is still resolving. Once the
    // outer modal transitions us into the sign-in substate via
    // `showSignIn()` this gate opens.
    const onAuthChanged = () =>
    {
        if (!signin.classList.contains("is-active")) return;
        if (authIsInteractiveSignInPending()) showWaiting();
        else restoreIdleSignIn();
    };
    document.addEventListener("mps:authChanged", onAuthChanged);

    return {
        root,
        showSpinner()
        {
            signin.classList.remove("is-shown");
            signin.classList.remove("is-active");
            spinner.classList.add("is-shown");
        },
        showSignIn()
        {
            // If a background sign-in is already in flight when we
            // arrive at the gate (rare — e.g. user clicked Sign In in
            // Settings and then opened Publish), skip straight to the
            // Waiting affordance so the panel matches reality.
            if (authIsInteractiveSignInPending())
            {
                showWaiting();
                return;
            }
            // Otherwise ensure any prior Waiting state is reset before
            // the fade-in animation runs.
            restoreIdleSignIn();

            // 1) Spinner starts fading out.
            spinner.classList.remove("is-shown");
            // 2) Signin enters layout (display:none → display:flex) with
            //    opacity still 0.
            signin.classList.add("is-active");
            // 3) On the NEXT frame, add is-shown so the browser registers
            //    display:flex first and the opacity transition runs.
            requestAnimationFrame(() =>
            {
                signin.classList.add("is-shown");
            });
        },
        // Called by the outer modal's close path. Detaches the
        // document-level mps:authChanged listener so repeated
        // open/close cycles don't accumulate stale handlers writing
        // into detached DOM.
        dispose()
        {
            document.removeEventListener("mps:authChanged", onAuthChanged);
        }
    };
}

/**
 * Form panel. Returns:
 *   { root, collect, errorRow, enableChooseFolder, preloadFolderPickerToken }
 *
 * `enableChooseFolder()` flips the Choose-Folder button from
 * `disabled=true` (default) to enabled, called by the preflight gate
 * after a token is acquired.
 *
 * `preloadFolderPickerToken()` kicks off the Drive token fetch so the
 * FolderPicker is ready to mount the moment the user clicks the button.
 *
 * `mode` switches the panel between the two publish flows. They share
 * every form-field row; mode only affects the top logo/heading, whether
 * the lock-row is shown, the primary button label, and the `intent` /
 * `lockOnPublish` values produced by `collect()`.
 *
 * @param {ReturnType<typeof _initialValues>} initialValues
 * @param {any} ctx
 * @param {{ onPublish: () => void, onCancel: () => void }} handlers
 * @param {"publish"|"collaborate"} [mode]
 */
function _buildFormPanel(initialValues, ctx, handlers, mode)
{
    const formMode = mode === "collaborate" ? "collaborate" : "publish";
    const isCollab = formMode === "collaborate";

    const root = document.createElement("section");
    root.className = "publish-panel publish-panel-form";

    // ── Logo + heading/explainer block ─────────────────────────────────
    const logo = document.createElement("div");
    logo.className = "publish-form-logo";
    const logoImg = document.createElement("img");
    logoImg.src = isCollab ? "./img/google-drive-logo.png" : "./img/google-doc-logo.png";
    logoImg.width = 48;
    logoImg.height = 48;
    logoImg.alt = "";
    logo.appendChild(logoImg);
    root.appendChild(logo);

    if (isCollab)
    {
        const explainer = document.createElement("p");
        explainer.className = "publish-form-explainer";
        explainer.textContent = t(
            "mangaplay-studio.googleDocsSync.publish.collab.formExplainer",
            "This will create or link a Google Docs™ with this document. You can use the Collaborate Button in the footer to Push or Pull changes.");
        root.appendChild(explainer);
    }
    else
    {
        const explainer = document.createElement("p");
        explainer.className = "publish-form-explainer";
        explainer.textContent = t(
            "mangaplay-studio.googleDocsSync.publish.publishExplainer",
            "This will create a new Google Docs™ from the current document.");
        root.appendChild(explainer);
    }

    // ── Form card — groups all form-field rows ─────────────────────────
    const card = document.createElement("div");
    card.className = "settings-card publish-form-card";

    // ── Title row (mps-row layout) ─────────────────────────────────────
    const titleRow = document.createElement("div");
    titleRow.className = "mps-row";
    const titleRowLabel = document.createElement("div");
    titleRowLabel.className = "mps-row-label";
    const titleRowTitle = document.createElement("div");
    titleRowTitle.className = "mps-row-title";
    titleRowTitle.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.titleLabel", "Document title");
    titleRowLabel.appendChild(titleRowTitle);

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "mps-select publish-title-input";
    titleInput.value = initialValues.title;
    titleRow.appendChild(titleRowLabel);
    titleRow.appendChild(titleInput);
    card.appendChild(titleRow);

    // ── Save-to row — two-pill toggle (My Drive | Choose Folder) ────────
    // Both pills act as a single-select toggle. The active pill shows a
    // tick (built via the `icon("check")` SVG into a `.publish-saveto-tick`
    // slot). My Drive resets folderId to null; Choose Folder slides the
    // modal to the folder-picker slot. After a folder is selected there,
    // the outer modal calls `setChosenFolder()` on this form panel to
    // update the Choose-Folder pill's label and move the tick.
    const saveToRow = document.createElement("div");
    saveToRow.className = "publish-saveto-row";
    const saveToLabel = document.createElement("span");
    saveToLabel.className = "publish-saveto-label";
    saveToLabel.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.saveToLabel", "Save to:");

    const myDrivePill = _buildSaveToPill({
        label: t("mangaplay-studio.googleDocsSync.publish.saveToMyDrive", "My Drive"),
        pressed: initialValues.folderId == null
    });
    const chooseFolderPill = _buildSaveToPill({
        label: t(
            "mangaplay-studio.googleDocsSync.publish.saveToChooseFolder",
            "Choose Google Folder…"),
        pressed: initialValues.folderId != null
    });
    // Permanently disabled pending the folder-picker hardening work — see
    // TODO/google-drive-folder-picker-hardening.md. The current Drive
    // tree is broken for new users (drive.file scope returns no folders)
    // and silently truncates at 100 children. Re-enable when the scope
    // upgrade + pagination + shared-drives phases land.
    chooseFolderPill.disabled = true;
    chooseFolderPill.title = t(
        "mangaplay-studio.googleDocsSync.publish.saveToChooseFolderComingSoon",
        "Coming soon");

    saveToRow.appendChild(saveToLabel);
    saveToRow.appendChild(myDrivePill);
    // Choose-Folder pill DOM omitted by design — the folder picker is gated
    // behind the hardening TODO and the user requested the disabled button
    // be hidden. `chooseFolderPill` stays as a detached element so
    // setChosenFolder / resetToMyDrive / setOnChooseFolder remain callable
    // no-ops; re-mount with `saveToRow.appendChild(chooseFolderPill)` to
    // restore the UI once the picker work lands.
    card.appendChild(saveToRow);

    /** @type {Promise<string|null>|null} */
    let preloadedTokenPromise = null;
    /** @type {(() => void)|null} */
    let onChooseFolderRequested = null;

    function preloadFolderPickerToken()
    {
        console.warn("[mps:auth:TRACE] preloadFolderPickerToken() called");
        if (preloadedTokenPromise)
        {
            console.warn("[mps:auth:TRACE] preloadFolderPickerToken() → already in-flight, skipping");
            return;
        }
        if (!ctx.authClient || !ctx.authClient.getAccessToken)
        {
            console.warn("[mps:auth:TRACE] preloadFolderPickerToken() → no authClient, resolving null");
            preloadedTokenPromise = Promise.resolve(null);
            return;
        }
        console.warn("[mps:auth:TRACE] preloadFolderPickerToken() → calling authClient.getAccessToken (silent refresh, should NOT open browser)");
        preloadedTokenPromise = ctx.authClient.getAccessToken({ allowRefresh: true })
            .then((tok) => { console.warn("[mps:auth:TRACE] preloadFolderPickerToken() ← token=", tok ? ("len=" + tok.length) : "null"); return tok; })
            .catch((e) => { console.warn("[mps:auth:TRACE] preloadFolderPickerToken() ← ERROR", e); return null; });
    }

    function getPreloadedTokenPromise()
    {
        if (!preloadedTokenPromise) preloadFolderPickerToken();
        return preloadedTokenPromise;
    }

    function enableChooseFolder()
    {
        // Intentionally a no-op while the folder picker is gated behind
        // the "Coming soon" tooltip — see
        // TODO/google-drive-folder-picker-hardening.md. The Picker's
        // onPublish still calls this; we keep the API surface stable so
        // re-enabling is a one-line revert when the picker lands.
    }

    /** @param {() => void} fn */
    function setOnChooseFolder(fn)
    {
        onChooseFolderRequested = fn;
    }

    function resetToMyDrive()
    {
        initialValues.folderId = null;
        initialValues.folderPath = "";
        myDrivePill.setAttribute("aria-pressed", "true");
        chooseFolderPill.setAttribute("aria-pressed", "false");
        chooseFolderPill.querySelector(".publish-saveto-label-text").textContent = t(
            "mangaplay-studio.googleDocsSync.publish.saveToChooseFolder",
            "Choose Google Folder…");
        chooseFolderPill.title = "";
    }

    /** @param {{ folderId: string, name: string, fullPath: string }} args */
    function setChosenFolder({ folderId, name, fullPath })
    {
        initialValues.folderId = folderId;
        initialValues.folderPath = fullPath;
        myDrivePill.setAttribute("aria-pressed", "false");
        chooseFolderPill.setAttribute("aria-pressed", "true");
        chooseFolderPill.querySelector(".publish-saveto-label-text").textContent =
            name || fullPath || t(
                "mangaplay-studio.googleDocsSync.publish.saveToChooseFolder",
                "Choose Google Folder…");
        chooseFolderPill.title = fullPath || "";
    }

    myDrivePill.addEventListener("click", () =>
    {
        resetToMyDrive();
    });

    chooseFolderPill.addEventListener("click", () =>
    {
        if (chooseFolderPill.disabled) return;
        if (onChooseFolderRequested) onChooseFolderRequested();
    });

    // ── Sharing row — native <select> ──────────────────────────────────
    const shareRow = document.createElement("div");
    shareRow.className = "mps-row";
    const shareRowLabel = document.createElement("div");
    shareRowLabel.className = "mps-row-label";
    const shareRowTitle = document.createElement("div");
    shareRowTitle.className = "mps-row-title";
    shareRowTitle.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.sharingLabel", "Sharing:");
    shareRowLabel.appendChild(shareRowTitle);

    const shareSelect = document.createElement("select");
    shareSelect.className = "mps-select";
    const SHARE_OPTIONS = [
        { v: "private",     k: "sharingPrivate",     d: "Only me" },
        { v: "viewLink",    k: "sharingViewLink",    d: "Anyone with link can view" },
        { v: "commentLink", k: "sharingCommentLink", d: "Anyone with link can comment" },
        { v: "specific",    k: "sharingSpecific",    d: "Specific people" },
    ];
    for (const opt of SHARE_OPTIONS)
    {
        const o = document.createElement("option");
        o.value = opt.v;
        o.textContent = t(
            `mangaplay-studio.googleDocsSync.publish.${opt.k}`, opt.d);
        if (opt.v === initialValues.sharing) o.selected = true;
        shareSelect.appendChild(o);
    }
    shareRow.appendChild(shareRowLabel);
    shareRow.appendChild(shareSelect);
    card.appendChild(shareRow);

    // Email row — visible only when sharing === "specific".
    const emailRow = document.createElement("div");
    emailRow.className = "publish-email-row";
    emailRow.hidden = shareSelect.value !== "specific";
    const emailInput = document.createElement("input");
    emailInput.type = "email";
    emailInput.className = "mps-select publish-email-input";
    emailInput.placeholder = t(
        "mangaplay-studio.googleDocsSync.publish.sharingSpecificPlaceholder", "Email address");
    const emailAddBtn = document.createElement("button");
    emailAddBtn.type = "button";
    emailAddBtn.className = "mps-btn-secondary publish-email-add";
    emailAddBtn.textContent = "+";
    const emailChips = document.createElement("div");
    emailChips.className = "publish-email-chips";
    emailRow.appendChild(emailInput);
    emailRow.appendChild(emailAddBtn);
    emailRow.appendChild(emailChips);
    card.appendChild(emailRow);

    /** @type {Array<string>} */
    const emails = initialValues.sharingEmails;
    const renderChips = () =>
    {
        emailChips.replaceChildren();
        emails.forEach((e, i) =>
        {
            const chip = document.createElement("span");
            chip.className = "publish-email-chip";
            chip.textContent = e;
            const x = document.createElement("button");
            x.type = "button";
            x.className = "publish-email-chip-x";
            x.textContent = "×";
            x.addEventListener("click", () =>
            {
                emails.splice(i, 1);
                renderChips();
                recomputePublishEnabled();
            });
            chip.appendChild(x);
            emailChips.appendChild(chip);
        });
    };
    emailAddBtn.addEventListener("click", () =>
    {
        const v = String(emailInput.value || "").trim();
        if (!v) return;
        emails.push(v);
        emailInput.value = "";
        renderChips();
        recomputePublishEnabled();
    });
    emailInput.addEventListener("keydown", (ev) =>
    {
        if (ev.key === "Enter") { ev.preventDefault(); emailAddBtn.click(); }
    });
    renderChips();

    shareSelect.addEventListener("change", () =>
    {
        emailRow.hidden = shareSelect.value !== "specific";
        recomputePublishEnabled();
    });

    // ── Lock row — mps-toggle inside mps-row ───────────────────────────
    // Only shown in publish mode. Collaborate is ALWAYS locked, surfaced
    // directly by collect() — no toggle, no row.
    /** @type {HTMLButtonElement|null} */
    let lockToggle = null;
    if (!isCollab)
    {
        const lockRow = document.createElement("div");
        lockRow.className = "mps-row";
        const lockRowLabel = document.createElement("div");
        lockRowLabel.className = "mps-row-label";
        const lockRowTitle = document.createElement("div");
        lockRowTitle.className = "mps-row-title";
        lockRowTitle.textContent = t(
            "mangaplay-studio.googleDocsSync.publish.lockCheckbox",
            "Lock immediately after publishing");
        lockRowLabel.appendChild(lockRowTitle);

        lockToggle = document.createElement("button");
        lockToggle.type = "button";
        lockToggle.className = "mps-toggle";
        lockToggle.setAttribute("role", "switch");
        lockToggle.setAttribute("aria-checked", String(!!initialValues.lockOnPublish));
        lockToggle.setAttribute("aria-label", t(
            "mangaplay-studio.googleDocsSync.publish.lockCheckbox",
            "Lock immediately after publishing"));
        lockToggle.addEventListener("click", () =>
        {
            const next = lockToggle.getAttribute("aria-checked") !== "true";
            lockToggle.setAttribute("aria-checked", String(next));
        });
        lockRow.appendChild(lockRowLabel);
        lockRow.appendChild(lockToggle);
        card.appendChild(lockRow);
    }

    // Card finished — mount it before the error slot + footer.
    root.appendChild(card);

    // ── Backend-error slot (kept for "publishing failed" messages) ─────
    const errorRow = document.createElement("div");
    errorRow.className = "publish-form-error";
    root.appendChild(errorRow);

    // ── Footer ────────────────────────────────────────────────────────
    const footer = document.createElement("div");
    footer.className = "publish-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "mps-btn-secondary";
    cancelBtn.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.back", "Back");
    cancelBtn.addEventListener("click", () => handlers.onCancel());
    const publishBtn = document.createElement("button");
    publishBtn.type = "button";
    publishBtn.className = "mps-btn-primary";
    publishBtn.textContent = isCollab
        ? t("mangaplay-studio.googleDocsSync.publish.collab.connectButton", "Connect Document")
        : t("mangaplay-studio.googleDocsSync.publish.publish", "Publish");
    publishBtn.disabled = true;
    publishBtn.addEventListener("click", () => handlers.onPublish());
    footer.appendChild(cancelBtn);
    footer.appendChild(publishBtn);
    root.appendChild(footer);

    // ── Publish-button gating ──────────────────────────────────────────
    function recomputePublishEnabled()
    {
        const titleOk = String(titleInput.value || "").trim().length > 0;
        const sharingOk = shareSelect.value !== "specific" || emails.length > 0;
        publishBtn.disabled = !(titleOk && sharingOk);
    }
    titleInput.addEventListener("input", recomputePublishEnabled);
    recomputePublishEnabled();

    function collect()
    {
        const lockOnPublish = isCollab
            ? true
            : (lockToggle ? lockToggle.getAttribute("aria-checked") === "true" : true);
        return /** @type {import("./publish-state-machine.js").PublishFormValues} */ ({
            intent: formMode,
            title: String(titleInput.value || "").trim() || initialValues.title,
            localPath: initialValues.localPath,
            format: initialValues.format,
            sourceText: initialValues.sourceText,
            folderId: initialValues.folderId,
            sharing: /** @type {"private"|"viewLink"|"commentLink"|"specific"} */ (shareSelect.value),
            sharingEmails: emails.slice(),
            lockOnPublish,
            userName: initialValues.userName,
            clientId: initialValues.clientId,
            projectId: initialValues.projectId,
            projectPath: initialValues.projectPath,
            scriptRelPath: initialValues.scriptRelPath
        });
    }

    return {
        root,
        collect,
        errorRow,
        enableChooseFolder,
        preloadFolderPickerToken,
        getPreloadedTokenPromise,
        setOnChooseFolder,
        setChosenFolder,
        resetToMyDrive
    };
}

/**
 * Build one of the two Save-to row pills (My Drive / Choose Google Folder).
 * The pill is a real `<button>` so it can take focus, fire on Enter/Space,
 * and use `[aria-pressed]` for the selected styling. The leading slot holds
 * a tick icon that fades in via CSS when `aria-pressed === "true"`.
 *
 * @param {{ label: string, pressed: boolean }} opts
 * @returns {HTMLButtonElement}
 */
function _buildSaveToPill({ label, pressed })
{
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "publish-saveto-pill";
    btn.setAttribute("aria-pressed", String(!!pressed));

    const tick = document.createElement("span");
    tick.className = "publish-saveto-tick";
    tick.innerHTML = icon("check", { size: 12 });
    btn.appendChild(tick);

    const labelEl = document.createElement("span");
    labelEl.className = "publish-saveto-label-text";
    labelEl.textContent = label;
    btn.appendChild(labelEl);

    return btn;
}

/**
 * Panel 4 — progress bar + step label + quota warning slot.
 */
function _buildProgressPanel()
{
    const root = document.createElement("section");
    root.className = "publish-panel publish-panel-progress";

    const heading = document.createElement("h2");
    heading.className = "publish-heading";
    heading.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.publishing", "Publishing…");
    root.appendChild(heading);

    const quotaSlot = document.createElement("div");
    quotaSlot.className = "publish-quota-warning";
    quotaSlot.hidden = true;
    root.appendChild(quotaSlot);

    const bar = document.createElement("div");
    bar.className = "publish-progress-bar";
    const fill = document.createElement("div");
    fill.className = "publish-progress-bar-fill";
    bar.appendChild(fill);
    root.appendChild(bar);

    const stepLabelEl = document.createElement("div");
    stepLabelEl.className = "publish-step-label";
    root.appendChild(stepLabelEl);

    return {
        root,
        reset()
        {
            fill.style.width = "0%";
            stepLabelEl.textContent = "";
            quotaSlot.hidden = true;
            quotaSlot.textContent = "";
        },
        /**
         * @param {{ state: string, pct: number, warnings?: Array<string> }} args
         */
        update({ state, pct, warnings })
        {
            fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
            stepLabelEl.textContent = stepLabel(state);
            if (warnings && warnings.indexOf("over95") !== -1)
            {
                quotaSlot.hidden = false;
                const tpl = t(
                    "mangaplay-studio.googleDocsSync.publish.quotaWarning",
                    "Drive is {pct}% full. Publish may fail if you're over your quota.");
                quotaSlot.textContent = tpl.replace("{pct}", "95+");
            }
        }
    };
}

/**
 * Panel 5 — success/error end states. Returns helpers to flip between
 * them and to reset back to a blank state.
 */
function _buildEndPanel(handlers)
{
    const root = document.createElement("section");
    root.className = "publish-panel publish-panel-end";

    const successWrap = document.createElement("div");
    successWrap.className = "publish-end-success";
    successWrap.hidden = true;

    const checkmark = document.createElement("div");
    checkmark.className = "publish-checkmark";
    // 100-unit stroke-dasharray animation; the path describes a simple tick.
    checkmark.innerHTML = `
        <svg viewBox="0 0 52 52" width="64" height="64" aria-hidden="true">
            <circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="M14 27 L23 36 L40 18" fill="none" stroke="currentColor" stroke-width="3"
                  stroke-linecap="round" stroke-linejoin="round" />
        </svg>`;
    const successHeading = document.createElement("h2");
    successHeading.className = "publish-heading";
    successHeading.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.published", "Published to Google Docs™");

    const urlRow = document.createElement("input");
    urlRow.type = "text";
    urlRow.readOnly = true;
    urlRow.className = "mps-select publish-doc-url";

    const successActions = document.createElement("div");
    successActions.className = "publish-footer";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "mps-btn-secondary";
    openBtn.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.openBrowser", "Open in Browser");
    openBtn.addEventListener("click", async () =>
    {
        try
        {
            const openerMod = await import("@tauri-apps/plugin-opener");
            await openerMod.openUrl(urlRow.value);
        }
        catch (e) { console.warn("[mps:gdocs:publish] open failed:", e); }
    });
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "mps-btn-secondary";
    copyBtn.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.copyLink", "Copy Link");
    copyBtn.addEventListener("click", async () =>
    {
        try
        {
            await navigator.clipboard.writeText(urlRow.value);
            const original = copyBtn.textContent;
            copyBtn.textContent = t(
                "mangaplay-studio.googleDocsSync.publish.copied", "Copied!");
            setTimeout(() => { copyBtn.textContent = original; }, 1500);
        }
        catch (e) { console.warn("[mps:gdocs:publish] copy failed:", e); }
    });
    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "mps-btn-primary";
    doneBtn.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.done", "Done");
    doneBtn.addEventListener("click", () => handlers.onDone());

    successActions.appendChild(openBtn);
    successActions.appendChild(copyBtn);
    successActions.appendChild(doneBtn);

    successWrap.appendChild(checkmark);
    successWrap.appendChild(successHeading);
    successWrap.appendChild(successActions);
    // URL row sits BELOW the action buttons — Open + Copy already cover the
    // common cases; the input stays for accessibility (keyboard-selectable)
    // but visually de-emphasised via the `:last-child` CSS rule.
    successWrap.appendChild(urlRow);

    // ── Error variant ──────────────────────────────────────────────────
    const errorWrap = document.createElement("div");
    errorWrap.className = "publish-end-error";
    errorWrap.hidden = true;

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

    const errorBody = document.createElement("p");
    errorBody.className = "publish-error-body";

    const errorDetails = document.createElement("details");
    errorDetails.className = "publish-error-details";
    const errorSummary = document.createElement("summary");
    errorSummary.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.showDetails", "Show technical details");
    const errorPre = document.createElement("pre");
    errorPre.className = "publish-error-diagnostic";
    errorDetails.appendChild(errorSummary);
    errorDetails.appendChild(errorPre);

    const errorActions = document.createElement("div");
    errorActions.className = "publish-footer";
    const errorCancelBtn = document.createElement("button");
    errorCancelBtn.type = "button";
    errorCancelBtn.className = "mps-btn-secondary";
    errorCancelBtn.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.cancel", "Cancel");
    errorCancelBtn.addEventListener("click", () => handlers.onCancel());
    const tryAgainBtn = document.createElement("button");
    tryAgainBtn.type = "button";
    tryAgainBtn.className = "mps-btn-primary";
    tryAgainBtn.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.tryAgain", "Try Again");
    tryAgainBtn.addEventListener("click", () => handlers.onTryAgain());
    errorActions.appendChild(errorCancelBtn);
    errorActions.appendChild(tryAgainBtn);

    errorWrap.appendChild(errorIcon);
    errorWrap.appendChild(errorHeading);
    errorWrap.appendChild(errorBody);
    errorWrap.appendChild(errorDetails);
    errorWrap.appendChild(errorActions);

    root.appendChild(successWrap);
    root.appendChild(errorWrap);

    return {
        root,
        reset()
        {
            successWrap.hidden = true;
            errorWrap.hidden   = true;
        },
        /**
         * @param {{ title: string, docUrl: string }} args
         */
        showSuccess({ docUrl })
        {
            urlRow.value = docUrl;
            successWrap.hidden = false;
            errorWrap.hidden   = true;
        },
        /**
         * @param {{ title: string, failedStep: string, errorClass: string, diagnostic: string }} args
         */
        showError({ title, failedStep, errorClass, diagnostic })
        {
            const headTpl = t(
                "mangaplay-studio.googleDocsSync.publish.failedTitle",
                'Couldn\'t publish "{title}"');
            errorHeading.textContent = headTpl.replace("{title}", title || "");

            const reasonTpl = t(
                "mangaplay-studio.googleDocsSync.publish.failedReason",
                'We hit a problem at step "{step}".');
            const stepReadable = stepLabel(failedStep) || failedStep;
            const explanation = plainLanguageError(errorClass, diagnostic);
            errorBody.textContent = `${reasonTpl.replace("{step}", stepReadable)} ${explanation}`.trim();
            errorPre.textContent = `${errorClass}\n${diagnostic}`;

            successWrap.hidden = true;
            errorWrap.hidden   = false;
        }
    };
}

/**
 * Picker panel — slot AFTER gate. Two large click-targets side by side:
 * "Publish" (left) → continues to the form panel, and "Collaborate"
 * (right) → slides to the placeholder `collab` panel.
 *
 * @param {{
 *   onPublish: () => void,
 *   onCollaborate: () => void
 * }} handlers
 */
function _buildPickerPanel(handlers)
{
    const root = document.createElement("section");
    root.className = "publish-panel publish-panel-picker";

    const heading = document.createElement("h2");
    heading.className = "publish-picker-heading";
    heading.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.picker.heading",
        "What would you like to do?");
    root.appendChild(heading);

    const cards = document.createElement("div");
    cards.className = "publish-picker-cards";
    root.appendChild(cards);

    // ── Publish card ──────────────────────────────────────────────────
    const publishCard = document.createElement("button");
    publishCard.type = "button";
    publishCard.className = "publish-picker-card publish-picker-card--publish";

    const publishImage = document.createElement("div");
    publishImage.className = "publish-picker-card-image";
    const publishImg = document.createElement("img");
    publishImg.src = "./img/google-doc-logo.png";
    publishImg.width = 48;
    publishImg.height = 48;
    publishImg.alt = "";
    publishImage.appendChild(publishImg);

    const publishTitle = document.createElement("div");
    publishTitle.className = "publish-picker-card-title";
    publishTitle.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.picker.publishCard.title", "Publish");

    const publishBody = document.createElement("p");
    publishBody.className = "publish-picker-card-body";
    publishBody.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.picker.publishCard.body",
        "I want to publish this document to Google Docs™.");

    publishCard.appendChild(publishImage);
    publishCard.appendChild(publishTitle);
    publishCard.appendChild(publishBody);
    publishCard.addEventListener("click", () => handlers.onPublish());
    cards.appendChild(publishCard);

    // ── Collaborate card ──────────────────────────────────────────────
    const collabCard = document.createElement("button");
    collabCard.type = "button";
    collabCard.className = "publish-picker-card publish-picker-card--collaborate";

    const collabImage = document.createElement("div");
    collabImage.className = "publish-picker-card-image";
    const collabImg = document.createElement("img");
    collabImg.src = "./img/google-drive-logo.png";
    collabImg.width = 48;
    collabImg.height = 48;
    collabImg.alt = "";
    collabImage.appendChild(collabImg);

    const collabTitle = document.createElement("div");
    collabTitle.className = "publish-picker-card-title";
    collabTitle.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.picker.collaborateCard.title",
        "Collaborate");

    const collabBody = document.createElement("p");
    collabBody.className = "publish-picker-card-body";
    collabBody.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.picker.collaborateCard.body",
        "I want to constantly update a single Google Document so it will match this version and others can collaborate.");

    const collabComingSoon = document.createElement("div");
    collabComingSoon.className = "publish-picker-card-coming-soon";
    collabComingSoon.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.saveToChooseFolderComingSoon",
        "Coming soon");

    collabCard.disabled = true;
    collabCard.setAttribute("aria-disabled", "true");
    collabCard.classList.add("publish-picker-card--disabled");

    collabCard.appendChild(collabImage);
    collabCard.appendChild(collabTitle);
    collabCard.appendChild(collabBody);
    collabCard.appendChild(collabComingSoon);
    collabCard.addEventListener("click", () => handlers.onCollaborate());
    cards.appendChild(collabCard);

    return { root };
}

/**
 * Collaborate panel — thin wrapper that reuses `_buildFormPanel` in
 * collaborate mode. Same shape as the publish form (logo, title input,
 * save-to, sharing) minus the lock row, with a "Connect Document"
 * primary button and a Back action that returns to the picker.
 *
 * @param {ReturnType<typeof _initialValues>} initialValues
 * @param {any} ctx
 * @param {{ onSubmit: () => void, onBack: () => void }} handlers
 */
function _buildCollabPanel(initialValues, ctx, handlers)
{
    return _buildFormPanel(initialValues, ctx, {
        onPublish: handlers.onSubmit,
        onCancel:  handlers.onBack
    }, "collaborate");
}

/**
 * Folder picker panel (slot 6 of the slide track). Hosts the FolderPicker
 * tree, plus a footer with Back + Select buttons. Lazy-creates the
 * FolderPicker on first show — needs a token, which lives in a Promise the
 * form panel preloads — and reuses it across re-entries so the user's
 * expansion + selection state persists.
 *
 * Returns:
 *   { root, prepare(getTokenPromise), reset() }
 *
 * `prepare(getTokenPromise)` is called every time the user slides into the
 * panel: it ensures the FolderPicker is mounted with a live token and
 * re-evaluates the Select button's enabled state. The first call performs
 * the actual token-fetch + FolderPicker construction; subsequent calls
 * just re-sync button state.
 *
 * @param {{
 *   onBack:   () => void,
 *   onSelect: (args: { folderId: string, name: string, fullPath: string }) => void
 * }} handlers
 */
function _buildFolderPanel(handlers)
{
    const root = document.createElement("section");
    root.className = "publish-panel publish-panel-folder";

    const heading = document.createElement("h2");
    heading.className = "publish-heading";
    heading.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.folder.heading",
        "Choose a Google Drive folder");
    root.appendChild(heading);

    const mount = document.createElement("div");
    mount.className = "publish-folder-mount";
    root.appendChild(mount);

    const footer = document.createElement("div");
    footer.className = "publish-footer";
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "mps-btn-secondary";
    backBtn.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.folder.back", "Back");
    backBtn.addEventListener("click", () => handlers.onBack());

    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.className = "mps-btn-primary";
    selectBtn.textContent = t(
        "mangaplay-studio.googleDocsSync.publish.folder.select", "Select");
    selectBtn.disabled = true;

    footer.appendChild(backBtn);
    footer.appendChild(selectBtn);
    root.appendChild(footer);

    /** @type {FolderPicker|null} */
    let picker = null;
    /** @type {{ folderId: string, name: string, fullPath: string }|null} */
    let pending = null;

    selectBtn.addEventListener("click", () =>
    {
        if (!pending) return;
        handlers.onSelect(pending);
    });

    /**
     * Ensure the FolderPicker is mounted (once) and the Select button
     * reflects the current selection. Called by the outer modal each time
     * it slides into this panel.
     *
     * @param {() => (Promise<string|null> | null)} getTokenPromise
     */
    async function prepare(getTokenPromise)
    {
        if (picker)
        {
            // Re-entry — picker remembers selection; just re-sync Select.
            const id = picker.getSelectedId();
            selectBtn.disabled = !id;
            return;
        }
        const tp = getTokenPromise && getTokenPromise();
        const tok = tp ? await tp : null;
        if (!tok)
        {
            mount.textContent = t(
                "mangaplay-studio.googleDocsSync.publish.errors.tokenExpired",
                "Your Google sign-in needs renewing.");
            return;
        }
        picker = new FolderPicker(mount, {
            driveClient: driveClientApi,
            token: tok,
            t,
            onSelect: (folderId, name, fullPath) =>
            {
                pending = { folderId, name, fullPath };
                selectBtn.disabled = false;
            }
        });
    }

    function reset()
    {
        if (picker)
        {
            picker.clearSelection();
        }
        pending = null;
        selectBtn.disabled = true;
    }

    return { root, prepare, reset };
}

/**
 * Stub auth client used when callers don't supply one. Always returns null
 * so preflight surfaces the sign-in panel cleanly.
 *
 * The real desktop wiring (Phase 3+) passes a concrete authClient sourced
 * from `src/auth/google-oauth.js` via the menu onSelect in app.js.
 */
function _stubAuthClient()
{
    return {
        async getAccessToken() { return null; }
    };
}
