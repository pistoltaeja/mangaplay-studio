// @ts-check
/**
 * footer-bootstrap.js — glue layer between app.js and the Google Docs sync
 * state machine + lock engine.
 *
 * Owns:
 *   - building a SyncStateMachine per opened script and wiring its
 *     transitions to an EXTERNAL gear controller (owned by app-footer.js),
 *   - swapping the machine on script-change,
 *   - exposing a `gearClickHandler` that opens the publish modal or sync
 *     popover depending on the current sync state (called by the App Footer
 *     when the user clicks its gear),
 *   - running Push / Pull / conflict-toast through the popover,
 *   - lifecycle for the heartbeat controller (start/stop on focus/blur +
 *     unlock; teardown on script close).
 *
 * The full-width `.editor-footer` is gone — sync gear + lock + status text
 * now live inside the bottom-right App Footer and the sync popover.
 */

import {
    getSyncEntry as projectGetSyncEntry,
    setSyncEntry as projectSetSyncEntry,
    removeSyncEntry as projectRemoveSyncEntry
} from "../project/project.js";
import { loadPublishLog } from "./publish-log.js";
import {
    driveClient as driveClientApi,
    filesUpdate as driveFilesUpdate,
    filesGet as driveFilesGet
} from "../../../../core/google-docs/index.js";
import { SyncStateMachine } from "./sync-state-machine.js";
import { openSyncPopover, closeSyncPopover } from "./sync-popover.js";
import {
    evaluateLockState,
    lock as lockEngineLock,
    unlock as lockEngineUnlock,
    HeartbeatController
} from "./lock-engine.js";
import { push as pushWorker, pull as pullWorker } from "./push-pull.js";
import { showConflictToast, dismissConflictToast } from "./conflict-toast.js";
import { t } from "../adapters/tauri-i18n.js";
import { getCurrentProfile } from "../auth/google-oauth.js";
import { openUpdateContentModal } from "./update-content-modal.js";

/**
 * Lazy-import for the Google Docs publish modal. Static-importing this at
 * module top pulls publish-modal.js into every bundle (including mobile
 * where it's unreachable) via the app.js → footer-bootstrap.js chain.
 * Only the gear-click handler needs it; deferring the import keeps mobile
 * bundles clean AND cuts standalone cold-boot parse cost.
 * @returns {Promise<typeof import("./publish-modal.js").openPublishModal>}
 */
async function _loadOpenPublishModal()
{
    const mod = await import("./publish-modal.js");
    return mod.openPublishModal;
}

/**
 * Minimal surface the bootstrap drives on the App Footer's gear element.
 *
 * @typedef {Object} GearController
 * @property {(state: "unsynced"|"idle"|"checking"|"local-ahead"|"remote-ahead"|"error") => void} setSyncState
 * @property {(state: "unsynced"|"unlocked"|"locked-by-me"|"locked-by-other"|"stale", by?: string, at?: string) => void} setLockState
 * @property {() => void} show
 * @property {() => void} hide
 * @property {() => HTMLElement} getAnchorEl     — element to anchor the popover against
 * @property {(name: string) => void} setFilename
 */

/** @type {GearController|null} */
let footer = null;

/**
 * Optional secondary sink — the top-bar Publish Doc pill. Registered by
 * app.js after mountGoogleDocsFooter so it receives the same SyncState
 * transitions and show/hide signals as the App Footer gear. The pill is
 * a pure projection — it does NOT own a state machine of its own.
 *
 * @typedef {Object} PublishDocPillController
 * @property {(state: "unsynced"|"idle"|"checking"|"local-ahead"|"remote-ahead"|"error") => void} setSyncState
 * @property {(state: "unsynced"|"unlocked"|"locked-by-me"|"locked-by-other"|"stale") => void} setLockState
 * @property {(fn: (ev?: MouseEvent) => void) => void} setClickHandler
 * @property {() => HTMLElement} getHostEl
 * @property {() => void} destroy
 */

/** @type {PublishDocPillController|null} */
let publishDocPill = null;

/** @type {SyncStateMachine|null} */
let machine = null;

/**
 * Tracks the most-recent `setActiveScript` promise so callers (notably the
 * pill click handler) can await it before reading `machine`. Without this,
 * a click that lands during the brief window between project boot and the
 * first `setActiveScript` resolving sees `machine === null` and silently
 * no-ops.
 *
 * @type {Promise<void>}
 */
let _activeScriptReady = Promise.resolve();

/**
 * A `setActiveScript(ctx)` call that arrived BEFORE `mountGoogleDocsFooter`
 * had a chance to register the footer. On fresh boot the slot-manager fires
 * its onActivate hook (which calls setActiveScript) inside
 * `mountProjectViews()` BEFORE that same function reaches the
 * mountGoogleDocsFooter call further down. The first call would otherwise
 * silently early-return with `footer === null`, leaving `machine === null`
 * so the first pill click after boot drops on the floor.
 *
 * Stashing the ctx here lets `mountGoogleDocsFooter` replay it the moment
 * the footer is registered.
 *
 * @type {Object|null}
 */
