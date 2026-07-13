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
import { openModal } from "../modals/modal-shell.js";
import { t } from "../adapters/tauri-i18n.js";
import { getStoredEmail, mergePickerTokens } from "../auth/google-oauth.js";

/**
 * Generate a process-local lock holder id — combined with a random suffix
 * so two windows of the same app don't collide. Consumed by the
 * `slides_publish_lock_*` Tauri commands.
 * @returns {string}
 */
function _makeHolderId()
{
    const rand = Math.random().toString(36).slice(2, 10);
    const ts = Date.now().toString(36);
    return `mps-${ts}-${rand}`;
}

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
    try
    {
        if (ctx.projectPath && ctx.scriptRelPath)
        {
            const link = await invoke("slides_link_get", {
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
                console.warn(`[slides-modal] existingLinkedPresentationId=${existingLinkedPresentationId} — WILL go straight to form with preset URL`);
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

            const PANEL_ORDER = ["picker", "form", "summary", "progress"];
            /**
             * @param {"picker"|"form"|"summary"|"progress"} name
             */
            const setPanel = (name) =>
            {
                const prev = track.dataset.panel;
                track.dataset.panel = name;
                /** @type {Record<string, HTMLElement>} */
                const roots = {
                    picker:   panelPicker.root,
                    form:     panelForm.root,
                    summary:  panelSummary.root,
                    progress: panelProgress.root,
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
                    // device against the same presentation. Released in
                    // the finally-block below.
                    const holderId = _makeHolderId();
                    let locked = false;
                    try
                    {
                        const lock = await invoke("slides_publish_lock_acquire", {
                            projectPath:    ctx.projectPath,
                            presentationId,
                            holderId,
                            ttlMs:          5 * 60_000,
                        });
                        if (lock && lock.ok)
                        {
                            locked = true;
                        }
                        else
                        {
                            const other = lock?.heldBy?.holderId || "another window";
                            panelSummary.setCaption?.(t(
                                "mangaplay-studio.googleSlidesSync.publish.summary.commit.lockHeld",
                                "Another publish is in progress ({holder}). Try again in a moment.",
                                { holder: String(other) }), "err");
                            return;
                        }
                    }
                    catch (e)
                    {
                        console.warn("[publish-slides] slides_publish_lock_acquire failed:",
                            /** @type {any} */ (e)?.message || e);
                        // Best-effort — proceed without a lock rather than
                        // block the user. Contention is rare in practice.
                    }

                    // Transition into the progress panel BEFORE any Slides
                    // network I/O — the user sees the 5-step timeline
                    // immediately, with step 1 flipping to running as the
                    // first download starts.
                    panelProgress.reset();
                    panelProgress.setHeadingForContext(ctx);
                    setPanel("progress");
                    commitAbortCtrl = new AbortController();

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
                                await invoke("slides_link_save", {
                                    projectPath:    ctx.projectPath,
                                    scriptRelPath:  ctx.scriptRelPath,
                                    presentationId: presentationId,
                                    prepareStatus:  status,
                                    folderUuid:     ctx.publishScope?.kind === "folder"
                                        ? ctx.publishScope.folderUuid
                                        : null,
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
                        // Release the publish lock — same holder that
                        // acquired it. If acquire failed above, `locked`
                        // stays false and release is a no-op call.
                        if (locked)
                        {
                            try
                            {
                                await invoke("slides_publish_lock_release", {
                                    projectPath:    ctx.projectPath,
                                    presentationId,
                                    holderId,
                                });
                            }
                            catch (e)
                            {
                                console.warn("[publish-slides] slides_publish_lock_release failed:",
                                    /** @type {any} */ (e)?.message || e);
                            }
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
            track.appendChild(panelForm.root);
            track.appendChild(panelSummary.root);
            track.appendChild(panelProgress.root);

            panelPicker.root.hidden = false;
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
                    console.warn(`[slides-modal] preflight branch: HAS_LINK — going to form with presetImportUrl for id=${existingLinkedPresentationId}`);
                    initialValues.intent = "import";
                    panelForm.setIntent("import");
                    panelForm.presetImportUrl(
                        `https://docs.google.com/presentation/d/${existingLinkedPresentationId}/edit`);
                    setPanel("form");
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
 * Picker panel — two large enabled cards.
 *
 * @param {{
 *   onPublish: () => void,
 *   onImport:  () => void
 * }} handlers
 */
function _buildPickerPanel(handlers)
{
    const root = document.createElement("section");
    root.className = "publish-panel publish-panel-picker";

    const heading = document.createElement("h2");
    heading.className = "publish-picker-heading";
    heading.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.picker.heading",
        "What would you like to do?");
    root.appendChild(heading);

    const cards = document.createElement("div");
    cards.className = "publish-picker-cards";
    root.appendChild(cards);

    const publishCard = _buildPickerCard({
        imageSrc: "./img/google-slides-logo.png",
        titleKey: "mangaplay-studio.googleSlidesSync.publish.picker.publishCard.title",
        titleFallback: "Publish Google Slides™",
        bodyKey: "mangaplay-studio.googleSlidesSync.publish.picker.publishCard.body",
        bodyFallback: "Create a new Google Slides™ presentation from this document.",
        onClick: handlers.onPublish
    });
    cards.appendChild(publishCard);

    const importCard = _buildPickerCard({
        imageSrc: "./img/google-drive-logo.png",
        titleKey: "mangaplay-studio.googleSlidesSync.publish.picker.importCard.title",
        titleFallback: "Sync Existing Slides",
        bodyKey: "mangaplay-studio.googleSlidesSync.publish.picker.importCard.body",
        bodyFallback: "Link this Storyboard & Mangaplay to an existing Google Slides™ presentation.",
        onClick: handlers.onImport
    });
    cards.appendChild(importCard);

    return { root };
}

/**
 * @param {{ imageSrc: string, titleKey: string, titleFallback: string, bodyKey: string, bodyFallback: string, onClick: () => void }} opts
 * @returns {HTMLButtonElement}
 */
function _buildPickerCard({ imageSrc, titleKey, titleFallback, bodyKey, bodyFallback, onClick })
{
    const card = document.createElement("button");
    card.type = "button";
    card.className = "publish-picker-card";

    const image = document.createElement("div");
    image.className = "publish-picker-card-image";
    const img = document.createElement("img");
    img.src = imageSrc;
    img.width = 48;
    img.height = 48;
    img.alt = "";
    image.appendChild(img);
    card.appendChild(image);

    const title = document.createElement("div");
    title.className = "publish-picker-card-title";
    title.textContent = t(titleKey, titleFallback);
    card.appendChild(title);

    const body = document.createElement("p");
    body.className = "publish-picker-card-body";
    body.textContent = t(bodyKey, bodyFallback);
    card.appendChild(body);

    card.addEventListener("click", onClick);
    return card;
}

/**
 * Extract a Google Slides presentation ID from a URL. Accepts any
 * docs.google.com/presentation/d/<ID>[/…] shape. Returns null when the
 * input isn't recognisable. Used by `presetImportUrl` to resolve a
 * previously-linked script's stored URL back into a Drive file id.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function _extractSlidesId(raw)
{
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    if (!s) return null;
    const m = s.match(/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
}

/**
 * Form panel — thin wrapper that mounts both Publish + Sync sub-panels
 * into the shared `form` slot on the track and swaps between them via
 * `setIntent`. Sharing a single builder for both intents was the source
 * of the layout drift the plan refactor addresses; each intent now owns
 * its own builder + its own DOM subtree.
 *
 * @param {ReturnType<typeof _initialValues>} initialValues
 * @param {{
 *   authClient: { getAccessToken: (opts?: { allowRefresh?: boolean }) => Promise<string|null> },
 *   ctx?: any,
 *   onClose: () => void,
 *   onBack: () => void,
 *   onPrepared?: (report: any, presentationId: string) => void
 * }} handlers
 */
function _buildFormPanel(initialValues, handlers)
{
    const root = document.createElement("section");
    root.className = "publish-panel publish-panel-form";

    const publishPanel = _buildPublishFormPanel(handlers);
    const syncPanel = _buildSyncFormPanel(initialValues, handlers);

    root.appendChild(publishPanel.root);
    root.appendChild(syncPanel.root);

    function setIntent(intent)
    {
        const prev = initialValues.intent;
        initialValues.intent = intent;
        const isImport = intent === "import";
        publishPanel.root.hidden = isImport;
        syncPanel.root.hidden = !isImport;
        console.warn(`[slides-modal] setIntent(${prev} → ${intent}) — publish.hidden=${publishPanel.root.hidden} sync.hidden=${syncPanel.root.hidden}`);
        if (isImport)
        {
            syncPanel.onShow();
        }
    }

    // Default copy so a directly-mounted form (no picker click) still reads.
    setIntent(initialValues.intent);

    return {
        root,
        setIntent,
        presetImportUrl: syncPanel.presetImportUrl,
    };
}

/**
 * Publish-intent form panel — "Coming Soon" page for the future
 * "create a NEW Google Slides deck from this script" flow. Only the Sync
 * flow (link to an existing deck) is shipped. Copy invites the user to
 * pick Sync from the previous card or check back later.
 *
 * @param {{ onClose: () => void, onBack: () => void }} handlers
 */
function _buildPublishFormPanel(handlers)
{
    const root = document.createElement("section");
    root.className = "publish-panel publish-panel-publish-form";

    const heading = document.createElement("h2");
    heading.className = "publish-heading";
    heading.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.form.heading",
        "Google Slides™ publishing is coming soon.");
    root.appendChild(heading);

    const body = document.createElement("p");
    body.className = "publish-body";
    body.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.form.publishPlaceholder",
        "Publishing this document to Google Slides™ is not available yet — check back soon.");
    root.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "publish-footer";
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "mps-btn-secondary";
    backBtn.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.back", "Back");
    backBtn.addEventListener("click", () => handlers.onBack());
    const primaryBtn = document.createElement("button");
    primaryBtn.type = "button";
    primaryBtn.className = "mps-btn-primary";
    primaryBtn.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.close", "Close");
    primaryBtn.addEventListener("click", () => handlers.onClose());
    footer.appendChild(backBtn);
    footer.appendChild(primaryBtn);
    root.appendChild(footer);

    return { root };
}

/**
 * Sync/Import-intent form panel — the real picker flow.
 *
 * Chrome matches Gate/Picker/End: heading, one-line lede, primary picker
 * button, live caption, two-button `[Back][Okay]` footer. `Okay` is
 * hidden by default; it only surfaces on the `presetImportUrl` re-link
 * path so the user can confirm the linked-to presentation without
 * re-picking.
 *
 * The picker button click handler LAZY-IMPORTS `picker-client.js` — the
 * module never enters the cold-boot bundle.
 *
 * Access-check design: on picker resolve we skip `_accessCheck` because
 * the picker uses `drive.file` scope which grants per-file access at
 * pick-time. `_accessCheck` is preserved for the re-link path where the
 * stored id may point at a file the current session doesn't have access
 * to (e.g. token was revoked, file was unshared).
 *
 * @param {ReturnType<typeof _initialValues>} initialValues
 * @param {{
 *   authClient: { getAccessToken: (opts?: { allowRefresh?: boolean }) => Promise<string|null> },
 *   ctx?: any,
 *   onClose: () => void,
 *   onBack: () => void,
 *   onPrepared?: (report: any, presentationId: string) => void
 * }} handlers
 */
function _buildSyncFormPanel(initialValues, handlers)
{
    const root = document.createElement("section");
    root.className = "publish-panel publish-panel-sync-form";

    const heading = document.createElement("h2");
    heading.className = "publish-heading";
    heading.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.form.sync.heading",
        "Sync existing Google Slides™");
    root.appendChild(heading);

    const lede = document.createElement("p");
    lede.className = "publish-body";
    const publishScope = handlers.ctx?.publishScope || null;
    if (publishScope && publishScope.kind === "folder")
    {
        lede.textContent = t(
            "mangaplay-studio.googleSlidesSync.publish.form.sync.ledeFolder",
            "All the files under the folder {folderName} will be linked to this presentation. Please pick a Google Slides Presentation.",
            { folderName: publishScope.folderName || "" });
    }
    else
    {
        lede.textContent = t(
            "mangaplay-studio.googleSlidesSync.publish.form.sync.lede",
            "Pick a presentation you want to link.");
    }
    root.appendChild(lede);

    const form = document.createElement("div");
    form.className = "publish-sync-form";
    root.appendChild(form);

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "mps-btn-primary publish-import-pick";
    pickBtn.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.form.sync.pickButton",
        "Choose from Google Drive™");
    form.appendChild(pickBtn);

    const caption = document.createElement("p");
    caption.className = "publish-sync-caption";
    caption.setAttribute("aria-live", "polite");
    form.appendChild(caption);

    /** @type {string|null} */
    let slidesId = null;
    /** @type {string|null} */
    let selectedName = null;
    let checking = false;
    let presetMode = false;

    // Footer — [ Back ] always visible; [ Okay ] hidden except on the
    // `presetImportUrl` re-link confirmation path.
    const footer = document.createElement("div");
    footer.className = "publish-footer";
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "mps-btn-secondary";
    backBtn.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.back", "Back");
    backBtn.setAttribute("aria-label", t(
        "mangaplay-studio.googleSlidesSync.publish.back", "Back"));
    backBtn.addEventListener("click", async () =>
    {
        // Back-during-in-flight-pick: cancel the pick before transitioning
        // so an orphaned browser callback doesn't fire against a modal
        // that has moved on. The Rust picker owns cancellation via
        // timeout / drop; JS-side we short-circuit against the in-flight
        // flag so we don't wait on it.
        try
        {
            const { isPickerInFlight } = await import("../google-picker/picker-client.js");
            if (isPickerInFlight())
            {
                // Rust drops the oneshot sender when the command's
                // callback listener is dropped; here we simply move on.
                // Any late resolution is discarded by the picker-client
                // finally-block.
                _setCaption("", "");
                _setChecking(false);
            }
        }
        catch (_) { /* best-effort */ }
        handlers.onBack();
    });

    const okayBtn = document.createElement("button");
    okayBtn.type = "button";
    okayBtn.className = "mps-btn-primary";
    okayBtn.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.form.import.okay",
        "Okay");
    okayBtn.hidden = true;
    okayBtn.addEventListener("click", () => { void onOkay(); });

    footer.appendChild(backBtn);
    footer.appendChild(okayBtn);
    root.appendChild(footer);

    function _setCaption(text, kind)
    {
        caption.textContent = text || "";
        caption.dataset.kind = kind || "";
    }

    function _setChecking(v)
    {
        checking = v;
        pickBtn.disabled = v;
        okayBtn.disabled = v;
    }

    async function _accessCheck(id)
    {
        // Uses Drive API v3 — Slides files are Drive files, so files.get
        // with fields=id,name,capabilities is the cheapest access probe.
        // 200 → access. 403 → no access. 404 → doesn't exist.
        //
        // Only called on the re-link (presetImportUrl) path — direct
        // picker resolves skip this because drive.file guarantees access
        // to files the user just picked.
        const token = await handlers.authClient.getAccessToken({ allowRefresh: true });
        if (!token)
        {
            const err = new Error("no-token");
            /** @type {any} */ (err).kind = "auth";
            throw err;
        }
        const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,capabilities`;
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 200) return true;
        const err = new Error(`http-${res.status}`);
        /** @type {any} */ (err).kind = res.status === 404 ? "not-found"
            : res.status === 403 ? "no-access"
            : "http";
        throw err;
    }

    /**
     * Fetch the file's `name` field via the same Drive files.get endpoint
     * `_accessCheck` uses. Cheaper than a full presentation fetch; runs
     * against the picker-issued access token so it works before any
     * merge into the main session.
     * @param {string} id
     * @param {string} token
     * @returns {Promise<string|null>}
     */
    async function _fetchFileName(id, token)
    {
        try
        {
            const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=name`;
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10_000),
            });
            if (res.status !== 200) return null;
            const body = await res.json();
            return typeof body?.name === "string" ? body.name : null;
        }
        catch (_)
        {
            return null;
        }
    }

    async function _runPrepare()
    {
        console.warn(`[slides-modal] _runPrepare START — slidesId=${slidesId} selectedName="${selectedName}" presetMode=${presetMode}`);
        // Shared post-pick / post-relink flow: fetch the deck, hand to
        // the orchestrator, hand the report to the summary panel. Skips
        // `_accessCheck` on the picker path (drive.file guarantees it),
        // but the re-link path still needs it — the caller decides.
        _setChecking(true);
        pickBtn.classList.add("is-loading");
        const spinner = document.createElement("span");
        spinner.className = "settings-update-spinner";
        pickBtn.appendChild(spinner);
        try
        {
            _setCaption(t(
                "mangaplay-studio.googleSlidesSync.publish.form.import.preparing.reading",
                "Reading presentation…"), "info");
            console.warn(`[slides-modal] _runPrepare: fetching access token for Slides API…`);
            const token = await handlers.authClient.getAccessToken({ allowRefresh: true });
            if (!token)
            {
                console.warn(`[slides-modal] _runPrepare: NO TOKEN — throwing auth error`);
                const err = new Error("no-token");
                /** @type {any} */ (err).kind = "auth";
                throw err;
            }
            console.warn(`[slides-modal] _runPrepare: calling getPresentation(${slidesId})…`);
            const { getPresentation } = await import("./slides-api.js");
            const { presentation, refreshedAt } = await getPresentation(slidesId, token);
            console.warn(`[slides-modal] _runPrepare: getPresentation RESOLVED — title="${presentation?.title || ""}" slides.length=${presentation?.slides?.length ?? "?"}`);

            _setCaption(t(
                "mangaplay-studio.googleSlidesSync.publish.form.import.preparing.matching",
                "Matching pages…"), "info");
            console.warn(`[slides-modal] _runPrepare: calling prepareSlidesSync()…`);
            const { prepareSlidesSync } = await import("./slides-prepare.js");
            const report = await prepareSlidesSync({
                presentation,
                refreshedAt,
                presentationId: slidesId,
                script:         handlers.ctx?.script,
                projectPath:    handlers.ctx?.projectPath,
                authClient:     handlers.authClient,
                onProgress:     (p) =>
                {
                    if (p.phase === "downloading" && p.total)
                    {
                        _setCaption(t(
                            "mangaplay-studio.googleSlidesSync.publish.form.import.preparing.downloading",
                            "Downloading images… ({current}/{total})",
                            { current: p.current, total: p.total }), "info");
                    }
                },
            });
            console.warn(`[slides-modal] _runPrepare: prepareSlidesSync RESOLVED — aborted=${report?.aborted ? JSON.stringify(report.aborted) : "false"} deckPages=${JSON.stringify(report?.deckPages)?.slice(0, 80)} localPages=${JSON.stringify(report?.localPages)?.slice(0, 80)}`);

            if (report.aborted)
            {
                console.warn(`[slides-modal] _runPrepare: report.aborted=${report.aborted.reason} — STAYING on form panel with error caption (should NOT show summary)`);
                const reason = report.aborted.reason;
                /** @type {string} */
                let msg;
                if (reason === "EMPTY_DECK")
                {
                    msg = t(
                        "mangaplay-studio.googleSlidesSync.publish.form.import.err.emptyDeck",
                        "The presentation has no slides.");
                }
                else if (reason === "FETCH_FAILED")
                {
                    msg = t(
                        "mangaplay-studio.googleSlidesSync.publish.form.import.err.fetchFailed",
                        "Couldn't fetch the presentation. Try again.");
                }
                else if (reason === "LOCK_HELD")
                {
                    msg = t(
                        "mangaplay-studio.googleSlidesSync.publish.form.import.err.lockHeld",
                        "Another window is preparing this deck — try again in a moment.");
                }
                else
                {
                    msg = t(
                        "mangaplay-studio.googleSlidesSync.publish.form.import.err.auth",
                        "Sign in to Google to continue.");
                }
                _setCaption(msg, "err");
                return;
            }

            if (typeof handlers.onPrepared === "function")
            {
                console.warn(`[slides-modal] _runPrepare: about to call handlers.onPrepared() — this WILL transition to summary panel`);
                handlers.onPrepared(report, slidesId, presentation);
            }
            else
            {
                console.warn(`[slides-modal] _runPrepare: handlers.onPrepared is NOT a function — summary transition SKIPPED`);
            }
        }
        catch (e)
        {
            const kind = /** @type {any} */ (e)?.kind;
            const msgRaw = String((/** @type {any} */ (e))?.message || e || "");
            console.warn(`[slides-modal] _runPrepare CAUGHT error — kind=${kind || "unknown"} msg=${msgRaw.slice(0, 200)}`);
            /** @type {string} */
            let msg;
            if (kind === "auth")           msg = t("mangaplay-studio.googleSlidesSync.publish.form.import.err.auth",     "Sign in to Google to continue.");
            else if (kind === "no-access") msg = t("mangaplay-studio.googleSlidesSync.publish.form.import.err.noAccess", "You don't have access to this presentation.");
            else if (kind === "not-found") msg = t("mangaplay-studio.googleSlidesSync.publish.form.import.err.notFound", "That presentation couldn't be found.");
            else                           msg = t("mangaplay-studio.googleSlidesSync.publish.form.import.err.network",  "Couldn't reach Google Slides™. Check your connection.");
            _setCaption(msg, "err");
        }
        finally
        {
            console.warn(`[slides-modal] _runPrepare FINALLY — resetting spinner + checking`);
            spinner.remove();
            pickBtn.classList.remove("is-loading");
            _setChecking(false);
        }
    }

    async function onOkay()
    {
        console.warn(`[slides-modal] onOkay CLICKED — okayBtn.disabled=${okayBtn.disabled} checking=${checking} slidesId=${slidesId}`);
        if (okayBtn.disabled || checking || !slidesId) return;
        // Re-link confirmation path — the stored id may point at a file
        // the current session can't access, so we DO need `_accessCheck`
        // here (unlike the fresh picker path).
        _setChecking(true);
        _setCaption(t(
            "mangaplay-studio.googleSlidesSync.publish.form.import.checkingAccess",
            "Checking access…"), "info");
        try
        {
            console.warn(`[slides-modal] onOkay: calling _accessCheck(${slidesId}) — re-link path only`);
            await _accessCheck(slidesId);
            console.warn(`[slides-modal] onOkay: _accessCheck OK`);
        }
        catch (e)
        {
            const kind = /** @type {any} */ (e)?.kind;
            console.warn(`[slides-modal] onOkay: _accessCheck FAILED — kind=${kind}`);
            /** @type {string} */
            let msg;
            if (kind === "auth")           msg = t("mangaplay-studio.googleSlidesSync.publish.form.import.err.auth",     "Sign in to Google to continue.");
            else if (kind === "no-access") msg = t("mangaplay-studio.googleSlidesSync.publish.form.import.err.noAccess", "You don't have access to this presentation.");
            else if (kind === "not-found") msg = t("mangaplay-studio.googleSlidesSync.publish.form.import.err.notFound", "That presentation couldn't be found.");
            else                           msg = t("mangaplay-studio.googleSlidesSync.publish.form.import.err.network",  "Couldn't reach Google Slides™. Check your connection.");
            _setCaption(msg, "err");
            _setChecking(false);
            return;
        }
        console.warn(`[slides-modal] onOkay: proceeding to _runPrepare()`);
        await _runPrepare();
    }

    pickBtn.addEventListener("click", async () =>
    {
        console.warn(`[slides-modal] pickBtn CLICKED — checking=${checking} presetMode=${presetMode} current slidesId=${slidesId}`);
        if (checking)
        {
            console.warn(`[slides-modal] pickBtn click IGNORED — already checking`);
            return;
        }
        _setChecking(true);
        _setCaption(t(
            "shared.ui.picker.openingBrowser", "Opening browser…"), "info");
        // Hoisted above the try so the catch block can `instanceof` the
        // error classes — const bindings inside a try are scoped to the try.
        console.warn(`[slides-modal] importing picker-client.js…`);
        const { pickFile, PickerCancelledError, PickerTimeoutError, PickerInFlightError }
            = await import("../google-picker/picker-client.js");
        try
        {

            // Update caption once the browser has been opened. Rust's
            // `picker_open` returns only after the callback lands, so
            // there's no explicit "opened" hook — swap the caption to
            // the waiting state on the next microtask and let Rust
            // race against the browser.
            queueMicrotask(() =>
            {
                if (checking && caption.dataset.kind === "info")
                {
                    _setCaption(t(
                        "shared.ui.picker.awaitingCallback",
                        "Waiting for you to pick a file…"), "info");
                }
            });

            const emailHint = getStoredEmail();
            console.warn(`[slides-modal] calling pickFile({kind:"slide"}) — Rust will open system browser to Google Picker; awaiting user pick… hint=${emailHint ? "PRESENT" : "null"}`);
            const result = await pickFile({ kind: "slide", hint: emailHint || undefined });
            console.warn(`[slides-modal] pickFile RESOLVED — fileId=${result?.fileId} token=${result?.token ? "PRESENT" : "NULL"}`);
            slidesId = result.fileId;

            // Seed the app-wide auth session so downstream Drive/Slides calls
            // in _runPrepare (and later re-syncs) can use handlers.authClient
            // instead of only the picker-scoped token. Also populates identity
            // via Drive about.get so future picks pass login_hint.
            try
            {
                await mergePickerTokens(result);
            }
            catch (e)
            {
                console.warn(`[slides-modal] mergePickerTokens failed (non-fatal):`, e);
            }

            // Fetch the picked file's display name — cheap, uses the
            // picker-issued token so it works before token merge. Falls
            // back to the id if the name lookup fails.
            const nameToken = result.token || await handlers.authClient.getAccessToken({ allowRefresh: true });
            if (nameToken)
            {
                selectedName = await _fetchFileName(slidesId, nameToken);
                console.warn(`[slides-modal] fetched picked file's display name: "${selectedName}"`);
            }

            _setCaption(t(
                "mangaplay-studio.googleSlidesSync.publish.form.sync.selectedCaption",
                "Selected: {name}",
                { name: selectedName || slidesId }), "ok");

            // Fresh pick — drive.file scope guarantees access at
            // pick-time, so skip `_accessCheck` and go straight to
            // `_runPrepare()`. The `_accessCheck` fn is preserved for
            // the re-link (presetImportUrl) path.
            console.warn(`[slides-modal] fresh pick path — skipping _accessCheck, calling _runPrepare()`);
            await _runPrepare();
        }
        catch (e)
        {
            const errName = (/** @type {any} */ (e))?.name || (/** @type {any} */ (e))?.constructor?.name || "unknown";
            const errMsg  = String((/** @type {any} */ (e))?.message || e || "");
            console.warn(`[slides-modal] pickBtn caught error — name=${errName} msg=${errMsg.slice(0, 200)}`);
            if (e instanceof PickerCancelledError)
            {
                console.warn(`[slides-modal] pickBtn error branch: PickerCancelledError (user closed browser or picker without picking)`);
                slidesId = null;
                selectedName = null;
                _setCaption(t(
                    "mangaplay-studio.googleSlidesSync.publish.form.sync.pickerCancelled",
                    "Picker cancelled — try again"), "err");
            }
            else if (e instanceof PickerTimeoutError)
            {
                console.warn(`[slides-modal] pickBtn error branch: PickerTimeoutError`);
                _setCaption(t(
                    "shared.ui.picker.timeoutRetry",
                    "Timed out — try again"), "err");
            }
            else if (e instanceof PickerInFlightError)
            {
                console.warn(`[slides-modal] pickBtn error branch: PickerInFlightError — another pick in progress`);
                _setCaption(t(
                    "shared.ui.picker.awaitingCallback",
                    "Waiting for you to pick a file…"), "info");
            }
            else
            {
                const msg = String((/** @type {any} */ (e))?.message || e || "");
                console.warn(`[slides-modal] pickBtn error branch: OTHER/${msg.includes("network") ? "network" : "http"}`);
                if (msg.includes("network"))
                {
                    _setCaption(t(
                        "shared.ui.picker.networkError",
                        "Couldn't reach the picker service. Check your connection."), "err");
                }
                else
                {
                    _setCaption(t(
                        "shared.ui.picker.httpError",
                        "The picker service returned an error. Try again."), "err");
                }
            }
            _setChecking(false);
        }
    });

    /**
     * Pre-populate the panel for an already-linked script. Extracts the
     * presentation id from the stored URL, shows a "Currently linked to
     * <name>" caption, and reveals the `Okay` button so the user can
     * confirm without re-picking. Picker button label switches to
     * "Choose different presentation".
     *
     * @param {string} url
     */
    function presetImportUrl(url)
    {
        console.warn(`[slides-modal] presetImportUrl("${url}") — entering RE-LINK mode; user will see Okay button + skip picker`);
        const id = _extractSlidesId(url);
        if (!id) { console.warn(`[slides-modal] presetImportUrl: could not extract id — bailing`); return; }
        presetMode = true;
        slidesId = id;
        selectedName = null;
        pickBtn.textContent = t(
            "mangaplay-studio.googleSlidesSync.publish.form.sync.pickButtonRelink",
            "Choose different presentation");
        okayBtn.hidden = false;
        _setCaption(t(
            "mangaplay-studio.googleSlidesSync.publish.form.sync.currentlyLinkedTo",
            "Currently linked to {name}",
            { name: id }), "info");
        // Best-effort fetch of the current linked name; runs against the
        // session's existing token, no picker needed.
        (async () =>
        {
            const token = await handlers.authClient.getAccessToken({ allowRefresh: true });
            if (!token) return;
            const name = await _fetchFileName(id, token);
            if (name && slidesId === id && presetMode)
            {
                selectedName = name;
                _setCaption(t(
                    "mangaplay-studio.googleSlidesSync.publish.form.sync.currentlyLinkedTo",
                    "Currently linked to {name}",
                    { name }), "info");
            }
        })();
    }

    /**
     * Called by the wrapper `setIntent("import")`. Resets the caption
     * (unless a preset is live) and focuses the picker button so
     * keyboard users can Space/Enter to open the picker.
     */
    function onShow()
    {
        if (!presetMode)
        {
            slidesId = null;
            selectedName = null;
            okayBtn.hidden = true;
            pickBtn.textContent = t(
                "mangaplay-studio.googleSlidesSync.publish.form.sync.pickButton",
                "Choose from Google Drive™");
            _setCaption("", "");
        }
        _setChecking(false);
        // Defer focus past the 260ms slide transition. focus() triggers
        // scroll-into-view on ancestors — during a translateX(100% → 0)
        // transition that forces the browser to snap the transform to
        // reveal the button, killing the animation. preventScroll would
        // be enough on modern engines but is unreliable in WebView2, so
        // just wait until the slide is done.
        setTimeout(() =>
        {
            try { pickBtn.focus({ preventScroll: true }); } catch (_)
            {
                try { pickBtn.focus(); } catch (_) { /* best-effort */ }
            }
        }, 300);
    }

    return { root, presetImportUrl, onShow };
}

