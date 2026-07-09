// @ts-check
/**
 * import-state-machine.js — drives the Import Screenplay modal.
 *
 * Shape mirrors publish-state-machine.js (STEPS weights, injected workers,
 * onTransition callback, min-total floor) but with import states:
 *
 *   PICKER → PREFLIGHT_READ → PREFLIGHT_PARSE → [PARSING] → APPLYING → SUCCESS
 *                                                                  ↘ ERROR
 *
 * The Fountain path skips PARSING (preflightFountain already parsed it).
 * The PDF path visits every state. `APPLYING` has a 225ms floor so the
 * user sees the "Updating document…" label even though view.dispatch()
 * returns synchronously (see plan §"Why APPLYING has an explicit 225ms
 * floor").
 *
 * All side effects (file reads, PDF parse, editor mutation) are injected
 * via the `workers` bag — the FSM stays trivially testable.
 */

/** @typedef {"PICKER"|"PREFLIGHT_READ"|"PREFLIGHT_PARSE"|"PARSING"|"APPLYING"|"SUCCESS"|"ERROR"} ImportState */
/** @typedef {"pdf"|"fountain"} ImportKind */

/** @type {Record<string, { minDwell: number, weight: number }>} */
export const STEPS = Object.freeze({
    "preflight.read":  { minDwell: 150, weight: 10 },
    "preflight.parse": { minDwell: 200, weight: 30 },
    "parsing":         { minDwell: 200, weight: 45 },
    "applying":        { minDwell: 225, weight: 15 }
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
 * @typedef {Object} ImportWorkers
 * @property {(path: string) => Promise<ArrayBuffer>} readBinaryFile
 * @property {(path: string) => Promise<string>} readTextFile
 * @property {(buf: ArrayBuffer) => Promise<{ valid: boolean, reason: string|null, detail: string|null }>} preflightPdf
 * @property {(text: string) => Promise<{ valid: boolean, reason: string|null, detail: string|null, screenplay?: any }>} preflightFountain
 * @property {(buf: ArrayBuffer) => Promise<{ fountainText: string }>} parsePdfToFountain
 * @property {(text: string) => { fountainText: string }} fountainPassthrough
 * @property {(fountainText: string) => void} applyToEditor
 */

/**
 * @typedef {Object} TransitionPayload
 * @property {ImportState} state
 * @property {number} pct
 * @property {any} [payload]
 */

export class ImportStateMachine
{
    /**
     * @param {{
     *   kind: ImportKind,
     *   path: string,
     *   workers: ImportWorkers,
     *   onTransition?: (t: TransitionPayload) => void,
     *   minTotalMs?: number,
     *   sleepImpl?: (ms: number) => Promise<void>
     * }} opts
     */
    constructor(opts)
    {
        this.kind = opts.kind;
        this.path = opts.path;
        this.workers = opts.workers;
        this.onTransition = opts.onTransition || (() => {});
        this.minTotalMs = opts.minTotalMs == null ? MIN_TOTAL_MS : opts.minTotalMs;
        this._sleep = opts.sleepImpl || sleep;

        /** @type {ImportState} */
        this.state = "PICKER";
        this.pct = 0;
        this.isCancelled = false;
        /** @type {ImportState|null} */
        this.failedStep = null;
    }

    /** Ask the FSM to ignore remaining transitions (modal closed mid-run). */
    cancel()
    {
        this.isCancelled = true;
    }

    /**
     * Walk the import pipeline. Resolves on SUCCESS or ERROR. Never throws.
     * @returns {Promise<void>}
     */
    async run()
    {
        const startedAt = Date.now();
        const clockPromise = this._sleep(this.minTotalMs);

        try
        {
            // ── PREFLIGHT_READ ────────────────────────────────────────────
            /** @type {ArrayBuffer|string} */
            let raw;
            if (this.kind === "pdf")
            {
                raw = await this._transition("preflight.read", "PREFLIGHT_READ",
                    () => this.workers.readBinaryFile(this.path));
            }
            else
            {
                raw = await this._transition("preflight.read", "PREFLIGHT_READ",
                    () => this.workers.readTextFile(this.path));
            }

            // ── PREFLIGHT_PARSE ───────────────────────────────────────────
            /** @type {any} */
            let preflightResult;
            if (this.kind === "pdf")
            {
                preflightResult = await this._transition("preflight.parse", "PREFLIGHT_PARSE",
                    () => this.workers.preflightPdf(/** @type {ArrayBuffer} */ (raw)));
            }
            else
            {
                preflightResult = await this._transition("preflight.parse", "PREFLIGHT_PARSE",
                    () => this.workers.preflightFountain(/** @type {string} */ (raw)));
            }
            if (!preflightResult.valid)
            {
                throw _err(preflightResult.reason || "unknown",
                    preflightResult.detail || "preflight failed");
            }

            // ── PARSING (PDF only) ────────────────────────────────────────
            /** @type {string} */
            let fountainText;
            if (this.kind === "pdf")
            {
                const parsed = await this._transition("parsing", "PARSING",
                    () => this.workers.parsePdfToFountain(
                        /** @type {ArrayBuffer} */ (raw)));
                fountainText = parsed.fountainText;
            }
            else
            {
                // Fountain path: passthrough. No dwell, no progress advance
                // for the "parsing" step — its weight is forfeit and the
                // bar ends earlier (matches publish's skipped-step behaviour).
                fountainText = this.workers.fountainPassthrough(
                    /** @type {string} */ (raw)).fountainText;
            }

            // ── APPLYING ──────────────────────────────────────────────────
            // view.dispatch is synchronous — enforce the 225ms floor so the
            // "Updating document…" label doesn't flash. STEPS["applying"]
            // minDwell already handles this via _transition's padding.
            await this._transition("applying", "APPLYING", async () =>
            {
                this.workers.applyToEditor(fountainText);
            });

            if (this.isCancelled) return;

            // ── Total-duration floor ──────────────────────────────────────
            await clockPromise;
            const elapsed = Date.now() - startedAt;
            if (elapsed < this.minTotalMs)
            {
                await this._sleep(this.minTotalMs - elapsed);
            }

            if (this.isCancelled) return;
            this._toState("SUCCESS", {});
        }
        catch (err)
        {
            if (this.isCancelled) return;
            console.error("[import-fsm] caught error in state:", this.state, err);
            console.error("[import-fsm] err.name:", /** @type {any} */ (err)?.name);
            console.error("[import-fsm] err.message:", /** @type {any} */ (err)?.message);
            console.error("[import-fsm] err.stack:", /** @type {any} */ (err)?.stack);
            const failedStep = this.state;
            const e = /** @type {any} */ (err);
            const reason = (e && e.name) || "fatal.unknown";
            const detail = String((e && e.message) || err || "");
            this.failedStep = failedStep;
            this._toState("ERROR", { failedStep, reason, detail });
        }
    }

    /**
     * @param {keyof typeof STEPS} stepKey
     * @param {ImportState} nextState
     * @param {() => Promise<any>} work
     */
    async _transition(stepKey, nextState, work)
    {
        this._toState(nextState);
        const def = STEPS[stepKey];
        const minDwell = def ? def.minDwell : 0;
        const weight = def ? def.weight : 0;

        const startedAt = Date.now();
        const result = await work();
        const elapsed = Date.now() - startedAt;
        if (elapsed < minDwell) await this._sleep(minDwell - elapsed);

        this.pct = Math.min(100, this.pct + weight);
        if (!this.isCancelled)
        {
            this.onTransition({ state: this.state, pct: this.pct });
        }
        return result;
    }

    /**
     * @param {ImportState} state
     * @param {any} [payload]
     */
    _toState(state, payload)
    {
        this.state = state;
        if (this.isCancelled) return;
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
