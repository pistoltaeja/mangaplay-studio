// @ts-check
/**
 * sync-state-machine.js — gear-icon state machine for a single open script.
 *
 * Per TODO/mangaplay-studio-google-docs-sync.md §4 + §4a. The machine owns:
 *   - the canonical sync state (`unsynced` | `idle` | `local-ahead` |
 *     `remote-ahead` | `error`, plus the transient `checking` while an L1
 *     check is in flight),
 *   - cache-first boot (`bootFromCache`) — UI renders the last-known state
 *     instantly, never blocks on network,
 *   - lifecycle-driven L1 revisionId checks (window focus, online),
 *   - the L2 adaptive backstop poll (60s → 5min cap, capped + reset by
 *     activity / signal),
 *   - a 30s "humanised text" tick that re-fires `onStatusText` so the
 *     footer's "Synced N min ago" string ages live without polling Drive.
 *
 * Push / Pull themselves live in Phase 4 — this machine only exposes hooks
 * for them: `notifyLocalEdit()`, `notifyPushSucceeded()`, `notifyPullSucceeded()`,
 * and the public `inflight` flag callers flip while a Push / Pull is in
 * progress so L2 doesn't race the user's own write.
 *
 * The whole thing is dependency-injected so tests run with no DOM, no
 * Drive, no Tauri.
 */

import { classifyError, getSurface } from "../../../../core/google-docs/index.js";

/** @typedef {"unsynced"|"idle"|"checking"|"local-ahead"|"remote-ahead"|"error"} SyncState */

/**
 * @typedef {Object} SyncTransition
 * @property {SyncState} state
 * @property {string|null} lastCheckedAt   — ISO-8601
 * @property {object} [errorPayload]       — set when state === "error"
 */

/**
 * @typedef {Object} SyncStateMachineOpts
 * @property {string} scriptRelPath        — forward-slash path inside project
 * @property {string} [projectPath]        — absolute project root
 * @property {object} projectStore         — `{ getSyncEntry, setSyncEntry, removeSyncEntry }`
 * @property {object} driveClient          — `{ filesGet }`
 * @property {() => Promise<string|null>} getAuthToken
 * @property {(t: SyncTransition) => void} [onTransition]
 * @property {() => void} [onStatusText]
 * @property {{ addEventListener: Function, removeEventListener: Function }} [windowImpl]
 * @property {{ addEventListener: Function, removeEventListener: Function }} [documentImpl]
 * @property {(fn: () => void, ms: number) => any} [setTimeoutImpl]
 * @property {(handle: any) => void} [clearTimeoutImpl]
 * @property {(fn: () => void, ms: number) => any} [setIntervalImpl]
 * @property {(handle: any) => void} [clearIntervalImpl]
 * @property {() => number} [nowImpl]
 */

const L2_INITIAL_MS = 60_000;
const L2_MAX_MS = 5 * 60_000;
const IDLE_THRESHOLD_MS = 60_000;
const STATUS_TEXT_REFRESH_MS = 30_000;

export class SyncStateMachine
{
    /** @param {SyncStateMachineOpts} opts */
    constructor(opts)
    {
        if (!opts || !opts.scriptRelPath)
        {
            throw new Error("SyncStateMachine: scriptRelPath required");
        }
        if (!opts.projectStore || typeof opts.projectStore.getSyncEntry !== "function")
        {
            throw new Error("SyncStateMachine: projectStore.getSyncEntry required");
        }

        this.scriptRelPath = opts.scriptRelPath;
        this.projectPath = opts.projectPath || "";
        this.projectStore = opts.projectStore;
        this.driveClient = opts.driveClient || { filesGet: async () => null };
        this.getAuthToken = opts.getAuthToken || (async () => null);
        this.onTransition = opts.onTransition || (() => {});
        this.onStatusText = opts.onStatusText || (() => {});

        // Injectable globals — tests can substitute counters / fakes.
        this._window = opts.windowImpl || (typeof window !== "undefined" ? window : null);
        this._document = opts.documentImpl || (typeof document !== "undefined" ? document : null);
        this._setTimeout = opts.setTimeoutImpl || ((fn, ms) => setTimeout(fn, ms));
        this._clearTimeout = opts.clearTimeoutImpl || ((h) => clearTimeout(h));
        this._setInterval = opts.setIntervalImpl || ((fn, ms) => setInterval(fn, ms));
        this._clearInterval = opts.clearIntervalImpl || ((h) => clearInterval(h));
        this._now = opts.nowImpl || (() => Date.now());

        /** @type {SyncState} */
        this.state = "unsynced";
        /** @type {string|null} */
        this.lastCheckedAt = null;
        /** @type {string|null} */
        this.docId = null;
        /** @type {string|null} */
        this.lastKnownRevisionId = null;
        /** @type {"mangaplay"|"fountain"|"text"|null} */
        this.format = null;
        /** @type {string|null} */
        this.lastKnownLockToken = null;
        /** @type {string|null} */
        this.rootTabId = null;
        /** @type {string|null} */
        this.screenplayTabId = null;
        /** @type {object|null} */
        this.lastErrorPayload = null;

        /** Public flag — flipped true while a Push or Pull is in flight so
         *  L2 backstop pauses. Phase 4 callers manage it. */
        this.inflight = false;

        // ── L2 + heartbeat state ──
        this._l2Cadence = L2_INITIAL_MS;
        this._l2Timer = null;
        this._lastInteractionAt = this._now();
        this._statusTextTimer = null;

        // Detach handles wired in start().
        this._detachers = /** @type {Array<() => void>} */ ([]);

        // Re-entrancy guard — `triggerL1Check` is one-shot in flight.
        this._l1InFlight = false;
    }

