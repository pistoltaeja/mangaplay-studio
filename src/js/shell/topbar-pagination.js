import { state } from "./state.js";
import { t } from "../adapters/tauri-i18n.js";
import { scriptRelPathOf } from "../util/paths.js";
import { setLastPageIndex } from "../project/project.js";

// Storyboard pagination state. Drives only the Storyboard canvas page
// (mps-canvas). The Visual Editor scrolls independently and does NOT follow
// these chevrons. Shared between the global #topbar-storyboard-pagination
// cluster and the editor-area top bar's chevron buttons so both surfaces stay
// in sync without a second event subscription chain.
let _paginationPageIndex = 0;
let _paginationTotalPages = 1;
/** Optional label override sourced from the parsed `# Page X` id. */
let _paginationPageLabel = null;
/** @type {Array<(state: { pageIndex: number, totalPages: number }) => void>} */
const _paginationSubscribers = [];
/** @type {(() => void) | null} Stashed by wireTopbarPagination so slider sites can re-invoke. */
let _renderTopbarPagination = null;

/**
 * Dispatch `page-change` + `screenplay-scroll-to-page` events. mps-canvas
 * listens for the former and advances `store.currentPageIndex`; the
 * screenplay component scrolls on the latter.
 * @param {number} dir
 */
export function paginationNavigate(dir)
{
    const newIndex = _paginationPageIndex + dir;
    if (newIndex < 0 || newIndex >= _paginationTotalPages) return;
    document.dispatchEvent(new CustomEvent("page-change", {
        detail: { pageIndex: newIndex, direction: dir }
    }));
    document.dispatchEvent(new CustomEvent("screenplay-scroll-to-page", {
        detail: { pageIndex: newIndex }
    }));
}

/**
 * Register a callback fired with `{ pageIndex, totalPages }` whenever
 * pagination state changes. The callback is invoked immediately with the
 * current state so subscribers can hydrate their UI without waiting for
 * the next change.
 * @param {(state: { pageIndex: number, totalPages: number }) => void} cb
 */
export function subscribePaginationState(cb)
{
    if (typeof cb !== "function") return;
    _paginationSubscribers.push(cb);
    try { cb({ pageIndex: _paginationPageIndex, totalPages: _paginationTotalPages }); }
    catch (e) { console.debug("[pagination] subscriber seed failed:", e); }
}

export function getPaginationState()
{
    return { pageIndex: _paginationPageIndex, totalPages: _paginationTotalPages };
}

function _notifyPaginationSubscribers()
{
    const snap = { pageIndex: _paginationPageIndex, totalPages: _paginationTotalPages };
    for (const cb of _paginationSubscribers)
    {
        try { cb(snap); }
        catch (e) { console.debug("[pagination] subscriber failed:", e); }
    }
}

/**
 * Resolve the active slot's file format ("mangaplay", "fountain", ...) for
 * pagination chevron gating. Storyboard pagination is only meaningful for
 * `.mangaplay` sources — other formats keep the chevrons visible but disabled.
 * Prefer `slotManager.getActive().format`; fall back to the `data-format`
 * attribute stamped on the editor-area top bar by `syncFormatToTopBar` so the
 * helper is robust during early-boot ordering.
 * @returns {string | null}
 */
export function getActivePaginationFormat()
{
    const fromSlot = state.slotManager?.getActive()?.format;
    if (fromSlot) return fromSlot;
    const bar = document.querySelector(".editor-area-top-bar");
    return bar?.getAttribute("data-format") ?? null;
}

/**
 * Wire the top-bar pagination cluster (#topbar-storyboard-pagination). Mirrors the
 * paint widget's pw-pagination-group: click dispatches `page-change`,
 * `page-state-update` updates the label + disabled state. Hidden until
 * the first state-update arrives so the row stays clean before the canvas
 * has fired.
 */
