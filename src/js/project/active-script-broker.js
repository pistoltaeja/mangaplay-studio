// @ts-check
/**
 * active-script-broker.js — Serialises autosave + mutation around the active
 * script file.
 *
 * Background: the editor fires keystroke-driven `scheduleScriptSave`, the
 * canvas fires drag-end-driven `scheduleMangaartSave`, meta updates fire
 * `scheduleMetaSave`, and the explorer can trigger destructive operations
 * (rename / delete / move) via `withLock`. Without a single broker the
 * destructive ops can race the inflight debounced writes, which on Windows
 * gives the user a "file in use" error or worse, a half-written file at a
 * path that no longer exists.
 *
 * Contract:
 *   - One singleton per renderer process (see `getBroker`).
 *   - `setActive(path)` clears any pending writes for the previous path so
 *     they cannot land in the wrong file after a switch.
 *   - Each `schedule*Save` is a 1500 ms debounce; mangaart is per-page so two
 *     different pages don't clobber each other's queued payload.
 *   - `withLock(fn)` drains all pending writes BEFORE running `fn`, holds the
 *     lock for `fn`'s duration, and unlocks even if `fn` rejects. Concurrent
 *     `withLock` calls queue and run serially.
 *   - `dropPendingWrites()` cancels all pending without flushing — used by
 *     the delete-active path so the latest keystrokes don't get written into
 *     a file that's about to be trashed.
 *
 * Test hook: when `window.__MPS_TEST === true` at import time, the broker
 * exposes `window.__brokerForTest` with two helpers used by the CDP smoke
 * harness to assert state without poking module privates.
 */

const SAVE_DEBOUNCE_MS = 1500;

/**
 * Path equality normaliser. Same file can come back from different code paths
 * with different separator styles (Rust `std::fs::rename` returns Windows
 * backslashes; JS path joins use forward slashes). Normalises every separator
 * to "/" so a string compare reflects identity, not formatting.
 * @param {string} p
 * @returns {string}
 */
function normalisePath(p)
{
    return p.replace(/\\/g, "/");
}

/**
 * Strip the Windows `\\?\` extended-length UNC prefix. Rust's
 * `std::fs::canonicalize` (and by extension `std::fs::rename` results after
 * canonicalisation) returns paths in the `\\?\D:\...` form on Windows, but
 * the explorer / row `data-path` attributes carry the bare `D:\...` form.
 * Broker paths are compared via `isActivePath`, which needs both forms to
 * collapse to the same string — otherwise delete-open-file confirmation
 * never fires after a rename.
 * @param {string | null} p
 * @returns {string | null}
 */
function stripUncPrefix(p)
{
    if (p == null) return p;
    if (p.startsWith("\\\\?\\")) return p.slice(4);
    return p;
}

/** @typedef {(payload: any) => Promise<void>} SaveFn */

/** @type {Broker | null} */
let singleton = null;

/**
 * Singleton accessor. Constructs the broker on first call and installs the
 * `__MPS_TEST` hook if requested.
 * @returns {Broker}
 */
export function getBroker()
{
    if (singleton) return singleton;
    singleton = new Broker();
    if (typeof window !== "undefined")
    {
        // Read-only peek helpers used by the CDP smoke harness to assert
        // broker state without poking module privates. The surface is
        // intentionally minimal (just waitDrained + peekState) so there's
        // no risk of test code mutating production state. Safe to expose
        // unconditionally; do not extend without an accompanying test.
        /** @type {any} */ (window).__brokerForTest =
        {
            waitDrained: () => singleton.drainAllPending(),
            peekState: () => singleton._peekState(),
        };
    }
    return singleton;
}

/**
 * For tests only. Resets the module-level singleton so each test can start
 * from a clean state. Not exported from the bundle index — tests import the
 * broker module directly.
 */
export function _resetBrokerForTest()
{
    singleton = null;
    if (typeof window !== "undefined")
    {
        try { delete /** @type {any} */ (window).__brokerForTest; }
        catch { /* ignore */ }
    }
}

/**
 * Creates a fresh, isolated Broker instance. Unlike the getBroker() singleton,
 * a factory-created broker owns its own state and is intended for scenarios
 * where multiple files need concurrent brokered saves (e.g. the aggregate view
 * mounts 3 CM6 EditorViews and each needs its own debounced save timeline).
 *
 * One-broker-per-fileUuid contract:
 *   Callers must guarantee that at any moment, at most ONE factory-created
 *   broker in the entire renderer has a given (path, uuid) as its active
 *   identity. Two brokers with the same active identity will race on writes
 *   and the "last write wins" outcome is undefined.
 *
 *   The aggregate view enforces this by mapping fileUuid → broker 1:1 and
 *   draining + destroying the old broker before creating a new one when a
 *   slide brings a new file into the window.
 *
 * Factory-created brokers set `_isFactory = true` so `setActive` can warn if
 * called a second time with a different identity (a violation of the contract
 * above). The singleton is exempt because its `setActive` swap-and-cancel
 * behaviour is load-bearing for the single-file code path.
 *
 * @returns {Broker}
 */