    /**
     * Read the cached sync entry and surface the initial state. Resolves
     * after the first transition fires.
     *
     * @returns {Promise<void>}
     */
    async bootFromCache()
    {
        console.warn("[mps:auth:TRACE] SyncStateMachine.bootFromCache() ENTRY projectPath=",
            this.projectPath, " scriptRelPath=", this.scriptRelPath);
        let entry = null;
        try
        {
            entry = await this.projectStore.getSyncEntry(this.projectPath, this.scriptRelPath);
        }
        catch (e)
        {
            console.warn("[mps:gdocs:sync] bootFromCache getSyncEntry failed:", e);
        }

        if (!entry)
        {
            console.warn("[mps:auth:TRACE] SyncStateMachine.bootFromCache() → NO cache entry → unsynced");
            this._transition("unsynced");
            return;
        }
        console.warn("[mps:auth:TRACE] SyncStateMachine.bootFromCache() cache entry restored",
            {
                docId: entry.docId,
                lastKnownRevisionId: entry.lastKnownRevisionId,
                lastKnownLockToken: entry.lastKnownLockToken ? "present" : "null",
                format: entry.format,
                lastCheckedAt: entry.lastCheckedAt
            });

        this.docId = entry.docId || null;
        this.lastKnownRevisionId = entry.lastKnownRevisionId || null;
        this.lastCheckedAt = entry.lastCheckedAt || null;
        this.format = entry.format || null;
        this.lastKnownLockToken = entry.lastKnownLockToken || null;
        this.rootTabId = entry.rootTabId || null;
        this.screenplayTabId = entry.screenplayTabId || null;

        // Offline-first: paint idle from cache. L1 will re-check on start().
        this._transition("idle");
    }

    /**
     * One-shot online revisionId fetch. If the doc's headRevisionId has
     * changed since our cached `lastKnownRevisionId`, transition to
     * `remote-ahead`; otherwise stay in `idle`. On error, transition to
     * `error` with a classified payload.
     *
     * Re-entrant calls are coalesced — if a check is already in flight,
     * subsequent calls no-op.
     *
     * @returns {Promise<boolean|undefined>}  true = remote changed; false =
     *   no change OR error; undefined = skipped (unsynced / inflight).
     */
    async triggerL1Check()
    {
        // Unsynced files have no remote — skip.
        if (this.state === "unsynced" || !this.docId) return;
        if (this._l1InFlight) return;

        // While push/pull is mid-flight, defer.
        if (this.inflight) return;

        this._l1InFlight = true;
        const prevState = this.state;
        this._transition("checking");
        try
        {
            const token = await this.getAuthToken();
            if (!token)
            {
                throw _err("AuthError", "no access token for L1 check");
            }
            const meta = await this.driveClient.filesGet({
                token,
                fileId: this.docId,
                fields: "headRevisionId"
            });
            const headRev = meta && meta.headRevisionId ? String(meta.headRevisionId) : null;
            this.lastCheckedAt = new Date(this._now()).toISOString();

            if (headRev && this.lastKnownRevisionId && headRev !== this.lastKnownRevisionId)
            {
                // L2 cadence resets on a *change* signal.
                this._l2Cadence = L2_INITIAL_MS;
                this._transition("remote-ahead");
                return true;
            }
            // No change — preserve any local-ahead state that was queued
            // while we were checking; otherwise go back to whatever the
            // pre-check state was (idle or local-ahead).
            if (prevState === "local-ahead")
            {
                this._transition("local-ahead");
            }
            else
            {
                this._transition("idle");
            }
            return false;
        }
        catch (err)
        {
            const cls = classifyError(err, { origin: "drive", docId: this.docId || undefined });
            const { surface, recoverable } = getSurface(cls);
            const e = /** @type {any} */ (err);
            this.lastErrorPayload = {
                class: cls,
                surface,
                recoverable,
                diagnostic: `${(e && e.name) || "Error"}: ${String((e && e.message) || "").slice(0, 200)}`
            };
            this._transition("error");
            return false;
        }
        finally
        {
            this._l1InFlight = false;
        }
    }