/**
 * Format a list of page fullIds for the summary counts row.
 *
 * Rules per plan spec:
 *   - ≤ 4 pages: comma-separated list of all ids, plus "(N total)".
 *   - Contiguous numeric 1..N: "first – last (N total)".
 *   - Non-contiguous or any non-numeric id (COVER, roman, sub-page): show
 *     first three + "…" + last, plus "(N total)".
 *
 * @param {string[]} pages
 * @returns {string}
 */
function _formatPageRange(pages)
{
    const n = pages.length;
    if (n === 0) return "0 total";
    if (n <= 4) return `${pages.join(", ")} (${n} total)`;

    // Contiguous check: every entry equals String(i + 1) starting at 1.
    let contiguous = true;
    for (let i = 0; i < n; i++)
    {
        if (pages[i] !== String(i + 1))
        {
            contiguous = false;
            break;
        }
    }
    if (contiguous)
    {
        return `${pages[0]} – ${pages[n - 1]} (${n} total)`;
    }
    return `${pages[0]}, ${pages[1]}, ${pages[2]}, …, ${pages[n - 1]} (${n} total)`;
}

/**
 * Summary panel — post-prep report + reconcile UI + Accept/Cancel.
 *
 * `onAccept` receives `{ mismatchPolicy }` where policy is `"use-deck"` or
 * `"use-local"` when the mismatch section is visible, else `null`.
 *
 * @param {{
 *   onCancel: () => void,
 *   onBack?:  () => void,
 *   onAccept: (args: { mismatchPolicy: "use-deck"|"use-local"|null }) => void
 * }} handlers
 */