export function createBroker()
{
    const broker = new Broker();
    broker._isFactory = true;
    return broker;
}

class Broker
{
    constructor()
    {
        /** @type {string | null} */
        this.path = null;
        /** @type {string | null} */
        this.uuid = null;
        /** @type {{ handle: any, text: string, saveFn: SaveFn } | null} */
        this.pendingScript = null;
        /** @type {Map<string, { handle: any, data: any, saveFn: SaveFn }>} */
        this.pendingMangaart = new Map();
        /** @type {{ handle: any, meta: any, saveFn: SaveFn } | null} */
        this.pendingMeta = null;
        /** @type {Array<() => void>} */
        this.queue = [];
        this.locked = false;
        /**
         * Set to true by `createBroker()` for factory-created instances. The
         * singleton path leaves this false. Used by `setActive` to warn when
         * a factory-created broker's identity is changed after construction —
         * a violation of the one-broker-per-fileUuid contract documented on
         * `createBroker`. Not exposed as a constructor parameter to keep the
         * constructor cost near-zero and its shape unchanged.
         * @type {boolean}
         */
        this._isFactory = false;
    }

    /**
     * Set the active script path and (optionally) its registry UUID. Clears
     * any pending writes belonging to the previous file — those writes were
     * targeting a different file and must not land here. Legacy call sites
     * that omit `uuid` still work; the broker treats absence as null.
     *
     * Singleton vs factory:
     *   - On the singleton (getBroker), `setActive` is the swap-file entry
     *     point: the singleton writes for one file at a time and switching
     *     files MUST cancel the previous file's pending writes. This is
     *     load-bearing — the single-file code path relies on it.
     *   - On a factory-created broker (createBroker), `setActive` should be
     *     called ONCE right after construction to bind the broker's identity.
     *     Calling it later with a different identity violates the
     *     one-broker-per-fileUuid contract from `createBroker`; the broker
     *     emits a console.warn but still performs the swap (safety valve,
     *     never the intended path).
     *
     * @param {string | null} path
     * @param {string | null} [uuid]
     */
    setActive(path, uuid = null)
    {
        const stripped = stripUncPrefix(path);
        if (this.path === stripped && this.uuid === uuid) return;
        if (this._isFactory && (this.path !== null || this.uuid !== null))
        {
            console.warn(
                "[broker] setActive called twice on a factory-created broker " +
                "(previous: " + this.path + " / " + this.uuid + ", " +
                "next: " + stripped + " / " + uuid + "). " +
                "Factory brokers should be bound once at construction; " +
                "this indicates an aggregate-view mount/unmount bug."
            );
        }
        this._cancelAllPending();
        this.path = stripped;
        this.uuid = uuid;
    }

    /** @returns {string | null} */
    getActivePath()
    {
        return this.path;
    }

    /** @returns {string | null} */
    getActiveUuid()
    {
        return this.uuid;
    }

    /**
     * UUID-equivalent check on the active file. Returns false when the
     * broker has no active UUID (e.g. path-only legacy callers) so a stray
     * `null === null` collision never matches.
     * @param {string | null | undefined} uuid
     * @returns {boolean}
     */
    isActiveUuid(uuid)
    {
        if (this.uuid === null || uuid == null) return false;
        return uuid === this.uuid;
    }

    /**
     * Path-equivalent check on the active path. Normalises separator style
     * (the Rust commands return Windows backslashes; JS path joins use
     * forward slashes; the same file can be represented either way) before
     * comparing. Without normalisation a fresh-from-Rust rename target
     * compares unequal to the next right-click's row.dataset.path even
     * though they refer to the same file.
     * @param {string | null | undefined} path
     * @returns {boolean}
     */
    isActivePath(path)
    {
        if (this.path === null || path == null) return false;
        return normalisePath(path) === normalisePath(this.path);
    }

    /**
     * Adopt a new path (and optionally a new UUID) or clear ownership
     * entirely. Callers that only pass a path (legacy) leave the tracked
     * UUID at null so the fall-through path-based checks still work.
     *   - `null`     → no file is active (e.g. external delete)
     *   - string     → adopt this path as the new active (e.g. external rename)
     * Pending writes are dropped on any change because they target the old file.
     * @param {string | null} newPath
     * @param {string | null} [newUuid]
     */
    unlock(newPath, newUuid = null)
    {
        this._cancelAllPending();
        this.path = stripUncPrefix(newPath);
        this.uuid = newUuid;
    }

    /**
     * Debounce a script save. `saveFn` is called with `text` after the
     * debounce window elapses.
     * @param {string} text
     * @param {SaveFn} saveFn
     */
    scheduleScriptSave(text, saveFn)
    {
        if (this.pendingScript) clearTimeout(this.pendingScript.handle);
        const pending = { handle: null, text, saveFn };
        pending.handle = setTimeout(() => { this._flushScript(); }, SAVE_DEBOUNCE_MS);
        this.pendingScript = pending;
    }

