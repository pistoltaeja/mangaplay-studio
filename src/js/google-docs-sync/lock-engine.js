// @ts-check
/**
 * lock-engine.js — Drive `contentRestrictions` + appProperties lock helpers.
 *
 * Three primitives:
 *
 *   lock({ token, docId, userName, clientId, lockedBySub })
 *     1. Mint a fresh lockToken (UUIDv4).
 *     2. PATCH the file with `contentRestrictions: [{ readOnly: true }]`
 *        plus our five appProperties (mpsLockToken/mpsLockedAt/mpsLockedBy/
 *        mpsClientId/mpsLockedBySub).
 *     3. Re-read appProperties via GET. If our token won, return it; if
 *        another client wrote concurrently, throw — caller routes that to
 *        the `permissions.doc_picker_denied` surface.
 *
 *   unlock({ token, docId })
 *     PATCH the file with `contentRestrictions: [{ readOnly: false }]`
 *     and clear all five mps lock fields (empty strings — Drive deletes
 *     appProperties keys whose value is "").
 *
 *   liftRestriction({ token, docId, driveClient })
 *     PATCH the file with `contentRestrictions: [{ readOnly: false }]`
 *     ONLY — appProperties untouched. Used by the Update Content flow to
 *     suspend the readonly flag while batchUpdate runs without losing the
 *     lock identity.
 *
 *   applyRestriction({ token, docId, userName, driveClient })
 *     PATCH the file with `contentRestrictions: [{ readOnly: true, reason }]`
 *     ONLY — appProperties untouched. Pairs with liftRestriction in the
 *     Update Content flow.
 *
 *   evaluateLockState({ appProperties, ourLockToken, ourSub, nowMs })
 *     Pure function. Returns one of:
 *       'unlocked'         — no mpsLockToken set
 *       'locked-by-me'     — sub matches OR token matches our session's
 *                            lockToken (sub match wins so a sign-out/sign-in
 *                            cycle on the same account doesn't lose
 *                            ownership)
 *       'stale'            — mpsLockedAt > 10 minutes ago
 *       'locked-by-other'  — neither sub nor token matches and lock is fresh
 *
 *   HeartbeatController
 *     5-minute interval that re-PATCHes mpsLockedAt — but only when the
 *     editor was foregrounded AND interacted within the last 60s. The
 *     "foregrounded" half is wired by the caller (start/stop on focus/blur);
 *     this class only manages the timer + idle skip.
 */

import { uuid } from "./uuid.js";

export const STALE_LOCK_MS = 10 * 60 * 1000;
export const HEARTBEAT_MS = 5 * 60 * 1000;
export const IDLE_THRESHOLD_MS = 60 * 1000;

/**
 * @typedef {Object} LockEvalArgs
 * @property {Record<string, string> | null | undefined} appProperties
 * @property {string|null} ourLockToken
 * @property {string|null} [ourSub]   — current Google account `sub`. When
 *   the lock's `mpsLockedBySub` matches this we treat it as "locked-by-me"
 *   even if the in-memory `ourLockToken` is gone (sign-out + sign-in on
 *   the same account would otherwise lose ownership).
 * @property {number} [nowMs]
 */

/**
 * Classify the Drive file's current lock state from its appProperties.
 *
 * @param {LockEvalArgs} args
 * @returns {'unlocked'|'locked-by-me'|'locked-by-other'|'stale'}
 */
export function evaluateLockState({ appProperties, ourLockToken, ourSub, nowMs })
{
    const props = appProperties || {};
    const lockToken = props.mpsLockToken || "";
    const lockedAt = props.mpsLockedAt || "";
    const lockedBy = props.mpsLockedBy || "";
    const lockedBySub = props.mpsLockedBySub || "";

    if (!lockToken)
    {
        return "unlocked";
    }

    const ts = lockedAt ? Date.parse(lockedAt) : NaN;
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    const ageMs = Number.isFinite(ts) ? (now - ts) : NaN;
    if (!Number.isFinite(ts) || (now - ts) > STALE_LOCK_MS)
    {
        return "stale";
    }

    if (ourSub && lockedBySub && lockedBySub === ourSub)
    {
        return "locked-by-me";
    }
    if (ourLockToken && lockToken === ourLockToken)
    {
        return "locked-by-me";
    }
    return "locked-by-other";
}