function _buildSummaryPanel(handlers)
{
    const root = document.createElement("section");
    root.className = "publish-panel publish-panel-summary";

    // ── Scope header (folder vs single-file) ─────────────────────────────
    const scopeHeader = document.createElement("p");
    scopeHeader.className = "publish-summary-scope-header";
    scopeHeader.hidden = true;
    root.appendChild(scopeHeader);

    // ── Meta row (presentation + local script) ──────────────────────────
    const meta = document.createElement("div");
    meta.className = "publish-summary-meta";
    const metaPresentation = document.createElement("p");
    const metaLocal = document.createElement("p");
    meta.appendChild(metaPresentation);
    meta.appendChild(metaLocal);
    root.appendChild(meta);

    // ── Counts card (two columns: Local | Presentation) ─────────────────
    const counts = document.createElement("div");
    counts.className = "publish-summary-counts";

    const colLocal = document.createElement("div");
    colLocal.className = "publish-summary-counts-col";
    const colLocalHeading = document.createElement("h4");
    colLocalHeading.className = "publish-summary-counts-col-heading";
    colLocalHeading.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.summary.counts.localHeading",
        "Local");
    colLocal.appendChild(colLocalHeading);

    const colDeck = document.createElement("div");
    colDeck.className = "publish-summary-counts-col";
    const colDeckHeading = document.createElement("h4");
    colDeckHeading.className = "publish-summary-counts-col-heading";
    colDeckHeading.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.summary.counts.deckHeading",
        "Presentation");
    colDeck.appendChild(colDeckHeading);

    counts.appendChild(colLocal);
    counts.appendChild(colDeck);

    /**
     * @param {HTMLElement} parent
     * @param {string} labelText
     * @returns {HTMLSpanElement}
     */
    const addCountRow = (parent, labelText) =>
    {
        const row = document.createElement("p");
        const label = document.createElement("span");
        label.className = "publish-summary-counts-label";
        label.textContent = labelText;
        const value = document.createElement("span");
        value.className = "publish-summary-counts-value";
        row.appendChild(label);
        row.appendChild(value);
        parent.appendChild(row);
        return value;
    };

    const valLocalPages = addCountRow(colLocal, t(
        "mangaplay-studio.googleSlidesSync.publish.summary.counts.localPages",
        "Pages in the local document:"));
    const valImagesToDownload = addCountRow(colLocal, t(
        "mangaplay-studio.googleSlidesSync.publish.summary.counts.imagesToDownload",
        "Images to download:"));

    const valDeckPages = addCountRow(colDeck, t(
        "mangaplay-studio.googleSlidesSync.publish.summary.counts.deckPages",
        "Pages in the presentation:"));
    const valImagesFound = addCountRow(colDeck, t(
        "mangaplay-studio.googleSlidesSync.publish.summary.counts.imagesFound",
        "Images found on slides:"));
    const valDeckOutOfScope = addCountRow(colDeck, t(
        "mangaplay-studio.googleSlidesSync.publish.summary.counts.deckOutOfScope",
        "Extra pages in deck (outside this script):"));
    // Hidden until setReport() sees a non-empty deckOutOfScope bucket.
    /** @type {HTMLElement} */
    (valDeckOutOfScope.parentElement).hidden = true;

    root.appendChild(counts);

    // ── Live caption row (progress during commit) ──────────────────────
    const caption = document.createElement("p");
    caption.className = "publish-summary-caption";
    caption.hidden = true;
    root.appendChild(caption);

    // ── Mismatch section (hidden unless report.mismatch !== null) ───────
    const mismatchSection = document.createElement("div");
    mismatchSection.className = "publish-summary-mismatch";
    mismatchSection.hidden = true;
    const mismatchPrompt = document.createElement("p");
    mismatchPrompt.className = "publish-summary-mismatch-prompt";
    mismatchSection.appendChild(mismatchPrompt);
    const mismatchFieldset = document.createElement("fieldset");

    // Radio 1: Use Local Version
    const labelLocal = document.createElement("label");
    labelLocal.className = "publish-summary-mismatch-option";
    const radioLocal = document.createElement("input");
    radioLocal.type = "radio";
    radioLocal.name = "publish-summary-mismatch-policy";
    radioLocal.value = "use-local";
    const localTextWrap = document.createElement("span");
    localTextWrap.className = "publish-summary-mismatch-text";
    const localTitle = document.createElement("span");
    localTitle.className = "publish-summary-mismatch-title";
    localTitle.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.summary.mismatch.useLocal",
        "Use Local Version");
    const localDesc = document.createElement("span");
    localDesc.className = "publish-summary-mismatch-desc";
    localDesc.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.summary.mismatch.useLocalDescription",
        "This will upload my local version of the pages and overwrite what is in Google Slides for the specific pages.");
    localTextWrap.appendChild(localTitle);
    localTextWrap.appendChild(localDesc);
    labelLocal.appendChild(radioLocal);
    labelLocal.appendChild(localTextWrap);

    // Radio 2: Use Google Slides Version (default checked — safer, doesn't overwrite deck)
    const labelDeck = document.createElement("label");
    labelDeck.className = "publish-summary-mismatch-option";
    const radioDeck = document.createElement("input");
    radioDeck.type = "radio";
    radioDeck.name = "publish-summary-mismatch-policy";
    radioDeck.value = "use-deck";
    radioDeck.checked = true;
    const deckTextWrap = document.createElement("span");
    deckTextWrap.className = "publish-summary-mismatch-text";
    const deckTitle = document.createElement("span");
    deckTitle.className = "publish-summary-mismatch-title";
    deckTitle.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.summary.mismatch.useDeck",
        "Use Google Slides Version");
    const deckDesc = document.createElement("span");
    deckDesc.className = "publish-summary-mismatch-desc";
    deckDesc.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.summary.mismatch.useDeckDescription",
        "This will overwrite my local version and accept the Google Slides version as the source of truth for the specific pages.");
    deckTextWrap.appendChild(deckTitle);
    deckTextWrap.appendChild(deckDesc);
    labelDeck.appendChild(radioDeck);
    labelDeck.appendChild(deckTextWrap);

    mismatchFieldset.appendChild(labelLocal);
    mismatchFieldset.appendChild(labelDeck);
    mismatchSection.appendChild(mismatchFieldset);
    root.appendChild(mismatchSection);

    // ── Warnings section (hidden unless report.warnings.length > 0) ─────
    const warningsSection = document.createElement("div");
    warningsSection.className = "publish-summary-warnings";
    warningsSection.hidden = true;
    const warningsHeading = document.createElement("h3");
    warningsHeading.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.summary.warnings.heading",
        "Warnings");
    const warningsList = document.createElement("ul");
    warningsSection.appendChild(warningsHeading);
    warningsSection.appendChild(warningsList);
    root.appendChild(warningsSection);

    // ── Footer ──────────────────────────────────────────────────────────
    const footer = document.createElement("div");
    footer.className = "publish-footer";
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "mps-btn-secondary";
    backBtn.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.back", "Back");
    backBtn.addEventListener("click", () => handlers.onBack?.());
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "mps-btn-secondary";
    cancelBtn.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.summary.cancel",
        "Cancel");
    cancelBtn.addEventListener("click", () => handlers.onCancel());
    const acceptBtn = document.createElement("button");
    acceptBtn.type = "button";
    acceptBtn.className = "mps-btn-primary";
    acceptBtn.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.summary.accept",
        "Accept & Link");
    acceptBtn.addEventListener("click", () =>
    {
        /** @type {"use-deck"|"use-local"|null} */
        let policy = null;
        if (!mismatchSection.hidden)
        {
            policy = radioDeck.checked ? "use-deck" : "use-local";
        }
        handlers.onAccept({ mismatchPolicy: policy });
    });
    footer.appendChild(backBtn);
    footer.appendChild(cancelBtn);
    footer.appendChild(acceptBtn);
    root.appendChild(footer);

    /**
     * Render a warning as an `<li>` with a t-keyed message.
     * @param {any} w
     * @returns {HTMLLIElement}
     */
    function renderWarning(w)
    {
        const li = document.createElement("li");
        const kind = w && w.kind;
        const pageId = w && w.pageId;
        const slideIndex = w && w.slideIndex;
        const message = w && w.message ? String(w.message) : "";
        /** @type {string} */
        let text;
        if (kind === "PARSE_ERROR")
        {
            text = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.warn.parseError",
                "Slide {slideIndex}: {message}",
                { slideIndex: String(slideIndex ?? "?"), message });
        }
        else if (kind === "DUPLICATE")
        {
            text = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.warn.duplicate",
                "Duplicate PAGE {pageId} on slide {slideIndex}",
                { pageId: String(pageId ?? "?"), slideIndex: String(slideIndex ?? "?") });
        }
        else if (kind === "NO_IMAGE_ON_SLIDE")
        {
            text = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.warn.noImage",
                "Page {pageId} has no image on the slide",
                { pageId: String(pageId ?? "?") });
        }
        else if (kind === "URL_EXPIRED")
        {
            text = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.warn.urlExpired",
                "Page {pageId} image URL expired — skipped",
                { pageId: String(pageId ?? "?") });
        }
        else if (kind === "DOWNLOAD_FAILED")
        {
            text = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.warn.downloadFailed",
                "Page {pageId} download failed — {message}",
                { pageId: String(pageId ?? "?"), message });
        }
        else if (kind === "NO_DECK_HEADER_TEXT")
        {
            text = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.warn.noDeckHeaderText",
                "Page {pageId} has no body text on the slide — treated as differing from local.",
                { pageId: String(pageId ?? "?") });
        }
        else if (kind === "VERIFY_FAILED")
        {
            text = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.warn.verifyFailed",
                "Page {pageId} content didn't match after upload. Try Publish again.",
                { pageId: String(pageId ?? "?") });
        }
        else
        {
            text = message || String(kind || "");
        }
        li.textContent = text;
        return li;
    }

    /**
     * Populate the panel with a `PrepareReport` + display strings.
     * @param {any} report
     * @param {string} presentationTitle
     * @param {string} basename
     * @param {any} [scope]  publishScope — { kind: "folder"|"file", ... }
     */
    function setReport(report, presentationTitle, basename, scope)
    {
        metaPresentation.textContent = t(
            "mangaplay-studio.googleSlidesSync.publish.summary.meta.presentation",
            "Presentation: {title}",
            { title: presentationTitle || "" });

        // Scope header + `Local script:` line vary by scope kind. Folder
        // scope shows the folder name; file scope shows the basename.
        const localPagesArr = Array.isArray(report?.localPages) ? report.localPages : [];
        const pageCount = localPagesArr.length || Number(scope?.pageCount || 0);
        if (scope && scope.kind === "folder")
        {
            metaLocal.textContent = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.meta.localFolder",
                "Storyboard folder: {folderName}",
                { folderName: scope.folderName || "" });
            scopeHeader.textContent = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.scope.folder",
                "Publishing folder {folderName} ({fileCount} files, {pageCount} pages)",
                {
                    folderName: scope.folderName || "",
                    fileCount:  String(scope.fileCount || 0),
                    pageCount:  String(pageCount),
                });
            scopeHeader.hidden = false;
        }
        else
        {
            metaLocal.textContent = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.meta.local",
                "Local script: {basename}",
                { basename: basename || "" });
            if (scope && scope.kind === "file")
            {
                scopeHeader.textContent = t(
                    "mangaplay-studio.googleSlidesSync.publish.summary.scope.file",
                    "Publishing {basename} ({pageCount} pages)",
                    { basename: basename || "", pageCount: String(pageCount) });
                scopeHeader.hidden = false;
            }
            else
            {
                scopeHeader.textContent = "";
                scopeHeader.hidden = true;
            }
        }

        const deckPages = Array.isArray(report?.deckPages) ? report.deckPages : [];
        const localPages = Array.isArray(report?.localPages) ? report.localPages : [];
        valDeckPages.textContent = _formatPageRange(deckPages);
        valLocalPages.textContent = _formatPageRange(localPages);

        const imagesFound = Number(report?.imagesFound || 0);
        const imagesToDownload = Number(report?.imagesToDownload || 0);
        valImagesFound.textContent = t(
            "mangaplay-studio.googleSlidesSync.publish.summary.counts.imagesFoundValue",
            "{found} of {total}",
            { found: String(imagesFound), total: String(deckPages.length) });
        valImagesToDownload.textContent = String(imagesToDownload);

        // Mismatch section — three buckets.
        //   diffCount = pairedDifferent.length + localOnly.length
        //   deckOutOfScope surfaces as an informational line, NEVER as a
        //   mismatch. Radio section hides when diffCount === 0.
        const mismatch = report?.mismatch;
        const pairedDifferent = Array.isArray(mismatch?.pairedDifferent) ? mismatch.pairedDifferent : [];
        const localOnly = Array.isArray(mismatch?.localOnly) ? mismatch.localOnly : [];
        const deckOutOfScope = Array.isArray(mismatch?.deckOutOfScope) ? mismatch.deckOutOfScope : [];
        const diffCount = pairedDifferent.length + localOnly.length;
        if (diffCount > 0)
        {
            mismatchSection.hidden = false;
            mismatchPrompt.textContent = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.mismatchPrompt",
                "{count} pages need reconciling. Which version do you want to use for those pages?",
                { count: String(diffCount) });
            radioDeck.checked = true;
            radioLocal.checked = false;
        }
        else
        {
            mismatchSection.hidden = true;
        }
        const dosRow = /** @type {HTMLElement} */ (valDeckOutOfScope.parentElement);
        if (deckOutOfScope.length > 0)
        {
            valDeckOutOfScope.textContent = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.counts.deckOutOfScopeValue",
                "{count}",
                { count: String(deckOutOfScope.length) });
            if (dosRow) dosRow.hidden = false;
        }
        else
        {
            valDeckOutOfScope.textContent = "0";
            if (dosRow) dosRow.hidden = true;
        }

        // Warnings section
        const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
        warningsList.innerHTML = "";
        if (warnings.length > 0)
        {
            warningsSection.hidden = false;
            for (const w of warnings) warningsList.appendChild(renderWarning(w));
        }
        else
        {
            warningsSection.hidden = true;
        }
    }

    /**
     * Update the live caption row shown during commit. Pass empty string to
     * hide.
     * @param {string} text
     * @param {"info"|"err"} [kind]
     */
    function setCaption(text, kind)
    {
        caption.textContent = text || "";
        caption.hidden = !text;
        caption.classList.toggle("is-err", kind === "err");
    }

    return { root, setReport, setCaption };
}

