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

class Broker
{
    constructor()
    {
        /** @type {string | null} */
        this.path = null;
        /** @type {{ handle: any, text: string, saveFn: SaveFn } | null} */
        this.pendingScript = null;
        /** @type {Map<string, { handle: any, data: any, saveFn: SaveFn }>} */
        this.pendingMangaart = new Map();
        /** @type {{ handle: any, meta: any, saveFn: SaveFn } | null} */
        this.pendingMeta = null;
        /** @type {Array<() => void>} */
        this.queue = [];
        this.locked = false;
    }

    /**
     * Set the active script path. Clears any pending writes belonging to the
     * previous path — those writes were targeting a different file and must
     * not land here.
     * @param {string | null} path
     */
    setActive(path)
    {
        if (this.path === path) return;
        this._cancelAllPending();
        this.path = path;
    }

    /** @returns {string | null} */
    getActivePath()
    {
        return this.path;
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
     * Adopt a new path or clear ownership entirely.
     *   - `null`     → no file is active (e.g. external delete)
     *   - string     → adopt this path as the new active (e.g. external rename)
     *   - undefined  → keep the current path (legacy callers)
     * Pending writes are dropped on any change because they target the old path.
     * @param {string | null} [newPath]
     */
    unlock(newPath)
    {
        if (newPath === undefined) return;
        this._cancelAllPending();
        this.path = newPath;
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
            locked: this.locked,
            queueLength: this.queue.length,
        };
    }
}