export function wireTopbarPagination()
{
    const wrap = document.getElementById("topbar-storyboard-pagination");
    const prev = document.getElementById("btn-page-prev");
    const next = document.getElementById("btn-page-next");
    const label = document.getElementById("topbar-page-label");
    if (!wrap || !prev || !next || !label) return;

    prev.addEventListener("click", () => paginationNavigate(-1));
    next.addEventListener("click", () => paginationNavigate(1));

    const render = () =>
    {
        const numeric = _paginationPageLabel != null ? _paginationPageLabel : String(_paginationPageIndex + 1);
        try
        {
            label.textContent = `${t("ui.paint.page") || "Page"} ${numeric}`;
        }
        catch
        {
            label.textContent = `Page ${numeric}`;
        }
        const slider = document.querySelector(".right-pane-slider");
        const screenplayActive = slider?.getAttribute("data-active") === "screenplay";
        const format = getActivePaginationFormat();
        const formatPaginates = format === "mangaplay";
        if (screenplayActive || !formatPaginates)
        {
            /** @type {HTMLButtonElement} */ (prev).disabled = true;
            /** @type {HTMLButtonElement} */ (next).disabled = true;
            label.setAttribute("data-disabled", "");
        }
        else
        {
            /** @type {HTMLButtonElement} */ (prev).disabled = _paginationPageIndex <= 0;
            /** @type {HTMLButtonElement} */ (next).disabled = _paginationPageIndex >= _paginationTotalPages - 1;
            label.removeAttribute("data-disabled");
        }
        _notifyPaginationSubscribers();
    };
    _renderTopbarPagination = render;
    state.renderTopbarPagination = render;

    document.addEventListener("page-state-update", (e) =>
    {
        const d = /** @type {CustomEvent} */ (e).detail;
        if (!d) return;
        if (Number.isFinite(d.pageIndex)) _paginationPageIndex = d.pageIndex;
        if (Number.isFinite(d.totalPages)) _paginationTotalPages = d.totalPages;
        _paginationPageLabel = d.pageLabel != null ? String(d.pageLabel) : null;
        if (wrap.hasAttribute("hidden")) wrap.removeAttribute("hidden");
        render();
    });

    // mps-canvas dispatches `page-state-update` once during its initial
    // render — that fires before project-mount completes wireTopbarPagination,
    // so the boot event is lost. Pull from the canvas store directly until
    // pages are loaded. Project mount can take several seconds on debug
    // builds, so poll on a slow interval until pages exist (no upper cap —
    // a long-running poll is cheap; we clear it once pages land).
    const tryPullFromCanvas = () =>
    {
        const canvas = /** @type {any} */ (document.querySelector("mps-canvas"));
        const state = canvas?.store?.state;
        if (!state) return false;
        const pages = state.script?.pages ?? [];
        const total = pages.length;
        if (total <= 0) return false;
        _paginationPageIndex = state.currentPageIndex ?? 0;
        _paginationTotalPages = total;
        const cur = pages[_paginationPageIndex];
        _paginationPageLabel = cur?.id != null ? String(cur.id) : null;
        if (wrap.hasAttribute("hidden")) wrap.removeAttribute("hidden");
        render();
        return true;
    };
    if (!tryPullFromCanvas())
    {
        const intervalId = setInterval(() =>
        {
            if (tryPullFromCanvas()) clearInterval(intervalId);
        }, 250);
    }

    render();
}

/**
 * Persist `currentPageIndex` per script basename into the project's
 * session.json. Debounced 500ms so a rapid 200-cycle page-switch (or a
 * cursor-driven page-sync) issues at most one disk write per quiet window.
 * Suppressed while a file-swap is in flight (data-canvas-state="swapping")
 * to avoid clobbering the incoming file's restored index with whatever
 * the outgoing file last reported.
 */
export function wirePageIndexSessionWriteThrough()
{
    /** @type {ReturnType<typeof setTimeout>|null} */
    let pending = null;
    /** @type {number|null} */
    let lastIndex = null;

    const flush = () =>
    {
        pending = null;
        if (lastIndex == null || !state.currentProject?.path || !state.currentProject?.scriptPath) return;
        const canvas = /** @type {any} */ (document.querySelector("mps-canvas"));
        if (canvas?.getAttribute("data-canvas-state") === "swapping") return;
        const idx = lastIndex;
        const proj = state.currentProject.path;
        const rel = scriptRelPathOf(proj, state.currentProject.scriptPath)
            || state.currentProject.scriptBasename;
        if (!rel) return;
        setLastPageIndex(proj, rel, idx).catch((e) =>
        {
            console.warn("[session] write-through failed:", e);
        });
    };

    document.addEventListener("page-state-update", (e) =>
    {
        const d = /** @type {any} */ (e).detail || {};
        if (!Number.isFinite(d.pageIndex)) return;
        lastIndex = Number(d.pageIndex);
        // Back-write the index onto the active slot so a later tab activate
        // restores the user to the page they were last viewing.
        const activeSlot = state.slotManager?.getActive();
        if (activeSlot) activeSlot.pageIndex = lastIndex;
        if (pending) clearTimeout(pending);
        pending = setTimeout(flush, 500);
    });
}