let _pendingActiveScriptCtx = null;

/** @type {HeartbeatController|null} */
let heartbeat = null;

/** @type {Array<() => void>} */
let heartbeatDetachers = [];

/** @type {{ projectPath: string|null, scriptRelPath: string|null, basename: string|null }} */
const activeScript = { projectPath: null, scriptRelPath: null, basename: null };

/**
 * @typedef {Object} BootstrapOpts
 * @property {() => Promise<string|null>} getAuthToken
 * @property {() => { name: string|null }} [getUserProfile]
 * @property {() => { format?: string, sourceText?: string, localPath?: string, dirty?: boolean }} [getScriptContext]
 * @property {() => string} [getClientId]
 */

/** @type {BootstrapOpts} */
let opts = { getAuthToken: async () => null };

/**
 * One-time mount. Idempotent — repeat calls are no-op.
 *
 * The bootstrap no longer creates its own footer DOM; the caller passes a
 * GearController (typically the App Footer in app.js) that exposes
 * `setSyncState` / `setLockState` / `show` / `hide` / `getAnchorEl`. We
 * just store the reference and start driving it when `setActiveScript()`
 * fires.
 *
 * @param {GearController} gearController
 * @param {BootstrapOpts} options
 */
export function mountGoogleDocsFooter(gearController, options)
{
    if (footer) return;
    if (!gearController) return;
    opts = Object.assign({ getAuthToken: async () => null }, options || {});
    footer = gearController;
    footer.hide();

    // Replay any setActiveScript(ctx) that arrived before us — see the
    // `_pendingActiveScriptCtx` declaration for the boot-ordering reason.
    if (_pendingActiveScriptCtx)
    {
        const replay = _pendingActiveScriptCtx;
        _pendingActiveScriptCtx = null;
        setActiveScript(replay);
    }
}

/**
 * Register the top-bar Publish Doc pill controller. Optional secondary sink
 * that mirrors the App Footer gear's SyncState + show/hide lifecycle. Wires
 * the gear-click handler into the pill so click behaviour stays in lock-step
 * across both surfaces.
 *
 * @param {PublishDocPillController|null} controller
 */
export function setPublishDocPillController(controller)
{
    publishDocPill = controller || null;
    if (!publishDocPill) return;
    try { publishDocPill.setClickHandler(getGoogleDocsGearClickHandler()); }
    catch (e) { console.warn("[mps:gdocs:footer] setClickHandler threw:", e); }

    // Late-registration catch-up: if a SyncStateMachine is already running,
    // replay its current state onto the new controller so the pill reflects
    // it on registration (instead of waiting for the next transition).
    if (machine && machine.state)
    {
        try { publishDocPill.setSyncState(/** @type {any} */ (machine.state)); }
        catch (e) { console.warn("[mps:gdocs:footer] pill late-setSyncState threw:", e); }
    }
}

/**
 * Click handler shared by the publish-doc footer pill. Opens the publish
 * modal when the SyncStateMachine is in `unsynced`, otherwise opens the
 * sync popover anchored on the current footer anchor element. Installed
 * on the pill via `setPublishDocPillController` → `setClickHandler`.
 *
 * @returns {(ev: MouseEvent) => Promise<void>}
 */
export function getGoogleDocsGearClickHandler()
{
    return async () =>
    {
        for (let i = 0; i < 4; i++)
        {
            const p = _activeScriptReady;
            try { await p; }
            catch (e) { console.warn("[mps:gdocs:footer] gear-click await _activeScriptReady threw:", e); }
            if (p === _activeScriptReady) break;
        }

        if (!machine)
        {
            return;
        }
        if (machine.state === "unsynced")
        {
            const ctxObj = (opts.getScriptContext && opts.getScriptContext()) || {};
            const profile = (opts.getUserProfile && opts.getUserProfile()) || { name: null };
            const clientId = (opts.getClientId && opts.getClientId()) || "";
            const openPublishModal = await _loadOpenPublishModal();
            await openPublishModal({
                script: null,
                scriptFormat: ctxObj.format || "text",
                sourceText: ctxObj.sourceText || "",
                basename: activeScript.basename || "Untitled",
                localPath: ctxObj.localPath || _absolutePathFor(activeScript) || "",
                projectId: "",
                projectPath: activeScript.projectPath || "",
                scriptRelPath: activeScript.scriptRelPath || "",
                userName: profile.name || "",
                clientId,
                authClient: { getAccessToken: async () => opts.getAuthToken() }
            });
            await machine.bootFromCache();
            return;
        }
        _openPopoverForCurrentState();
    };
}

/**
 * Switch the footer + state machine to track a different script (or none).
 * Pass `null` to detach (e.g. when no script is open).
 *
 * The returned promise is recorded as `_activeScriptReady` so the pill
 * click handler can await it — see `_activeScriptReady` declaration above
 * for the race this prevents.
 *
 * @param {Object|null} ctx
 * @param {string} ctx.projectPath
 * @param {string} ctx.scriptRelPath
 * @param {string} ctx.basename
 */
