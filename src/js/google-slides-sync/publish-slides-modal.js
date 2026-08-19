// @ts-check
/**
 * publish-slides-modal.js — "Publish to Google Slides™" modal.
 *
 * Slots: picker / form / summary. Only the Sync flow is shipped —
 * user picks a Google Slides deck from Drive, we fetch it, prepare a
 * report, and land on Summary for confirmation before writing the link.
 *
 * The picker's "Publish Google Slides" card renders a Coming Soon page.
 * The Sync card runs the full pick → prepare → summary → link flow.
 */

import { invoke } from "@tauri-apps/api/core";
import { icon } from "../panes/icons.js";
import { openModal, setModalBusy } from "../modals/modal-shell.js";
import { t } from "../adapters/tauri-i18n.js";
import { slidesLinkGet } from "../adapters/tauri-storage.js";
import { getStoredEmail, mergePickerTokens } from "../auth/google-oauth.js";
import { renderPageToPng } from "./render-page-to-png.js";
import { uploadPngsViaJsTransport } from "./slides-upload-transport.js";
import { withPublishLock } from "./publish-lock.js";
import { isDevBuild } from "../adapters/platform-capabilities.js";
import {
    _buildPickerPanel,
    _buildUpdatePanel,
    _buildUpdateStoryPanel,
    _buildUpdateStoryboardPanel,
} from "./publish-slides-modal-panels.js";
import {
    _fetchDeckName,
    _buildFormPanel,
} from "./publish-slides-modal-forms.js";
import {
    _buildSummaryPanel,
    _buildProgressPanel,
} from "./publish-slides-modal-summary.js";

/**
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
 * Open the Publish Slides modal.
 *
 * @param {{
 *   script?: any,
 *   scriptFormat?: "mangaplay"|"fountain"|"superscript"|"general-text"|string,
 *   sourceText?: string,
 *   basename?: string,
 *   localPath?: string,
 *   projectId?: string,
 *   projectPath?: string,
 *   scriptRelPath?: string,
 *   userName?: string,
 *   clientId?: string,
 *   publishScope?: {
 *     kind: "file",
 *     activeFileUuid: string,
 *     basename: string,
 *     pageCount: number,
 *   } | {
 *     kind: "folder",
 *     folderUuid: string,
 *     folderName: string,
 *     fileUuids: string[],
 *     activeFileUuid: string,
 *     fileCount: number,
 *     pageCount: number,
 *   },
 *   authClient?: { getAccessToken: (opts?: { allowRefresh?: boolean }) => Promise<string|null> }
 * }} ctx
 * @returns {Promise<null>}
 */
