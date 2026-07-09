// @ts-check
/**
 * publish-state-machine.js — drives the three-panel Publish modal.
 *
 * Per TODO/mangaplay-studio-google-docs-sync.md §3a "Implementation
 * skeleton". The machine is pure orchestration — every side effect (every
 * Drive / Docs API call) is injected as a worker function. That lets the
 * tests run with no network and no Tauri.
 *
 * Lifecycle:
 *   constructor() ── form values + workers + onTransition + clock
 *   run()         ── walks preflight → creating → writing → applyProps →
 *                    [sharing] → [locking] → success, with min-dwell
 *                    padding per step and a 2-second total floor before
 *                    transitioning to success.
 *
 * Error handling:
 *   Any thrown error is routed through `errorClassifier.classifyError`
 *   (origin "publish") and the machine transitions to `error` with
 *   `{ failedStep, errorClass, message, retryable, diagnostic }`.
 *
 * Progress weights (per §3a "Step labels and progress weights"):
 *   The realistic paths total ~100%. Skipped optional steps (sharing,
 *   locking) drop out and their weight is forfeit — the bar simply ends
 *   earlier. That's the documented behaviour ("skipped → 0").
 */

import { classifyError } from "../../../../core/google-docs/index.js";

/** @typedef {"form"|"preflight.network"|"preflight.google"|"preflight.token"|"preflight.file"|"preflight.dest"|"creating"|"writingTabs"|"applyProps"|"sharing"|"locking"|"success"|"error"} PublishState */

/** @type {Record<string, { minDwell: number, weight: number }>} */
export const STEPS = Object.freeze({
    "preflight.network": { minDwell: 200, weight: 5 },
    "preflight.google":  { minDwell: 150, weight: 5 },
    "preflight.token":   { minDwell: 200, weight: 10 },
    "preflight.file":    { minDwell: 100, weight: 5 },
    "preflight.dest":    { minDwell: 150, weight: 5 },
    "creating":          { minDwell: 300, weight: 15 },
    // One step now covers both formats — the merged mangaplay batch and the
    // single-tab fountain/text batch each issue exactly one batchUpdate.
    // Weight 35 = the old writingTab1 (20) + writingTab2 (15) combined.
    "writingTabs":       { minDwell: 400, weight: 35 },
    "applyProps":        { minDwell: 100, weight: 5 },
    "sharing":           { minDwell: 200, weight: 5 },
    "locking":           { minDwell: 200, weight: 5 }
});

const MIN_TOTAL_MS = 2000;

/**
 * Wait `ms` milliseconds. Pulled out so tests can stub `Date.now` and we
 * still get deterministic behaviour — but the test suite for this module
 * uses real-time `setTimeout` because the durations are short (≤ 2s).
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms)
{
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * @typedef {Object} PreflightWorkers
 * @property {(args: any) => Promise<any>} preflightNetwork
 * @property {(args: any) => Promise<any>} preflightGoogle
 * @property {(args: any) => Promise<{ token: string }>} preflightToken
 * @property {(args: any) => Promise<any>} preflightFile
 * @property {(args: any) => Promise<{ warning?: string } | any>} preflightDest
 */

/**
 * @typedef {Object} PublishWorkers
 * @property {(args: { token: string, title: string }) => Promise<{ documentId: string, rootTabId: string }>} createDoc
 * @property {(args: { token: string, docId: string, rootTabId: string, sourceText: string, format: "mangaplay"|"fountain"|"text" }) => Promise<{ screenplayTabId: string|null }>} writeTabs
 * @property {(args: any) => Promise<void>} writeAppProps
 * @property {(args: any) => Promise<{ failedEmails: Array<string> }>} applySharing
 * @property {(args: any) => Promise<{ lockToken: string, lockedAt: string }>} acquireLock
 * @property {(args: { token: string, docId: string }) => Promise<string|null>} fetchHeadRevisionId
 * @property {(args: { projectPath: string, scriptRelPath: string, entry: any }) => Promise<void>} persistCacheEntry
 * @property {(args: { fileName: string, docId: string, docUrl: string, format: "mangaplay"|"fountain"|"text", intent: "publish"|"collaborate" }) => Promise<void>} [appendPublishLog]
 */

/**
 * @typedef {Object} PublishFormValues
 * @property {"publish"|"collaborate"} intent  — `publish` = one-shot copy, no
 *   sync cache, no link; `collaborate` = persist cache entry + seed
 *   revisionId so the footer surfaces the Sync popover and Push/Pull track
 *   the same Doc on subsequent opens.
 * @property {string} title
 * @property {string} localPath
 * @property {"mangaplay"|"fountain"|"text"} format
 * @property {string} sourceText
 * @property {string|null} folderId        — null/"root" for My Drive root
 * @property {"private"|"viewLink"|"commentLink"|"specific"} sharing
 * @property {Array<string>} sharingEmails  — only when sharing === "specific"
 * @property {boolean} lockOnPublish
 * @property {string} [userName]
 * @property {string} [clientId]
 * @property {string} [projectId]
 * @property {string} [scriptRelPath]
 * @property {string} [projectPath]
 */

