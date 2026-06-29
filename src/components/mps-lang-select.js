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
        this._onDocClick = this._onDocClick.bind(this);
        this._onKey = this._onKey.bind(this);
    }

    connectedCallback()
    {
        this._render();
        this._unsubLang = subscribe(() => this._render());
    }

    disconnectedCallback()
    {
        if (this._unsubLang) { this._unsubLang(); this._unsubLang = null; }
        document.removeEventListener('click', this._onDocClick, true);
        document.removeEventListener('keydown', this._onKey, true);
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
            ${this._open ? this._renderPopover(cur) : ''}
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

        if (this._open)
        {
            const items = Array.from(this.querySelectorAll('.mls-item'));
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
            this._syncActive();
        }
    }

    _renderPopover(cur)
    {
        const rows = SUPPORTED_LANGUAGES_LIST.map((l, i) =>
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
        return `<div class="mls-popover mps-scrollbar" role="listbox">${rows}</div>`;
    }

    _syncActive()
    {
        const items = this.querySelectorAll('.mls-item');
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

        // Decide whether to anchor the popover above (default) or below the
        // button. If there's not enough room above to fit the full 14-row
        // list (~320px max-height), flip below so the first row (English)
        // doesn't get clipped at the top.
        const rect = this.getBoundingClientRect();
        const spaceAbove = rect.top;
        const spaceBelow = window.innerHeight - rect.bottom;
        const POPOVER_HEIGHT = 320;
        if (spaceAbove < POPOVER_HEIGHT && spaceBelow > spaceAbove)
        {
            this.setAttribute('data-popover-side', 'below');
        }
        else
        {
            this.removeAttribute('data-popover-side');
        }

        this._render();

        // Scroll the active row into view inside the popover. Solves the
        // case where English (top of list) is above the visible window when
        // the popover opens scrolled to a middle item.
        requestAnimationFrame(() =>
        {
            const items = this.querySelectorAll('.mls-item');
            const active = items[this._activeIndex];
            if (active && typeof active.scrollIntoView === 'function')
            {
                active.scrollIntoView({ block: 'nearest' });
            }
            else
            {
                // Always scroll to the top so English is visible by default.
                const pop = this.querySelector('.mls-popover');
                if (pop) pop.scrollTop = 0;
            }
        });

        document.addEventListener('click', this._onDocClick, true);
        document.addEventListener('keydown', this._onKey, true);
    }

    _close()
    {
        if (!this._open) return;
        this._open = false;
        this._render();
        document.removeEventListener('click', this._onDocClick, true);
        document.removeEventListener('keydown', this._onKey, true);
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
        if (!this.contains(/** @type {Node} */ (e.target))) this._close();
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