    /**
     * Synchronous notification from the editor: the user typed something.
     * Drives `idle → local-ahead`. No network.
     */
    notifyLocalEdit()
    {
        this._lastInteractionAt = this._now();
        if (this.state === "idle" || this.state === "checking")
        {
            this._transition("local-ahead");
        }
    }

    /**
     * Called by Phase 4 Push worker on success. Updates cache + transitions
     * `local-ahead → idle`.
     *
     * @param {string} newRevisionId
     */
    async notifyPushSucceeded(newRevisionId)
    {
        console.warn("[mps:auth:TRACE] SyncStateMachine.notifyPushSucceeded() newRevisionId=", newRevisionId,
            " (was lastKnownRevisionId=", this.lastKnownRevisionId + ")");
        this.lastKnownRevisionId = newRevisionId || this.lastKnownRevisionId;
        this.lastCheckedAt = new Date(this._now()).toISOString();
        await this._persistCacheUpdate();
        this._transition("idle");
    }

    /**
     * Called by Phase 4 Pull worker on success. Updates cache + transitions
     * `remote-ahead → idle`.
     *
     * @param {string} newRevisionId
     */
    async notifyPullSucceeded(newRevisionId)
    {
        this.lastKnownRevisionId = newRevisionId || this.lastKnownRevisionId;
        this.lastCheckedAt = new Date(this._now()).toISOString();
        await this._persistCacheUpdate();
        this._transition("idle");
    }

    /**
     * Clear the local cache entry and transition to `unsynced`. The
     * Drive-side `appProperties` removal lives in `runUnlinkFlow` in
     * footer-bootstrap.js — this method only owns the local half.
     *
     * Idempotent: a second call while already `unsynced` is a no-op so a
     * double-click on the popover Unlink button doesn't double-fire the
     * removeSyncEntry write or re-emit the transition.
     */
    async unlink()
    {
        if (this.state === "unsynced") return;
        try
        {
            if (this.projectStore.removeSyncEntry)
            {
                await this.projectStore.removeSyncEntry(this.projectPath, this.scriptRelPath);
            }
        }
        catch (e)
        {
            console.warn("[mps:gdocs:sync] unlink removeSyncEntry failed:", e);
        }
        this.docId = null;
        this.lastKnownRevisionId = null;
        this.lastCheckedAt = null;
        this.format = null;
        this.lastKnownLockToken = null;
        this.rootTabId = null;
        this.screenplayTabId = null;
        this.lastErrorPayload = null;
        this._transition("unsynced");
    }

    /**
     * Wire up L1 lifecycle triggers, the L2 adaptive backstop, the
     * interaction tracker, and the 30s humanised-text refresher.
     */
    start()
    {
        // ── L1 lifecycle triggers ──
        if (this._window && typeof this._window.addEventListener === "function")
        {
            const onFocus = () =>
            {
                this._lastInteractionAt = this._now();
                this._scheduleL2();
                void this.triggerL1Check();
            };
            const onBlur = () => this._cancelL2();
            const onOnline = () => { void this.triggerL1Check(); };

            this._window.addEventListener("focus", onFocus);
            this._window.addEventListener("blur", onBlur);
            this._window.addEventListener("online", onOnline);
            this._detachers.push(() => this._window.removeEventListener("focus", onFocus));
            this._detachers.push(() => this._window.removeEventListener("blur", onBlur));
            this._detachers.push(() => this._window.removeEventListener("online", onOnline));
        }

        // ── Interaction tracker (capture phase, document-wide input) ──
        if (this._document && typeof this._document.addEventListener === "function")
        {
            const onInput = () => { this._lastInteractionAt = this._now(); };
            this._document.addEventListener("input", onInput, true);
            this._detachers.push(() => this._document.removeEventListener("input", onInput, true));
        }

        // ── L2 backstop ──
        this._scheduleL2();

        // ── Status text refresher ──
        this._statusTextTimer = this._setInterval(() =>
        {
            try { this.onStatusText(); }
            catch (e) { console.warn("[mps:gdocs:sync] onStatusText threw:", e); }
        }, STATUS_TEXT_REFRESH_MS);
    }

