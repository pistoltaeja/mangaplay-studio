// @ts-check
/**
 * focused-view-registry.js — central registry for CM6 EditorView focus
 * tracking.
 *
 * Supports N concurrent views (needed for aggregate view — Phase 2). Every
 * focused-view change mirror-writes `window.__mpsActiveEditorView` so
 * pre-existing external consumers (editor-clipboard, context menu router,
 * import-workers, smoke tests) keep working without changes.
 *
 * IMPORTANT: callers MUST invoke `unregisterView(view)` BEFORE
 * `view.destroy()`. Once destroyed, the view's DOM is detached and we can
 * no longer reliably clean up the focusin listener, and `getFocusedView()`
 * cannot detect the dead reference.
 */

/**
 * @typedef {import("@codemirror/view").EditorView} EditorView
 */

/**
 * @typedef {object} ViewMeta
 * @property {string} [tabId]
 * @property {string} [aggregateId]
 * @property {string|null} [fileUuid]
 */

/**
 * @typedef {object} ViewEntry
 * @property {ViewMeta} meta
 * @property {(ev: FocusEvent) => void} focusHandler
 */

/** @type {Map<EditorView, ViewEntry>} */
const views = new Map();

/** @type {EditorView | null} */
let focused = null;

/** @type {Set<(view: EditorView | null) => void>} */
const subscribers = new Set();

/**
 * Most-recently-focused view first. Used as fallback when the currently-
 * focused view is unregistered — we promote the MRU head.
 * @type {EditorView[]}
 */
const mru = [];

/**
 * Mirror the current focused view onto the legacy global. Wrapped in
 * try/catch so a locked-down browser env (frozen window, hostile Proxy)
 * cannot take down the registry.
 * @param {EditorView | null} view
 */
function mirrorWrite(view)
{
    try
    {
        /** @type {any} */ (window).__mpsActiveEditorView = view;
    }
    catch (_)
    {
        /* ignore — mirror is best-effort */
    }
}

/**
 * Internal focus transition. Idempotent: no-op if `view === focused`.
 * Bumps MRU, mirror-writes, notifies subscribers.
 * @param {EditorView | null} view
 */
function _setFocused(view)
{
    if (view === focused) return;
    focused = view;

    if (view)
    {
        // Bump MRU: remove existing entry (if any) then unshift to head.
        const idx = mru.indexOf(view);
        if (idx !== -1) mru.splice(idx, 1);
        mru.unshift(view);
    }

    mirrorWrite(view);

    for (const fn of subscribers)
    {
        try { fn(view); }
        catch (err) { console.warn("[focused-view-registry] subscriber threw", err); }
    }
}

/**
 * Register a CM6 EditorView. Idempotent — a second call with the same view
 * is a no-op. If this is the first view registered, it becomes focused.
 * @param {EditorView} view
 * @param {ViewMeta} [meta]
 */
export function registerView(view, meta = {})
{
    if (views.has(view)) return;

    /** @type {(ev: FocusEvent) => void} */
    const focusHandler = () => { _setFocused(view); };

    try { view.dom.addEventListener("focusin", focusHandler); }
    catch (_) { /* view.dom missing — defensive */ }

    views.set(view, { meta, focusHandler });
    mru.push(view);

    if (focused === null)
    {
        _setFocused(view);
    }
}

/**
 * Unregister a view. Removes the focusin listener, drops it from MRU. If
 * the view was focused, promotes the MRU head (or clears focus if empty).
 * Idempotent — unknown views are a no-op.
 * @param {EditorView} view
 */
export function unregisterView(view)
{
    const entry = views.get(view);
    if (!entry) return;

    try { view.dom.removeEventListener("focusin", entry.focusHandler); }
    catch (_) { /* view.dom may already be detached */ }

    views.delete(view);

    const mruIdx = mru.indexOf(view);
    if (mruIdx !== -1) mru.splice(mruIdx, 1);

    if (focused === view)
    {
        // Head of MRU is now the previous-focused view (since we removed
        // `view` above). Promote it, or clear focus if nothing remains.
        const next = mru.length > 0 ? mru[0] : null;
        // Force transition even if `next === focused` because focused
        // still points at the dead view — clear then set.
        focused = null;
        _setFocused(next);
    }
}

/**
 * @returns {EditorView | null}
 */
export function getFocusedView()
{
    return focused;
}

/**
 * Explicitly set the focused view (e.g. from editor-slot-manager on tab
 * activation). Warns and no-ops if the view isn't registered.
 * @param {EditorView} view
 */
export function setFocused(view)
{
    if (!views.has(view))
    {
        console.warn("[focused-view-registry] setFocused called with unregistered view");
        return;
    }
    _setFocused(view);
}

/**
 * Subscribe to focused-view changes. Returns an unsubscribe function.
 * @param {(view: EditorView | null) => void} fn
 * @returns {() => void}
 */
export function subscribe(fn)
{
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
}

/**
 * Snapshot of all registered views. Returns a fresh Set — mutating the
 * result does NOT affect registry state.
 * @returns {Set<EditorView>}
 */
export function getAllRegisteredViews()
{
    return new Set(views.keys());
}