/**
 * Progress panel — 5-step commit timeline.
 *
 * Steps:
 *   0. Downloading images
 *   1. Syncing page text
 *   2. Verifying page text
 *   3. Finalising (save link)
 *   4. Refreshing linked indicator
 *
 * Each step row renders `<pip> <label> <detail>`. Pip statuses:
 *   queued (○), running (⟳ spinner), done (✓), warn (⚠), failed (✗), skipped (—).
 *
 * The footer button is `[ Cancel ]` while steps 1-2 are eligible and
 * swaps to `[ Close ]` once the run is done (via `setDone`).
 *
 * The heading renders "Publishing …" during the run and swaps to the
 * outcome header on `setDone`.
 *
 * @param {{
 *   onCancel: () => void,
 *   onClose:  () => void,
 * }} handlers
 */
function _buildProgressPanel(handlers)
{
    const root = document.createElement("section");
    root.className = "publish-panel publish-panel-progress";

    const heading = document.createElement("h2");
    heading.className = "publish-heading publish-progress-heading";
    heading.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.progress.heading",
        "Publishing");
    root.appendChild(heading);

    const scopeHeader = document.createElement("p");
    scopeHeader.className = "publish-progress-scope";
    scopeHeader.hidden = true;
    root.appendChild(scopeHeader);

    // Slim horizontal progress bar — reuses the exact CSS classes shipped
    // by the Docs publish modal (see app-modals.css:1596-1618).
    const bar = document.createElement("div");
    bar.className = "publish-progress-bar";
    const fill = document.createElement("div");
    fill.className = "publish-progress-bar-fill";
    bar.appendChild(fill);
    root.appendChild(bar);

    const stepLabelEl = document.createElement("div");
    stepLabelEl.className = "publish-step-label";
    stepLabelEl.setAttribute("aria-live", "polite");
    root.appendChild(stepLabelEl);

    // 5 steps × 20% each — monotonic 0 → 100% across the whole run.
    const STEP_LABEL_KEYS = [
        { key: "stepImages", fallback: "Downloading images" },
        { key: "stepText",   fallback: "Syncing page text" },
        { key: "stepVerify", fallback: "Verifying page text" },
        { key: "stepDone",   fallback: "Finalising" },
        { key: "stepLinked", fallback: "Refreshing linked indicator" },
    ];
    const STEP_WEIGHT = 100 / STEP_LABEL_KEYS.length;

    /** Monotonic percentage — never regress mid-run. */
    let lastPct = 0;

    /** @param {number} i */
    function labelFor(i)
    {
        const meta = STEP_LABEL_KEYS[i];
        if (!meta) return "";
        return t(
            `mangaplay-studio.googleSlidesSync.publish.progress.${meta.key}`,
            meta.fallback);
    }

    const footer = document.createElement("div");
    footer.className = "publish-footer";
    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "mps-btn-secondary";
    actionBtn.textContent = t(
        "mangaplay-studio.googleSlidesSync.publish.progress.cancel", "Cancel");
    actionBtn.addEventListener("click", () =>
    {
        if (actionBtn.dataset.mode === "close")
        {
            handlers.onClose();
        }
        else
        {
            handlers.onCancel();
        }
    });
    actionBtn.dataset.mode = "cancel";
    footer.appendChild(actionBtn);
    root.appendChild(footer);

    /** @param {number} pct */
    function setPct(pct)
    {
        const clamped = Math.max(0, Math.min(100, pct));
        // Enforce monotonic sweep — later steps starting must not roll back.
        if (clamped < lastPct) return;
        lastPct = clamped;
        fill.style.width = `${clamped}%`;
    }

    /**
     * Consume an onStep event from `runCommit`. Maps step index + phase to
     * a monotonic 0 → 100% bar sweep plus a single "current step" label.
     * Warnings surface in the footer/summary — not in the progress row.
     *
     * @param {number} i
     * @param {any} ev
     */
    function onStepEvent(i, ev)
    {
        const phase = ev && ev.phase;
        const base = i * STEP_WEIGHT;
        const total = Number(ev && ev.total) || 0;
        const current = Number(ev && ev.current) || 0;

        if (phase === "skipped" || phase === "done" || phase === "warn")
        {
            // Step completed → snap to the end of its slice.
            setPct(base + STEP_WEIGHT);
            stepLabelEl.textContent = labelFor(i);
            return;
        }
        if (phase === "failed")
        {
            fill.classList.add("is-error");
            stepLabelEl.textContent = labelFor(i);
            return;
        }
        if (phase === "running")
        {
            const inner = (total > 0)
                ? Math.min(1, Math.max(0, current / total)) * STEP_WEIGHT
                : 0;
            setPct(base + inner);
            stepLabelEl.textContent = labelFor(i);
        }
    }

    function reset()
    {
        lastPct = 0;
        fill.style.width = "0%";
        fill.classList.remove("is-error");
        stepLabelEl.textContent = "";
        actionBtn.dataset.mode = "cancel";
        actionBtn.className = "mps-btn-secondary";
        actionBtn.textContent = t(
            "mangaplay-studio.googleSlidesSync.publish.progress.cancel", "Cancel");
        heading.textContent = t(
            "mangaplay-studio.googleSlidesSync.publish.progress.heading",
            "Publishing");
        scopeHeader.textContent = "";
        scopeHeader.hidden = true;
    }

    /** @param {any} ctx */
    function setHeadingForContext(ctx)
    {
        const scope = ctx?.publishScope;
        if (scope && scope.kind === "folder")
        {
            scopeHeader.textContent = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.scope.folder",
                "Publishing folder {folderName} ({fileCount} files, {pageCount} pages)",
                {
                    folderName: scope.folderName || "",
                    fileCount:  String(scope.fileCount || 0),
                    pageCount:  String(scope.pageCount || 0),
                });
            scopeHeader.hidden = false;
        }
        else if (scope && scope.kind === "file")
        {
            scopeHeader.textContent = t(
                "mangaplay-studio.googleSlidesSync.publish.summary.scope.file",
                "Publishing {basename} ({pageCount} pages)",
                { basename: ctx?.basename || "", pageCount: String(scope.pageCount || 0) });
            scopeHeader.hidden = false;
        }
        else
        {
            scopeHeader.hidden = true;
        }
    }

    /**
     * @param {{ ok: boolean, warnings: any[], onClose: () => void }} opts
     */
    function setDone(opts)
    {
        const warnings = Array.isArray(opts.warnings) ? opts.warnings : [];
        const hasWarn = warnings.length > 0;
        if (!opts.ok)
        {
            heading.textContent = t(
                "mangaplay-studio.googleSlidesSync.publish.progress.outcomeFailed",
                "Publish failed");
            fill.classList.add("is-error");
        }
        else if (hasWarn)
        {
            heading.textContent = t(
                "mangaplay-studio.googleSlidesSync.publish.progress.outcomeWarnings",
                "Publish complete with warnings");
            setPct(100);
        }
        else
        {
            heading.textContent = t(
                "mangaplay-studio.googleSlidesSync.publish.progress.outcomeSuccess",
                "Publish complete");
            setPct(100);
        }
        stepLabelEl.textContent = "";
        actionBtn.dataset.mode = "close";
        actionBtn.className = "mps-btn-primary";
        actionBtn.textContent = t(
            "mangaplay-studio.googleSlidesSync.publish.progress.close", "Close");
        // Rebind close on this run.
        handlers.onClose = opts.onClose;
    }

    return {
        root,
        reset,
        setHeadingForContext,
        onStepEvent,
        setDone,
    };
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