    /** Tear down all listeners and timers. Idempotent. */
    stop()
    {
        for (const d of this._detachers)
        {
            try { d(); }
            catch (e) { console.warn("[mps:gdocs:sync] detach threw:", e); }
        }
        this._detachers.length = 0;
        this._cancelL2();
        if (this._statusTextTimer != null)
        {
            this._clearInterval(this._statusTextTimer);
            this._statusTextTimer = null;
        }
    }

    // ── Internal ─────────────────────────────────────────────────────────

    _scheduleL2()
    {
        this._cancelL2();
        this._l2Timer = this._setTimeout(() => { void this._tickL2(); }, this._l2Cadence);
    }

    _cancelL2()
    {
        if (this._l2Timer != null)
        {
            this._clearTimeout(this._l2Timer);
            this._l2Timer = null;
        }
    }

    async _tickL2()
    {
        // Pause if a Push/Pull is in flight; reschedule and exit.
        if (this.inflight)
        {
            this._scheduleL2();
            return;
        }

        // Idle gate — if no recent interaction, suspend until next focus.
        const idleMs = this._now() - this._lastInteractionAt;
        if (idleMs > IDLE_THRESHOLD_MS)
        {
            this._cancelL2();
            return;
        }

        // Snapshot state pre-check so we can tell "changed" from "no change".
        const prevRev = this.lastKnownRevisionId;
        const result = await this.triggerL1Check();
        // triggerL1Check resolves to: true (changed), false (no-change/error), undefined (skipped).
        // We back off on a *no-change* result; reset on a *change* result; otherwise just reschedule.
        if (result === true)
        {
            this._l2Cadence = L2_INITIAL_MS;
        }
        else if (result === false && prevRev === this.lastKnownRevisionId)
        {
            this._l2Cadence = Math.min(this._l2Cadence * 2, L2_MAX_MS);
        }

        this._scheduleL2();
    }

    /**
     * @param {SyncState} state
     */
    _transition(state)
    {
        console.warn("[mps:auth:TRACE] SyncStateMachine._transition() →", state,
            " (was", this.state + ")",
            " lastKnownRevisionId=", this.lastKnownRevisionId);
        this.state = state;
        try
        {
            this.onTransition({
                state,
                lastCheckedAt: this.lastCheckedAt,
                errorPayload: state === "error" ? this.lastErrorPayload : undefined
            });
        }
        catch (e)
        {
            console.warn("[mps:gdocs:sync] onTransition threw:", e);
        }
        // Status text refresh on transition too — state change implies
        // the humanised string moved.
        try { this.onStatusText(); }
        catch (e) { console.warn("[mps:gdocs:sync] onStatusText threw:", e); }
    }

    async _persistCacheUpdate()
    {
        if (!this.projectStore.setSyncEntry || !this.docId) return;
        try
        {
            await this.projectStore.setSyncEntry(this.projectPath, this.scriptRelPath, {
                docId: this.docId,
                lastKnownRevisionId: this.lastKnownRevisionId,
                lastKnownLockToken: this.lastKnownLockToken,
                lastCheckedAt: this.lastCheckedAt || new Date(this._now()).toISOString(),
                format: this.format || "text",
                rootTabId: this.rootTabId,
                screenplayTabId: this.screenplayTabId
            });
        }
        catch (e)
        {
            console.warn("[mps:gdocs:sync] persistCacheUpdate failed:", e);
        }
    }

}

/**
 * @param {string} name
 * @param {string} message
 * @returns {Error}
 */
function _err(name, message)
{
    const e = new Error(message);
    e.name = name;
    return e;
}
