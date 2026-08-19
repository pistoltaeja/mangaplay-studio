// @ts-check
/**
 * update-state-machine.js — drives the four-panel Update Content modal.
 *
 * Mirrors the shape of
 * `publish-state-machine.js`: pure orchestration with every side effect
 * injected as a worker. That keeps the machine testable without network
 * or Tauri, and lets the modal layer hold the user-confirm pause for the
 * `confirmForceTake` panel.
 *
 * Flow:
 *
 *   form (entry)
 *     → preflight.network
 *     → preflight.token
 *     → preflight.fileAccess
 *     → checkingLock
 *         ├─ unlocked          → writing → success
 *         ├─ locked-by-me      → lifting → writing → reapplying → success
 *         └─ locked-by-other   → confirmForceTake (PAUSE)
 *             ├─ Cancel        → cancelled (terminal)
 *             └─ Force Update  → forceTake → lifting → writing → reapplying → success
 *     → error (from any step on classified failure)
 *
 * Error handling:
 *   Any thrown error from a worker is classified via `classifyError`
 *   (origin "publish") and the machine transitions to `error` with
 *   `{ failedStep, errorClass, message, retryable, diagnostic }`.
 *
 * Progress weights total ~100. confirmForceTake contributes 0 since the
 * pause is user-driven; lifting/writing/reapplying carry the bulk.
 */

import { classifyError } from "../../../../core/google-docs/index.js";

/** @typedef {"form"|"preflight.network"|"preflight.token"|"preflight.fileAccess"|"checkingLock"|"confirmForceTake"|"forceTaking"|"lifting"|"writing"|"reapplying"|"success"|"error"|"cancelled"} UpdateState */

/** @type {Record<string, { minDwell: number, weight: number }>} */
export const STEPS = Object.freeze({
    "preflight.network":    { minDwell: 150, weight: 5 },
    "preflight.token":      { minDwell: 150, weight: 10 },
    "preflight.fileAccess": { minDwell: 200, weight: 10 },
    "checkingLock":         { minDwell: 200, weight: 10 },
    "confirmForceTake":     { minDwell: 0,   weight: 0 },
    "forceTaking":          { minDwell: 200, weight: 10 },
    "lifting":              { minDwell: 150, weight: 10 },
    "writing":              { minDwell: 300, weight: 35 },
    "reapplying":           { minDwell: 150, weight: 10 }
});