export function setActiveScript(ctx)
{
    _activeScriptReady = _doSetActiveScript(ctx);
    return _activeScriptReady;
}

/**
 * @param {Object|null} ctx
 */
async function _doSetActiveScript(ctx)
{
    // Tear down previous machine + heartbeat.
    if (machine)
    {
        try { machine.stop(); }
        catch (e) { console.warn("[mps:gdocs:footer] previous machine.stop threw:", e); }
        machine = null;
    }
    _teardownHeartbeat();
    dismissConflictToast();

    if (!ctx || !ctx.scriptRelPath)
    {
        activeScript.projectPath = null;
        activeScript.scriptRelPath = null;
        activeScript.basename = null;
        if (footer) footer.hide();
        // Drive the publish-doc pill to its "not-sync" baseline so the
        // colour reflects "no doc open". The pill stays visible — its three
        // states already include the "no doc / not signed in" cases.
        publishDocPill?.setSyncState(/** @type {any} */ ("unsynced"));
        // Clear any deferred-replay request from a prior null/dropped call.
        _pendingActiveScriptCtx = null;
        return;
    }
    if (!footer)
    {
        // The footer-bootstrap hasn't been mounted yet — this happens on
        // first boot because the slot-manager opens the auto-resumed slot
        // BEFORE mountGoogleDocsFooter runs further down in
        // mountProjectViews(). Remember the ctx and replay it from
        // mountGoogleDocsFooter() once the footer is registered. Without
        // this, machine stays null and the first pill click after boot is
        // silently dropped — symptom reported as "publish pill does
        // nothing after boot, switching files fixes it."
        _pendingActiveScriptCtx = ctx;
        return;
    }

    activeScript.projectPath = ctx.projectPath;
    activeScript.scriptRelPath = ctx.scriptRelPath;
    activeScript.basename = ctx.basename || ctx.scriptRelPath;
    footer.setFilename(activeScript.basename);

    machine = new SyncStateMachine({
        scriptRelPath: ctx.scriptRelPath,
        projectPath: ctx.projectPath,
        projectStore: {
            getSyncEntry: projectGetSyncEntry,
            setSyncEntry: projectSetSyncEntry,
            removeSyncEntry: projectRemoveSyncEntry
        },
        driveClient: driveClientApi,
        getAuthToken: opts.getAuthToken,
        onTransition: ({ state }) =>
        {
            if (!footer) return;
            footer.setSyncState(/** @type {any} */ (state));
            publishDocPill?.setSyncState(/** @type {any} */ (state));
            if (state === "unsynced")
            {
                footer.setLockState("unsynced");
                // Close any open sync popover — its actions (Push/Pull/
                // Refresh/Unlink/Padlock) only make sense for linked
                // scripts. The popover's own Unlink button already closes
                // itself; this catches non-popover paths to unsynced.
                closeSyncPopover();
            }
            // Auto-surface the conflict toast on remote drift.
            if (state === "remote-ahead")
            {
                _showConflictToastFromMachine();
            }
            else
            {
                // Any non-remote-ahead transition implicitly resolves the
                // conflict (push succeeded, user pulled, unsynced, error).
                dismissConflictToast();
            }
        },
        onStatusText: () =>
        {
            // No inline status text now — the App Footer doesn't surface
            // humanised relative-time strings. The sync popover re-derives
            // them from `machine.lastCheckedAt` on open.
        }
    });

    await machine.bootFromCache();
    machine.start();
    footer.show();

    // External-rename recovery — if bootFromCache landed at unsynced but
    // the publish-log shows this script (or its basename) WAS published,
    // surface a one-time toast so the user knows the link looks broken
    // and can re-link. v1 stops at the toast; the attach-to-existing-Doc
    // flow lands in a follow-up.
    if (machine.state === "unsynced")
    {
        void maybeSurfaceRenameRecoveryToast(ctx).catch((e) =>
        {
            console.debug("[mps:gdocs:recovery] toast check threw:", e);
        });
    }
}

/**
 * Per-session set of {projectPath}::{basename} keys that have already
 * received the recovery toast — guards against showing it twice in the
 * same session when the user tab-flips.
 * @type {Set<string>}
 */
const _renameRecoveryShown = new Set();

/**
 * Show a non-blocking toast IF the publish-log records a prior publish
 * for the active script's basename AND no live sync entry exists. The
 * intent is to tell the user "this script looks like it lost its Google
 * Doc link" — actionable next-step (re-link, find the Doc manually) is
 * deferred to the v2 attach-to-existing flow.
 *
 * @param {{projectPath: string, scriptRelPath: string, basename: string}} ctx
 */
