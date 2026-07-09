// @ts-check
/**
 * <mps-lang-select> — Custom-element language picker with flag icons.
 *
 * Renders a button (closed) + popover (open). Calls setLanguage() from
 * the desktop i18n adapter on selection, which fires:
 *   - subscribe() callbacks
 *   - document-level 'mps-lang-change' CustomEvent { detail: { code } }
 *
 * The button is keyboard-navigable: Enter/Space opens, ↑↓ move the focus
 * ring inside the popover, Enter selects, Esc closes. Outside-click closes.
 *
 * Two consumers today: the picker shell (large, 220px) and the Settings
 * General row (smaller, 180px). Size is driven by the host element's
 * `--mps-lang-select-width` CSS var so consumers can tune without forking.
 */

import { SUPPORTED_LANGUAGES_LIST, getFlagSvgUrl } from '../adapters/languages.js';
import { getLanguage, setLanguage, subscribe } from '../adapters/tauri-i18n.js';

class MpsLangSelect extends HTMLElement
{
    constructor()
    {
        super();
        this._open = false;
        this._activeIndex = 0;
        /** @type {HTMLElement|null} */
        this._popoverEl = null;
        this._onDocClick = this._onDocClick.bind(this);
        this._onKey = this._onKey.bind(this);
        this._onScrollClose = (e) =>
        {
            // Ignore scrolls that originate inside the popover itself —
            // users scrolling the language list must not close it.
            const t = /** @type {Node|null} */ (e && e.target);
            if (t && this._popoverEl && this._popoverEl.contains(t)) return;
            this._close();
        };
    }

    connectedCallback()
    {
        this._render();
        this._unsubLang = subscribe(() => this._render());
    }

    disconnectedCallback()
    {
        if (this._unsubLang) { this._unsubLang(); this._unsubLang = null; }
        if (this._popoverEl && this._popoverEl.parentNode)
        {
            this._popoverEl.parentNode.removeChild(this._popoverEl);
        }
        this._popoverEl = null;
        this._open = false;
        document.removeEventListener('click', this._onDocClick, true);
        document.removeEventListener('keydown', this._onKey, true);
        window.removeEventListener('scroll', this._onScrollClose, true);
        window.removeEventListener('resize', this._onScrollClose);
    }

    _render()
    {
        const cur = getLanguage();
        const curCfg = SUPPORTED_LANGUAGES_LIST.find((l) => l.code === cur)
            || SUPPORTED_LANGUAGES_LIST[0];

        this.innerHTML = `
            <button type="button" class="mls-button" aria-haspopup="listbox" aria-expanded="${this._open}">
                <img class="mls-flag" src="${getFlagSvgUrl(curCfg.code)}" alt="" width="18" height="12">
                <span class="mls-label">${curCfg.nativeName}</span>
                <span class="mls-chev" aria-hidden="true">▾</span>
            </button>
        `;

        const btn = this.querySelector('.mls-button');
        if (btn)
        {
            btn.addEventListener('click', (e) =>
            {
                e.stopPropagation();
                this._toggle();
            });
        }

        // If the popover is currently open, re-render it in place (locale
        // change fires _render() via subscribe; keep the portalled popover
        // in sync with the new current-locale checkmark).
        if (this._open && this._popoverEl)
        {
            this._popoverEl.innerHTML = this._renderPopoverRows(cur);
            this._wirePopoverItems();
            this._positionPopover();
            this._syncActive();
        }
    }

    _renderPopoverRows(cur)
    {
        return SUPPORTED_LANGUAGES_LIST.map((l, i) =>
        {
            const active = l.code === cur ? ' aria-selected="true"' : '';
            const check = l.code === cur ? '<span class="mls-check">✓</span>' : '';
            return `
                <div class="mls-item" role="option" data-code="${l.code}" data-index="${i}"${active}>
                    <img class="mls-flag" src="${getFlagSvgUrl(l.code)}" alt="" width="18" height="12">
                    <span class="mls-label">${l.nativeName}</span>
                    ${check}
                </div>`;
        }).join('');
    }

    _wirePopoverItems()
    {
        if (!this._popoverEl) return;
        const items = Array.from(this._popoverEl.querySelectorAll('.mls-item'));
        items.forEach((item, i) =>
        {
            item.addEventListener('click', (e) =>
            {
                e.stopPropagation();
                const code = item.getAttribute('data-code');
                if (code) this._select(code);
            });
            item.addEventListener('mouseenter', () =>
            {
                this._activeIndex = i;
                this._syncActive();
            });
        });
    }

    _syncActive()
    {
        if (!this._popoverEl) return;
        const items = this._popoverEl.querySelectorAll('.mls-item');
        items.forEach((el, i) =>
        {
            el.classList.toggle('is-focused', i === this._activeIndex);
        });
    }

    _toggle()
    {
        this._open ? this._close() : this._openMenu();
    }