    /**
     * Debounce a per-page mangaart save. Keyed by `pageId` so writes against
     * different pages don't overwrite each other in the pending slot.
     * @param {string} pageId
     * @param {any} data
     * @param {SaveFn} saveFn
     */
    scheduleMangaartSave(pageId, data, saveFn)
    {
        const existing = this.pendingMangaart.get(pageId);
        if (existing) clearTimeout(existing.handle);
        const pending = { handle: null, data, saveFn };
        pending.handle = setTimeout(() => { this._flushMangaart(pageId); }, SAVE_DEBOUNCE_MS);
        this.pendingMangaart.set(pageId, pending);
    }

    /**
     * Debounce a meta.json save. Single-slot — meta isn't per-page.
     * @param {any} meta
     * @param {SaveFn} saveFn
     */
    scheduleMetaSave(meta, saveFn)
    {
        if (this.pendingMeta) clearTimeout(this.pendingMeta.handle);
        const pending = { handle: null, meta, saveFn };
        pending.handle = setTimeout(() => { this._flushMeta(); }, SAVE_DEBOUNCE_MS);
        this.pendingMeta = pending;
    }

    /**
     * Cancel everything queued without writing. Used before a delete so the
     * pending keystrokes do not get flushed into a file that's about to move
     * to the trash.
     */
    dropPendingWrites()
    {
        this._cancelAllPending();
    }

    /**
     * Serialise `fn` against the broker's lock. Drains pending writes first
     * so `fn` operates on disk that matches the editor's last committed
     * payload. Concurrent calls queue and run in arrival order. Errors inside
     * `fn` still release the lock.
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    withLock(fn)
    {
        return new Promise((resolve, reject) =>
        {
            const task = async () =>
            {
                try
                {
                    await this.drainAllPending();
                    this.locked = true;
                    const result = await fn();
                    this.locked = false;
                    resolve(result);
                }
                catch (e)
                {
                    this.locked = false;
                    reject(e);
                }
                finally
                {
                    this.queue.shift();
                    if (this.queue.length > 0)
                    {
                        const next = this.queue[0];
                        // Yield to a microtask so the resolving promise's
                        // continuation runs before the next task starts.
                        Promise.resolve().then(next);
                    }
                }
            };
            this.queue.push(task);
            if (this.queue.length === 1)
            {
                Promise.resolve().then(task);
            }
        });
    }

    // ── internals ──────────────────────────────────────────────────────

    /** @returns {Promise<void>} */
    async drainAllPending()
    {
        const flushes = [];
        if (this.pendingScript)
        {
            clearTimeout(this.pendingScript.handle);
            const p = this.pendingScript;
            this.pendingScript = null;
            flushes.push(this._safeInvoke(p.saveFn, p.text));
        }
        if (this.pendingMeta)
        {
            clearTimeout(this.pendingMeta.handle);
            const p = this.pendingMeta;
            this.pendingMeta = null;
            flushes.push(this._safeInvoke(p.saveFn, p.meta));
        }
        if (this.pendingMangaart.size > 0)
        {
            for (const [, p] of this.pendingMangaart)
            {
                clearTimeout(p.handle);
                flushes.push(this._safeInvoke(p.saveFn, p.data));
            }
            this.pendingMangaart.clear();
        }
        await Promise.all(flushes);
    }

    _cancelAllPending()
    {
        if (this.pendingScript)
        {
            clearTimeout(this.pendingScript.handle);
            this.pendingScript = null;
        }
        if (this.pendingMeta)
        {
            clearTimeout(this.pendingMeta.handle);
            this.pendingMeta = null;
        }
        for (const [, p] of this.pendingMangaart)
        {
            clearTimeout(p.handle);
        }
        this.pendingMangaart.clear();
    }

    _flushScript()
    {
        if (!this.pendingScript) return;
        const p = this.pendingScript;
        this.pendingScript = null;
        // Fire and forget; callers handle their own error reporting because
        // we may be invoked from a setTimeout with nowhere to throw to.
        this._safeInvoke(p.saveFn, p.text);
    }

    /** @param {string} pageId */
    _flushMangaart(pageId)
    {
        const p = this.pendingMangaart.get(pageId);
        if (!p) return;
        this.pendingMangaart.delete(pageId);
        this._safeInvoke(p.saveFn, p.data);
    }

    _flushMeta()
    {
        if (!this.pendingMeta) return;
        const p = this.pendingMeta;
        this.pendingMeta = null;
        this._safeInvoke(p.saveFn, p.meta);
    }

    /**
     * @param {SaveFn} fn
     * @param {any} payload
     * @returns {Promise<void>}
     */
    async _safeInvoke(fn, payload)
    {
        try { await fn(payload); }
        catch (e) { console.error("[broker] save failed:", e); }
    }

    _peekState()
    {
        return {
            path: this.path,
            uuid: this.uuid,
            locked: this.locked,
            queueLength: this.queue.length,
        };
    }
}