/**
 * Acquire the lock with race detection.
 *
 * @param {Object} args
 * @param {string} args.token
 * @param {string} args.docId
 * @param {string} args.userName
 * @param {string} args.clientId
 * @param {string|null} [args.lockedBySub] — current Google account `sub`.
 *   Written into `mpsLockedBySub` so the Update Content flow can match
 *   "this is my own lock" by identity across sign-out/sign-in cycles.
 *   Pass `null` to leave the field blank (back-compat).
 * @param {object} args.driveClient    — `{ filesUpdate, filesGet }`
 * @returns {Promise<{ lockToken: string, lockedAt: string }>}
 */
export async function lock({ token, docId, userName, clientId, lockedBySub, driveClient })
{
    if (!docId) throw _err("DocsApiError", "lock: docId required");
    if (!driveClient) throw _err("DocsApiError", "lock: driveClient required");

    const lockToken = uuid();
    const lockedAt = new Date().toISOString();
    const lockedBy = userName || "Mangaplay Studio";

    console.debug("[mps:gdocs:update] lock starting", { docId });
    try
    {
        await driveClient.filesUpdate({
            token,
            fileId: docId,
            body: {
                contentRestrictions: [{
                    readOnly: true,
                    reason: `Locked by ${lockedBy} in Mangaplay Studio`
                }],
                appProperties: {
                    mpsLockToken: lockToken,
                    mpsLockedAt: lockedAt,
                    mpsLockedBy: lockedBy,
                    mpsClientId: clientId || "",
                    mpsLockedBySub: lockedBySub || ""
                }
            }
        });
        console.debug("[mps:gdocs:update] lock ok", { docId });
    }
    catch (e)
    {
        const ee = /** @type {any} */ (e);
        console.warn("[mps:gdocs:update] lock failed", { docId, name: ee && ee.name, message: ee && ee.message });
        throw e;
    }

    // Race-detection re-read — last-writer-wins on Drive, so the survivor
    // is whoever shows up here.
    const verify = await driveClient.filesGet({
        token,
        fileId: docId,
        fields: "appProperties"
    });
    const seenToken = verify && verify.appProperties && verify.appProperties.mpsLockToken;
    if (seenToken !== lockToken)
    {
        throw _err("FileNotGrantedError",
            "Lock contested by another client (re-read returned different token)");
    }

    return { lockToken, lockedAt };
}

/**
 * Release the lock — clear contentRestriction + the four mps lock fields.
 *
 * @param {Object} args
 * @param {string} args.token
 * @param {string} args.docId
 * @param {object} args.driveClient
 * @returns {Promise<void>}
 */
export async function unlock({ token, docId, driveClient })
{
    if (!docId) throw _err("DocsApiError", "unlock: docId required");
    if (!driveClient) throw _err("DocsApiError", "unlock: driveClient required");

    console.debug("[mps:gdocs:update] unlock starting", { docId });
    try
    {
        await driveClient.filesUpdate({
            token,
            fileId: docId,
            body: {
                contentRestrictions: [{ readOnly: false }],
                appProperties: {
                    // Drive deletes appProperties whose value is "".
                    mpsLockToken: "",
                    mpsLockedAt: "",
                    mpsLockedBy: "",
                    mpsClientId: "",
                    mpsLockedBySub: ""
                }
            }
        });
        console.debug("[mps:gdocs:update] unlock ok", { docId });
    }
    catch (e)
    {
        const ee = /** @type {any} */ (e);
        console.warn("[mps:gdocs:update] unlock failed", { docId, name: ee && ee.name, message: ee && ee.message });
        throw e;
    }
}

/**
 * Suspend the readonly content-restriction WITHOUT touching appProperties.
 * Pairs with `applyRestriction` so the Update Content flow can run a
 * batchUpdate over a locked doc without losing the lock identity.
 *
 * @param {Object} args
 * @param {string} args.token
 * @param {string} args.docId
 * @param {object} args.driveClient    — `{ filesUpdate }`
 * @returns {Promise<void>}
 */
export async function liftRestriction({ token, docId, driveClient })
{
    if (!docId) throw _err("DocsApiError", "liftRestriction: docId required");
    if (!driveClient) throw _err("DocsApiError", "liftRestriction: driveClient required");

    console.debug("[mps:gdocs:update] liftRestriction starting", { docId });
    try
    {
        await driveClient.filesUpdate({
            token,
            fileId: docId,
            body: { contentRestrictions: [{ readOnly: false }] }
        });
        console.debug("[mps:gdocs:update] liftRestriction ok", { docId });
    }
    catch (e)
    {
        const ee = /** @type {any} */ (e);
        console.warn("[mps:gdocs:update] liftRestriction failed", { docId, name: ee && ee.name, message: ee && ee.message });
        throw e;
    }
}

