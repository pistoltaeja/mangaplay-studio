import { state } from "./state.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri, basename } from "../util/index.js";
import { t } from "../adapters/tauri-i18n.js";
import { showBanner } from "../boot/toast.js";
import { getBroker } from "../project/active-script-broker.js";
import { registryListTree } from "../adapters/tauri-storage.js";
import { refreshExplorer, consumeSelfChange, peekSelfChange } from "./explorer.js";
import { getActiveAggregate } from "../editor/aggregate-view.js";
import { confirmModal } from "../modals/confirm-modal.js";

// ── aggregate-view fs-event fan-out ──────────────────────────────────────
//
// When an aggregate is mounted, fs-listeners forwards folder-scoped events
// (rename/move/delete/create + modified-with-buffer) into the handle.
// Modified events on a file with pending buffer edits fire an interactive
// prompt (Keep buffer / Reload from disk). Prompt state is guarded per
// fileUuid to avoid stacking modals on burst events.
//
// Debounce: fs bursts (atomic-write rename → deleted+created+modified)
// arrive in-order; we coalesce per-uuid via a 100ms trailing timer so the
// aggregate handle sees at most one call per uuid per burst window.

/** @type {Map<string, number>} */
const aggregateFsDebounce = new Map();

/** @type {Set<string>} */
const reconcileInFlight = new Set();

/**
 * Fire-and-forget: schedule a debounced dispatch of `event` into the
 * active aggregate. Coalesced by uuid so 8 events for the same file
 * within 100ms produce one handler call.
 * @param {import("../editor/aggregate-view.js").FsChangeEvent} event
 */
function scheduleAggregateFsChange(event)
{
    const active = getActiveAggregate();
    if (!active) return;
    const key = event.uuid || event.newPath || event.oldPath || String(Math.random());
    const existing = aggregateFsDebounce.get(key);
    if (existing !== undefined)
    {
        clearTimeout(existing);
    }
    const handle = setTimeout(async () =>
    {
        aggregateFsDebounce.delete(key);
        const stillActive = getActiveAggregate();
        if (!stillActive) return;
        try { await stillActive.onFsChange(event); }
        catch (e) { console.warn("[fs-listeners] aggregate.onFsChange threw:", e); }
    }, 100);
    aggregateFsDebounce.set(key, /** @type {any} */ (handle));
}

/**
 * If the aggregate has a mounted view for `fileUuid` AND that view has
 * unsaved edits, prompt the user (Keep buffer / Reload). Otherwise treat
 * the modification as a silent buffer-reload — the CM6 view has no dirty
 * state to lose. Guarded per uuid to prevent modal-stacking on bursts.
 * @param {string} fileUuid
 */
async function promptReconcileIfNeeded(fileUuid)
{
    const active = getActiveAggregate();
    if (!active) return;
    if (!active.isFileMounted(fileUuid)) return;
    if (reconcileInFlight.has(fileUuid)) return;
    reconcileInFlight.add(fileUuid);
    try
    {
        if (active.hasUnsavedBufferForFile(fileUuid))
        {
            // Modal: block until user picks. English literals for now —
            // adding 4 new keys × 14 locales for one prompt is out of
            // scope for Round B; migrate when the locale bundle grows.
            const reload = await confirmModal({
                title: "External change detected",
                body: "This file changed on disk while you had unsaved edits. Reload from disk (discards your edits) or keep your buffer?",
                confirm: "Reload from disk",
                cancel: "Keep buffer",
                danger: true,
            });
            await active.reconcileExternal(fileUuid, reload ? "reload" : "keep");
        }
        else
        {
            // Silent reload — nothing to conflict.
            await active.reconcileExternal(fileUuid, "reload");
        }
    }
    catch (e) { console.warn("[fs-listeners] reconcile prompt threw:", e); }
    finally
    {
        reconcileInFlight.delete(fileUuid);
    }
}

/**
 * Wire the cross-window `project-fs-changed` listener. Each Tauri window
 * receives the event so window B reacts when window A mutates the FS.
 */