const MIN_TOTAL_MS = 1500;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms)
{
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * @typedef {Object} UpdateWorkers
 * @property {(args?: any) => Promise<any>} preflightNetwork
 * @property {(args?: any) => Promise<{ token: string }>} preflightToken
 * @property {(args: { token: string, docId: string }) => Promise<{ canEdit: boolean }>} preflightFileAccess
 * @property {(args: { token: string, docId: string, ourLockToken: string|null, ourSub: string|null }) => Promise<{ lockState: string, appProps: Record<string,string>, headRevisionId: string|null }>} readLockState
 * @property {(args: { token: string, docId: string, userName: string, clientId: string, lockedBySub: string|null }) => Promise<{ lockToken: string, lockedAt: string }>} forceTake
 * @property {(args: { token: string, docId: string, hasOwnLock: boolean, userName: string, format: "mangaplay"|"fountain"|"text", sourceText: string, localPath: string, expectedRevisionId: string|null }) => Promise<{ newRevisionId: string }>} runPush
 */

/**
 * @typedef {Object} UpdateFormValues
 * @property {string} docId
 * @property {string} [projectPath]
 * @property {string} [scriptRelPath]
 * @property {"mangaplay"|"fountain"|"text"} format
 * @property {string} sourceText
 * @property {string} localPath
 * @property {string|null} expectedRevisionId
 * @property {string} [userName]
 * @property {string} [clientId]
 * @property {string|null} [ourLockToken]
 * @property {string|null} [ourSub]
 */

/**
 * @typedef {Object} TransitionPayload
 * @property {UpdateState} state
 * @property {number} pct
 * @property {any} [payload]
 */

export class UpdateStateMachine
{
    /**
     * @param {{ formValues: UpdateFormValues, workers: UpdateWorkers, onTransition?: (t: TransitionPayload) => void, minTotalMs?: number, sleepImpl?: (ms: number) => Promise<void> }} opts
     */
    constructor(opts)
    {
        this.values = opts.formValues;
        this.workers = opts.workers;
        this.onTransition = opts.onTransition || (() => {});
        this.minTotalMs = opts.minTotalMs == null ? MIN_TOTAL_MS : opts.minTotalMs;
        this._sleep = opts.sleepImpl || sleep;

        /** @type {UpdateState} */
        this.state = "form";
        this.pct = 0;

        /** @type {string|null} */
        this.token = null;
        /** @type {UpdateState|null} */
        this.failedStep = null;

        /** Resolves true on confirmForceTake(), false on cancel(). */
        /** @type {Promise<boolean>|null} */
        this._forceTakeDeferred = null;
        /** @type {((v: boolean) => void)|null} */
        this._resolveForceTake = null;

        /** @type {string} */
        this.newRevisionId = "";
    }

    /**
     * User accepted the "Force Update Now" button on the confirmForceTake
     * panel. Resumes `run()` past the pause.
     */
    confirmForceTake()
    {
        if (this._resolveForceTake)
        {
            const r = this._resolveForceTake;
            this._resolveForceTake = null;
            r(true);
        }
    }

    /**
     * User cancelled — either from the confirmForceTake panel or by closing
     * the modal mid-pause. Resolves the pause with false; `run()` will
     * transition to the `cancelled` terminal state and return.
     */
    cancel()
    {
        if (this._resolveForceTake)
        {
            const r = this._resolveForceTake;
            this._resolveForceTake = null;
            r(false);
        }
    }

    /**
     * Walk the update pipeline. Resolves once the machine reaches a
     * terminal state (`success`, `error`, or `cancelled`). Never throws.
     *
     * @returns {Promise<void>}
     */
    async run()
    {
        const startedAt = Date.now();
        const clockPromise = this._sleep(this.minTotalMs);

        try
        {
            await this._transition("preflight.network",
                () => this.workers.preflightNetwork({}));

            const tokenResult = await this._transition("preflight.token",
                () => this.workers.preflightToken({}));
            this.token = tokenResult && tokenResult.token ? tokenResult.token : null;
            if (!this.token) throw _err("AuthError", "no access token from preflight");

            const access = await this._transition("preflight.fileAccess",
                () => this.workers.preflightFileAccess({
                    token: this.token,
                    docId: this.values.docId
                }));
            if (access && access.canEdit === false)
            {
                throw _err("PermissionError",
                    "Google has revoked access to this Doc. Re-share it or re-publish.");
            }

            const lockResult = await this._transition("checkingLock",
                () => this.workers.readLockState({
                    token: this.token,
                    docId: this.values.docId,
                    ourLockToken: this.values.ourLockToken || null,
                    ourSub: this.values.ourSub || null
                }));

            const lockState = lockResult && lockResult.lockState;
            const appProps = (lockResult && lockResult.appProps) || {};

            /** @type {boolean} */
            let hasOwnLock = false;

            if (lockState === "locked-by-me")
            {
                hasOwnLock = true;
            }
            else if (lockState === "locked-by-other" || lockState === "stale")
            {
                this._forceTakeDeferred = new Promise((resolve) =>
                {
                    this._resolveForceTake = resolve;
                });
                this._toState("confirmForceTake", {
                    lockedBy: appProps.mpsLockedBy || "another user",
                    lockedAt: appProps.mpsLockedAt || "",
                    isStale: lockState === "stale"
                });
                const accepted = await this._forceTakeDeferred;
                this._forceTakeDeferred = null;
                if (!accepted)
                {
                    this._toState("cancelled");
                    return;
                }

                await this._transition("forceTaking",
                    () => this.workers.forceTake({
                        token: this.token,
                        docId: this.values.docId,
                        userName: this.values.userName || "Mangaplay Studio",
                        clientId: this.values.clientId || "",
                        lockedBySub: this.values.ourSub || null
                    }));
                hasOwnLock = true;
            }
            // "unlocked" → hasOwnLock stays false; push doesn't lift.

            if (hasOwnLock)
            {
                // The lift/reapply pair lives inside runPush (push() in
                // push-pull.js owns the try/finally). We surface the
                // lifting + reapplying states for UX progress only.
                this._toState("lifting");
                // Brief dwell for the bar to advance — the actual lift API
                // call is inside runPush, but the UI benefits from seeing
                // the step pass before "writing" lights up.
                await this._sleep(STEPS["lifting"].minDwell);
                this.pct = Math.min(100, this.pct + STEPS["lifting"].weight);
                this.onTransition({ state: this.state, pct: this.pct });
            }

            const pushResult = await this._transition("writing",
                () => this.workers.runPush({
                    token: this.token,
                    docId: this.values.docId,
                    hasOwnLock,
                    userName: this.values.userName || "",
                    format: this.values.format,
                    sourceText: this.values.sourceText,
                    localPath: this.values.localPath,
                    expectedRevisionId: this.values.expectedRevisionId
                }));
            this.newRevisionId = (pushResult && pushResult.newRevisionId) || "";

            if (hasOwnLock)
            {
                this._toState("reapplying");
                await this._sleep(STEPS["reapplying"].minDwell);
                this.pct = Math.min(100, this.pct + STEPS["reapplying"].weight);
                this.onTransition({ state: this.state, pct: this.pct });
            }

            await clockPromise;
            const elapsed = Date.now() - startedAt;
            if (elapsed < this.minTotalMs)
            {
                await this._sleep(this.minTotalMs - elapsed);
            }

            this._toState("success", { newRevisionId: this.newRevisionId });
        }
        catch (err)
        {
            const failedStep = this.state;
            const errorClass = classifyError(err, { origin: "publish", stepKey: failedStep });
            const e = /** @type {any} */ (err);
            const message = String((e && e.message) || err || "");
            const diagnostic = `${(e && e.name) || "Error"}: ${message.slice(0, 200)}`;
            const retryable = errorClass !== "fatal.config" && errorClass !== "fatal.unknown";

            this.failedStep = failedStep;
            this._toState("error", {
                failedStep,
                errorClass,
                errorName: (e && e.name) || "Error",
                message,
                retryable,
                diagnostic
            });
        }
    }

    /**
     * @param {UpdateState} stepKey
     * @param {() => Promise<any>} work
     * @returns {Promise<any>}
     */
    async _transition(stepKey, work)
    {
        this._toState(stepKey);
        const def = STEPS[stepKey];
        const minDwell = def ? def.minDwell : 0;
        const weight = def ? def.weight : 0;

        const startedAt = Date.now();
        const result = await work();
        const elapsed = Date.now() - startedAt;
        if (elapsed < minDwell) await this._sleep(minDwell - elapsed);

        this.pct = Math.min(100, this.pct + weight);
        this.onTransition({ state: this.state, pct: this.pct });
        return result;
    }

    /**
     * @param {UpdateState} state
     * @param {any} [payload]
     */
    _toState(state, payload)
    {
        this.state = state;
        this.onTransition({ state, pct: this.pct, payload });
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
