// @ts-check
/**
 * mps-context-menu.js — Singleton point-anchored context menu.
 *
 * Plain module (not a custom element). Mounts a single .ctx-menu node into
 * document.body on first use, then reuses it. Calling openContextMenu while
 * the menu is already open repositions + re-renders in place (no flash).
 *
 * Public API:
 *   openContextMenu({ x, y, items, onClose })
 *   closeContextMenu()
 *   isContextMenuOpen()
 *
 * Items shape:
 *   { id, label, icon?, danger?, disabled?, onSelect }
 *   { kind: "divider" }
 *
 * Keyboard:
 *   Esc                  → close
 *   ArrowDown / ArrowUp  → move focus, skip dividers + disabled, wrap
 *   Enter / Space        → activate focused item (native <button> handles this)
 *
 * Auto-close triggers (all in capture phase so inner stopPropagation can't bypass):
 *   - outside click
 *   - window blur
 *   - window resize
 *   - scroll on any element
 */

import { icon } from "../icons.js";

const MARGIN = 8;

/** @type {HTMLElement | null} */
let menuEl = null;
/** @type {Array<any>} */
let currentItems = [];
/** @type {(() => void) | null} */
let currentOnClose = null;
let isOpen = false;
let focusedIndex = -1;

/**
 * Compute the point-anchored placement. 4-quadrant flip: when the menu would
 * overflow the right or bottom edge, anchor by the opposite corner instead.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} menuW
 * @param {number} menuH
 * @param {number} vw
 * @param {number} vh
 * @param {number} margin
 * @returns {{px:number, py:number}}
 */
function placeAt(x, y, menuW, menuH, vw, vh, margin = MARGIN)
{
    const fitsRight = x + menuW + margin <= vw;
    const fitsBelow = y + menuH + margin <= vh;
    return {
        px: fitsRight ? x : Math.max(margin, x - menuW),
        py: fitsBelow ? y : Math.max(margin, y - menuH),
    };
}

/** Build (or return existing) singleton DOM node. */
function ensureMenuEl()
{
    if (menuEl) return menuEl;
    menuEl = document.createElement("div");
    menuEl.className = "ctx-menu";
    menuEl.setAttribute("role", "menu");
    menuEl.tabIndex = -1;
    return menuEl;
}

/**
 * Render the items list into the menu element. Buttons are <button type="button">
 * so they're focusable, support native Enter/Space activation, and honour
 * the `disabled` attribute.
 */