async function maybeSurfaceRenameRecoveryToast(ctx)
{
    if (!ctx || !ctx.projectPath || !ctx.basename) return;
    const key = `${ctx.projectPath}::${ctx.basename}`;
    if (_renameRecoveryShown.has(key)) return;

    let entries;
    try { entries = await loadPublishLog(); }
    catch (e) { return; }
    if (!Array.isArray(entries) || entries.length === 0) return;

    // The publish-log fileName is the title shown in the modal — for
    // `Foo.mangaplay.md` that's typically "Foo.mangaplay" (no `.md`).
    // Also tolerate "Foo" alone (title without extension). Compare against
    // multiple shapes of the active script's basename.
    const stripMd = (s) => s.replace(/\.md$/i, "");
    const stripExt = (s) => {
        const i = s.lastIndexOf(".");
        return i > 0 ? s.slice(0, i) : s;
    };
    const targets = new Set([
        ctx.basename,
        stripMd(ctx.basename),
        stripExt(stripMd(ctx.basename)),
    ]);
    const hit = entries.find((e) =>
        e && typeof e === "object"
        && typeof e.fileName === "string"
        && targets.has(e.fileName));
    if (!hit) return;

    _renameRecoveryShown.add(key);
    showRenameRecoveryToast(ctx.basename);
}

/**
 * Minimal toast — fixed bottom-right, auto-dismisses. Independent from
 * settings-modal's private `showToast` so we don't have to plumb it
 * across modules.
 * @param {string} basename
 */
function showRenameRecoveryToast(basename)
{
    const msg = t(
        "mangaplay-studio.googleDocsSync.recovery.unlinkedToast",
        "Couldn't find a linked Google Doc for {name}. If it was renamed or moved, re-link it from the gear menu.",
    ).replace("{name}", basename);

    const el = document.createElement("div");
    el.className = "mps-gdocs-recovery-toast";
    el.textContent = msg;
    el.setAttribute("role", "status");
    el.style.cssText = [
        "position:fixed", "right:16px", "bottom:48px", "z-index:10000",
        "max-width:420px", "padding:10px 14px",
        "background:rgba(40,40,40,0.96)", "color:#fff",
        "border-radius:8px", "font:13px/1.4 system-ui,sans-serif",
        "box-shadow:0 4px 14px rgba(0,0,0,0.35)",
        "opacity:0", "transform:translateY(6px)",
        "transition:opacity 180ms ease, transform 180ms ease",
    ].join(";");
    document.body.appendChild(el);
    requestAnimationFrame(() =>
    {
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
    });
    setTimeout(() =>
    {
        el.style.opacity = "0";
        el.style.transform = "translateY(6px)";
        setTimeout(() => el.remove(), 220);
    }, 6000);
}

/**
 * Notify the active machine that the user typed in the editor. Forwarded
 * from `onMpsChangeFromSlot` in app.js.
 */
export function notifyEdit()
{
    if (!machine) return;
    machine.notifyLocalEdit();
    if (heartbeat) heartbeat.noteInteraction();
}

/**
 * Re-read the project.json sync cache for the currently active script. Used
 * by callers that opened the Publish modal outside the gear-click path
 * (e.g. the editor menu's "Publish Google Doc" item) so the footer reflects
 * the freshly written cache entry without waiting for the user to reopen
 * the file. No-op when no machine is mounted. See BUG-001.
 *
 * @returns {Promise<void>}
 */
export async function refreshActiveScript()
{
    if (!machine) return;
    try
    {
        await machine.bootFromCache();
    }
    catch (e)
    {
        console.warn("[mps:gdocs:footer] refreshActiveScript bootFromCache failed:", e);
    }
}

// ── Push / Pull / Conflict ──────────────────────────────────────────────────

function _showConflictToastFromMachine()
{
    if (!machine) return;
    showConflictToast({
        title: activeScript.basename || "",
        onKeepMine: async () => { await _runPush(); },
        onKeepTheirs: async () => { await _runPull({ promptIfDirty: true }); },
        onOpenBoth: async () => { await _openInBrowser(); }
    });
}

async function _openInBrowser()
{
    if (!machine || !machine.docId) return;
    try
    {
        const openerMod = await import("@tauri-apps/plugin-opener");
        await openerMod.openUrl(`https://docs.google.com/document/d/${machine.docId}`);
    }
    catch (e)
    {
        console.warn("[mps:gdocs:footer] open failed:", e);
    }
}

async function _runPush()
{
    if (!machine || !machine.docId)
    {
        return;
    }
    const ctxObj = (opts.getScriptContext && opts.getScriptContext()) || {};
    const profile = (opts.getUserProfile && opts.getUserProfile()) || { name: null };

    machine.inflight = true;
    try
    {
        const { newRevisionId } = await openUpdateContentModal({
            docId: machine.docId,
            docUrl: `https://docs.google.com/document/d/${machine.docId}`,
            projectPath: activeScript.projectPath || "",
            scriptRelPath: activeScript.scriptRelPath || "",
            format: /** @type {any} */ (machine.format || ctxObj.format || "text"),
            sourceText: ctxObj.sourceText || "",
            localPath: ctxObj.localPath || _absolutePathFor(activeScript) || "",
            expectedRevisionId: machine.lastKnownRevisionId || null,
            getAuthToken: opts.getAuthToken,
            userName: profile.name || "",
            clientId: (opts.getClientId && opts.getClientId()) || "",
            ourLockToken: machine.lastKnownLockToken || null
        });
        await machine.notifyPushSucceeded(newRevisionId || machine.lastKnownRevisionId || "");
    }
    catch (e)
    {
        // UserCancelled rejection from the modal — silent.
        if (e && /** @type {any} */ (e).name === "UserCancelled")
        {
            return;
        }
    }
    finally
    {
        if (machine) machine.inflight = false;
    }
}

