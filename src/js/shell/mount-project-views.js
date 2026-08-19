import { state, SCREENPLAY_DEBOUNCE_MS } from "./state.js";
import { basename } from "../util/index.js";
import { t } from "../adapters/tauri-i18n.js";
import { icon } from "../panes/icons.js";
import { showBanner } from "../boot/toast.js";
import { getBroker } from "../project/active-script-broker.js";
import {
    saveScript,
    saveMangaart,
    saveMangaartByUuid,
    debouncedSave,
    updateMangaartPage,
    getMangaartCache,
    getMangaartCacheByKey,
    getTabSnapshot,
    readFile,
    migrateLegacyTabEntries,
} from "../project/project.js";
import { EditorSlotManager } from "../editor/editor-slot-manager.js";
import { getFocusedView } from "../editor/focused-view-registry.js";
import "../editor/mps-editor-toolbar.js";
import { mountEditorTabs } from "../editor/editor-tabs.js";
import { formatForFilename } from "../editor/lang-registry.js";
import { setEditorViewMode, setEditorMode } from "../editor/mps-editor.js";
import { mountEmptyTabCta } from "../panes/empty-tab-cta.js";
import { mountRightPaneEmpty } from "../panes/right-pane-empty.js";
import { mountAppFooter } from "../panes/app-footer.js";
import { mountGoogleAccountPill } from "../pills/google-account-pill.js";
import { mountPublishDocPill } from "../pills/publish-doc-pill.js";
import { mountPublishSlidesPill } from "../pills/publish-slides-pill.js";
import { formatScript as visualFormatScript } from "../services/format-script.js";
import { initCanvas } from "../editor/mps-canvas.js";
import { getRuntimeStorage } from "@mangaplay-studio/core/state";
import { scriptRelPathOf } from "../util/paths.js";
import { getAccessToken, getCurrentProfile } from "../auth/google-oauth.js";
import { getUserSetting, saveUserSettings } from "../project/user-settings.js";
import { hasFixableIssues, fixIssues } from "../editor/structural-fixer.js";
import {
    mountGoogleDocsFooter,
    setPublishDocPillController
} from "../google-docs-sync/footer-bootstrap.js";
import { isContextMenuOpen, closeContextMenu } from "../components/mps-context-menu.js";
import { markSelfChange, onCreate, replaceActiveTab, openEditorMoreOptionsMenu, parentForCreation } from "./explorer.js";
import { openFind } from "./find-controller.js";
import { isMobileLike } from "../boot/ux-mode.js";
import { isEasyEditorEnabled } from "../boot/editor-features.js";
import { subscribePaginationState, paginationNavigate, getPaginationState, getActivePaginationFormat } from "./topbar-pagination.js";
import { setViewMode } from "./layout.js";
import { refreshProjectSwitcher, switchProject } from "./project-switcher.js";
import {
    setSaveState,
    publishParsedScript,
    updateEmptyState,
    onMpsChangeFromSlot,
    onSlotActivated,
    applyAllowedModesForFormat,
    debouncedWriteSession,
    syncStructuralFixerConvention,
    restoreShellMeta,
    wireQuickToggleRelocation,
    getOrCreateClientId,
    _setCurrentDoc,
    currentDoc,
} from "../app.js";

// ── View mounting ──
/**
 * Per-project mount: builds the slot manager, canvas, screenplay, mode toggle,
 * empty-tab CTA, and restores the tab snapshot. MUST be called once per
 * project mount (boot + every project switch). The static-shell DOM is wired
 * separately by `wireShellOnce()` exactly once per app lifetime.
 */