function renderItems()
{
    if (!menuEl) return;
    menuEl.innerHTML = "";
    currentItems.forEach((it, idx) =>
    {
        if (it && it.kind === "divider")
        {
            const div = document.createElement("div");
            div.className = "ctx-menu-divider";
            div.setAttribute("role", "separator");
            menuEl.appendChild(div);
            return;
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ctx-menu-item";
        if (it.danger) btn.classList.add("is-danger");
        if (it.disabled)
        {
            btn.disabled = true;
            btn.setAttribute("aria-disabled", "true");
        }
        btn.setAttribute("role", "menuitem");
        btn.dataset.index = String(idx);

        const iconHtml = it.icon
            ? `<span class="ctx-menu-icon">${icon(it.icon, { size: 14 })}</span>`
            : `<span class="ctx-menu-icon"></span>`;
        btn.innerHTML = `${iconHtml}<span class="ctx-menu-label">${escapeHtml(it.label || "")}</span>`;

        btn.addEventListener("click", (e) =>
        {
            e.preventDefault();
            e.stopPropagation();
            if (it.disabled) return;
            try { it.onSelect?.(); }
            finally { closeContextMenu(); }
        });
        menuEl.appendChild(btn);
    });
}

/** @param {string} s */
function escapeHtml(s)
{
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** First / next activatable item index walking with `step` (+1 / -1), wraps. */
function nextActivatableIndex(from, step)
{
    const n = currentItems.length;
    if (n === 0) return -1;
    let i = from;
    for (let count = 0; count < n; count++)
    {
        i = (i + step + n) % n;
        const it = currentItems[i];
        if (it && it.kind !== "divider" && !it.disabled) return i;
    }
    return -1;
}

function syncFocus()
{
    if (!menuEl) return;
    const buttons = /** @type {HTMLButtonElement[]} */ (
        Array.from(menuEl.querySelectorAll(".ctx-menu-item"))
    );
    for (const b of buttons) b.classList.remove("is-focused");
    if (focusedIndex < 0) return;
    const target = menuEl.querySelector(`.ctx-menu-item[data-index="${focusedIndex}"]`);
    if (target instanceof HTMLElement)
    {
        target.classList.add("is-focused");
        target.focus();
    }
}

// ── Document-level listeners (installed only while open, all CAPTURE) ──

/** @param {MouseEvent} e */
function onDocClick(e)
{
    const target = /** @type {Element|null} */ (e.target);
    if (target && menuEl && target.closest && target.closest(".ctx-menu") === menuEl)
    {
        // Click inside our menu — let the item handler run.
        return;
    }
    closeContextMenu();
}

/** @param {KeyboardEvent} e */
function onDocKey(e)
{
    if (!isOpen) return;
    if (e.key === "Escape")
    {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
        return;
    }
    if (e.key === "ArrowDown")
    {
        e.preventDefault();
        focusedIndex = nextActivatableIndex(focusedIndex < 0 ? -1 : focusedIndex, +1);
        syncFocus();
        return;
    }
    if (e.key === "ArrowUp")
    {
        e.preventDefault();
        focusedIndex = nextActivatableIndex(focusedIndex < 0 ? currentItems.length : focusedIndex, -1);
        syncFocus();
    }
    // Enter / Space — native <button> activation fires the click handler.
}

// True between a mousedown inside the menu and the next mouseup/click.
// While true, window.blur events are ignored — Windows occasionally fires
// a transient blur during the activation of a menu item (e.g. the IME
// candidate window, the OS focus-stealing-prevention reshuffle, or a UI
// helper like PowerShell SendInput briefly grabbing foreground). Without
// this guard, the menu would close mid-activation, the corresponding click
// would land on the (now-removed) menu position, and the user's Copy /
// Rename / Delete action would silently no-op.
let mouseDownInsideMenu = false;

function onBlur()
{
    if (mouseDownInsideMenu) return;
    closeContextMenu();
}
function onResize() { closeContextMenu(); }

/** @param {MouseEvent} e */
function onDocMouseDown(e)
{
    const target = /** @type {Element|null} */ (e.target);
    if (target && menuEl && target.closest && target.closest(".ctx-menu") === menuEl)
    {
        mouseDownInsideMenu = true;
        return;       // click inside our menu — let the item handler run
    }
    closeContextMenu();
}

/** Clear the guard after the click sequence finishes. */
function onDocMouseUp()
{
    // Defer one frame so any window-blur that fires "right after mouseup"
    // (some OS / WebView2 combos do this) still sees the guard.
    if (!mouseDownInsideMenu) return;
    requestAnimationFrame(() => { mouseDownInsideMenu = false; });
}
/** @param {Event} e */
function onScroll(e)
{
    // Ignore scroll events originating inside the menu itself (in case the
    // item list ever overflows and gets a scrollbar).
    const t = /** @type {Element|null} */ (e.target);
    if (t && menuEl && t.nodeType === 1 && menuEl.contains(t)) return;
    closeContextMenu();
}

function installDocListeners()
{
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("mouseup", onDocMouseUp, true);
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onDocKey, true);
    window.addEventListener("blur", onBlur, true);
    window.addEventListener("resize", onResize, true);
    document.addEventListener("scroll", onScroll, true);
}

function removeDocListeners()
{
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("mouseup", onDocMouseUp, true);
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onDocKey, true);
    window.removeEventListener("blur", onBlur, true);
    window.removeEventListener("resize", onResize, true);
    document.removeEventListener("scroll", onScroll, true);
}

/**
 * Open the context menu at a point.
 * If already open, repositions + re-renders in place (no flash).
 *
 * @param {{ x:number, y:number, items:Array<any>, onClose?:() => void }} opts
 */
export function openContextMenu(opts)
{
    const { x, y, items, onClose } = opts;
    const wasOpen = isOpen;
    currentItems = Array.isArray(items) ? items.slice() : [];
    currentOnClose = onClose || null;
    focusedIndex = -1;

    const el = ensureMenuEl();
    if (!el.isConnected) document.body.appendChild(el);

    // Render first with measurement-friendly off-screen positioning.
    el.style.visibility = "hidden";
    el.style.left = "-9999px";
    el.style.top = "0px";
    renderItems();

    // Measure now that content is laid out.
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const { px, py } = placeAt(x, y, rect.width, rect.height, vw, vh, MARGIN);

    el.style.left = `${px}px`;
    el.style.top = `${py}px`;
    el.style.visibility = "";

    if (!wasOpen)
    {
        isOpen = true;
        installDocListeners();
    }
}

/** Close the menu (no-op if not open). */
export function closeContextMenu()
{
    if (!isOpen) return;
    isOpen = false;
    mouseDownInsideMenu = false;
    removeDocListeners();
    if (menuEl && menuEl.isConnected) menuEl.remove();
    const cb = currentOnClose;
    currentOnClose = null;
    currentItems = [];
    focusedIndex = -1;
    if (cb)
    {
        try { cb(); } catch { /* swallow */ }
    }
}

/** @returns {boolean} */
export function isContextMenuOpen()
{
    return isOpen;
}

/** Test-only: tear down singleton DOM + listeners. */
export function _resetContextMenuForTest()
{
    removeDocListeners();
    if (menuEl)
    {
        if (menuEl.isConnected) menuEl.remove();
        menuEl = null;
    }
    currentItems = [];
    currentOnClose = null;
    focusedIndex = -1;
    isOpen = false;
}

// Test helper for the placement math.
export const _placeAtForTest = placeAt;