/**
 * @param {{ promptIfDirty: boolean }} [pullOpts]
 */
async function _runPull(pullOpts)
{
    if (!machine || !machine.docId) return;
    const ctxObj = (opts.getScriptContext && opts.getScriptContext()) || {};
    const dirty = !!ctxObj.dirty;

    if (pullOpts && pullOpts.promptIfDirty && dirty)
    {
        const ok = window.confirm(t(
            "mangaplay-studio.googleDocsSync.conflict.pullOverwriteWarn",
            "Pulling will overwrite your local changes. Continue? Your changes will be saved as a .conflict sidecar file."));
        if (!ok) return;
    }

    const token = await opts.getAuthToken();
    if (!token)
    {
        console.warn("[mps:gdocs:footer] pull: no token");
        return;
    }

    // Read the cache entry for the stored tabIds. Entries written before
    // tab-id tracking landed won't have `rootTabId` — surface a
    // re-publish prompt instead of attempting the pull.
    const entry = await projectGetSyncEntry(activeScript.projectPath, activeScript.scriptRelPath);
    if (!entry || !entry.rootTabId)
    {
        _toast(t(
            "mangaplay-studio.googleDocsSync.pull.missingTabIdInCache",
            "Please re-publish this Doc to enable sync.")); // TODO: localise
        return;
    }

    machine.inflight = true;
    try
    {
        const { newRevisionId } = await pullWorker({
            token,
            docId: machine.docId,
            format: /** @type {any} */ (machine.format || ctxObj.format || "text"),
            localSourceText: ctxObj.sourceText || "",
            localDirty: dirty,
            localPath: ctxObj.localPath || _absolutePathFor(activeScript) || "",
            rootTabId: entry.rootTabId,
            screenplayTabId: entry.screenplayTabId || null
        });
        await machine.notifyPullSucceeded(newRevisionId || machine.lastKnownRevisionId || "");
    }
    catch (e)
    {
        console.warn("[mps:gdocs:footer] pull failed:", e);
        const eName = (e && /** @type {any} */ (e).name) || "Error";
        if (eName === "MissingTabIdInCache")
        {
            _toast(t(
                "mangaplay-studio.googleDocsSync.pull.missingTabIdInCache",
                "Please re-publish this Doc to enable sync.")); // TODO: localise
        }
        else if (eName === "MangaplayTabMissing")
        {
            _toast(t(
                "mangaplay-studio.googleDocsSync.pull.mangaplayTabMissing",
                "The Mangaplay tab is missing from your Google Docs™. Someone may have renamed or deleted it. Open it in Google Docs™ to fix."));
        }
        else
        {
            _toast(t(
                "mangaplay-studio.googleDocsSync.pull.failed",
                "Pull from Google Docs™ failed. See console for details."));
        }
    }
    finally
    {
        machine.inflight = false;
    }
}

// ── Unlink with Drive-side appProperties clear ──────────────────────────────

/**
 * Pure orchestrator for the unlink flow. Exported so unit tests can drive it
 * with mocked deps without spinning up the whole footer-bootstrap module.
 *
 * Contract:
 *   1. No token / docId → local-only unlink (cleanup).
 *   2. driveFilesGet throws → local-only unlink (Doc gone / no access).
 *   3. lockState === "locked-by-me" | "stale" → call lockEngineUnlock BEFORE
 *      the 5-key clear, drops contentRestriction + lock fields.
 *   4. lockState === "locked-by-other" → confirm dialog; if declined, abort
 *      WITHOUT touching Drive or machine. If accepted, proceed with the 5-key
 *      clear but do NOT release the lock (it's not ours).
 *   5. Always finishes with machine.unlink() + heartbeat teardown unless the
 *      user aborted the locked-by-other confirm.
 *
 * @param {Object} deps
 * @param {string|null} deps.token
 * @param {string|null} deps.docId
 * @param {string|null} deps.ourLockToken
 * @param {string|null} [deps.ourSub]
 * @param {(args:{token:string,fileId:string,fields:string}) => Promise<{appProperties?:object}|null>} deps.filesGet
 * @param {(args:{token:string,fileId:string,body:object}) => Promise<any>} deps.filesUpdate
 * @param {(args:{token:string,docId:string,driveClient:object}) => Promise<void>} deps.lockUnlock
 * @param {(args:{appProperties:object,ourLockToken:string|null,ourSub:string|null}) => string} deps.evaluateLockStateFn
 * @param {(args:{lockedBy:string,lockedAt:string}) => boolean} deps.confirmLockedByOther — true if user accepts
 * @param {() => void} [deps.onDriveUpdateFailed]       — toast hook
 * @param {() => Promise<void>} deps.localUnlink         — machine.unlink()
 * @param {() => void} deps.teardownHeartbeat
 * @returns {Promise<{ branch: "no-token" | "filesGet-failed" | "released-own-lock" | "released-stale-lock" | "locked-by-other-accepted" | "locked-by-other-declined" | "unlocked" | "lock-release-failed" }>}
 */