export async function mountProjectViews() {
    const editorEl = document.querySelector("mps-editor-host");
    const canvasEl = document.querySelector("mps-canvas");

    // Autosave: routed through the ActiveScriptBroker so destructive ops
    // (rename / delete / migrate) can drain pending writes before mutating.
    // The broker owns the 1500 ms debounce — we just pass the saveFn that
    // hits the right path at fire-time.
    const broker = getBroker();
    state.debouncedScriptSave = (text) =>
    {
        if (!state.currentProject || !state.currentProject.scriptPath) return;
        broker.scheduleScriptSave(text, async (latest) =>
        {
            setSaveState("saving");
            try
            {
                // Mark the path as a self-change so the FS watcher swallows
                // any events the atomic write emits — a single atomic write
                // can fan out into "deleted" then "modified" depending on
                // notify-rs behaviour, so consumeSelfChange is now a TTL
                // window peek (not single-take). Short TTL keeps the window
                // tight so genuine external edits aren't suppressed for
                // longer than the watcher debounce.
                markSelfChange(state.currentProject.scriptPath, 1500);
                await saveScript(state.currentProject.scriptPath, latest);
                setSaveState("saved");
                if (state.saveFailureBannerShown) state.saveFailureBannerShown = false;
            }
            catch (e)
            {
                console.error("Autosave failed:", e);
                setSaveState("dirty");
                if (!state.saveFailureBannerShown)
                {
                    const reason = (e && /** @type {any} */ (e).message) ? /** @type {any} */ (e).message : String(e);
                    showBanner(t("mangaplay-studio.banner.saveFailed", { reason }));
                    state.saveFailureBannerShown = true;
                }
            }
        });
    };

    // Debounced screenplay re-render — keeps fast typing cheap on long docs.
    // Also publish the parsed AST to RuntimeStorage so mps-canvas can paginate
    // and the right-pane screenplay re-renders from the same source of truth.
    state.debouncedScreenplayUpdate = debouncedSave((text) => {
        publishParsedScript(text);
    }, SCREENPLAY_DEBOUNCE_MS);

    if (editorEl)
    {
        const tabBarEl = document.querySelector(".top-bar-tabs");
        if (!tabBarEl)
        {
            console.warn("[mountViews] .top-bar-tabs not found; tab strip will not render");
        }

        // Mount the tab strip first; it back-references the slot manager via
        // setManager() once the manager exists.
        state.editorTabs = mountEditorTabs(
            /** @type {HTMLElement} */ (tabBarEl),
            null,
            {
                onNewTab: () =>
                {
                    // The "+" button opens a fresh empty scratch tab.
                    state.slotManager?.openNew(
                        null,
                        "",
                        /** @type {any} */ ("general-text")
                    );
                }
            }
        );

        state.slotManager = new EditorSlotManager(
            /** @type {HTMLElement} */ (editorEl),
            /** @type {HTMLElement} */ (tabBarEl),
            {
                onChange: (slot, text) =>
                {
                    _setCurrentDoc(text);
                    // Mirror onto currentProject when the change came from the
                    // currently-active slot. Prefer fileUuid identity — path
                    // equality is fragile once Rust canonicalises separators
                    // or UNC-prefixes strings behind our back.
                    const activeSlot = state.slotManager?.getActive();
                    const isActiveSlot = activeSlot && slot.tabId === activeSlot.tabId;
                    if (state.currentProject && slot.path && isActiveSlot)
                    {
                        state.currentProject.script = text;
                    }
                    onMpsChangeFromSlot(slot, text);
                },
                onActivate: (slot) =>
                {
                    onSlotActivated(slot);
                    // Contextual editor toolbar follows the active format —
                    // unsupported buttons crossfade out, new ones in.
                    try { state.editorToolbarEl?.setFormat(slot.format); }
                    catch (e) { console.debug("[editor-toolbar] setFormat threw:", e); }
                },
                onCloseRequest: async (slot) =>
                {
                    // Flush any pending writes for THIS path before destroying
                    // the view. withLock drains pending broker writes.
                    if (slot.path)
                    {
                        try { await getBroker().withLock(async () => {}); }
                        catch (e) { console.warn("[slot-close] flush failed:", e); }
                    }
                },
                onTabsChanged: () =>
                {
                    state.editorTabs?.render();
                    debouncedWriteSession();
                }
            }
        );
        state.editorTabs.setManager(state.slotManager);

        // ── Phase-2: three-state editor mode (Source / WYSIWYG / Easy Editor) ─
        // `applyEditorMode(mode)` is the single switchboard. It —
        //   1. Flushes any pending broker writes so Easy Editor reads the
        //      latest buffer (not a stale snapshot mid-debounce).
        //   2. For WYSIWYG / Source: reconfigures EVERY slot's CM language
        //      compartment AND remembers the mode module-side so new
        //      slots built later honour it. Cursor / scroll / undo
        //      survive because it's reconfigure, not re-instantiate.
        //   3. For Easy Editor: hides all CM slot containers and mounts a
        //      single cached `<mps-easy-editor>` element as a sibling
        //      so it never coexists with a live CM subscriber.
        //   4. Persists `editorMode` to user-settings.json AFTER the
        //      switch succeeds (never before — a thrown switch must
        //      not leave the persisted mode out of sync with reality).
        //   5. Syncs the mode-toggle button's `mode` property.
        /** @type {"source"|"wysiwyg"|"easy"} */
        let editorMode = /** @type {any} */ (getUserSetting("editorMode", "wysiwyg"));
        // Migrate old persisted ids forward before validation.
        if (editorMode === "text") { editorMode = "wysiwyg"; }
        else if (editorMode === "visual") { editorMode = "easy"; }
        if (editorMode !== "source" && editorMode !== "wysiwyg" && editorMode !== "easy")
        {
            editorMode = "wysiwyg";
        }
        // Build gate: a project last saved in Easy Editor must not mount it
        // when the mode is disabled in this build. Downgrade to WYSIWYG so the
        // gated-off surface never appears (no flash before format eval runs).
        if (editorMode === "easy" && !isEasyEditorEnabled()) { editorMode = "wysiwyg"; }
        state.modeToggleEl = /** @type {any} */ (
            document.createElement("mps-editor-mode-toggle")
        );
        state.modeToggleEl.setAttribute("mode", editorMode);

        /**
         * Apply `mode` to the editor pane. See block comment above for the
         * full contract. Idempotent — calling with the current mode is a
         * cheap no-op aside from re-persisting.
         * @param {"source"|"wysiwyg"|"easy"} mode
         * @param {{ persist?: boolean }} [opts] persist defaults to true.
         *   Set false for one-shot switches (e.g. the empty-tab CTA's
         *   auto-mode-switch when creating a new file) so the user's
         *   global editorMode setting isn't overwritten.
         */
        async function applyEditorMode(mode, opts)
        {
            if (mode !== "source" && mode !== "wysiwyg" && mode !== "easy")
            {
                return;
            }
            const persist = opts?.persist !== false;

            const previousMode = editorMode;

            // Drain pending CM autosaves before swapping surfaces — Visual
            // reads `state.script` from RuntimeStorage, which is populated
            // by the existing debounced subscriber. Source / Text never
            // strictly need this, but the cost is one no-op await so we
            // run it unconditionally for a single code path.
            try { await getBroker().withLock(async () => {}); }
            catch (e) { console.warn("[mode-switch] flush failed:", e); }

            // Leaving Easy Editor → tear down (or hide) the easy-editor element so
            // it stops subscribing to RuntimeStorage before CM remounts.
            if (mode !== "easy" && state.easyEditorEl)
            {
                state.easyEditorEl.style.display = "none";
            }

            if (mode === "easy")
            {
                if (editorEl)
                {
                    // Hide every CM slot container so they don't paint
                    // behind the easy editor.
                    for (const child of Array.from(editorEl.children))
                    {
                        const el = /** @type {HTMLElement} */ (child);
                        if (el.classList.contains("editor-slot"))
                        {
                            el.dataset.cmHiddenForVisual = "1";
                            el.style.display = "none";
                        }
                    }
                    if (!state.easyEditorEl)
                    {
                        state.easyEditorEl = /** @type {HTMLElement} */ (
                            document.createElement("mps-easy-editor")
                        );
                        state.easyEditorEl.id = "mps-easy-editor-host";
                        editorEl.appendChild(state.easyEditorEl);
                    }
                    else
                    {
                        state.easyEditorEl.style.display = "";
                    }
                }
            }
            else
            {
                // If we were previously in Visual mode, the user may have
                // mutated the script via the visual editor (Insert Blank
                // Page, panel reorder, etc). Those edits live in the
                // RuntimeStorage `script` field; CodeMirror has no
                // store→buffer subscriber, so we explicitly serialise the
                // current AST and push it into the active CM view here.
                if (previousMode === "easy" && state.slotManager)
                {
                    try
                    {
                        const storeState = getRuntimeStorage().state;
                        const script = storeState?.script;
                        let source = null;
                        if (typeof script === "string")
                        {
                            source = script;
                        }
                        else if (script && typeof script === "object")
                        {
                            source = visualFormatScript(/** @type {any} */ (script));
                        }
                        if (typeof source === "string")
                        {
                            const active = state.slotManager.getActive();
                            const view = active?.view;
                            if (view && view.state.doc.toString() !== source)
                            {
                                view.dispatch({
                                    changes: {
                                        from: 0,
                                        to: view.state.doc.length,
                                        insert: source
                                    }
                                });
                            }
                        }
                    }
                    catch (e)
                    {
                        console.warn("[mode-switch] easy→CM sync failed:", e);
                    }
                }
                if (editorEl)
                {
                    for (const child of Array.from(editorEl.children))
                    {
                        const el = /** @type {HTMLElement} */ (child);
                        if (el.classList.contains("editor-slot")
                            && el.dataset.cmHiddenForVisual === "1")
                        {
                            delete el.dataset.cmHiddenForVisual;
                            // Slot manager owns `display:""` for the active
                            // slot — only the active slot will become
                            // visible; inactive slots stay hidden via the
                            // manager's own bookkeeping.
                            el.style.display = "";
                        }
                    }
                    // Re-run activate() so the active slot ends up the only
                    // visible one (mirrors the post-construction invariant).
                    const active = state.slotManager?.getActive();
                    if (active && state.slotManager)
                    {
                        state.slotManager.activate(active.tabId);
                    }
                }
                // Reconfigure every existing slot's CM compartment so the
                // user sees the new extension set immediately.
                if (state.slotManager)
                {
                    for (const slot of state.slotManager.list())
                    {
                        try { setEditorViewMode(slot.view, mode); }
                        catch (e)
                        {
                            console.warn("[mode-switch] setEditorViewMode failed for slot",
                                slot.tabId, e);
                        }
                    }
                }
            }

            // Show the line-number gutter only in Source mode — WYSIWYG and
            // Easy Editor hide it. CSS gate is `mps-editor-host[data-show-line-numbers]`.
            if (editorEl)
            {
                if (mode === "source")
                {
                    editorEl.setAttribute("data-show-line-numbers", "");
                }
                else
                {
                    editorEl.removeAttribute("data-show-line-numbers");
                }
            }

            // Mirror the mode onto the editor-area top bar so other
            // attribute-driven UI (e.g. format pill visibility) can react.
            // Pagination is NO LONGER gated on mode — it follows the active
            // file format instead (mangaplay → enabled, anything else →
            // visible-but-disabled), so the user can paginate the Storyboard
            // canvas from wysiwyg / source / easy alike. tooltip.js keys off
            // attr presence, so we drop `data-tooltip` while disabled to
            // suppress the hover.
            if (state.editorAreaTopBarEl)
            {
                state.editorAreaTopBarEl.setAttribute("data-mode", mode);
            }
            // Contextual editor toolbar shows only in WYSIWYG mode (slides up
            // + fades out otherwise; the element owns the animation).
            try { state.editorToolbarEl?.setMode(mode); }
            catch (e) { console.debug("[editor-toolbar] setMode threw:", e); }
            if (state.editorBarPagePrevBtn && state.editorBarPageNextBtn)
            {
                const format = getActivePaginationFormat();
                if (format === "mangaplay")
                {
                    const prevLabel = t("ui.paint.prevPage") || "Previous page";
                    const nextLabel = t("ui.paint.nextPage") || "Next page";
                    state.editorBarPagePrevBtn.setAttribute("data-tooltip", prevLabel);
                    state.editorBarPagePrevBtn.setAttribute("data-tooltip-side", "bottom");
                    state.editorBarPageNextBtn.setAttribute("data-tooltip", nextLabel);
                    state.editorBarPageNextBtn.setAttribute("data-tooltip-side", "bottom");
                    const { pageIndex: _pi, totalPages: _tp } = getPaginationState();
                    state.editorBarPagePrevBtn.disabled = _pi <= 0;
                    state.editorBarPageNextBtn.disabled = _pi >= _tp - 1;
                }
                else
                {
                    state.editorBarPagePrevBtn.disabled = true;
                    state.editorBarPageNextBtn.disabled = true;
                    state.editorBarPagePrevBtn.removeAttribute("data-tooltip");
                    state.editorBarPageNextBtn.removeAttribute("data-tooltip");
                }
            }
            if (state.editorBarFixIssuesBtn)
            {
                const slot = state.slotManager?.getActive();
                const supportedFormat = slot?.format === "mangaplay"
                    || slot?.format === "fountain";
                if (supportedFormat)
                {
                    const fixLabel = t("ui.easyEditor.fixStructuralIssues",
                        "Fix Structural Issues");
                    state.editorBarFixIssuesBtn.setAttribute("data-tooltip", fixLabel);
                    state.editorBarFixIssuesBtn.setAttribute("data-tooltip-side", "bottom");
                    state.editorBarFixIssuesBtn.setAttribute("aria-label", fixLabel);
                    if (typeof window.__mpsRefreshFixIssuesBtn === "function")
                    {
                        try { window.__mpsRefreshFixIssuesBtn(); } catch (_) {}
                    }
                    else
                    {
                        state.editorBarFixIssuesBtn.disabled = true;
                    }
                }
                else
                {
                    state.editorBarFixIssuesBtn.disabled = true;
                    state.editorBarFixIssuesBtn.removeAttribute("data-tooltip");
                }
            }

            // Remember module-side so future buildEditor() calls match.
            setEditorMode(mode);
            editorMode = mode;
            state.modeToggleEl.mode = mode;
            // Mode sync contract — single switchboard fans out to every
            // surface that displays current mode. App Footer's Mode Button
            // reflects the new icon; never tracks its own state.
            try { state.appFooter?.setMode(mode); }
            catch (e) { console.debug("[mode-switch] appFooter.setMode threw:", e); }

            // Restore keyboard focus to the editor after a mode switch.
            // Without this, the toggle button (a plain <button>) keeps focus
            // and silently swallows keystrokes — the user reports "cannot type
            // after switching modes". Visual mode owns its own focus model so
            // we skip it there.
            if ((mode === "wysiwyg" || mode === "source") && state.slotManager)
            {
                try
                {
                    const active = state.slotManager.getActive();
                    active?.view?.focus();
                }
                catch (e) { console.debug("[mode-switch] focus restore failed:", e); }
            }

            // Persist AFTER the switch succeeded — unless the caller asked
            // for a one-shot switch (e.g. empty-tab CTA file-create flow).
            if (persist)
            {
                try { await saveUserSettings({ editorMode: mode }); }
                catch (e) { console.debug("[mode-switch] persist failed:", e); }
            }
        }

        // 44px top bar across the editor host. Carries the pagination
        // chevrons on the left and the mode toggle on the right. The bar
        // overlays all three editor surfaces (WYSIWYG / Source / Easy Editor)
        // so a single chrome serves every mode. CSS in app.css owns the
        // positioning; we only build the shell + wire its children.
        if (editorEl)
        {
            state.editorAreaTopBarEl = document.createElement("div");
            state.editorAreaTopBarEl.className = "editor-area-top-bar";

            state.editorBarPagePrevBtn = /** @type {HTMLButtonElement} */ (
                document.createElement("button")
            );
            state.editorBarPagePrevBtn.type = "button";
            state.editorBarPagePrevBtn.className = "editor-bar-page-prev";
            state.editorBarPagePrevBtn.innerHTML = icon("arrow-left", { size: 16 });
            state.editorBarPagePrevBtn.addEventListener("click", () =>
            {
                if (state.editorBarPagePrevBtn?.disabled) return;
                paginationNavigate(-1);
            });

            state.editorBarPageNextBtn = /** @type {HTMLButtonElement} */ (
                document.createElement("button")
            );
            state.editorBarPageNextBtn.type = "button";
            state.editorBarPageNextBtn.className = "editor-bar-page-next";
            state.editorBarPageNextBtn.innerHTML = icon("arrow-right", { size: 16 });
            state.editorBarPageNextBtn.addEventListener("click", () =>
            {
                if (state.editorBarPageNextBtn?.disabled) return;
                paginationNavigate(1);
            });

            state.editorAreaTopBarEl.appendChild(state.editorBarPagePrevBtn);
            state.editorAreaTopBarEl.appendChild(state.editorBarPageNextBtn);

            // Fix Structural Issues — lucide wrench icon, sits right after
            // the page next chevron. Active only for mangaplay / fountain
            // formats (see mode-bridge above). Click rewrites the active
            // CM6 buffer via the pure source-text fixers in
            // ./structural-fixer.js. Disabled state refreshed via the
            // `window.__mpsRefreshFixIssuesBtn` window hook below.
            state.editorBarFixIssuesBtn = /** @type {HTMLButtonElement} */ (
                document.createElement("button")
            );
            state.editorBarFixIssuesBtn.type = "button";
            state.editorBarFixIssuesBtn.className = "editor-bar-fix-issues";
            state.editorBarFixIssuesBtn.innerHTML = icon("wrench", { size: 16 });
            state.editorBarFixIssuesBtn.addEventListener("click", () =>
            {
                if (state.editorBarFixIssuesBtn?.disabled) return;
                const slot = state.slotManager?.getActive();
                const view = slot?.view;
                if (!view) return;
                syncStructuralFixerConvention();
                const before = view.state.doc.toString();
                const after = fixIssues(slot.format, before);
                if (after === before) return;
                view.dispatch({
                    changes: { from: 0, to: view.state.doc.length, insert: after }
                });
            });
            state.editorAreaTopBarEl.appendChild(state.editorBarFixIssuesBtn);

            // Sync hook — mps-easy-editor calls this from its _render
            // wrapper after every AST round-trip so the disabled state of
            // the icon always reflects the current set of fixable issues.
            // Returns silently when no easy editor is mounted (wysiwyg /
            // source mode), when the button hasn't been built yet, or
            // when the top bar is not in visual mode.
            window.__mpsRefreshFixIssuesBtn = () =>
            {
                if (!state.editorBarFixIssuesBtn) return;
                const slot = state.slotManager?.getActive();
                const view = slot?.view;
                const supported = slot
                    && (slot.format === "mangaplay" || slot.format === "fountain");
                if (!view || !supported)
                {
                    state.editorBarFixIssuesBtn.disabled = true;
                    state.editorBarFixIssuesBtn.removeAttribute("data-tooltip");
                    state.editorBarFixIssuesBtn.removeAttribute("aria-label");
                    return;
                }
                // Tooltip is also set in the applyEditorMode bridge, but
                // we re-stamp here so it survives a slot activation that
                // doesn't trigger a mode switch (e.g. opening a Fountain
                // file directly into its default mode).
                const fixLabel = t("ui.easyEditor.fixStructuralIssues",
                    "Fix Structural Issues");
                state.editorBarFixIssuesBtn.setAttribute("data-tooltip", fixLabel);
                state.editorBarFixIssuesBtn.setAttribute("data-tooltip-side", "bottom");
                state.editorBarFixIssuesBtn.setAttribute("aria-label", fixLabel);
                syncStructuralFixerConvention();
                const text = view.state.doc.toString();
                state.editorBarFixIssuesBtn.disabled = !hasFixableIssues(slot.format, text);
            };

            // SuperScript alpha warning pill. Visibility driven by the
            // `data-format` attribute on the top bar (set by syncFormatToTopBar
            // when the active slot changes). The element stays mounted so we
            // don't churn the DOM on every format flip.
            const superscriptWarningEl = document.createElement("span");
            superscriptWarningEl.className = "editor-bar-superscript-warning";
            superscriptWarningEl.textContent = t("mangaplay-studio.banner.superscriptAlpha")
                || "SuperScript is in alpha — expect bugs";
            state.editorAreaTopBarEl.appendChild(superscriptWarningEl);

            state.editorAreaTopBarEl.appendChild(state.modeToggleEl);

            // Mobile / tablet only: a dedicated Find button beside the More
            // Options button. Desktop reaches Find via Ctrl+F or the More
            // Options → Find menu; mobile has neither a keyboard shortcut
            // nor an on-screen keyboard shortcut for it, so a first-class
            // affordance goes here.
            if (isMobileLike())
            {
                const findBtn = /** @type {HTMLButtonElement} */ (
                    document.createElement("button")
                );
                findBtn.type = "button";
                findBtn.id = "btn-editor-find";
                findBtn.className = "mps-editor-mode-toggle-btn editor-bar-find";
                findBtn.innerHTML = icon("search", { size: 18 });
                const findLabel = t("mangaplay-studio.menu.editor.find") || "Find";
                findBtn.setAttribute("aria-label", findLabel);
                findBtn.setAttribute("data-tooltip", findLabel);
                findBtn.setAttribute("data-tooltip-side", "bottom");
                findBtn.addEventListener("click", () =>
                {
                    openFind();
                    findBtn.blur();
                });
                state.editorAreaTopBarEl.appendChild(findBtn);
            }

            // More Options button — opens a context menu (Rename, Show in
            // Explorer, Reveal Navigator, Delete File). Styled to match the
            // mode toggle button (same .mps-editor-mode-toggle-btn class) so
            // the two sit visually together.
            const moreOptionsBtn = /** @type {HTMLButtonElement} */ (
                document.createElement("button")
            );
            moreOptionsBtn.type = "button";
            moreOptionsBtn.id = "btn-editor-more-options";
            moreOptionsBtn.className = "mps-editor-mode-toggle-btn editor-bar-more-options";
            moreOptionsBtn.innerHTML = icon("ellipsis-vertical", { size: 18 });
            const moreOptionsLabel = t("mangaplay-studio.menu.editor.moreOptionsTooltip")
                || "More Options";
            moreOptionsBtn.setAttribute("aria-label", moreOptionsLabel);
            moreOptionsBtn.setAttribute("data-tooltip", moreOptionsLabel);
            moreOptionsBtn.setAttribute("data-tooltip-side", isMobileLike() ? "bottom" : "left");
            moreOptionsBtn.addEventListener("click", () =>
            {
                if (isContextMenuOpen())
                {
                    closeContextMenu();
                }
                else
                {
                    openEditorMoreOptionsMenu(moreOptionsBtn);
                }
                if (moreOptionsBtn) moreOptionsBtn.blur();
            });
            state.editorAreaTopBarEl.appendChild(moreOptionsBtn);

            editorEl.appendChild(state.editorAreaTopBarEl);

            // Contextual editor toolbar — sits directly below the top bar,
            // visible only in Text mode for script formats. Buttons resolve
            // the live view/format at click-time via these accessors so tab
            // switches never leave the bar pointing at a stale slot.
            state.editorToolbarEl = /** @type {any} */ (
                document.createElement("mps-editor-toolbar")
            );
            // View resolution: the focused-view registry is the app-wide
            // authority on "the CM6 view the user is editing" — it covers
            // both the single-file slots AND the folder-aggregate's own
            // views (which mount ON TOP of a hidden slot view; reading the
            // slot manager there would dispatch into the hidden background
            // buffer). Same source find-controller.js uses. Aggregate views
            // stamp `__mpsFormat`; slot views resolve via the slot manager.
            state.editorToolbarEl.configure({
                getView: () =>
                    getFocusedView() || state.slotManager?.getActive()?.view || null,
                getFormat: () =>
                {
                    const focused = /** @type {any} */ (getFocusedView());
                    if (focused?.__mpsFormat) { return focused.__mpsFormat; }
                    return state.slotManager?.getActive()?.format || null;
                }
            });
            editorEl.appendChild(state.editorToolbarEl);

            // Reflect pagination state on the chevron buttons. Only honoured
            // when the active slot's format is `mangaplay` — other formats
            // keep the chevrons visible but disabled (gate enforced in the
            // applyEditorMode bridge above). Read `data-format` off the
            // editor-area top bar (stamped by syncFormatToTopBar) so we don't
            // need to re-resolve via slotManager on every page-state event.
            subscribePaginationState(({ pageIndex, totalPages }) =>
            {
                if (!state.editorBarPagePrevBtn || !state.editorBarPageNextBtn) return;
                if (state.editorAreaTopBarEl?.getAttribute("data-format") !== "mangaplay") return;
                state.editorBarPagePrevBtn.disabled = pageIndex <= 0;
                state.editorBarPageNextBtn.disabled = pageIndex >= totalPages - 1;
            });

            state.modeToggleEl.addEventListener("mps:mode-change", async (ev) =>
            {
                const next = /** @type {any} */ (ev).detail?.mode;
                if (!next) return;
                // Aggregate wins when mounted — fan the mode swap to all
                // three CM6 views (source↔text) or drain+mount canvas
                // (source/text↔visual). Fall through to the singleton
                // switchboard when no aggregate is live.
                try
                {
                    const mod = await import("../editor/aggregate-view.js");
                    const active = mod.getActiveAggregate();
                    if (active)
                    {
                        try { await active.applyMode(next); }
                        catch (e) { console.warn("[mode-change] aggregate.applyMode failed:", e); }
                        // Keep the persisted preference in sync with the
                        // aggregate's mode so the next single-file open
                        // starts in the same mode.
                        try
                        {
                            const { saveUserSettings } = await import("../project/user-settings.js");
                            await saveUserSettings({ editorMode: next });
                        }
                        catch (e) { console.warn("[mode-change] persist editorMode failed:", e); }
                        return;
                    }
                }
                catch (e) { console.warn("[mode-change] aggregate module import failed:", e); }
                void applyEditorMode(next);
            });
            // Expose the closure to module-level helpers so format-driven
            // downgrades (applyAllowedModesForFormat) can re-route through
            // the same single switchboard.
            state.applyEditorModeRef = applyEditorMode;
            // Seed the initial mode (also reconfigures Compartments for
            // pre-existing slots, mounts Visual if needed).
            void applyEditorMode(editorMode);
            // Apply allowed-mode constraints + warning pill for the active
            // slot's format. onSlotActivated re-applies this whenever the
            // user switches tabs.
            try
            {
                const initialFormat = state.slotManager?.getActive()?.format
                    || /** @type {any} */ (formatForFilename(state.currentProject?.scriptBasename || ""));
                applyAllowedModesForFormat(initialFormat);
            }
            catch (e) { console.debug("[mode-init] allowed-modes seed failed:", e); }
        }
        // ────────────────────────────────────────────────────────────────────

        // Empty-tab CTA — overlay shown over the active slot when its path
        // is null (the "Create New file" placeholder). Handlers:
        //   onCreateStoryboard: create a new .mangaplay.md at the project
        //                       root, adopt it into the active empty tab,
        //                       switch the editor to Easy Editor mode (one-shot,
        //                       does NOT persist the mode preference).
        //   onCreateScreenplay: same as above but creates a .fountain file
        //                       and switches to WYSIWYG mode.
        //   onClose:            close the active empty tab; the slot
        //                       manager auto-spawns a fresh one.
        /**
         * Create + adopt + mode-switch helper.
         *
         * 1. onCreate delegates to registryCreateFile; JS picks the next
         *    free `Untitled` basename by inspecting the sibling entries.
         * 2. replaceActiveTab — the canonical "swap the active tab to file X"
         *    helper. Handles broker re-anchor, mangaart cache swap, page-index
         *    restore, slot-switched dispatch, and explorer refresh in one go.
         *    Without this, the editor pane shows the new file but the
         *    right-pane storyboard stays anchored to the previous file's
         *    mangaart, and the explorer doesn't repaint its is-active marker.
         * 3. One-shot mode switch — persist:false so the user's global
         *    editorMode preference isn't overwritten.
         *
         * @param {"mangaplay"|"fountain"} kind
         * @param {"easy"|"wysiwyg"} mode
         */
        async function ctaCreateAndAdopt(kind, mode)
        {
            if (!state.currentProject?.path || !state.slotManager) return;
            // parentForCreation honours the explorer's last-focused folder
            // (so the new file lands where the user is browsing), falling
            // back to <projectRoot>/project — which is where the v2 layout
            // expects scripts to live and where the explorer reads from.
            // Passing currentProject.path directly drops the file at the
            // PROJECT ROOT, outside the project/ subtree the explorer
            // walks; the file is created on disk but invisible in the UI.
            const parent = parentForCreation();
            if (!parent) return;
            // onCreate already handles the broker lock, self-change marking,
            // banner surfacing on error, and explorer refresh.
            const createdPath = await onCreate(parent, kind);
            if (!createdPath) return;

            await replaceActiveTab(createdPath);
            await applyEditorMode(mode, { persist: false });
        }

        state.emptyTabCta = mountEmptyTabCta(
            /** @type {HTMLElement} */ (editorEl),
            {
                onCreateStoryboard: () => ctaCreateAndAdopt("mangaplay", "easy"),
                onCreateScreenplay: () => ctaCreateAndAdopt("fountain", "wysiwyg"),
                onClose: async () =>
                {
                    const active = state.slotManager?.getActive();
                    if (active) await state.slotManager.close(active.tabId);
                }
            }
        );

        state.rightPaneEmpty = mountRightPaneEmpty();

        // Boot — restore prior tab snapshot if any. Each restored entry
        // either references a file path (read from disk; skipped on read
        // failure) or carries a null path (fresh "New tab" placeholder).
        // We honour the persisted tab id on each slot so activeTabId still
        // matches after restore. The slot manager uses an array (no Map
        // index), so directly patching `tabId` after openNew is safe — get()
        // walks the array.
        let bootRestored = false;
        let restoredInitialDoc = "";
        try
        {
            if (state.currentProject?.path)
            {
                // Legacy migration: legacy {id, path, fileUuid:null} tabs get
                // their fileUuid resolved via the registry before restore.
                // Best-effort — never blocks boot.
                try { await migrateLegacyTabEntries(state.currentProject.path); }
                catch (e) { console.warn("[session] migrateLegacyTabEntries failed:", e); }
                const snap = await getTabSnapshot(state.currentProject.path);
                for (const entry of snap.openTabs)
                {
                    if (entry.path)
                    {
                        try
                        {
                            const text = (await readFile(entry.path)) ?? "";
                            const base = basename(entry.path);
                            state.slotManager.openNew(
                                entry.path,
                                text,
                                /** @type {any} */ (formatForFilename(base)),
                                /** @type {any} */ (entry).fileUuid ?? null
                            );
                            const newest = state.slotManager.list().at(-1);
                            if (newest) newest.tabId = entry.id;
                        }
                        catch (e)
                        {
                            console.warn(`[session] tab ${entry.path} failed to restore:`,
                                /** @type {any} */ (e)?.message || e);
                        }
                    }
                    else
                    {
                        state.slotManager.openNew(null, "", /** @type {any} */ ("general-text"));
                        const newest = state.slotManager.list().at(-1);
                        if (newest) newest.tabId = entry.id;
                    }
                }
                if (state.slotManager.list().length > 0)
                {
                    bootRestored = true;
                    const target = snap.activeTabId && state.slotManager.get(snap.activeTabId)
                        ? snap.activeTabId
                        : state.slotManager.list()[0].tabId;
                    state.slotManager.activate(target);
                    const active = state.slotManager.getActive();
                    if (active)
                    {
                        try { restoredInitialDoc = active.view.state.doc.toString(); }
                        catch (_e) { restoredInitialDoc = ""; }
                    }
                }
            }
        }
        catch (e)
        {
            console.warn("[session] restore failed:", /** @type {any} */ (e)?.message || e);
        }

        // Fallback when nothing restored — open the project's main script,
        // or a scratch tab when no project script is set (locked decision
        // #10 — the strip is never empty).
        const initialDoc = bootRestored ? restoredInitialDoc : (state.currentProject?.script || "");
        if (!bootRestored)
        {
            const initialPath = state.currentProject?.scriptPath || null;
            if (initialPath)
            {
                state.slotManager.openNew(
                    initialPath,
                    initialDoc,
                    /** @type {any} */ (formatForFilename(state.currentProject?.scriptBasename || ""))
                );
            }
            else
            {
                state.slotManager.openNew(
                    null,
                    "",
                    /** @type {any} */ ("general-text")
                );
            }
        }
        _setCurrentDoc(initialDoc);
        // Seed RuntimeStorage so the canvas mounts with parsed pages instead
        // of waiting for the first keystroke.
        publishParsedScript(initialDoc);

        // ── aggregate session restore ─────────────────────────────────
        // If the previous session had an aggregate open AND the folder
        // still exists AND its type is still storyboard/screenplay, mount
        // the aggregate on top of the single-file tab we just restored.
        // The single-file tab remains behind the aggregate host — closing
        // the aggregate reveals it. Fallbacks per plan §2.8:
        //   - folder gone → skip (leave openTabs restore alone).
        //   - type reverted → skip (single-file tab stands as-is).
        //   - focused file moved out of folder → focus alphabetically-
        //     first remaining child, scrollTop reset.
        try
        {
            const { renderGroupsAsOne } = await import("../editor/aggregate-view.js");
            if (renderGroupsAsOne && state.currentProject?.path)
            {
                const { getAggregateSession, getFolderType, listProjectTree } = await import("../project/project.js");
                const agSession = await getAggregateSession(state.currentProject.path);
                if (agSession)
                {
                    const folderType = await getFolderType(state.currentProject.path, agSession.folderUuid);
                    if (folderType === "storyboard" || folderType === "screenplay")
                    {
                        const entries = await listProjectTree(state.currentProject.path);
                        const folder = entries.find((e) => e.uuid === agSession.folderUuid);
                        if (folder)
                        {
                            const wantedFormat = folderType === "storyboard" ? "mangaplay" : "fountain";
                            const siblings = entries
                                .filter((e) => e.parentUuid === folder.uuid
                                    && e.kind === "file"
                                    && formatForFilename(e.name) === wantedFormat)
                                .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
                            if (siblings.length > 0)
                            {
                                let focusedUuid = agSession.focusedFileUuid;
                                if (!siblings.find((s) => s.uuid === focusedUuid))
                                {
                                    focusedUuid = siblings[0].uuid;
                                }
                                const focusedEntry = siblings.find((s) => s.uuid === focusedUuid);
                                if (focusedEntry)
                                {
                                    const projRoot = state.currentProject.path.replace(/[\\/]+$/, "");
                                    const focusedPath = `${projRoot}/${focusedEntry.relPath}`;
                                    // replaceActiveTab's aggregate router
                                    // will re-mount for us — pass the
                                    // scrollTop hint via the aggregate
                                    // session (already written) so
                                    // openAggregateForFile picks it up.
                                    // We call it AFTER a microtask so the
                                    // slot manager finishes restore first.
                                    setTimeout(() =>
                                    {
                                        (async () =>
                                        {
                                            try
                                            {
                                                const { replaceActiveTab } = await import("./explorer.js");
                                                await replaceActiveTab(focusedPath, focusedUuid);
                                            }
                                            catch (e) { console.warn("[session] aggregate restore failed:", e); }
                                        })();
                                    }, 0);
                                }
                            }
                        }
                    }
                }
            }
        }
        catch (e) { console.warn("[session] aggregate restore threw:", e); }
    }

    if (canvasEl) {
        const debouncedMangaartSave = (pageId) =>
        {
            if (!state.currentProject) return;
            const key = String(pageId ?? "_all");
            // Capture the mangaart cache KEY at schedule time — NOT inside
            // the debounce closure. Reading `state.slotManager.getActive()`
            // at flush time would race with file switches during the
            // debounce window: the queued drawing belongs to the file that
            // was active when scheduleMangaartSave fired, and must be
            // written to that file's on-disk `.mangaart`, not whatever the
            // user has since navigated to. Same reasoning for the boot-
            // window fallback path.
            const projectPath = state.currentProject.path;
            const capturedFileUuid = state.slotManager?.getActive()?.fileUuid || null;
            const capturedRel = capturedFileUuid
                ? null
                : (scriptRelPathOf(projectPath, state.currentProject.scriptPath)
                    || state.currentProject.scriptBasename);
            const cacheKey = capturedFileUuid
                ? "file:" + capturedFileUuid
                : "path:" + capturedRel;
            const capturedEntry = getMangaartCacheByKey(cacheKey);
            // Payload is the cached art blob. The broker uses this only for
            // drain/telemetry — the actual write reads the entry back by
            // key inside the saver so late in-place mutations still land.
            broker.scheduleMangaartSave(key, capturedEntry ? capturedEntry.art : null, async () =>
            {
                try
                {
                    setSaveState("saving");
                    if (capturedFileUuid)
                    {
                        await saveMangaartByUuid(projectPath, capturedFileUuid);
                    }
                    else
                    {
                        // Boot window fallback: no active slot UUID yet.
                        await saveMangaart(projectPath, capturedRel);
                    }
                    setSaveState("saved");
                    if (state.saveFailureBannerShown) state.saveFailureBannerShown = false;
                }
                catch (e)
                {
                    console.error("Failed to save mangaart:", e);
                    setSaveState("dirty");
                    if (!state.saveFailureBannerShown)
                    {
                        const reason = (e && /** @type {any} */ (e).message) ? /** @type {any} */ (e).message : String(e);
                        showBanner(t("mangaplay-studio.banner.saveFailed", { reason }));
                        state.saveFailureBannerShown = true;
                    }
                }
            });
        };

        /** @type {any} */
        (globalThis).__MPS_DESKTOP__ =
        {
            // Per-file slot id so RuntimeDrawingCache, PersistentStorage
            // pending-sync buffer, and IDB drawing-store all key drawings
            // by the SCRIPT they belong to. Prefer the file's registry UUID
            // — path-based slot IDs go stale mid-rename/move and cause the
            // canvas's stale-hydrate guard to drop the newly-loaded strokes.
            // Fall back to project-relative path for the boot window before
            // the active slot has resolved its fileUuid.
            getActiveSlotId: () => {
                if (!state.currentProject?.path) return null;
                const fileUuid = state.slotManager?.getActive()?.fileUuid || null;
                if (fileUuid) return `${state.currentProject.path}::uuid:${fileUuid}`;
                const rel = scriptRelPathOf(state.currentProject.path, state.currentProject.scriptPath)
                    || state.currentProject.scriptBasename
                    || "";
                return rel ? `${state.currentProject.path}::${rel}` : state.currentProject.path;
            },
            getMangaart: () => getMangaartCache(),
            updatePage: (pageIndex, drawing) => updateMangaartPage(pageIndex, drawing),
            queueSave: (pageId) => debouncedMangaartSave(pageId),
            // Test hook — lets driver smoke tests exercise the same
            // switchProject code path the project-switcher dropdown uses,
            // without needing to drive the popup menu UI from CDP.
            switchProject: (path) => switchProject(path),
            currentProjectPath: () => state.currentProject?.path || null,
        };

        state.canvasApi = await initCanvas(canvasEl, {
            onSave: (pageIndex, drawing) =>
            {
                if (!state.currentProject) return;
                updateMangaartPage(pageIndex, drawing);
                setSaveState("dirty");
                debouncedMangaartSave(pageIndex);
            },
        });
        // Seed the canvas with the current doc so its pageCount matches
        // the initial state without waiting for the first keystroke.
        if (state.canvasApi && typeof state.canvasApi.setScript === "function") {
            state.canvasApi.setScript(currentDoc);
        }

        // Defer two frames so the slider has finished its initial layout, then
        // force the website canvas to re-fit. Without this, the engine attaches
        // pointer listeners to a 0×0 .drawing-canvas before the slider's initial
        // translateX transition has resolved, and draw input never registers.
        requestAnimationFrame(() =>
        {
            requestAnimationFrame(() =>
            {
                const c = document.querySelector("mps-canvas");
                if (c && typeof c.fitToContainer === "function")
                {
                    try { c.fitToContainer(true); } catch {}
                }
                if (c && typeof c.resizeDrawingCanvas === "function")
                {
                    try { c.resizeDrawingCanvas(); } catch {}
                }
                // Nudge the active tool so applyDrawingTool re-binds the pencil.
                document.dispatchEvent(new CustomEvent("paint-tool-change", { detail: { tool: "pencil" } }));
            });
        });
    }

    // Apply initial view mode from app settings (shell layout is app-wide).
    // Mobile/tablet first-boot lands on editor (solo-mangaplay). After that,
    // whatever the user last chose via the FAB toggle is honoured. Flag lives
    // in user-settings.json so it's per-install (persists across app updates).
    const __shellSettings = globalThis.__MPS_APP_SETTINGS__ || {};
    const __mobile = isMobileLike();
    let __restoreMode = __shellSettings.viewMode;
    if (__mobile)
    {
        const seenBefore = getUserSetting("mobileFirstBootDone", false) === true;
        if (!seenBefore)
        {
            __restoreMode = "solo-mangaplay";
            saveUserSettings({ mobileFirstBootDone: true }).catch(() => {});
        }
        else if (__restoreMode === "dual")
        {
            __restoreMode = __shellSettings.lastSoloMode || "solo-mangaplay";
        }
    }
    if (__restoreMode) {
        setViewMode(__restoreMode);
        if (__shellSettings.lastSoloMode) {
            state.lastSoloMode = __shellSettings.lastSoloMode;
        }
    }
    if (state.currentProject?.meta?.printPreview) {
        const sp = document.querySelector("mps-screenplay");
        if (sp) sp.setAttribute("data-screenplay-mode", "paginated");
    }

    // Per-project sidebar relocation — `mps-canvas` re-creates its child
    // <mps-quick-toggle-sidebar> on each project mount.
    wireQuickToggleRelocation();

    // Per-project meta restore (shell DOM has already been wired once by
    // `wireShellOnce()` at boot).
    restoreShellMeta();
    refreshProjectSwitcher();
    updateEmptyState();

    // ── App Footer + Google Docs sync gear ──────────────────────────────
    // The App Footer is the 200×30 bottom-right panel owning the mode
    // button, word / char counts, and the Google Docs sync gear. It's
    // built once per app lifetime; project switches just call
    // setMode / recountNow / setSyncState on the same controller.
    //
    // mountGoogleDocsFooter no longer creates its own DOM — it accepts the
    // gear-controller adapter below so the SyncStateMachine drives the
    // shared App Footer instead of a separate full-width bar.
    try
    {
        const footerHost = /** @type {HTMLElement|null} */ (
            document.getElementById("app-footer"));
        if (footerHost && !state.appFooter)
        {
            state.appFooter = mountAppFooter({
                host: footerHost,
                getActiveSlot: () => state.slotManager?.getActive() || null,
                applyEditorMode: (mode) =>
                {
                    // Re-route through whatever applyEditorMode closure the
                    // current project mount installed (matches the top-bar
                    // toggle's path). Bridge ref because the closure is
                    // captured per-mount.
                    if (state.applyEditorModeRef) return state.applyEditorModeRef(mode);
                },
                getEditorMode: () =>
                {
                    // Read the live attribute on modeToggleEl — the single
                    // source of truth post-applyEditorMode. Falls back to
                    // "wysiwyg" on cold boot before applyEditorMode runs.
                    return /** @type {any} */ (
                        state.modeToggleEl?.getAttribute("mode") || "wysiwyg");
                },
                getDocumentText: () =>
                {
                    // Visual mode reads the AST in RuntimeStorage; serialise
                    // before counting. WYSIWYG / Source read the active CM
                    // slot via the manager's getActiveSlot bridge.
                    try
                    {
                        const mode = state.modeToggleEl?.getAttribute("mode");
                        if (mode === "easy")
                        {
                            const script = getRuntimeStorage().state?.script;
                            if (typeof script === "string") return script;
                            if (script && typeof script === "object")
                            {
                                return visualFormatScript(/** @type {any} */ (script));
                            }
                            return "";
                        }
                    }
                    catch (e) { console.debug("[app-footer] visual read threw:", e); }
                    const slot = state.slotManager?.getActive();
                    return slot?.view?.state?.doc?.toString?.() || "";
                }
            });
            // The footer's previous sync gear is gone — publish-doc pill
            // (registered below) absorbs its click-target + anchor roles.
            state.appFooter.show();
        }

        if (state.appFooter)
        {
            // Mount the Google Docs sync state-machine bootstrap. The
            // gear is gone — its three responsibilities (state colour,
            // click target, popover anchor) now live on the publish-doc
            // pill, which gets registered via setPublishDocPillController
            // immediately below. The adapter we pass here keeps the footer
            // visible across script switches and forwards setLockState +
            // anchor lookup through the pill controller.
            mountGoogleDocsFooter({
                setSyncState: (_state) => { /* publish-doc pill consumes via setPublishDocPillController */ },
                setLockState: (lockState) => { try { state.publishDocPillCtrl?.setLockState(lockState); } catch {} },
                show: () => state.appFooter?.show(),
                hide: () => { /* keep footer visible even when no GDoc */ },
                getAnchorEl: () => /** @type {HTMLElement} */ (state.publishDocPillCtrl?.getHostEl?.() || state.appFooter?.publishDocPillEl),
                setFilename: (_name) => { /* shown in the sync popover header */ }
            }, {
                getAuthToken: async () =>
                {
                    try
                    {
                        const t = await getAccessToken({ allowRefresh: true });
                        return t;
                    }
                    catch (e)
                    {
                        return null;
                    }
                },
                getUserProfile: () =>
                {
                    const p = getCurrentProfile();
                    return { name: p?.name || p?.email || null };
                },
                getClientId: () => getOrCreateClientId(),
                getScriptContext: () =>
                {
                    const slot = state.slotManager?.getActive();
                    return {
                        format: slot?.format || "text",
                        sourceText: slot?.view?.state?.doc?.toString?.() || ""
                    };
                }
            });

            // Wire the App Footer's Publish Doc pill. With the gear gone,
            // this pill is the single click-target + popover-anchor for the
            // Google Docs sync surface. The bootstrap drives setSyncState
            // + setLockState + show/hide via setPublishDocPillController().
            try
            {
                const pillHost = state.appFooter.publishDocPillEl;
                if (pillHost)
                {
                    state.publishDocPillCtrl = mountPublishDocPill({ host: pillHost });
                    setPublishDocPillController(state.publishDocPillCtrl);
                }
            }
            catch (e) { console.warn("[wireShellOnce] mountPublishDocPill failed:", e?.message); }

            // Wire the App Footer's Publish Slides pill. Opens the same
            // openPublishSlidesModal used by the explorer's context menu.
            // Greyed out on non-mangaplay scripts (matches menu-item visibility
            // rule from explorer.js).
            try
            {
                const slidesHost = state.appFooter.publishSlidesPillEl;
                if (slidesHost)
                {
                    state.publishSlidesPillCtrl = mountPublishSlidesPill({
                        host: slidesHost,
                        getScriptFormat: () => state.activeFormat || null,
                        getIsLinked:     () => Boolean(state.slidesLinkedForActive),
                        // Storyboard-folder scope — when the active file lives
                        // in a Storyboard Folder, the pill flips to the
                        // "ready-group" tooltip variant. The flag is refreshed
                        // by onSlotActivated (app.js) alongside slidesLinkedForActive.
                        getIsStoryboardFolder: () => Boolean(state.publishScopeIsFolder),
                        getSyncStatus:  () => state.slidesSyncStatus,
                    });
                    state.publishSlidesPillCtrl.setClickHandler(async () =>
                    {
                        // @ts-ignore __MPS_MOBILE__ injected by build-bundle.js define
                        if (__MPS_MOBILE__) return;
                        try
                        {
                            const active = state.slotManager?.getActive();
                            const localPath = active?.path || "";
                            const basename = active?.basename || "Untitled";
                            let projectPath = "";
                            let scriptRelPath = "";
                            if (state.currentProject && localPath)
                            {
                                projectPath = state.currentProject.path || "";
                                const projNorm = projectPath.replace(/\\/g, "/");
                                const slotNorm = String(localPath).replace(/\\/g, "/");
                                scriptRelPath = slotNorm.startsWith(projNorm + "/")
                                    ? slotNorm.slice(projNorm.length + 1)
                                    : basename;
                            }
                            // Script AST + source text live in the runtime store,
                            // not the shell state. Format lives on the shell state.
                            const runtime = getRuntimeStorage().state || {};
                            const activeFileUuid = active?.fileUuid || null;
                            const [mod, authMod, scopeMod] = await Promise.all([
                                import("../google-slides-sync/publish-slides-modal.js"),
                                import("../auth/google-oauth.js"),
                                import("../google-slides-sync/publish-scope.js"),
                            ]);
                            // Resolve the publish scope BEFORE opening the modal.
                            // Storyboard folder → publish the whole folder as an
                            // aggregate script. Otherwise → single-file.
                            const resolved = await scopeMod.resolvePublishScope({
                                projectPath,
                                activeFileUuid,
                                activeBasename: basename,
                                fallbackSourceText: runtime.scriptSourceText || "",
                                fallbackScript: runtime.script,
                            });
                            await mod.openPublishSlidesModal({
                                script: resolved.script,
                                scriptFormat: state.activeFormat,
                                sourceText: resolved.sourceText,
                                basename,
                                localPath,
                                projectPath,
                                scriptRelPath,
                                publishScope: resolved.scope,
                                authClient: {
                                    getAccessToken: (opts) => authMod.getAccessToken(opts),
                                },
                                // Fires from step 5 of the progress panel —
                                // after `slides_link_save` succeeds. Flip
                                // the in-memory linked flag + refresh the
                                // pill immediately so the user sees the
                                // linked indicator light up without waiting
                                // for the next slot activation.
                                onLinked: () =>
                                {
                                    state.slidesLinkedForActive = true;
                                    state.slidesSyncStatus = "synced";
                                    try { state.publishSlidesPillCtrl?.refresh(); }
                                    catch (_) { /* best-effort */ }
                                },
                                // Fires after Unlink succeeds. Mirror onLinked
                                // inverted: flip flag false + refresh pill.
                                // Also re-fire onSlotActivated so the right-pane
                                // storyboard-mode controller re-evaluates and
                                // unmounts <mps-display> immediately.
                                onUnlinked: () =>
                                {
                                    state.slidesLinkedForActive = false;
                                    state.slidesSyncStatus = null;
                                    try { state.publishSlidesPillCtrl?.refresh(); }
                                    catch (_) { /* best-effort */ }
                                    try
                                    {
                                        const activeSlot = state.slotManager?.getActive();
                                        if (activeSlot) onSlotActivated(activeSlot);
                                    }
                                    catch (_) { /* best-effort */ }
                                },
                                // Fires after a local-storyboard import writes
                                // new PNGs into the deck manifest. Re-fire
                                // onSlotActivated so <mps-display> re-reads
                                // the manifest and picks up the new pages.
                                onStoryboardImported: () =>
                                {
                                    try
                                    {
                                        const activeSlot = state.slotManager?.getActive();
                                        if (activeSlot) onSlotActivated(activeSlot);
                                    }
                                    catch (_) { /* best-effort */ }
                                },
                            });
                        }
                        catch (e) { console.warn("[publish-slides-pill] open failed:", e?.message); }
                    });
                }
            }
            catch (e) { console.warn("[wireShellOnce] mountPublishSlidesPill failed:", e?.message); }

            // Wire the App Footer's Google Account pill. Stateless projection
            // of auth + navigator.onLine; clicks open Settings → Account.
            try
            {
                const accountHost = state.appFooter.accountPillEl;
                if (accountHost) mountGoogleAccountPill({ host: accountHost });
            }
            catch (e) { console.warn("[wireShellOnce] mountGoogleAccountPill failed:", e?.message); }

            // Seed the mode icon + counts now that the footer is mounted.
            try
            {
                const initialMode = /** @type {any} */ (
                    state.modeToggleEl?.getAttribute("mode") || "wysiwyg");
                state.appFooter.setMode(initialMode);
            }
            catch (e) { console.debug("[app-footer] initial setMode threw:", e); }
            try { state.appFooter.recountNow(); }
            catch (e) { console.debug("[app-footer] initial recount threw:", e); }
        }
    }
    catch (err) { console.warn("[app-footer] mount failed:", err); }
}