/**
 * @typedef {Object} TransitionPayload
 * @property {PublishState} state
 * @property {number} pct
 * @property {any} [payload]
 */

export class PublishStateMachine
{
    /**
     * @param {{ formValues: PublishFormValues, workers: PreflightWorkers & PublishWorkers, onTransition?: (t: TransitionPayload) => void, minTotalMs?: number, sleepImpl?: (ms: number) => Promise<void> }} opts
     */
    constructor(opts)
    {
        this.values = opts.formValues;
        this.workers = opts.workers;
        this.onTransition = opts.onTransition || (() => {});
        this.minTotalMs = opts.minTotalMs == null ? MIN_TOTAL_MS : opts.minTotalMs;
        this._sleep = opts.sleepImpl || sleep;

        /** @type {PublishState} */
        this.state = "form";
        this.pct = 0;

        /** @type {string|null} */
        this.token = null;
        /** @type {string|null} */
        this.docId = null;
        /** @type {string|null} */
        this.docUrl = null;

        /** @type {Array<string>} */
        this.warnings = [];

        /** @type {PublishState|null} */
        this.failedStep = null;
    }

    /**
     * Walk the publish pipeline. Resolves once the machine reaches `success`
     * or `error`. Never throws — errors are caught, classified, and routed
     * via `onTransition`.
     *
     * @returns {Promise<void>}
     */
    async run()
    {
        const startedAt = Date.now();
        const clockPromise = this._sleep(this.minTotalMs);

        try
        {
            // ── Preflight ────────────────────────────────────────────────
            const netResult = await this._transition("preflight.network",
                () => this.workers.preflightNetwork({}));

            await this._transition("preflight.google",
                () => this.workers.preflightGoogle({ response: netResult && netResult.response }));

            const tokenResult = await this._transition("preflight.token",
                () => this.workers.preflightToken({}));
            this.token = tokenResult && tokenResult.token ? tokenResult.token : null;
            if (!this.token) throw _err("AuthError", "no access token from preflight");

            await this._transition("preflight.file",
                () => this.workers.preflightFile({ localPath: this.values.localPath }));

            const destResult = await this._transition("preflight.dest",
                () => this.workers.preflightDest({ token: this.token, folderId: this.values.folderId }));
            if (destResult && destResult.warning) this.warnings.push(destResult.warning);

            // ── Doc creation ─────────────────────────────────────────────
            const createResult = await this._transition("creating",
                () => this.workers.createDoc({ token: this.token, title: this.values.title }));
            const docId = createResult && createResult.documentId;
            const rootTabId = createResult && createResult.rootTabId;
            if (!docId) throw _err("DocsApiError", "createDoc did not return a documentId");
            this.docId = docId;
            this.docUrl = `https://docs.google.com/document/d/${docId}`;

            // ── Tab writes ───────────────────────────────────────────────
            // One batchUpdate covers both formats — the merged mangaplay
            // batch (root insert + rename + addDocumentTab + screenplay
            // insert) and the single-tab fountain/text insertText.
            const tabsResult = await this._transition("writingTabs",
                () => this.workers.writeTabs({
                    token: this.token,
                    docId,
                    rootTabId,
                    sourceText: this.values.sourceText,
                    format: this.values.format
                }));
            const screenplayTabId = (tabsResult && tabsResult.screenplayTabId) || null;

            // ── appProperties + parents ─────────────────────────────────
            await this._transition("applyProps",
                () => this.workers.writeAppProps({
                    token: this.token,
                    docId,
                    formValues: this.values
                }));

            // ── Sharing (optional) ──────────────────────────────────────
            if (this.values.sharing && this.values.sharing !== "private")
            {
                await this._transition("sharing",
                    () => this.workers.applySharing({
                        token: this.token,
                        docId,
                        sharing: this.values.sharing,
                        emails: this.values.sharingEmails || []
                    }));
            }

            // ── Lock (optional) ─────────────────────────────────────────
            /** @type {{ lockToken: string, lockedAt: string }|null} */
            let lockResult = null;
            if (this.values.lockOnPublish)
            {
                lockResult = await this._transition("locking",
                    () => this.workers.acquireLock({
                        token: this.token,
                        docId,
                        userName: this.values.userName || "Mangaplay Studio",
                        clientId: this.values.clientId || ""
                    }));
            }

            // ── Post-publish cache write (collaborate-only, best-effort) ─
            // Publish has succeeded by this point. Both calls below are
            // non-fatal — failure is logged but doesn't surface as a
            // publish error. See BUG-001 + BUG-003.
            //
            // For `intent === "publish"` we skip both: the user wanted a
            // one-shot copy with no link, so writing a googleDocsSync entry
            // would make the footer mount the Sync popover on next open
            // (the very bug this gate prevents).
            const isCollaborate = this.values.intent === "collaborate";
            let lastKnownRevisionId = null;
            if (isCollaborate && this.workers.fetchHeadRevisionId)
            {
                console.warn("[mps:auth:TRACE] PublishStateMachine → collaborate: fetching headRevisionId post-publish");
                try
                {
                    lastKnownRevisionId = await this.workers.fetchHeadRevisionId({
                        token: this.token,
                        docId
                    });
                    console.warn("[mps:auth:TRACE] PublishStateMachine → fetchHeadRevisionId returned=", lastKnownRevisionId);
                }
                catch (e)
                {
                    console.warn("[mps:auth:TRACE] PublishStateMachine → fetchHeadRevisionId THREW", e);
                }
            }

            if (isCollaborate
                && this.workers.persistCacheEntry
                && this.values.projectPath
                && this.values.scriptRelPath)
            {
                console.warn("[mps:auth:TRACE] PublishStateMachine → persistCacheEntry writing",
                    {
                        projectPath: this.values.projectPath,
                        scriptRelPath: this.values.scriptRelPath,
                        docId,
                        rootTabId: !!rootTabId,
                        screenplayTabId: !!screenplayTabId,
                        lastKnownRevisionId,
                        lastKnownLockToken: lockResult && lockResult.lockToken ? "present" : "null"
                    });
                try
                {
                    await this.workers.persistCacheEntry({
                        projectPath: this.values.projectPath,
                        scriptRelPath: this.values.scriptRelPath,
                        entry:
                        {
                            docId,
                            rootTabId,
                            screenplayTabId,
                            lastKnownRevisionId,
                            lastKnownLockToken: lockResult && lockResult.lockToken
                                ? lockResult.lockToken
                                : null,
                            lastCheckedAt: new Date().toISOString(),
                            format: this.values.format
                        }
                    });
                    console.warn("[mps:auth:TRACE] PublishStateMachine → persistCacheEntry succeeded");
                }
                catch (e)
                {
                    console.warn("[mps:auth:TRACE] PublishStateMachine → persistCacheEntry THREW", e);
                }
            }
            else if (!isCollaborate)
            {
                console.warn("[mps:auth:TRACE] PublishStateMachine → intent=publish, skipping cache write");
            }
            else
            {
                console.warn("[mps:auth:TRACE] PublishStateMachine → collab cache write SKIPPED — missing worker/projectPath/scriptRelPath",
                    {
                        hasWorker: !!this.workers.persistCacheEntry,
                        hasProjectPath: !!this.values.projectPath,
                        hasScriptRelPath: !!this.values.scriptRelPath
                    });
            }

            // Post-publish log entry — best-effort, both intents. A failure
            // here MUST NOT surface as a publish error; the worker swallows
            // internally but the try/catch is belt-and-braces.
            if (this.workers.appendPublishLog)
            {
                try
                {
                    await this.workers.appendPublishLog({
                        fileName: this.values.title,
                        docId,
                        docUrl: this.docUrl,
                        format: this.values.format,
                        intent: this.values.intent
                    });
                }
                catch (e)
                {
                    console.warn("[publish] appendPublishLog failed", e);
                }
            }

            // ── 2-second floor ──────────────────────────────────────────
            await clockPromise;
            const elapsed = Date.now() - startedAt;
            if (elapsed < this.minTotalMs)
            {
                // Defensive — clockPromise should already cover this.
                await this._sleep(this.minTotalMs - elapsed);
            }

            this._toState("success", { docId, docUrl: this.docUrl });
        }
        catch (err)
        {
            const failedStep = this.state;
            const errorClass = classifyError(err, { origin: "publish", stepKey: failedStep });
            const e = /** @type {any} */ (err);
            const message = String((e && e.message) || err || "");
            const diagnostic = `${(e && e.name) || "Error"}: ${message.slice(0, 200)}`;
            const retryable = errorClass !== "fatal.config" && errorClass !== "fatal.unknown"
                ? true
                : false;

            this.failedStep = failedStep;
            this._toState("error", { failedStep, errorClass, message, retryable, diagnostic });
        }
    }