/**
 * Re-apply the readonly content-restriction WITHOUT touching appProperties.
 * Pairs with `liftRestriction`.
 *
 * @param {Object} args
 * @param {string} args.token
 * @param {string} args.docId
 * @param {string} [args.userName]
 * @param {object} args.driveClient    — `{ filesUpdate }`
 * @returns {Promise<void>}
 */
export async function applyRestriction({ token, docId, userName, driveClient })
{
    if (!docId) throw _err("DocsApiError", "applyRestriction: docId required");
    if (!driveClient) throw _err("DocsApiError", "applyRestriction: driveClient required");

    const lockedBy = userName || "Mangaplay Studio";
    console.debug("[mps:gdocs:update] applyRestriction starting", { docId });
    try
    {
        await driveClient.filesUpdate({
            token,
            fileId: docId,
            body: {
                contentRestrictions: [{
                    readOnly: true,
                    reason: `Locked by ${lockedBy} in Mangaplay Studio`
                }]
            }
        });
        console.debug("[mps:gdocs:update] applyRestriction ok", { docId });
    }
    catch (e)
    {
        const ee = /** @type {any} */ (e);
        console.warn("[mps:gdocs:update] applyRestriction failed", { docId, name: ee && ee.name, message: ee && ee.message });
        throw e;
    }
}

/**
 * 5-minute heartbeat that refreshes `mpsLockedAt` so the 10-minute TTL
 * doesn't expire while the user is actively editing. Skip-on-idle
 * behaviour means a walked-away user lets the lock decay normally.
 *
 * The caller is responsible for `start` on focus / `stop` on blur. The
 * controller does NOT subscribe to window events itself — that keeps it
 * unit-testable and lets the parent state machine decide policy.
 */
export class HeartbeatController
{
    /**
     * @param {Object} opts
     * @param {object} opts.driveClient                — `{ filesUpdate }`
     * @param {() => number} [opts.nowImpl]
     * @param {(fn: () => void, ms: number) => any} [opts.setIntervalImpl]
     * @param {(handle: any) => void} [opts.clearIntervalImpl]
     */
    constructor(opts = /** @type {any} */ ({}))
    {
        this.driveClient = opts.driveClient;
        this._now = opts.nowImpl || (() => Date.now());
        this._setInterval = opts.setIntervalImpl || ((fn, ms) => setInterval(fn, ms));
        this._clearInterval = opts.clearIntervalImpl || ((h) => clearInterval(h));

        this._timer = null;
        this._lastInteractionAt = this._now();

        /** @type {string|null} */ this._token = null;
        /** @type {string|null} */ this._docId = null;
        /** @type {string|null} */ this._lockToken = null;
    }

    /** Update the "last interaction" stamp — callers fire this from input/key events. */
    noteInteraction()
    {
        this._lastInteractionAt = this._now();
    }

    /**
     * Begin the heartbeat. Safe to call repeatedly with new params —
     * previous interval is cleared first.
     *
     * @param {Object} args
     * @param {string} args.token
     * @param {string} args.docId
     * @param {string} args.lockToken
     */
    start({ token, docId, lockToken })
    {
        this.stop();
        if (!token || !docId || !lockToken) return;
        this._token = token;
        this._docId = docId;
        this._lockToken = lockToken;

        this._timer = this._setInterval(() => { void this._tick(); }, HEARTBEAT_MS);
    }

    stop()
    {
        if (this._timer != null)
        {
            this._clearInterval(this._timer);
            this._timer = null;
        }
    }

    async _tick()
    {
        if (!this._token || !this._docId) return;
        const idleMs = this._now() - this._lastInteractionAt;
        if (idleMs > IDLE_THRESHOLD_MS) return;

        try
        {
            await this.driveClient.filesUpdate({
                token: this._token,
                fileId: this._docId,
                body: {
                    appProperties: { mpsLockedAt: new Date(this._now()).toISOString() }
                }
            });
        }
        catch (e)
        {
            // Heartbeat is best-effort — log but never throw out of the
            // setInterval callback, that would leave the timer dangling
            // in some runtimes.
            console.warn("[mps:gdocs:lock] heartbeat failed:", e);
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