/**
 * Stored `UnlistenFn` returned by `w.listen("project-fs-changed", ...)`.
 * Currently unused — preserved for a future shutdown / window-close hook
 * that needs to detach the listener cleanly (see plan
 * path-portability-and-watcher-followups.md N1).
 */
export async function wireProjectFsChangedListener()
{
    // One-shot: project-fs-changed handler watches `currentProject` by closure,
    // so re-wiring on each project swap would stack handlers (leak). Two-step
    // guard: set the flag BEFORE the await so concurrent callers return early
    // (prevents stacking), and reset it on failure / non-Tauri host so a failed
    // wire stays retryable on the next call.
    if (state.projectFsChangedWired) return;
    state.projectFsChangedWired = true;
    try
    {
        const w = isTauri() ? getCurrentWindow() : null;
        if (!w || typeof w.listen !== "function")
        {
            state.projectFsChangedWired = false;
            return;
        }
        await w.listen("project-fs-changed", async ({ payload }) =>
        {
            try
            {
                if (!state.currentProject) return;
                if (!payload?.path) return;
                // SEPARATOR CONTRACT: payload.path arrives from Rust as a platform-native
                // string (see lib.rs emit_fs_changed). currentProject.path also comes via
                // Tauri's dialog plugin in native form. Both should match in separator
                // style on a given host — but the verify-first watcher item (plan:
                // path-portability-and-watcher-followups.md) checks this on Windows
                // before we drop the explicit sep inference below.
                const root = state.currentProject.path;
                // Accept exact-match (the root itself) OR path starts with
                // root+separator. Without the separator check a sibling dir
                // like /a/bc would match /a/b.
                const sep = root.includes("\\") ? "\\" : "/";
                if (payload.path !== root && !payload.path.startsWith(root + sep)) return;

                // If the NEW registry-fs-changed listener is wired, it is the
                // authoritative handler — emits the banner + refreshExplorer
                // itself. The OLD project-fs-changed listener must still run
                // to DRAIN the __mpsSelfChanges TTL mark (so it doesn't leak),
                // but must NOT emit its own UI updates or we'd double-toast
                // and double-refresh per event.
                if (state.registryFsChangedWired && payload?.path)
                {
                    consumeSelfChange(payload.path);
                    return;
                }

                // Tauri emits project-fs-changed to ALL windows, including the
                // one that initiated the change. To avoid showing "File deleted
                // externally" when WE just deleted it locally, the local
                // mutation entry points (onCopy / onDelete / handleRename /
                // onCreate) mark expected events in `__mpsSelfChanges`. The
                // handler consumes the mark before treating the event as
                // external.
                if (consumeSelfChange(payload.path))
                {
                    await refreshExplorer();
                    return;
                }

                const broker = getBroker();
                const change = payload.change || {};
                const type = change.type;

                if (type === "renamed" && broker.isActivePath(payload.path))
                {
                    broker.unlock(change.to ?? null);
                    // Update the slot for the active tab too so its label
                    // tracks the external rename.
                    const activeSlot = state.slotManager?.getActive();
                    if (activeSlot)
                    {
                        state.slotManager.renamePath(activeSlot.tabId, change.to ?? null);
                    }
                    if (state.currentProject)
                    {
                        state.currentProject.scriptPath = change.to ?? null;
                        const newBase = basename(change.to);
                        if (newBase) state.currentProject.scriptBasename = newBase;
                    }
                    showBanner(t("mangaplay-studio.banner.fileRenamedExternally"));
                }
                else if (type === "deleted" && broker.isActivePath(payload.path))
                {
                    broker.unlock(null);
                    if (state.currentProject) state.currentProject.scriptPath = null;
                    // Close the active slot; slot manager auto-spawns a
                    // fresh empty tab.
                    const activeSlot = state.slotManager?.getActive();
                    if (activeSlot) await state.slotManager.close(activeSlot.tabId);
                    showBanner(t("mangaplay-studio.banner.fileDeletedExternally"));
                }
                else if (type === "created" || type === "modified")
                {
                    // Note: self-initiated creates are consumed by consumeSelfChange() above
                    // (see the dedup call earlier in this handler), so this branch only
                    // fires for genuine external events. Don't re-flag as a bug.
                    // External create or modify. On Linux backends an
                    // atomic-write rename surfaces as Created on the final
                    // path (the .tmp is dropped by the ignore filter); on
                    // Windows/macOS the same operation collapses to Modified
                    // via map_notify_event's rename rule. Both shapes mean
                    // the same thing to the user: "the file I have open just
                    // changed under me". If it's the active script, surface a
                    // banner so the user knows the on-disk content diverged
                    // from the buffer. For other files in the explorer, the
                    // trailing refreshExplorer() picks up the mtime change.
                    if (broker.isActivePath(payload.path))
                    {
                        const base = basename(payload.path);
                        showBanner(t("mangaplay-studio.banner.fileModifiedExternally", { file: base }));
                    }
                }
                else if (type === "created-dir")
                {
                    // Directory was created externally. No file to open —
                    // the trailing refreshExplorer() surfaces the new folder.
                }
                await refreshExplorer();
            }
            catch (e) { console.warn("[fs-changed] handler failed:", e); }
        });
    }
    catch (e)
    {
        // Reaches here only when w.listen() itself throws — the non-Tauri
        // jsdom path is handled by the explicit early-return above, so this
        // catch is the real Tauri-failure case. Log at warn (a silent failure
        // here disables cross-window fs notifications) and clear the flag so
        // the next call can retry.
        state.projectFsChangedWired = false;
        console.warn("[fs-changed] listener wiring failed:", e?.message);
    }
}