export async function openPublishSlidesModal(ctx)
{
    // Release-build gate — until Slides sync ships, all entry points land
    // on a single Coming-Soon card. Pill click behaviour is unchanged
    // (`no-account` still prompts sign-in) — this only fires when execution
    // actually reaches the modal opener. Dev builds fall through to the
    // real flow below.
    if (!isDevBuild())
    {
        return _openComingSoonModal();
    }
    console.warn(`[slides-modal] ═══════════════════════════════════════════════════════════════`);
    console.warn(`[slides-modal] EXPECTED FLOW (fresh project, signed in, Sync Existing Slides):`);
    console.warn(`[slides-modal]   1. openPublishSlidesModal()`);
    console.warn(`[slides-modal]   2. slides_link_get returns null (no existing link)`);
    console.warn(`[slides-modal]   3. preflight START → token PRESENT → NO_LINK branch → stays on picker panel`);
    console.warn(`[slides-modal]   4. USER clicks "Sync Existing Slides" card → setIntent(→import) → setPanel(picker → form)`);
    console.warn(`[slides-modal]   5. USER clicks "Choose from Google Drive™" pickBtn`);
    console.warn(`[slides-modal]   6. pickFile() → SYSTEM BROWSER opens with Google Picker`);
    console.warn(`[slides-modal]   7. USER picks a Slides file in browser → pickFile RESOLVES with { fileId, token }`);
    console.warn(`[slides-modal]   8. _runPrepare() → getPresentation() → prepareSlidesSync() → report`);
    console.warn(`[slides-modal]   9. onPrepared() → setReport() → setPanel(form → summary)`);
    console.warn(`[slides-modal] Only 3 slots exist: picker, form, summary. Publish card is a Coming Soon page.`);
    console.warn(`[slides-modal] ═══════════════════════════════════════════════════════════════`);
    console.warn(`[slides-modal] openPublishSlidesModal() called — basename="${ctx.basename}" scriptRelPath="${ctx.scriptRelPath}" projectPath="${ctx.projectPath}"`);
    const stem = stemFor(ctx.basename || "Untitled");
    const initialValues = _initialValues(ctx, stem);
    const authClient = ctx.authClient || _stubAuthClient();

    /** @type {string|null} */
    let existingLinkedPresentationId = null;
    /** @type {"folder"|"file"|null} — which registry entry slides_link_get resolved to. */
    let existingLinkedScope = null;
    try
    {
        if (ctx.projectPath && ctx.scriptRelPath)
        {
            const link = await slidesLinkGet({
                projectPath:   ctx.projectPath,
                scriptRelPath: ctx.scriptRelPath,
                folderUuid:    ctx.publishScope?.kind === "folder"
                    ? ctx.publishScope.folderUuid
                    : null,
            });
            console.warn(`[slides-modal] slides_link_get returned: ${JSON.stringify(link)}`);
            if (link && typeof (/** @type {any} */ (link).presentationId) === "string")
            {
                existingLinkedPresentationId = /** @type {any} */ (link).presentationId;
                const rawScope = /** @type {any} */ (link).scope;
                if (rawScope === "folder" || rawScope === "file")
                {
                    existingLinkedScope = rawScope;
                }
                console.warn(`[slides-modal] existingLinkedPresentationId=${existingLinkedPresentationId} scope=${existingLinkedScope} — WILL go straight to form with preset URL`);
            }
            else
            {
                console.warn(`[slides-modal] no existing link — will go to picker panel after preflight`);
            }
        }
        else
        {
            console.warn(`[slides-modal] ctx.projectPath or scriptRelPath missing — skipping slides_link_get`);
        }
    }
    catch (e)
    {
        console.warn(`[slides-modal] slides_link_get FAILED: ${(/** @type {any} */ (e))?.message || e}`);
    }

    return openModal({
        variantClass: "publish-modal-backdrop",
        cancelValue: null,
        build: ({ backdrop, resolveWith: rawResolveWith, cancel: rawCancel }) =>
        {
            /** @type {(v: any) => void} */
            const resolveWith = (v) => { rawResolveWith(v); };
            const cancel = () => { rawCancel(); };

            const dialog = document.createElement("div");
            dialog.className = "settings-dialog publish-modal publish-modal-slides";
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            const modalTitle = t(
                "mangaplay-studio.googleSlidesSync.publish.modalTitle",
                "Publish to Google Slides™");
            dialog.setAttribute("aria-label", modalTitle);

            // ── Titlebar ───────────────────────────────────────────────
            const titlebar = document.createElement("div");
            titlebar.className = "settings-titlebar publish-titlebar";
            const titleText = document.createElement("div");
            titleText.className = "publish-title";
            titleText.textContent = modalTitle;
            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className = "settings-close";
            closeBtn.setAttribute("aria-label",
                t("mangaplay-studio.googleSlidesSync.publish.close", "Close"));
            closeBtn.insertAdjacentHTML("afterbegin", icon("x", { size: 16 }));
            closeBtn.addEventListener("click", () => cancel());
            titlebar.appendChild(titleText);
            titlebar.appendChild(closeBtn);

            // ── Track + five panels ────────────────────────────────────
            const track = document.createElement("div");
            track.className = "publish-track";
            track.dataset.panel = "picker";

            const PANEL_ORDER = ["picker", "update", "updateStory", "updateStoryboard", "form", "summary", "progress"];
            /**
             * @param {"picker"|"update"|"updateStory"|"updateStoryboard"|"form"|"summary"|"progress"} name
             */
            const setPanel = (name) =>
            {
                const prev = track.dataset.panel;
                track.dataset.panel = name;
                /** @type {Record<string, HTMLElement>} */
                const roots = {
                    picker:           panelPicker.root,
                    update:           panelUpdate.root,
                    updateStory:      panelUpdateStory.root,
                    updateStoryboard: panelUpdateStoryboard.root,
                    form:             panelForm.root,
                    summary:          panelSummary.root,
                    progress:         panelProgress.root,
                };
                const prevEl = /** @type {HTMLElement|null} */ (prev ? roots[prev] : null);
                const nextEl = roots[name];
                if (!nextEl) return;

                if (!prevEl || prev === name)
                {
                    for (const key of PANEL_ORDER)
                    {
                        const el = roots[key];
                        if (!el) continue;
                        el.classList.remove("is-active", "is-leaving-left", "is-leaving-right", "is-entering-left");
                        el.hidden = (key !== name);
                        if (key === name) el.classList.add("is-active");
                    }
                    _logModalState(`setPanel(${prev} → ${name})`, track, initialValues);
                    return;
                }

                const prevIndex = PANEL_ORDER.indexOf(prev);
                const nextIndex = PANEL_ORDER.indexOf(name);
                const forward = nextIndex > prevIndex;

                for (const key of PANEL_ORDER)
                {
                    const el = roots[key];
                    if (!el) continue;
                    if (key !== prev && key !== name)
                    {
                        el.classList.remove("is-active", "is-leaving-left", "is-leaving-right", "is-entering-left");
                        el.hidden = true;
                    }
                }

                nextEl.hidden = false;
                nextEl.classList.remove("is-active", "is-leaving-left", "is-leaving-right");
                if (forward)
                {
                    nextEl.classList.remove("is-entering-left");
                }
                else
                {
                    nextEl.classList.add("is-entering-left");
                }

                // Force layout so the browser paints the start state before the transition.
                void nextEl.offsetWidth;

                requestAnimationFrame(() =>
                {
                    nextEl.classList.remove("is-entering-left");
                    nextEl.classList.add("is-active");

                    prevEl.classList.remove("is-active");
                    prevEl.classList.add(forward ? "is-leaving-left" : "is-leaving-right");

                    /** @param {TransitionEvent} ev */
                    const onEnd = (ev) =>
                    {
                        if (ev.propertyName !== "transform") return;
                        prevEl.removeEventListener("transitionend", onEnd);
                        prevEl.classList.remove("is-leaving-left", "is-leaving-right");
                        prevEl.hidden = true;
                    };
                    prevEl.addEventListener("transitionend", onEnd);
                    setTimeout(() =>
                    {
                        prevEl.removeEventListener("transitionend", onEnd);
                        if (!prevEl.classList.contains("is-active"))
                        {
                            prevEl.classList.remove("is-leaving-left", "is-leaving-right");
                            prevEl.hidden = true;
                        }
                    }, 400);
                });

                _logModalState(`setPanel(${prev} → ${name})`, track, initialValues);
            };

            const panelPicker = _buildPickerPanel({
                onPublish: () =>
                {
                    console.warn(`[slides-modal] picker card CLICKED: Publish (create new deck)`);
                    initialValues.intent = "publish";
                    panelForm.setIntent("publish");
                    setPanel("form");
                },
                onImport: () =>
                {
                    console.warn(`[slides-modal] picker card CLICKED: Sync Existing Slides — transitioning to form panel with sync sub-panel visible`);
                    initialValues.intent = "import";
                    panelForm.setIntent("import");
                    setPanel("form");
                }
            });

            // Update panel — landed on when preflight detects an existing
            // link. Three cards: Update Story / Update Storyboard / Unlink.
            const panelUpdate = _buildUpdatePanel({
                onUpdateStory:      () =>
                {
                    setPanel("updateStory");
                    // Fire the prepare pass AFTER the slide-in starts so
                    // the panel is visible while the "Reading deck…" line
                    // shows. Non-blocking; the panel manages its own UI.
                    void panelUpdateStory.onEnter();
                },
                onUpdateStoryboard: () =>
                {
                    setPanel("updateStoryboard");
                    panelUpdateStoryboard.onEnter();
                },
                onBack:             () => setPanel("picker"),
                onUnlink:           () => { void _runUnlinkFlow(); },
            });

            const panelUpdateStory = _buildUpdateStoryPanel({
                onBack:  () => setPanel("update"),
                onOkay:  (prepareResult) =>
                {
                    void _runUpdateStoryCommit(prepareResult);
                },
                runPrepare: async () =>
                {
                    if (!existingLinkedPresentationId) throw new Error("no-link");
                    const token = await authClient.getAccessToken({ allowRefresh: true });
                    if (!token)
                    {
                        const err = new Error("no-token");
                        /** @type {any} */ (err).kind = "auth";
                        throw err;
                    }
                    const { getPresentation } = await import("./slides-api.js");
                    const { presentation, refreshedAt } = await getPresentation(
                        existingLinkedPresentationId, token);
                    const { prepareSlidesSync } = await import("./slides-prepare.js");
                    const report = await prepareSlidesSync({
                        presentation,
                        refreshedAt,
                        presentationId: existingLinkedPresentationId,
                        script:         ctx.script,
                        projectPath:    ctx.projectPath,
                        authClient,
                    });
                    return { report, presentation, presentationId: existingLinkedPresentationId };
                },
            });

            // Update-Storyboard panel — desktop-only for now. Mobile paths
            // (Android SAF / iOS multi-file) land in Task 2e; the panel
            // itself renders a "not yet available" message when platform
            // detection returns android/ios.
            const panelUpdateStoryboard = _buildUpdateStoryboardPanel({
                onBack:  () => setPanel("update"),
                getScript:      () => ctx.script,
                getProjectPath: () => ctx.projectPath,
                getPresentationId: () => existingLinkedPresentationId,
                getAuthClient:     () => authClient,
                getCtx:            () => ctx,
                getProgressPanel:  () => panelProgress,
                slideToProgress:   () => setPanel("progress"),
                resolveWithNull:   () => resolveWith(null),
                onImported: (payload) =>
                {
                    try
                    {
                        if (typeof (/** @type {any} */ (ctx).onStoryboardImported) === "function")
                        {
                            (/** @type {any} */ (ctx).onStoryboardImported)(payload);
                        }
                    }
                    catch (e)
                    {
                        console.warn("[slides-modal] onStoryboardImported hook threw:",
                            /** @type {any} */ (e)?.message || e);
                    }
                },
                onSlidesPushed: (payload) =>
                {
                    try
                    {
                        if (typeof (/** @type {any} */ (ctx).onSlidesPushed) === "function")
                        {
                            (/** @type {any} */ (ctx).onSlidesPushed)(payload);
                        }
                    }
                    catch (e)
                    {
                        console.warn("[slides-modal] onSlidesPushed hook threw:",
                            /** @type {any} */ (e)?.message || e);
                    }
                },
            });

            /**
             * Shared commit runner — replicates the summary-panel Accept
             * flow but with `skipImagesStep: true` and a fixed
             * `mismatchPolicy: "use-local"`. Update-Story pushes local text
             * to the deck; images are already known-current.
             *
             * @param {{ report: any, presentation: any, presentationId: string }} prep
             */
            async function _runUpdateStoryCommit(prep)
            {
                const { report, presentation, presentationId } = prep;

                // Publish lock — acquired via `withPublishLock` helper so
                // the acquire/heartbeat/release dance is uniform across the
                // three publish call sites. Throws distinguish `lock-held`
                // (another holder owns the lease) from `lock-acquire-failed`
                // (the IPC itself threw — network / Rust panic).
                try
                {
                    await withPublishLock({
                        projectPath:    ctx.projectPath,
                        presentationId,
                    }, async () =>
                    {
                        panelProgress.setLabelsForPublish();
                        panelProgress.reset();
                        panelProgress.setHeadingForContext(ctx);
                        setPanel("progress");
                        commitAbortCtrl = new AbortController();
                        panelProgress.setOnCancel(() =>
                        {
                            if (commitAbortCtrl)
                            {
                                try { commitAbortCtrl.abort(); }
                                catch (_) { /* best-effort */ }
                            }
                        });

                        setModalBusy(true);
                        closeBtn.disabled = true;
                        closeBtn.setAttribute("aria-disabled", "true");
                        panelProgress.setWarningVisible(true);

                        try
                        {
                            const { runCommit } = await import("./slides-prepare.js");
                            const result = await runCommit({
                                report,
                                script:         ctx.script,
                                presentation,
                                presentationId,
                                mismatchPolicy: "use-local",
                                skipImagesStep: true,
                                projectPath:    ctx.projectPath,
                                authClient,
                                signal:         commitAbortCtrl.signal,
                                renderPageToPng: (pageId) => renderPageToPng({
                                    pageId,
                                    scriptAST:      ctx.script,
                                    projectPath:    ctx.projectPath,
                                    presentationId,
                                }),
                                onStep: (i, ev) => panelProgress.onStepEvent(i, ev),
                                onSaveLink: async () =>
                                {
                                    const status = (report && Array.isArray(report.warnings)
                                        && report.warnings.length > 0)
                                            ? "with-warnings"
                                            : "clean";
                                    // Capture Drive headRevisionId so the background
                                    // sync-status check can compare on next open.
                                    let revisionId = null;
                                    try
                                    {
                                        const { getHeadRevisionId } =
                                            await import("./slides-api.js");
                                        const token = await ctx.authClient?.getAccessToken?.({ allowRefresh: true });
                                        if (token)
                                        {
                                            revisionId = await getHeadRevisionId(presentationId, token);
                                        }
                                    }
                                    catch (_) { /* best-effort — link saves even without revisionId */ }
                                    await invoke("slides_link_save", {
                                        projectPath:    ctx.projectPath,
                                        scriptRelPath:  ctx.scriptRelPath,
                                        presentationId,
                                        prepareStatus:  status,
                                        folderUuid:     ctx.publishScope?.kind === "folder"
                                            ? ctx.publishScope.folderUuid
                                            : null,
                                        revisionId,
                                    });
                                },
                                onRefreshPill: async () =>
                                {
                                    try
                                    {
                                        if (typeof (/** @type {any} */ (ctx).onLinked) === "function")
                                        {
                                            await (/** @type {any} */ (ctx).onLinked)({
                                                presentationId,
                                                folderUuid: ctx.publishScope?.kind === "folder"
                                                    ? ctx.publishScope.folderUuid
                                                    : null,
                                            });
                                        }
                                    }
                                    catch (e)
                                    {
                                        console.warn("[publish-slides] onLinked hook threw:",
                                            /** @type {any} */ (e)?.message || e);
                                    }
                                },
                            });
                            panelProgress.setDone({
                                ok:       result.ok,
                                warnings: report.warnings || [],
                                onClose:  () => { resolveWith(null); },
                            });
                        }
                        catch (e)
                        {
                            console.warn("[publish-slides] runCommit (update-story) failed:",
                                /** @type {any} */ (e)?.message || e);
                            panelProgress.setDone({
                                ok:       false,
                                warnings: report?.warnings || [],
                                onClose:  () => { resolveWith(null); },
                            });
                        }
                        finally
                        {
                            commitAbortCtrl = null;
                            setModalBusy(false);
                            closeBtn.disabled = false;
                            closeBtn.removeAttribute("aria-disabled");
                            panelProgress.setWarningVisible(false);
                        }
                    });
                }
                catch (e)
                {
                    if (e && /** @type {any} */ (e).kind === "lock-held")
                    {
                        const other = /** @type {any} */ (e).holder?.holderId || "another window";
                        panelUpdateStory.showError(t(
                            "mangaplay-studio.googleSlidesSync.publish.summary.commit.lockHeld",
                            "Another publish is in progress ({holder}). Try again in a moment.",
                            { holder: String(other) }));
                    }
                    else if (e && /** @type {any} */ (e).kind === "lock-acquire-failed")
                    {
                        console.warn("[publish-slides] publish lock acquire failed:",
                            /** @type {any} */ (e).cause);
                        panelUpdateStory.showError(t(
                            "mangaplay-studio.googleSlidesSync.publish.summary.commit.lockAcquireFailed",
                            "Couldn't get exclusive access to the deck. Try again."));
                    }
                    else
                    {
                        throw e;
                    }
                }
            }

            /**
             * Unlink flow: confirm → drop the scope-aware link → best-effort
             * delete of the cached deck PNGs → back to the picker panel.
             * Scope for the confirm copy comes from `existingLinkedScope`
             * — the discriminator returned by `slidesLinkGet` in preflight,
             * i.e. which registry entry actually resolved. A file that
             * lives inside a Storyboard Folder but only has a file-scope
             * link resolves to "file", so the confirm reads as file-scope
             * even though `ctx.publishScope.kind === "folder"`.
             */
            async function _runUnlinkFlow()
            {
                if (!existingLinkedPresentationId || !ctx.projectPath) return;

                const isFolderScope = existingLinkedScope === "folder";
                const folderName = isFolderScope
                    ? (ctx.publishScope?.folderName
                        || t("mangaplay-studio.googleSlidesSync.publish.update.unlinkConfirm.folderNameFallback",
                            "this folder"))
                    : "";

                const body = isFolderScope
                    ? t("mangaplay-studio.googleSlidesSync.publish.update.unlinkConfirm.folder",
                        "Unlink this deck? All files under the folder {folderName} will be unlinked. Local files are kept.",
                        { folderName })
                    : t("mangaplay-studio.googleSlidesSync.publish.update.unlinkConfirm.file",
                        "Unlink this deck? Local files are kept; the link to Google Slides will be removed.");

                const { confirmModal } = await import("../modals/confirm-modal.js");
                const ok = await confirmModal({
                    title: t("mangaplay-studio.googleSlidesSync.publish.update.unlinkConfirm.title", "Unlink deck"),
                    body,
                    confirm: t("mangaplay-studio.googleSlidesSync.publish.update.unlinkConfirm.confirmBtn", "Unlink"),
                    cancel: t("mangaplay-studio.googleSlidesSync.publish.update.unlinkConfirm.cancelBtn", "Cancel"),
                    danger: true,
                });
                if (!ok) return;

                const presentationId = existingLinkedPresentationId;
                setModalBusy(true);
                closeBtn.disabled = true;
                closeBtn.setAttribute("aria-disabled", "true");
                try
                {
                    try
                    {
                        const dropResult = await invoke("slides_link_drop_scoped", {
                            projectPath:   ctx.projectPath,
                            scriptRelPath: ctx.scriptRelPath,
                            folderUuid:    isFolderScope ? ctx.publishScope?.folderUuid : null,
                        });
                        console.warn(`[slides-modal] slides_link_drop_scoped result: ${JSON.stringify(dropResult)}`);
                    }
                    catch (e)
                    {
                        console.warn("[slides-modal] slides_link_drop_scoped failed:",
                            /** @type {any} */ (e)?.message || e);
                        // Even if the link drop fails, do not proceed to
                        // deck delete — the user will retry.
                        return;
                    }

                    try
                    {
                        const delResult = await invoke("slides_deck_delete", {
                            projectPath:    ctx.projectPath,
                            presentationId,
                        });
                        console.warn(`[slides-modal] slides_deck_delete result: ${JSON.stringify(delResult)}`);
                    }
                    catch (e)
                    {
                        // Best-effort — the link is already dropped. Deck
                        // PNGs get GCed on the next open.
                        console.warn("[slides-modal] slides_deck_delete failed (best-effort, continuing):",
                            /** @type {any} */ (e)?.message || e);
                    }

                    existingLinkedPresentationId = null;
                    try
                    {
                        if (typeof (/** @type {any} */ (ctx).onUnlinked) === "function")
                        {
                            await (/** @type {any} */ (ctx).onUnlinked)({
                                presentationId,
                                folderUuid: isFolderScope ? ctx.publishScope?.folderUuid : null,
                            });
                        }
                    }
                    catch (e)
                    {
                        console.warn("[slides-modal] onUnlinked hook threw:",
                            /** @type {any} */ (e)?.message || e);
                    }
                    setPanel("picker");
                }
                finally
                {
                    setModalBusy(false);
                    closeBtn.disabled = false;
                    closeBtn.removeAttribute("aria-disabled");
                }
            }
            const panelForm = _buildFormPanel(initialValues, {
                authClient,
                ctx,
                onClose: () => cancel(),
                onBack:  () => setPanel("picker"),
                onPrepared: (report, presentationId, presentation) =>
                {
                    console.warn(`[slides-modal] onPrepared() called — presentationId=${presentationId} report.deckPages=${JSON.stringify(report?.deckPages)?.slice(0, 100)} report.localPages=${JSON.stringify(report?.localPages)?.slice(0, 100)} imagesFound=${report?.imagesFound} imagesToDownload=${report?.imagesToDownload} warnings=${report?.warnings?.length || 0}`);
                    panelSummary.setReport(
                        report,
                        report.presentationTitle || "",
                        ctx.basename || "",
                        ctx.publishScope || null);
                    panelSummary.__lastReport = report;
                    panelSummary.__presentationId = presentationId;
                    panelSummary.__presentation = presentation;
                    setPanel("summary");
                }
            });
            /** @type {AbortController|null} */
            let commitAbortCtrl = null;

            const panelSummary = _buildSummaryPanel({
                onCancel: () => cancel(),
                onBack:   () => setPanel("form"),
                onAccept: async ({ mismatchPolicy }) =>
                {
                    const report = panelSummary.__lastReport;
                    const presentationId = panelSummary.__presentationId;
                    const presentation = panelSummary.__presentation;

                    // Acquire the publish lock before ANY commit runs.
                    // Blocks concurrent publishes from a second window /
                    // device against the same presentation. The helper
                    // handles acquire → heartbeat → release; distinct
                    // throw kinds surface `lock-held` vs `lock-acquire-failed`.
                    try
                    {
                        await withPublishLock({
                            projectPath:    ctx.projectPath,
                            presentationId,
                        }, async () =>
                        {

                    // Transition into the progress panel BEFORE any Slides
                    // network I/O — the user sees the 5-step timeline
                    // immediately, with step 1 flipping to running as the
                    // first download starts.
                    panelProgress.setLabelsForPublish();
                    panelProgress.reset();
                    panelProgress.setHeadingForContext(ctx);
                    setPanel("progress");
                    commitAbortCtrl = new AbortController();
                    panelProgress.setOnCancel(() =>
                    {
                        if (commitAbortCtrl)
                        {
                            try { commitAbortCtrl.abort(); }
                            catch (_) { /* best-effort */ }
                        }
                    });

                    // Busy window covers the full runCommit promise —
                    // backdrop-click / Escape / close-X are all gated so a
                    // stray input can't abort a mid-download. The in-panel
                    // Cancel button remains the only exit.
                    setModalBusy(true);
                    closeBtn.disabled = true;
                    closeBtn.setAttribute("aria-disabled", "true");
                    panelProgress.setWarningVisible(true);

                    try
                    {
                        const { runCommit } = await import("./slides-prepare.js");
                        const result = await runCommit({
                            report,
                            script:         ctx.script,
                            presentation,
                            presentationId,
                            mismatchPolicy,
                            projectPath:    ctx.projectPath,
                            authClient,
                            signal:         commitAbortCtrl.signal,
                            onStep: (i, ev) => panelProgress.onStepEvent(i, ev),
                            onSaveLink: async () =>
                            {
                                const status = (report && Array.isArray(report.warnings)
                                    && report.warnings.length > 0)
                                        ? "with-warnings"
                                        : "clean";
                                // mismatchPolicy is a per-publish user choice — NOT
                                // persisted. The user picks it fresh every time they
                                // publish/sync so they consciously reconcile each run.
                                // Capture Drive headRevisionId so the background
                                // sync-status check can compare on next open.
                                let revisionId = null;
                                try
                                {
                                    const { getHeadRevisionId } =
                                        await import("./slides-api.js");
                                    const token = await ctx.authClient?.getAccessToken?.({ allowRefresh: true });
                                    if (token)
                                    {
                                        revisionId = await getHeadRevisionId(presentationId, token);
                                    }
                                }
                                catch (_) { /* best-effort — link saves even without revisionId */ }
                                await invoke("slides_link_save", {
                                    projectPath:    ctx.projectPath,
                                    scriptRelPath:  ctx.scriptRelPath,
                                    presentationId: presentationId,
                                    prepareStatus:  status,
                                    folderUuid:     ctx.publishScope?.kind === "folder"
                                        ? ctx.publishScope.folderUuid
                                        : null,
                                    revisionId,
                                });
                            },
                            onRefreshPill: async () =>
                            {
                                // Best-effort in-memory pill refresh so the
                                // linked-indicator lights up immediately
                                // instead of waiting for the next slot
                                // activation. Any consumer of the modal
                                // that wires `ctx.onLinked` gets a callback
                                // with the just-saved presentation id.
                                try
                                {
                                    if (typeof (/** @type {any} */ (ctx).onLinked) === "function")
                                    {
                                        await (/** @type {any} */ (ctx).onLinked)({
                                            presentationId,
                                            folderUuid: ctx.publishScope?.kind === "folder"
                                                ? ctx.publishScope.folderUuid
                                                : null,
                                        });
                                    }
                                }
                                catch (e)
                                {
                                    console.warn("[publish-slides] onLinked hook threw:",
                                        /** @type {any} */ (e)?.message || e);
                                }
                            },
                        });
                        panelProgress.setDone({
                            ok:       result.ok,
                            warnings: report.warnings || [],
                            onClose:  () => { resolveWith(null); },
                        });
                    }
                    catch (e)
                    {
                        console.warn("[publish-slides] runCommit failed:",
                            /** @type {any} */ (e)?.message || e);
                        panelProgress.setDone({
                            ok:       false,
                            warnings: report?.warnings || [],
                            onClose:  () => { resolveWith(null); },
                        });
                    }
                    finally
                    {
                        commitAbortCtrl = null;
                        setModalBusy(false);
                        closeBtn.disabled = false;
                        closeBtn.removeAttribute("aria-disabled");
                        panelProgress.setWarningVisible(false);
                    }

                        });
                    }
                    catch (e)
                    {
                        if (e && /** @type {any} */ (e).kind === "lock-held")
                        {
                            const other = /** @type {any} */ (e).holder?.holderId || "another window";
                            panelSummary.setCaption?.(t(
                                "mangaplay-studio.googleSlidesSync.publish.summary.commit.lockHeld",
                                "Another publish is in progress ({holder}). Try again in a moment.",
                                { holder: String(other) }), "err");
                        }
                        else if (e && /** @type {any} */ (e).kind === "lock-acquire-failed")
                        {
                            console.warn("[publish-slides] publish lock acquire failed:",
                                /** @type {any} */ (e).cause);
                            panelSummary.setCaption?.(t(
                                "mangaplay-studio.googleSlidesSync.publish.summary.commit.lockAcquireFailed",
                                "Couldn't get exclusive access to the deck. Try again."), "err");
                        }
                        else
                        {
                            throw e;
                        }
                    }
                }
            });

            const panelProgress = _buildProgressPanel({
                onCancel: () =>
                {
                    if (commitAbortCtrl)
                    {
                        try { commitAbortCtrl.abort(); }
                        catch (_) { /* best-effort */ }
                    }
                },
                onClose: () => { resolveWith(null); },
            });

            track.appendChild(panelPicker.root);
            track.appendChild(panelUpdate.root);
            track.appendChild(panelUpdateStory.root);
            track.appendChild(panelUpdateStoryboard.root);
            track.appendChild(panelForm.root);
            track.appendChild(panelSummary.root);
            track.appendChild(panelProgress.root);

            panelPicker.root.hidden = false;
            panelUpdate.root.hidden = true;
            panelUpdateStory.root.hidden = true;
            panelUpdateStoryboard.root.hidden = true;
            panelForm.root.hidden = true;
            panelSummary.root.hidden = true;
            panelProgress.root.hidden = true;
            panelPicker.root.classList.add("is-active");

            dialog.appendChild(titlebar);
            dialog.appendChild(track);
            backdrop.appendChild(dialog);

            // ── Preflight gate ─────────────────────────────────────────
            (async () =>
            {
                console.warn(`[slides-modal] preflight START — calling authClient.getAccessToken(allowRefresh=true)`);
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
                const wait = Math.max(0, 300 - (performance.now() - t0));
                if (wait > 0) await new Promise((r) => setTimeout(r, wait));

                console.warn(`[slides-modal] preflight SETTLED — token=${token ? "PRESENT" : "NULL"} existingLinkedPresentationId=${existingLinkedPresentationId || "null"}`);

                if (token && existingLinkedPresentationId)
                {
                    console.warn(`[slides-modal] preflight branch: HAS_LINK — going to update panel for id=${existingLinkedPresentationId}`);
                    panelUpdate.setPresentationId(existingLinkedPresentationId);
                    // Best-effort deck-name fetch — panel mounts immediately
                    // with "Currently linked"; the name lands when it arrives.
                    (async () =>
                    {
                        try
                        {
                            const nameToken = await authClient.getAccessToken({ allowRefresh: true });
                            if (!nameToken) return;
                            const name = await _fetchDeckName(existingLinkedPresentationId, nameToken);
                            if (name) panelUpdate.setDeckName(name);
                        }
                        catch (e)
                        {
                            console.warn("[slides-modal] deck-name fetch failed:",
                                /** @type {any} */ (e)?.message || e);
                        }
                    })();
                    setPanel("update");
                }
                else
                {
                    // NO_LINK (with or without token). Land on picker panel —
                    // the picker button's OAuth round-trip doubles as sign-in
                    // when no prior token exists, so no separate gate needed.
                    console.warn(`[slides-modal] preflight branch: NO_LINK — going to picker panel (token=${token ? "PRESENT" : "NULL"})`);
                    setPanel("picker");
                    if (preflightErr)
                    {
                        console.warn("[publish-slides-modal] preflight getAccessToken threw:", preflightErr);
                    }
                }
            })();

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
        intent: /** @type {"publish"|"import"} */ ("publish"),
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
 * Release-build gate — collapses the entire Publish Slides modal to a
 * single Coming-Soon card. Reuses the existing `.publish-panel` chrome
 * so no new CSS is needed. Resolves with `null` on any dismissal (Close
 * button, backdrop click, Esc) to match the shape of the real
 * `openPublishSlidesModal` return.
 *
 * @returns {Promise<null>}
 */
async function _openComingSoonModal()
{
    await openModal({
        variantClass: "publish-modal-backdrop",
        cancelValue: null,
        build: ({ backdrop, resolveWith, cancel }) =>
        {
            const dialog = document.createElement("div");
            dialog.className = "settings-dialog publish-modal publish-modal-slides";
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            const modalTitle = t(
                "mangaplay-studio.googleSlidesSync.publish.modalTitle",
                "Publish to Google Slides™");
            dialog.setAttribute("aria-label", modalTitle);

            // Titlebar — matches the real modal's structure.
            const titlebar = document.createElement("div");
            titlebar.className = "settings-titlebar publish-titlebar";
            const titleText = document.createElement("div");
            titleText.className = "publish-title";
            titleText.textContent = modalTitle;
            const closeXBtn = document.createElement("button");
            closeXBtn.type = "button";
            closeXBtn.className = "settings-close";
            closeXBtn.setAttribute("aria-label",
                t("mangaplay-studio.googleSlidesSync.publish.close", "Close"));
            closeXBtn.insertAdjacentHTML("afterbegin", icon("x", { size: 16 }));
            closeXBtn.addEventListener("click", () => cancel());
            titlebar.appendChild(titleText);
            titlebar.appendChild(closeXBtn);

            // Track — the .publish-modal-slides .publish-track > .publish-panel
            // selectors in app-modals.css need this exact ancestor chain to
            // apply position/size/transition. Without it the panel collapses
            // to 14.2857% of viewport unstyled.
            const track = document.createElement("div");
            track.className = "publish-track";

            // Single Coming-Soon panel. is-active flips the base off-screen
            // transform (translateX(100%) opacity:0) to the on-screen state.
            const panel = document.createElement("section");
            panel.className = "publish-panel publish-panel-coming-soon is-active";

            // Picker-heading — matches the real picker panel's chrome so the Coming-
            // Soon card reads as "the same kind of panel, minus a second card."
            const heading = document.createElement("h2");
            heading.className = "publish-picker-heading";
            heading.textContent = t(
                "mangaplay-studio.googleSlidesSync.comingSoon.heading",
                "Coming Soon");
            panel.appendChild(heading);

            // Cards row — reused from the real picker so a single card slots into the
            // same flex container. A single .publish-picker-card would stretch to 100%
            // because it's `flex: 1 1 0`; a max-width + margin:auto below keeps it
            // looking like a card, not a wall.
            const cards = document.createElement("div");
            cards.className = "publish-picker-cards publish-picker-cards-coming-soon";

            const card = document.createElement("div");
            card.className = "publish-picker-card publish-picker-card--disabled";

            const image = document.createElement("div");
            image.className = "publish-picker-card-image";
            const img = document.createElement("img");
            img.src = "./img/Google_Slides_logo_(2014-2020).svg";
            img.width = 48;
            img.height = 48;
            img.alt = "";
            image.appendChild(img);
            card.appendChild(image);

            const title = document.createElement("div");
            title.className = "publish-picker-card-title";
            title.textContent = t(
                "mangaplay-studio.googleSlidesSync.comingSoon.cardTitle",
                "Sync coming soon");
            card.appendChild(title);

            const bodyEl = document.createElement("p");
            bodyEl.className = "publish-picker-card-body";
            bodyEl.textContent = t(
                "mangaplay-studio.googleSlidesSync.comingSoon.body",
                "Soon you'll be able to sync a Google Slides™ presentation with a Mangaplay document.");
            card.appendChild(bodyEl);

            cards.appendChild(card);
            panel.appendChild(cards);

            // Footer — Close button on the right, same as the other Slides modal panels.
            const footer = document.createElement("div");
            footer.className = "publish-footer";
            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className = "mps-btn-primary";
            closeBtn.textContent = t(
                "mangaplay-studio.googleSlidesSync.publish.close", "Close");
            closeBtn.addEventListener("click", () => resolveWith(null));
            footer.appendChild(closeBtn);
            panel.appendChild(footer);

            track.appendChild(panel);
            dialog.appendChild(titlebar);
            dialog.appendChild(track);
            backdrop.appendChild(dialog);
        }
    });
    return null;
}
/**
 * Stub auth client used when callers don't supply one. Always returns null
 * so preflight surfaces the sign-in panel cleanly.
 */
function _stubAuthClient()
{
    return {
        async getAccessToken() { return null; }
    };
}

/**
 * Diagnostic log — dumps active panel + visibility of every sub-panel and
 * the current intent. Fires on every `setPanel(...)` call so the test log
 * shows a clean state transition trail. No-ops if console.log is missing.
 *
 * @param {string} label
 * @param {HTMLElement} track
 * @param {any} initialValues
 */
function _logModalState(label, track, initialValues)
{
    try
    {
        const panels = [
            "publish-panel-gate",
            "publish-panel-picker",
            "publish-panel-form",
            "publish-panel-publish-form",
            "publish-panel-sync-form",
            "publish-panel-summary",
        ];
        const snapshot = {};
        for (const cls of panels)
        {
            const el = track.querySelector("." + cls) || document.querySelector("." + cls);
            if (!el) { snapshot[cls] = "MISSING"; continue; }
            const cs = getComputedStyle(el);
            snapshot[cls] = `hidden=${el.hasAttribute("hidden")} display=${cs.display} width=${Math.round(parseFloat(cs.width) || 0)}px`;
        }
        // Use console.warn — the boot.js log forwarder only pipes .warn /
        // .error to Rust, so .log lines wouldn't surface in test stdout.
        console.warn(`[slides-modal] ${label} — activePanel=${track.dataset.panel} intent=${initialValues.intent}`);
        for (const [k, v] of Object.entries(snapshot))
        {
            console.warn(`[slides-modal]   ${k}: ${v}`);
        }
    }
    catch (_) { /* best-effort */ }
}