export async function runUnlinkFlow(deps)
{
    const {
        token,
        docId,
        ourLockToken,
        ourSub,
        filesGet,
        filesUpdate,
        lockUnlock,
        evaluateLockStateFn,
        confirmLockedByOther,
        onDriveUpdateFailed,
        localUnlink,
        teardownHeartbeat
    } = deps;

    // (1) No reach to Drive → local-only unlink.
    if (!token || !docId)
    {
        await localUnlink();
        teardownHeartbeat();
        return { branch: "no-token" };
    }

    // (2) Read live appProperties.
    let appProps = null;
    try
    {
        const meta = await filesGet({ token, fileId: docId, fields: "appProperties" });
        appProps = (meta && meta.appProperties) || {};
    }
    catch (e)
    {
        console.warn("[mps:gdocs:footer] unlink filesGet failed; local-only:", e);
        await localUnlink();
        teardownHeartbeat();
        return { branch: "filesGet-failed" };
    }

    const lockState = evaluateLockStateFn({
        appProperties: appProps,
        ourLockToken: ourLockToken || null,
        ourSub: ourSub || null
    });

    /** @type {"released-own-lock"|"released-stale-lock"|"locked-by-other-accepted"|"unlocked"} */
    let branch = "unlocked";

    // (3) Ours / stale → release lock first.
    if (lockState === "locked-by-me" || lockState === "stale")
    {
        try
        {
            await lockUnlock({
                token,
                docId,
                driveClient: { filesUpdate }
            });
        }
        catch (e)
        {
            console.warn("[mps:gdocs:footer] unlink: lock release failed:", e);
            if (onDriveUpdateFailed) onDriveUpdateFailed();
            return { branch: "lock-release-failed" };
        }
        branch = lockState === "stale" ? "released-stale-lock" : "released-own-lock";
    }
    // (4) Someone else's lock → confirm.
    else if (lockState === "locked-by-other")
    {
        const lockedBy = (appProps && appProps.mpsLockedBy) || "another user";
        const lockedAt = (appProps && appProps.mpsLockedAt) || "";
        const ok = confirmLockedByOther({ lockedBy, lockedAt });
        if (!ok)
        {
            return { branch: "locked-by-other-declined" };
        }
        branch = "locked-by-other-accepted";
        // Don't touch their lock — fall through to 5-key clear only.
    }

    // (5) Clear our 5 link-tracking appProperties.
    try
    {
        await filesUpdate({
            token,
            fileId: docId,
            body:
            {
                appProperties:
                {
                    mpsProjectId: "",
                    mpsScriptRelPath: "",
                    mpsFormat: "",
                    mpsClientId: "",
                    mpsSchemaVersion: ""
                }
            }
        });
    }
    catch (e)
    {
        console.warn("[mps:gdocs:footer] unlink Drive update failed:", e);
        if (onDriveUpdateFailed) onDriveUpdateFailed();
    }

    await localUnlink();
    teardownHeartbeat();
    return { branch };
}

async function _runUnlink()
{
    if (!machine) return;
    const docIdSnapshot = machine.docId;
    const token = await opts.getAuthToken();
    const localMachine = machine;

    const _profile = getCurrentProfile();
    await runUnlinkFlow({
        token: token || null,
        docId: docIdSnapshot || null,
        ourLockToken: localMachine.lastKnownLockToken || null,
        ourSub: (_profile && _profile.sub) || null,
        filesGet: driveFilesGet,
        filesUpdate: driveFilesUpdate,
        lockUnlock: lockEngineUnlock,
        evaluateLockStateFn: evaluateLockState,
        confirmLockedByOther: ({ lockedBy, lockedAt }) =>
        {
            return window.confirm(t(
                "mangaplay-studio.googleDocsSync.unlink.lockedByOtherConfirm",
                "Someone else is editing this Doc right now ({name}, locked {when}). Unlink anyway? They'll keep their lock.")
                .replace("{name}", lockedBy)
                .replace("{when}", lockedAt));
        },
        onDriveUpdateFailed: () =>
        {
            _toast(t(
                "mangaplay-studio.googleDocsSync.unlink.driveUpdateFailed",
                "Couldn't clear Google Docs™ link, but local unlink is done."));
        },
        localUnlink: () => localMachine.unlink(),
        teardownHeartbeat: _teardownHeartbeat
    });
}

// ── Lock + heartbeat ─────────────────────────────────────────────────────────