/**
 * UUID-identity sibling of `wireProjectFsChangedListener`. Runs in parallel
 * with the legacy path-based listener during the UUID file registry migration;
 * the legacy listener is removed once the broker migrates off paths. Both
 * listeners peek — but do not consume — the same `__mpsSelfChanges` TTL marks
 * so neither races the other's cleanup.
 */
export async function wireRegistryFsChangedListener()
{
    if (state.registryFsChangedWired) return;
    state.registryFsChangedWired = true;
    try
    {
        if (!isTauri())
        {
            state.registryFsChangedWired = false;
            return;
        }
        const { subscribeRegistryFsChanged } = await import("../adapters/tauri-storage.js");
        await subscribeRegistryFsChanged(async (change) =>
        {
            try
            {
                if (!state.currentProject) return;
                if (!change || !change.change) return;

                // Rust emits relPath with forward slashes relative to the
                // project root; strip any trailing separator from the root
                // before joining to avoid double slashes on Windows.
                const derivedPath = change.relPath
                    ? `${state.currentProject.path.replace(/[\\/]+$/, "")}/${change.relPath}`
                    : null;

                // Legacy listener consumes the self-change mark and refreshes
                // the explorer; bail out here so we don't double-refresh or
                // race the cleanup.
                if (derivedPath && peekSelfChange(derivedPath))
                {
                    return;
                }

                const broker = getBroker();
                const variant = change.change;

                // Fan the event into the active aggregate BEFORE the
                // legacy variant handlers (they surface banners + close
                // the tab, so ordering matters — the aggregate must see
                // the event on its terms first).
                if (change.uuid)
                {
                    const mapped = variant === "renamed" || variant === "moved" || variant === "deleted" || variant === "created"
                        ? variant : null;
                    if (mapped)
                    {
                        scheduleAggregateFsChange({
                            type: mapped,
                            uuid: change.uuid,
                            oldPath: derivedPath,
                            newPath: null,
                        });
                    }
                    else if (variant === "modified")
                    {
                        // Modified with buffer — prompt path. Fire-and-forget;
                        // the guard set makes this idempotent per-uuid.
                        void promptReconcileIfNeeded(change.uuid);
                    }
                }

                if (variant === "renamed")
                {
                    const oldRel = change.relPath || "";
                    const parent = oldRel.includes("/")
                        ? oldRel.slice(0, oldRel.lastIndexOf("/"))
                        : "";
                    const newRel = parent ? `${parent}/${change.newName}` : (change.newName || "");
                    const newDerivedPath = newRel
                        ? `${state.currentProject.path.replace(/[\\/]+$/, "")}/${newRel}`
                        : null;

                    const activeByUuid = change.uuid && broker.isActiveUuid(change.uuid);
                    if (activeByUuid || (derivedPath && broker.isActivePath(derivedPath)))
                    {
                        broker.unlock(newDerivedPath, change.uuid || null);
                        const activeSlot = state.slotManager?.getActive();
                        if (activeSlot)
                        {
                            state.slotManager.renamePath(activeSlot.tabId, newDerivedPath);
                        }
                        if (state.currentProject)
                        {
                            state.currentProject.scriptPath = newDerivedPath;
                            if (change.newName) state.currentProject.scriptBasename = change.newName;
                        }
                        showBanner(t("mangaplay-studio.banner.fileRenamedExternally"));
                    }
                }
                else if (variant === "deleted")
                {
                    const activeByUuid = change.uuid && broker.isActiveUuid(change.uuid);
                    if (activeByUuid || (derivedPath && broker.isActivePath(derivedPath)))
                    {
                        broker.unlock(null);
                        if (state.currentProject) state.currentProject.scriptPath = null;
                        const activeSlot = state.slotManager?.getActive();
                        if (activeSlot) await state.slotManager.close(activeSlot.tabId);
                        showBanner(t("mangaplay-studio.banner.fileDeletedExternally"));
                    }
                }
                else if (variant === "created" || variant === "modified")
                {
                    const activeByUuid = change.uuid && broker.isActiveUuid(change.uuid);
                    if (activeByUuid || (derivedPath && broker.isActivePath(derivedPath)))
                    {
                        const base = change.relPath
                            ? change.relPath.slice(change.relPath.lastIndexOf("/") + 1)
                            : "";
                        showBanner(t("mangaplay-studio.banner.fileModifiedExternally", { file: base }));
                    }
                }
                else if (variant === "moved")
                {
                    // newParentUuid is a uuid, not a path — resolve it to a
                    // relPath via the registry tree so the broker lock (and
                    // the slot label) can hop to the new location instead of
                    // being dropped to null. Fall through to broker.unlock(null)
                    // only if the tree lookup fails.
                    const activeByUuid = change.uuid && broker.isActiveUuid(change.uuid);
                    if (activeByUuid || (derivedPath && broker.isActivePath(derivedPath)))
                    {
                        let resolvedNewPath = null;
                        try
                        {
                            const tree = await registryListTree();
                            const newParentEntry = change.newParentUuid
                                ? tree.find((e) => e.uuid === change.newParentUuid)
                                : null;
                            const newParentRel = newParentEntry ? newParentEntry.relPath : "";
                            const oldRel = change.relPath || "";
                            const base = oldRel.slice(oldRel.lastIndexOf("/") + 1);
                            const newRel = newParentRel ? `${newParentRel}/${base}` : base;
                            if (newRel)
                            {
                                resolvedNewPath = `${state.currentProject.path.replace(/[\\/]+$/, "")}/${newRel}`;
                            }
                        }
                        catch (e) { /* fall through to null */ }
                        broker.unlock(resolvedNewPath);
                        const activeSlot = state.slotManager?.getActive();
                        if (activeSlot && resolvedNewPath)
                        {
                            state.slotManager.renamePath(activeSlot.tabId, resolvedNewPath);
                        }
                        showBanner(t("mangaplay-studio.banner.fileRenamedExternally"));
                    }
                }

                await refreshExplorer();
            }
            catch (e) { console.warn("[registry-fs-changed] handler failed:", e); }
        });
    }
    catch (e)
    {
        state.registryFsChangedWired = false;
        console.warn("[registry-fs-changed] listener wiring failed:", e?.message);
    }
}