    /**
     * Run the work for `stepKey` with min-dwell padding, advance progress
     * by the (optionally adjusted) weight, and notify subscribers.
     *
     * @param {PublishState} stepKey
     * @param {() => Promise<any>} work
     * @param {number} [weightDelta]  — adjusts STEPS[stepKey].weight; unused
     *                                  today since the merged writingTabs
     *                                  step covers both formats.
     * @returns {Promise<any>}
     */
    async _transition(stepKey, work, weightDelta = 0)
    {
        this._toState(stepKey);
        const def = STEPS[stepKey];
        const minDwell = def ? def.minDwell : 0;
        const weight = def ? def.weight + weightDelta : 0;

        const startedAt = Date.now();
        const result = await work();
        const elapsed = Date.now() - startedAt;
        if (elapsed < minDwell) await this._sleep(minDwell - elapsed);

        this.pct = Math.min(100, this.pct + weight);
        this.onTransition({ state: this.state, pct: this.pct });
        return result;
    }

    /**
     * @param {PublishState} state
     * @param {any} [payload]
     */
    _toState(state, payload)
    {
        this.state = state;
        this.onTransition({ state, pct: this.pct, payload });
    }
}

/**
 * Local helper — preflight throws using shape that mirrors the rest of the
 * code base (`name` + `message`). Used here only for "shouldn't happen"
 * defensive guards on worker return shapes.
 *
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