    _openMenu()
    {
        this._open = true;
        const cur = getLanguage();
        const idx = SUPPORTED_LANGUAGES_LIST.findIndex((l) => l.code === cur);
        this._activeIndex = Math.max(0, idx);

        // Portal the popover to <body>. The picker shell's .pkr-shell-page
        // ancestor uses `transform: translateX(...)` for slide animation,
        // which makes it the containing block for `position: fixed`
        // descendants — so a popover rendered inside <mps-lang-select> can
        // never escape the picker's overflow clipping. Appending to <body>
        // moves the popover out of that transformed subtree entirely.
        const pop = document.createElement('div');
        pop.className = 'mls-popover mps-scrollbar';
        // Context modifier so scoped colour rules still hit the portalled
        // popover after it detaches from mps-picker-shell / .settings-dialog.
        if (this.closest('mps-picker-shell')) pop.classList.add('mls-popover--picker');
        else if (this.closest('.settings-dialog')) pop.classList.add('mls-popover--settings');
        pop.setAttribute('role', 'listbox');
        pop.innerHTML = this._renderPopoverRows(cur);
        document.body.appendChild(pop);
        this._popoverEl = pop;

        this._wirePopoverItems();
        this._syncActive();
        this._positionPopover();

        this.setAttribute('aria-expanded', 'true');
        const btn = this.querySelector('.mls-button');
        if (btn) btn.setAttribute('aria-expanded', 'true');

        requestAnimationFrame(() =>
        {
            // Scroll the active row into view within the popover itself
            // (never scrollIntoView — that scrolls ancestors and trips the
            // capture-phase scroll close listener).
            const items = pop.querySelectorAll('.mls-item');
            const active = /** @type {HTMLElement|null} */ (items[this._activeIndex]);
            if (active)
            {
                const popRect = pop.getBoundingClientRect();
                const activeRect = active.getBoundingClientRect();
                if (activeRect.top < popRect.top || activeRect.bottom > popRect.bottom)
                {
                    pop.scrollTop = active.offsetTop - (pop.clientHeight / 2) + (active.clientHeight / 2);
                }
            }

            document.addEventListener('click', this._onDocClick, true);
            document.addEventListener('keydown', this._onKey, true);
            window.addEventListener('scroll', this._onScrollClose, true);
            window.addEventListener('resize', this._onScrollClose);
        });
    }

    /**
     * Anchor the portalled popover to the button's viewport rect using
     * `position: fixed`. Popover lives on <body> — no transformed
     * ancestor — so fixed is truly viewport-relative here.
     */
    _positionPopover()
    {
        const pop = this._popoverEl;
        const btn = /** @type {HTMLElement|null} */ (this.querySelector('.mls-button'));
        if (!pop || !btn) return;

        const rect = btn.getBoundingClientRect();
        const spaceAbove = rect.top;
        const spaceBelow = window.innerHeight - rect.bottom;
        const POPOVER_HEIGHT = 320;
        const openBelow = spaceAbove < POPOVER_HEIGHT && spaceBelow > spaceAbove;

        const width = rect.width;
        // Clamp to viewport so a fixed popover positioned near the right
        // edge never introduces horizontal overflow.
        const maxLeft = Math.max(0, window.innerWidth - width - 4);
        const left = Math.min(rect.left, maxLeft);

        pop.style.position = 'fixed';
        pop.style.left = `${left}px`;
        pop.style.width = `${width}px`;
        if (openBelow)
        {
            pop.style.top = `${rect.bottom + 4}px`;
            pop.style.bottom = 'auto';
        }
        else
        {
            pop.style.top = 'auto';
            pop.style.bottom = `${window.innerHeight - rect.top + 4}px`;
        }
    }

    _close()
    {
        if (!this._open) return;
        this._open = false;
        if (this._popoverEl && this._popoverEl.parentNode)
        {
            this._popoverEl.parentNode.removeChild(this._popoverEl);
        }
        this._popoverEl = null;
        const btn = this.querySelector('.mls-button');
        if (btn) btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', this._onDocClick, true);
        document.removeEventListener('keydown', this._onKey, true);
        window.removeEventListener('scroll', this._onScrollClose, true);
        window.removeEventListener('resize', this._onScrollClose);
    }

    _select(code)
    {
        // setLanguage is async (loads the locale chunk first). Fire-and-forget
        // from this sync event handler — subscribers + mps-lang-change fire
        // once the chunk lands. _close() still runs immediately so the popover
        // dismisses on click.
        void setLanguage(code);
        this._close();
    }

    _onDocClick(e)
    {
        const t = /** @type {Node} */ (e.target);
        if (this.contains(t)) return;
        if (this._popoverEl && this._popoverEl.contains(t)) return;
        this._close();
    }

    _onKey(e)
    {
        if (!this._open) return;
        const max = SUPPORTED_LANGUAGES_LIST.length - 1;
        if (e.key === 'Escape')
        {
            e.preventDefault();
            this._close();
        }
        else if (e.key === 'ArrowDown')
        {
            e.preventDefault();
            this._activeIndex = Math.min(max, this._activeIndex + 1);
            this._syncActive();
        }
        else if (e.key === 'ArrowUp')
        {
            e.preventDefault();
            this._activeIndex = Math.max(0, this._activeIndex - 1);
            this._syncActive();
        }
        else if (e.key === 'Enter' || e.key === ' ')
        {
            e.preventDefault();
            const cfg = SUPPORTED_LANGUAGES_LIST[this._activeIndex];
            if (cfg) this._select(cfg.code);
        }
    }
}

if (!customElements.get('mps-lang-select'))
{
    customElements.define('mps-lang-select', MpsLangSelect);
}