async function _onPadlockClick()
{
    if (!machine || !machine.docId)
    {
        console.warn("[mps:gdocs:footer] padlock click: no machine/docId");
        return;
    }

    const token = await opts.getAuthToken();
    if (!token)
    {
        console.warn("[mps:gdocs:footer] padlock click: no token");
        return;
    }

    // Read live appProperties so we always branch off the freshest state.
    let appProps = null;
    try
    {
        const meta = await driveFilesGet({
            token,
            fileId: machine.docId,
            fields: "appProperties"
        });
        appProps = (meta && meta.appProperties) || {};
    }
    catch (e)
    {
        console.warn("[mps:gdocs:footer] padlock filesGet failed:", e);
        return;
    }

    const googleProfile = getCurrentProfile();
    const lockState = evaluateLockState({
        appProperties: appProps,
        ourLockToken: machine.lastKnownLockToken || null,
        ourSub: (googleProfile && googleProfile.sub) || null
    });

    const profile = (opts.getUserProfile && opts.getUserProfile()) || { name: null };
    const userName = profile.name || "Mangaplay Studio";
    const clientId = (opts.getClientId && opts.getClientId()) || "";

    if (lockState === "unlocked")
    {
        try
        {
            const { lockToken, lockedAt } = await lockEngineLock({
                token,
                docId: machine.docId,
                userName,
                clientId,
                lockedBySub: (googleProfile && googleProfile.sub) || null,
                driveClient: { filesUpdate: driveFilesUpdate, filesGet: driveFilesGet }
            });
            machine.lastKnownLockToken = lockToken;
            await _persistLockTokenToCache();
            if (footer) footer.setLockState("locked-by-me", userName, lockedAt);
            _startHeartbeat({ token, docId: machine.docId, lockToken });
        }
        catch (e)
        {
            console.warn("[mps:gdocs:footer] lock failed:", e);
            _toast(t(
                "mangaplay-studio.googleDocsSync.lock.lockedByOtherToast",
                "Locked by {name} since {when}. Only they can unlock.")
                .replace("{name}", appProps.mpsLockedBy || "another user")
                .replace("{when}", appProps.mpsLockedAt || ""));
        }
        return;
    }

    if (lockState === "locked-by-me")
    {
        try
        {
            await lockEngineUnlock({
                token,
                docId: machine.docId,
                driveClient: { filesUpdate: driveFilesUpdate }
            });
        }
        catch (e)
        {
            console.warn("[mps:gdocs:footer] unlock failed:", e);
            return;
        }
        machine.lastKnownLockToken = null;
        await _persistLockTokenToCache();
        if (footer) footer.setLockState("unlocked");
        _teardownHeartbeat();
        return;
    }

    if (lockState === "stale")
    {
        const lockedBy = appProps.mpsLockedBy || "someone";
        const lockedAt = appProps.mpsLockedAt || "";
        const ok = window.confirm(t(
            "mangaplay-studio.googleDocsSync.lock.forceUnlockConfirm",
            "Lock appears stale (held by {name} since {when}). Force unlock?")
            .replace("{name}", lockedBy)
            .replace("{when}", lockedAt));
        if (!ok) return;
        try
        {
            await lockEngineUnlock({
                token,
                docId: machine.docId,
                driveClient: { filesUpdate: driveFilesUpdate }
            });
            machine.lastKnownLockToken = null;
            await _persistLockTokenToCache();
            if (footer) footer.setLockState("unlocked");
            _teardownHeartbeat();
            _toast(t(
                "mangaplay-studio.googleDocsSync.lock.forceUnlockedToast",
                "Force-unlocked."));
        }
        catch (e)
        {
            console.warn("[mps:gdocs:footer] force-unlock failed:", e);
        }
        return;
    }

    if (lockState === "locked-by-other")
    {
        const lockedBy = appProps.mpsLockedBy || "another user";
        const lockedAt = appProps.mpsLockedAt || "";
        if (footer)
        {
            footer.setLockState("locked-by-other", lockedBy, lockedAt);
        }
        _toast(t(
            "mangaplay-studio.googleDocsSync.lock.lockedByOtherToast",
            "Locked by {name} since {when}. Only they can unlock.")
            .replace("{name}", lockedBy)
            .replace("{when}", lockedAt));
    }
}

/**
 * Persist `machine.lastKnownLockToken` back into the project sync entry
 * cache. No-op when there's no docId.
 */
async function _persistLockTokenToCache()
{
    if (!machine || !machine.docId) return;
    try
    {
        // Read first so we preserve rootTabId / screenplayTabId — they were
        // written by the publish path and `machine` doesn't track them, so
        // a naïve overwrite would clobber the fields push/pull rely on.
        const prior = await projectGetSyncEntry(
            machine.projectPath, machine.scriptRelPath);
        await projectSetSyncEntry(
            machine.projectPath,
            machine.scriptRelPath,
            {
                docId: machine.docId,
                rootTabId: prior && prior.rootTabId,
                screenplayTabId: prior ? (prior.screenplayTabId || null) : null,
                lastKnownRevisionId: machine.lastKnownRevisionId || "",
                lastKnownLockToken: machine.lastKnownLockToken || null,
                lastCheckedAt: machine.lastCheckedAt || new Date().toISOString(),
                format: machine.format || "text"
            });
    }
    catch (e)
    {
        console.warn("[mps:gdocs:footer] persist lock token failed:", e);
    }
}

/**
 * Start the heartbeat and attach focus/blur listeners so it pauses while
 * the window is in the background.
 *
 * @param {{ token: string, docId: string, lockToken: string }} args
 */
function _startHeartbeat({ token, docId, lockToken })
{
    _teardownHeartbeat();
    heartbeat = new HeartbeatController({
        driveClient: { filesUpdate: driveFilesUpdate }
    });
    heartbeat.start({ token, docId, lockToken });

    if (typeof window !== "undefined" && window.addEventListener)
    {
        const onFocus = () =>
        {
            if (heartbeat) heartbeat.start({ token, docId, lockToken });
        };
        const onBlur = () =>
        {
            if (heartbeat) heartbeat.stop();
        };
        // Interaction trackers — keyboard + pointer count as activity so the
        // heartbeat's idle gate doesn't suspend while the user is actually
        // working. `notifyEdit()` already covers editor input, but lock
        // refresh also wants to track non-editor interaction (menu work,
        // dialog clicks, etc.).
        const onKey = () => { if (heartbeat) heartbeat.noteInteraction(); };
        const onPointer = () => { if (heartbeat) heartbeat.noteInteraction(); };

        window.addEventListener("focus", onFocus);
        window.addEventListener("blur", onBlur);
        if (typeof document !== "undefined" && document.addEventListener)
        {
            document.addEventListener("keydown", onKey, true);
            document.addEventListener("pointerdown", onPointer, true);
            heartbeatDetachers.push(() => document.removeEventListener("keydown", onKey, true));
            heartbeatDetachers.push(() => document.removeEventListener("pointerdown", onPointer, true));
        }
        heartbeatDetachers.push(() => window.removeEventListener("focus", onFocus));
        heartbeatDetachers.push(() => window.removeEventListener("blur", onBlur));
    }
}

function _teardownHeartbeat()
{
    if (heartbeat)
    {
        try { heartbeat.stop(); }
        catch (e) { console.warn("[mps:gdocs:footer] heartbeat.stop threw:", e); }
        heartbeat = null;
    }
    for (const d of heartbeatDetachers)
    {
        try { d(); }
        catch (e) { console.warn("[mps:gdocs:footer] heartbeat detach threw:", e); }
    }
    heartbeatDetachers = [];
}

// ── Popover wiring ──────────────────────────────────────────────────────────

function _openPopoverForCurrentState()
{
    if (!machine || !footer) return;
    const anchor = footer.getAnchorEl();
    if (!anchor) return;
    openSyncPopover({
        anchor,
        state: /** @type {any} */ (machine.state),
        lastCheckedAt: machine.lastCheckedAt,
        filename: activeScript.basename || "",
        lockState: footer && /** @type {any} */ (anchor.dataset?.lock) || "unsynced",
        onPush: async () => { await _runPush(); },
        onPull: async () =>
        {
            const promptIfDirty = (machine && machine.state === "local-ahead");
            await _runPull({ promptIfDirty });
        },
        onViewInBrowser: async () => { await _openInBrowser(); },
        onRefresh: async () => { await machine.triggerL1Check(); },
        onUnlink: async () => { await _runUnlink(); },
        onPadlock: () => { void _onPadlockClick(); }
    });
}

/**
 * Tear down everything. Used by app shutdown / project teardown.
 */
export function destroyGoogleDocsFooter()
{
    closeSyncPopover();
    dismissConflictToast();
    _teardownHeartbeat();
    if (machine) { try { machine.stop(); } catch {} machine = null; }
    // The footer DOM is owned by app-footer.js — don't destroy it here.
    if (footer) { try { footer.hide(); } catch {} footer = null; }
    activeScript.projectPath = null;
    activeScript.scriptRelPath = null;
    activeScript.basename = null;
}

/**
 * Reconstruct the absolute path for the active script from project root +
 * relative path. The relative path uses forward slashes; the OS may not,
 * but Drive consumers don't care — only the publish modal needs it for
 * its preflight which runs through a slot helper.
 *
 * @param {{ projectPath: string|null, scriptRelPath: string|null }} a
 * @returns {string|null}
 */
function _absolutePathFor(a)
{
    if (!a.projectPath || !a.scriptRelPath) return null;
    const sep = a.projectPath.includes("\\") ? "\\" : "/";
    return `${a.projectPath}${sep}${a.scriptRelPath.replace(/\//g, sep)}`;
}

/**
 * Lightweight transient toast — top-anchored, auto-dismisses after 4s.
 * Used for the lock-by-other / force-unlocked / Drive-unlink-warn cases.
 *
 * @param {string} message
 */
function _toast(message)
{
    if (typeof document === "undefined") return;
    const el = document.createElement("div");
    el.className = "gds-mini-toast";
    el.textContent = message;
    el.style.cssText =
        "position:fixed;top:16px;left:50%;transform:translateX(-50%);" +
        "background:var(--bg-elevated,#1f1f1f);color:var(--text-default,#fafafa);" +
        "border:1px solid var(--border-subtle,rgba(255,255,255,0.15));" +
        "padding:8px 14px;border-radius:6px;font-size:13px;z-index:10001;" +
        "box-shadow:0 4px 16px rgba(0,0,0,0.3);max-width:90vw;";
    document.body.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch {} }, 4000);
}
