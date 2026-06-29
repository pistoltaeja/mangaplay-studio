/**
 * Mangaplay Visual Editor Component
 *
 * Renders the title block (Page 0), page-level direction, and editable
 * widget surface (Dialogue + SFX, character combobox, parenthetical chips,
 * SFX placeholder rotation) on top of the parser AST.
 *
 * Sync contract: copies the `_suppressStoreSync` flag pattern from
 * mps-editor.js so the visual editor's own store writes don't loop back
 * through its `state.script` subscriber.
 */

import { getRuntimeStorage, parseScript } from '@mangaplay-studio/core';
import { formatScript } from '../services/format-script.js';
import { t, subscribe as subscribeToLanguage } from '../adapters/tauri-i18n.js';
import { getSpellcheckState } from '../spellcheck-state.js';
import { PersistentStorage, STORAGE_KEYS } from '../adapters/tauri-storage.js';
import { sequentialPages, sequentialPanels, unknownPanelTags, characterCueCase } from '../editor-checks.js';
import { CODE_META } from '../editor-linter.js';
import { resolveDiagnosticMessage } from '../../../core/validation/diagnostic-i18n.js';

/**
 * Read an SFX placeholder by index from the localised string table.
 * Falls back to the hardcoded ladder so a missing translation can never
 * blank out the placeholder.
 * @param {number} idx
 */
function sfxPlaceholderAt(idx)
{
    const fallback = ['BOOM', 'KRAK!', 'SLAM', 'WHOOSH'][idx % 4];
    return t(`ui.visualEditor.sfxPlaceholder.${idx % 4}`, fallback);
}

const SFX_PLACEHOLDERS_LEN = 4;
const BUILTIN_PARENTHETICALS = ['thought', 'whisper', 'caption'];
const EDIT_DEBOUNCE_MS = 300;

/**
 * Closed title-block key list.  Order = on-screen order.
 *
 * Round-trip note (verified): the parser only extracts six of these keys
 * into `ScriptMetadata` — `Title`, `Author`, `Genre`, `Format`, `Pages`
 * (→ `totalPages`), `Status`.  The other eight are accepted by
 * `KNOWN_METADATA_KEYS` (i.e. won't warn on parse) but their values are
 * NOT stored on the AST.  The formatter only emits the same six.  Editing
 * one of the eight non-extracted keys is held in the AST during the
 * session (so the UI reflects the typed value), but the value is
 * dropped on the next parse round-trip.  Documented as a known v1 gap
 * in TODO/mps-visual-panel-editor.md → Round-trip risks #1.
 *
 * @type {Array<{ key: string, prop: string, kind: 'text' | 'number' | 'format' }>}
 */
const TITLE_BLOCK_KEYS = [
    { key: 'Title',      prop: 'title',      kind: 'text'   },
    { key: 'Author',     prop: 'author',     kind: 'text'   },
    { key: 'Authors',    prop: 'authors',    kind: 'text'   },
    { key: 'Genre',      prop: 'genre',      kind: 'text'   },
    { key: 'Format',     prop: 'format',     kind: 'format' },
    { key: 'Pages',      prop: 'totalPages', kind: 'number' },
    { key: 'Status',     prop: 'status',     kind: 'text'   },
    { key: 'Credit',     prop: 'credit',     kind: 'text'   },
    { key: 'Source',     prop: 'source',     kind: 'text'   },
    { key: 'Draft date', prop: 'draftDate',  kind: 'text'   },
    { key: 'Contact',    prop: 'contact',    kind: 'text'   },
    { key: 'Copyright',  prop: 'copyright',  kind: 'text'   },
    { key: 'Notes',      prop: 'notes',      kind: 'text'   },
    { key: 'Revision',   prop: 'revision',   kind: 'text'   }
];

/**
 * Look up the title-block descriptor for a key name.
 * @param {string} key
 */
function titleBlockDesc(key)
{
    return TITLE_BLOCK_KEYS.find((k) => k.key === key) ?? null;
}

/**
 * Read the on-screen display value for a title-block key out of
 * `metadata`.  Number / format fields stringify; text fields trim to ''.
 * Returns '' when the key is unset or empty.
 * @param {Object} metadata
 * @param {{ key: string, prop: string, kind: string }} desc
 */
function titleBlockValue(metadata, desc)
{
    if (!metadata) return '';
    const v = metadata[desc.prop];
    if (v === undefined || v === null) return '';
    if (desc.kind === 'number')
    {
        // `_totalPagesImplicit` (Pages auto-derived from page count): hide
        // the row so a fresh script doesn't render a phantom `Pages` line
        // the user never typed.
        if (desc.prop === 'totalPages' && metadata._totalPagesImplicit) return '';
        return (typeof v === 'number' && v > 0) ? String(v) : '';
    }
    const s = String(v).trim();
    // `metadata.title` defaults to 'Untitled' from the parser.  Treat
    // that placeholder as 'empty' for visibility purposes so the user
    // sees an empty Title field on a fresh script — not the literal
    // word 'Untitled'.
    if (desc.prop === 'title' && s === 'Untitled') return '';
    return s;
}

/**
 * Normalise whatever `state.script` happens to be into a ScriptAST.
 *
 * The store holds the parsed AST in practice (mps-editor.js writes
 * `store.update({ script: parseScript(text) })` on every edit, and
 * app.js#loadScript does the same on sample/file load).  However the
 * subscriber contract isn't typed and existing callers occasionally
 * pass raw text on first boot, so we accept both shapes.
 *
 * @param {unknown} value
 * @returns {import('@mangaplay-studio/core').ScriptAST | null}
 */
function coerceScript(value)
{
    if (!value) return null;
    if (typeof value === 'string')
    {
        try
        {
            return parseScript(value);
        }
        catch (_err)
        {
            return null;
        }
    }
    if (typeof value === 'object' && Array.isArray(/** @type {any} */ (value).pages))
    {
        return /** @type {import('@mangaplay-studio/core').ScriptAST} */ (value);
    }
    return null;
}

/**
 * Build the character roster from the entire AST: union of every
 * `dialogue.character` across all panels + title-page Characters field
 * if present.  Uppercase-normalised, deduped, alphabetised.
 *
 * @param {import('@mangaplay-studio/core').ScriptAST | null} ast
 * @returns {string[]}
 */
function buildRoster(ast)
{
    if (!ast) return [];
    const set = new Set();
    const pages = ast.pages ?? [];
    for (const page of pages)
    {
        const panels = page.panels ?? [];
        for (const panel of panels)
        {
            const dialogues = panel.dialogue ?? [];
            for (const d of dialogues)
            {
                if (d && typeof d.character === 'string' && d.character.trim())
                {
                    set.add(d.character.trim().toUpperCase());
                }
            }
        }
    }
    const tp = ast.titlePage;
    if (tp && typeof tp === 'object')
    {
        const cast = /** @type {any} */ (tp).Characters
            ?? /** @type {any} */ (tp).characters;
        if (typeof cast === 'string')
        {
            for (const name of cast.split(','))
            {
                const n = name.trim().toUpperCase();
                if (n) set.add(n);
            }
        }
    }
    return Array.from(set).sort();
}

/**
 * Top-3 most-recent characters used on a given page, in encounter order
 * (latest first).  Used by the character combobox to float recent
 * speakers above the alphabetical roster.
 *
 * @param {import('@mangaplay-studio/core').Page | undefined} page
 * @returns {string[]}
 */
function recentCharactersForPage(page)
{
    if (!page) return [];
    const seen = [];
    const panels = page.panels ?? [];
    for (let i = panels.length - 1; i >= 0; i--)
    {
        const dialogues = panels[i].dialogue ?? [];
        for (let j = dialogues.length - 1; j >= 0; j--)
        {
            const c = dialogues[j]?.character;
            if (c && typeof c === 'string')
            {
                const u = c.trim().toUpperCase();
                if (u && !seen.includes(u)) seen.push(u);
                if (seen.length >= 3) return seen;
            }
        }
    }
    return seen;
}

/**
 * Scan upward inside a panel for the most recent non-empty character.
 * Caller falls back to prior panels on the page if this returns ''.
 * @param {import('@mangaplay-studio/core').Panel} panel
 * @returns {string}
 */
function lastSpeakerInPanel(panel)
{
    const dialogues = panel.dialogue ?? [];
    for (let i = dialogues.length - 1; i >= 0; i--)
    {
        const c = dialogues[i]?.character;
        if (c && typeof c === 'string' && c.trim()) return c.trim().toUpperCase();
    }
    return '';
}

/**
 * Return the indent convention the document already uses.
 * Scans the first stamped panel; defaults to Convention B when
 * no panel has stamps (new/blank document).
 * @param {import('@mangaplay-studio/core').ScriptAST | null} ast
 * @returns {{ panelIndent: number, dialogueIndent: number }}
 */
function getDocumentIndentStyle(ast) {
    if (!ast) return { panelIndent: 0, dialogueIndent: 4 };
    const pages = ast.pages ?? [];
    for (const page of pages) {
        for (const panel of (page.panels ?? [])) {
            if (panel._panelIndent !== undefined) {
                return {
                    panelIndent: panel._panelIndent,
                    dialogueIndent: panel._dialogueIndent ?? 4
                };
            }
        }
    }
    return { panelIndent: 0, dialogueIndent: 4 };
}

/**
 * Format a Location for display in the page-header textarea.
 * Round-trips with `parseSceneHeading`.
 * @param {{ type?: string, place?: string, time?: string } | undefined} loc
 * @returns {string}
 */
function formatSceneHeading(loc)
{
    if (!loc) return '';
    const type = loc.type ? `${loc.type}.` : '';
    const place = loc.place ?? '';
    const head = [type, place].filter(Boolean).join(' ');
    return loc.time ? `${head} - ${loc.time}` : head;
}

/**
 * Parse a free-text scene-heading string into a Location.
 * Tolerant: if no recognised type prefix, the whole string becomes `place`
 * and `type` is omitted (the formatter will skip emission).
 * @param {string} text
 * @returns {{ type?: 'INT' | 'EXT', place: string, time?: string } | undefined}
 */
function parseSceneHeading(text)
{
    const trimmed = (text ?? '').trim();
    if (!trimmed) return undefined;

    // Pull off the optional time after " - " (last occurrence wins).
    let body = trimmed;
    let time;
    const dashIdx = body.lastIndexOf(' - ');
    if (dashIdx >= 0)
    {
        time = body.slice(dashIdx + 3).trim() || undefined;
        body = body.slice(0, dashIdx).trim();
    }

    // Detect leading type. Accept INT., EXT., INT./EXT., EST. (only first
    // word matters — we normalise to the canonical INT | EXT enum).
    const typeMatch = body.match(/^(INT\.\/EXT\.|INT\.|EXT\.|EST\.)\s*(.*)$/i);
    if (typeMatch)
    {
        const rawType = typeMatch[1].toUpperCase();
        const place = typeMatch[2].trim();
        // LocationType is constrained to 'INT' | 'EXT' — collapse the
        // others to the closest match.
        const type = rawType.startsWith('EXT') ? 'EXT' : 'INT';
        return time ? { type, place, time } : { type, place };
    }

    return time ? { place: body, time } : { place: body };
}

class MPSVisualEditor extends HTMLElement
{
    constructor()
    {
        super();

        /** @type {ReturnType<typeof getRuntimeStorage>} */
        this.store = getRuntimeStorage();

        /** @type {import('@mangaplay-studio/core').ScriptAST | null} */
        this._ast = null;

        /**
         * Visual-Editor-internal page index. Seeded ONCE from the canvas
         * store at connectedCallback time (and re-seeded on script update)
         * and read by `_buildPanelCard` + friends to index `ast.pages[]`.
         *
         * IMPORTANT: this is NOT a live mirror of `store.currentPageIndex`.
         * Storyboard chevrons no longer drive the Visual Editor's scroll
         * position — the canvas page and the Visual Editor are independent
         * surfaces now. The upcoming continuous-scroll patch will replace
         * the page-bound call sites with per-card page tracking.
         * @type {number}
         */
        this._currentPageIndex = this.store.state.currentPageIndex ?? 0;

        /**
         * Re-entrancy guard.  When the visual editor writes back to the
         * store, it sets this true before `store.update` and clears it
         * in a microtask — the script subscriber early-returns instead
         * of re-parsing our own write.
         * @type {boolean}
         */
        this._suppressStoreSync = false;

        /**
         * One-shot guard: when the visual editor selects a panel (and
         * scroll-syncs the source view), the source editor's
         * selectedPanelId subscriber should NOT trigger a cursor move
         * or scroll back.
         * @type {boolean}
         */
        this._suppressNextSourceScroll = false;

        /** @type {(() => void) | null} */
        this._unsubscribeLanguage = null;

        /** @type {(() => void) | null} */
        this._unsubscribeScript = null;

        /** @type {number | null} */
        this._editDebounceTimer = null;

        /**
         * Pending mutation snapshot — held while the debounce timer is
         * scheduled.  We mutate the live AST eagerly so the UI doesn't
         * flicker, but only flush to the store after the debounce so
         * mid-typing keystrokes don't re-parse on every character.
         * @type {boolean}
         */
        this._dirtyPending = false;

        /**
         * Auto-focus target slot.  After re-render, focus this widget
         * sub-element if non-null, then clear.
         *  - `{ pageIndex, panelIndex, widgetType, widgetIndex, sub: 'character'|'text' }`
         * `pageIndex` scopes the lookup to a specific `.visual-editor-page`
         * section in continuous-scroll mode — without it the same
         * `data-panel-index` exists on every page section.
         * @type {null | { pageIndex?: number, panelIndex: number, widgetType: 'dialogue'|'sfx', widgetIndex: number, sub: string }}
         */
        this._postRenderFocus = null;

        /**
         * Continuous-scroll observer: watches every `.visual-editor-page`
         * section and emits `visual-editor-page-in-view` for the topmost
         * section crossing the 50% threshold.  Rebuilt every `_renderInner`.
         * @type {IntersectionObserver | null}
         */
        this._pageObserver = null;

        /** @type {number | null} */
        this._renderDebounceTimer = null;
        /** @type {number} */
        this._renderDebounceMs = 80;

        /**
         * SFX placeholder rotation counter for the current page.  Held
         * per-instance, NOT in the AST.  Resets on page change.
         * @type {number}
         */
        this._sfxRotationIndex = 0;

        /**
         * Track which dialogue widget is currently in custom-parenthetical
         * input mode.  `null` when no widget is in edit mode.
         * Key: `${panelIndex}:${widgetIndex}`.
         * @type {string | null}
         */
        this._customChipEditing = null;

        /** @type {(ev: MouseEvent) => void | null} */
        this._documentClickHandler = null;

        /**
         * One-shot placeholder for the next-rendered SFX widget.  Set by
         * `_onAddSfx` so the input's `placeholder` attribute reflects the
         * rotated suggestion (BOOM / KRAK! / SLAM / WHOOSH).
         * @type {null | { panelIndex: number, widgetIndex: number, text: string }}
         */
        this._pendingSfxPlaceholder = null;

        // -----------------------------------------------------------------
        // Drag-and-drop state.
        //
        // Pointer-event-based DnD with same-type-only validation.  The
        // engine tracks one active drag at a time; multi-touch aborts
        // and snap-backs.  Ghost element follows the cursor via
        // `transform`; live reorder uses FLIP for neighbour shift.
        // -----------------------------------------------------------------

        /** @type {number | null} */
        this._activeDragPointerId = null;
        /** @type {'mouse' | 'pen' | 'touch' | null} */
        this._activeDragPointerType = null;
        /** @type {HTMLElement | null} */
        this._dragSourceWidget = null;
        /** @type {HTMLElement | null} */
        this._dragGhost = null;
        /** @type {'dialogue' | 'sfx' | null} */
        this._dragWidgetType = null;
        /** @type {{ panelIndex: number, widgetIndex: number } | null} */
        this._dragOrigin = null;
        /** @type {DOMRect | null} */
        this._dragSourceRect = null;
        /** @type {number} */
        this._dragGhostOffsetX = 0;
        /** @type {number} */
        this._dragGhostOffsetY = 0;
        /** @type {number} */
        this._dragDownX = 0;
        /** @type {number} */
        this._dragDownY = 0;
        /** @type {boolean} */
        this._dragActivated = false;
        /** @type {boolean} Becomes true once the cursor has moved off the source zone at least once. */
        this._dragLeftSourceZone = false;
        /** @type {boolean} True while the cursor is over a non-droppable target during a panel drag. */
        this._dragOverInvalidTarget = false;
        /** @type {HTMLElement | null} The element currently showing the invalid-target visual state. */
        this._invalidTargetEl = null;
        /** @type {boolean} Set when a render was suppressed during a drag — flushed on cleanup. */
        this._pendingRenderAfterDrag = false;

        /** @type {boolean} True while a ghost element is mid-animation and owns its own cleanup. */
        this._ghostAnimating = false;
        /** @type {ReturnType<typeof setTimeout> | null} */
        this._longPressTimer = null;
        /** @type {HTMLElement | null} */
        this._currentDropZone = null;
        /** @type {boolean} */
        this._crossTypeTooltipShown = false;
        /** @type {HTMLElement | null} */
        this._crossTypeTooltipEl = null;
        /** @type {((ev: KeyboardEvent) => void) | null} */
        this._dragKeyHandler = null;
        /** @type {((ev: PointerEvent) => void) | null} */
        this._dragMoveHandler = null;
        /** @type {((ev: PointerEvent) => void) | null} */
        this._dragUpHandler = null;
        /** @type {((ev: PointerEvent) => void) | null} */
        this._dragCancelHandler = null;
        /** @type {((ev: PointerEvent) => void) | null} */
        this._multiTouchGuard = null;

        // -----------------------------------------------------------------
        // Keyboard-drag state.  Activated when the user focuses
        // a `.widget-grip-rail` and hits Space.  Each Arrow keystroke
        // mutates the AST and re-renders; Esc restores the pre-grab
        // snapshot; Enter / Tab commit cleanly.
        // -----------------------------------------------------------------
        /** @type {{ panelIndex: number, widgetType: 'dialogue'|'sfx', widgetIndex: number } | null} */
        this._kbDragOrigin = null;
        /** @type {string | null} */
        this._kbDragAstSnapshot = null;
    }

    /**
     * Push the spellcheck toggle onto every editable field inside the
     * visual editor. Called by mps-editor.js applySpellcheckToAllViews
     * when the settings toggle flips, and during each `_render()` so
     * newly-built blocks pick up the current state.
     * @param {boolean} enabled
     */
    applySpellcheckState(enabled)
    {
        const { language } = getSpellcheckState();
        const editables = this.querySelectorAll('input, textarea');
        for (const el of editables)
        {
            /** @type {any} */ (el).spellcheck = !!enabled;
            // `lang` hints which dictionary the WebView2 spellchecker
            // should use. Harmless on inputs even when spellcheck is off.
            if (enabled && language) el.setAttribute('lang', String(language));
            else el.removeAttribute('lang');
        }
    }

    connectedCallback()
    {
        // Re-render on language change so all tooltips, placeholders, and
        // aria-labels reflect the current locale.
        this._unsubscribeLanguage = subscribeToLanguage(() => this._render());

        // Seed initial render from current store state BEFORE subscribing
        // to selection so _updateActiveCard has DOM to query.
        this._handleScriptUpdate(this.store.state.script);

        this._unsubscribeScript = this.store.select(
            (state) => state.script,
            (script) =>
            {
                if (this._suppressStoreSync) return;
                this._handleScriptUpdate(script);
            }
        );

        // Subscribe to panel selection changes so the visual editor
        // can toggle .is-active on the matching card.
        this._unsubscribeSelection = this.store.select(
            (state) => state.selectedPanelId,
            (selectedPanelId) =>
            {
                this._updateActiveCard(selectedPanelId);
            }
        );

        this._documentClickHandler = (ev) => this._onDocumentClick(ev);
        document.addEventListener('click', this._documentClickHandler, true);

        // Delegate pointerdown on grip rails to a single handler.
        this.addEventListener('pointerdown', this._onPointerDown);

        // Delegated keydown for keyboard-drag on grip rails.
        this.addEventListener('keydown', this._onGripKeyDown);

        // Re-render when source line-height changes (font load, zoom).
        this.addEventListener('mps-line-height-change', () =>
        {
            this._render();
        });
    }

    disconnectedCallback()
    {
        if (this._unsubscribeLanguage)
        {
            this._unsubscribeLanguage();
            this._unsubscribeLanguage = null;
        }
        if (this._unsubscribeScript)
        {
            this._unsubscribeScript();
            this._unsubscribeScript = null;
        }
        if (this._unsubscribeSelection)
        {
            this._unsubscribeSelection();
            this._unsubscribeSelection = null;
        }
        if (this._editDebounceTimer)
        {
            clearTimeout(this._editDebounceTimer);
            this._editDebounceTimer = null;
        }
        if (this._renderDebounceTimer)
        {
            clearTimeout(this._renderDebounceTimer);
            this._renderDebounceTimer = null;
        }
        if (this._pageObserver)
        {
            this._pageObserver.disconnect();
            this._pageObserver = null;
        }
        if (this._documentClickHandler)
        {
            document.removeEventListener('click', this._documentClickHandler, true);
            this._documentClickHandler = null;
        }
        this.removeEventListener('pointerdown', this._onPointerDown);
        this.removeEventListener('keydown', this._onGripKeyDown);
        this._cancelDrag(true);
        this._kbDragOrigin = null;
        this._kbDragAstSnapshot = null;
    }

    /**
     * Dispatch `visual-editor-page-in-view` so the canvas / topbar chevrons
     * can mirror the page currently scrolled into view. Stub for the
     * upcoming continuous-scroll patch — IntersectionObserver wiring will
     * call this from `_render` once per page card. No callers yet.
     * @param {number} pageIndex
     */
    _emitPageInView(pageIndex)
    {
        this.dispatchEvent(new CustomEvent('visual-editor-page-in-view', {
            detail: { pageIndex },
            bubbles: true
        }));
    }

    /**
     * Normalise `state.script` into an AST and re-render.
     * @param {unknown} script
     */
    _handleScriptUpdate(script)
    {
        if (script === null || script === undefined || script === '')
        {
            this._ast = null;
            this._debouncedRender();
            return;
        }

        const ast = coerceScript(script);
        if (ast)
        {
            this._ast = ast;
        }
        else
        {
            console.warn('[mps-visual-editor] could not coerce script; keeping previous AST');
        }

        this._debouncedRender();
    }

    /**
     * Coalesce keystroke-driven re-renders. Continuous-scroll renders ALL
     * pages, so per-keystroke rebuilds would lag on long scripts.
     */
    _debouncedRender()
    {
        if (this._renderDebounceTimer) clearTimeout(this._renderDebounceTimer);
        this._renderDebounceTimer = setTimeout(() =>
        {
            this._renderDebounceTimer = null;
            this._render();
        }, this._renderDebounceMs);
    }

    /**
     * Flush a pending AST mutation to the store.  Goes through
     * `formatScript` so indent-style is preserved, then re-parses so
     * the store receives an AST (matching mps-editor's contract).
     */
    _flushAstToStore()
    {
        if (!this._ast) return;
        try
        {
            // Round-trip safety: strip widget entries that haven't been
            // filled in yet.
            //  - Empty SFX strings: format would emit a bare `SFX: ` line.
            //  - Dialogue with empty `.text`: format emits a cue line
            //    with no body, which the next parse rolls into the
            //    panel description (verified) — corrupting the panel.
            // Both placeholder-state widgets are held in the AST so the
            // UI renders them, then stripped at the format boundary.
            for (const page of (this._ast.pages ?? []))
            {
                for (const panel of (page.panels ?? []))
                {
                    if (Array.isArray(panel.sfx))
                    {
                        panel.sfx = panel.sfx.filter(
                            (s) => typeof s === 'string' && s.trim() !== ''
                        );
                    }
                    if (Array.isArray(panel.dialogue))
                    {
                        panel.dialogue = panel.dialogue.filter(
                            (d) => d && typeof d.text === 'string' && d.text.trim() !== ''
                        );
                    }
                }
            }
            const source = formatScript(this._ast);
            const newAst = parseScript(source);
            this._ast = newAst;
            this._suppressStoreSync = true;
            this.store.update({
                script: newAst,
                readingDirection: newAst.readingDirection
            });
            // Refresh the on-card line-range gutter without a full re-render
            // (re-rendering would destroy the focused textarea and steal the
            // user's caret position). The source editor has already rebuilt
            // panelRanges synchronously inside the store.update above.
            this._refreshLineGutters();
            queueMicrotask(() =>
            {
                this._suppressStoreSync = false;
            });
        }
        catch (err)
        {
            console.error('[mps-visual-editor] format/parse round-trip failed', err);
        }
    }

    /**
     * Schedule a debounced flush.  Used by text-input edits where we
     * don't want to re-parse on every keystroke.
     */
    _scheduleFlush()
    {
        this._dirtyPending = true;
        if (this._editDebounceTimer)
        {
            clearTimeout(this._editDebounceTimer);
        }
        this._editDebounceTimer = window.setTimeout(() =>
        {
            this._editDebounceTimer = null;
            this._dirtyPending = false;
            this._flushAstToStore();
        }, EDIT_DEBOUNCE_MS);
    }

    /**
     * Immediate flush + re-render.  Used by add/remove/chip-toggle ops
     * where the user expects to see the change reflected at once.
     */
    _flushAndRerender()
    {
        if (this._editDebounceTimer)
        {
            clearTimeout(this._editDebounceTimer);
            this._editDebounceTimer = null;
            this._dirtyPending = false;
        }
        this._flushAstToStore();
        this._render();
    }

    /**
     * Conditional flush variant: when the dialogue has typed text, do a
     * full flush + re-render (round-trips through format/parse so the
     * source stays in sync). When text is empty, just re-render so the
     * chip's visual state updates without going through the round-trip
     * — the format+parse cycle strips empty-text dialogues at the strip
     * filter in _flushAstToStore, which would silently delete the whole
     * widget the user is still filling in.
     *
     * The mutation has already happened on the in-memory AST; on the
     * next real keystroke (which will have non-empty text) the normal
     * debounced _scheduleFlush will persist both the typed text and the
     * pending chip state through to source.
     *
     * @param {{ text?: string }} dialogue
     */
    _flushOrRerender(dialogue)
    {
        const hasText = typeof dialogue?.text === 'string'
            && dialogue.text.trim() !== '';
        if (hasText)
        {
            this._flushAndRerender();
        }
        else
        {
            this._render();
        }
    }

    /**
     * Clear and rebuild the visual editor DOM.
     *
     * Render lock: while a drag is active, all re-renders are queued
     * and replayed on cleanup. Re-rendering during a drag detaches
     * the source DOM the drag engine is holding refs to, leaving
     * the ghost orphaned and the state inconsistent. The flush
     * pipeline still mutates the AST; only the DOM rebuild is
     * deferred until the user releases the pointer.
     *
     * Every rebuild also mirrors the live spellcheck toggle onto the
     * freshly-created input / textarea elements (cheap O(n) walk; the
     * editor already pays a full replaceChildren cost) and nudges the
     * editor-area top bar's Fix Structural Issues button to refresh
     * its enabled state to match the current AST.
     */
    _render()
    {
        try
        {
            this._renderInner();
        }
        finally
        {
            try { this.applySpellcheckState(getSpellcheckState().enabled); }
            catch (_) { /* ignore */ }
            try
            {
                if (typeof window !== "undefined"
                    && typeof window.__mpsRefreshFixIssuesBtn === "function")
                {
                    window.__mpsRefreshFixIssuesBtn();
                }
            }
            catch (_) { /* ignore */ }
        }
    }

    _renderInner()
    {
        if (this._dragActivated)
        {
            this._pendingRenderAfterDrag = true;
            return;
        }

        // Tear down the previous observer before clearing the DOM — its
        // targets are about to detach.
        if (this._pageObserver)
        {
            this._pageObserver.disconnect();
            this._pageObserver = null;
        }

        this.replaceChildren();

        const ast = this._ast;
        const pages = ast?.pages ?? [];
        const totalPages = pages.length;

        const body = document.createElement('div');
        body.className = 'visual-editor-body';

        // Title block always renders at the top of the body in
        // continuous-scroll mode (no more synthetic Page-0 branch).
        if (ast)
        {
            body.appendChild(this._buildTitleBlock(ast));
        }

        if (totalPages === 0)
        {
            this.appendChild(body);
            const empty = document.createElement('div');
            empty.className = 'visual-editor-empty';
            empty.textContent = 'No pages';
            this.appendChild(empty);
            return;
        }

        // Read panel ranges + source lines once; reused per page below.
        const hostEditor = this.closest('mps-editor');
        const panelRanges = hostEditor?.getPanelRanges?.() ?? [];
        const textarea = hostEditor?.querySelector?.('.editor-textarea');
        const sourceLines = textarea ? textarea.value.split('\n') : [];

        for (let pageIdx = 0; pageIdx < totalPages; pageIdx++)
        {
            const page = pages[pageIdx];
            const pageNum = page.number ?? (pageIdx + 1);
            const pageHeaderPattern = new RegExp(`^#\\s+PAGE\\s+${pageNum}\\b`, 'i');
            let pageHeaderLine = -1;
            for (let li = 0; li < sourceLines.length; li++)
            {
                if (pageHeaderPattern.test(sourceLines[li]))
                {
                    pageHeaderLine = li;
                    break;
                }
            }

            const section = document.createElement('section');
            section.className = 'visual-editor-page';
            section.dataset.pageIndex = String(pageIdx);

            const headerCard = this._buildPageHeaderCard(page, pageIdx, pageHeaderLine);
            if (headerCard) section.appendChild(headerCard);

            const panels = page.panels ?? [];
            for (let i = 0; i < panels.length; i++)
            {
                section.appendChild(this._buildPanelCard(panels[i], i, page, panelRanges));
            }

            body.appendChild(section);
        }

        this.appendChild(body);

        // Click on empty space in body clears panel selection.
        body.addEventListener('click', (e) =>
        {
            if (e.target === body)
            {
                this.store.update({ selectedPanelId: undefined }, 'visual-deselect-panel');
            }
        });

        // Reapply .is-active after rebuild — selection lives in the store
        // but the DOM was just replaced, so the class needs to be reattached.
        this._updateActiveCard(this.store.state.selectedPanelId);

        // Watch each page section; emit `visual-editor-page-in-view` for the
        // topmost section crossing 50%. Updating `_currentPageIndex` here keeps
        // the per-page mutator call sites (`_kbDragMove`, `_onAddDialogue`,
        // `_onRemovePanel`, ...) pointing at the page the user is editing.
        this._pageObserver = new IntersectionObserver((entries) =>
        {
            let topmost = -1;
            for (const entry of entries)
            {
                if (entry.intersectionRatio < 0.5) continue;
                const idx = Number(
                    /** @type {HTMLElement} */ (entry.target).dataset.pageIndex
                );
                if (!Number.isFinite(idx)) continue;
                if (topmost === -1 || idx < topmost) topmost = idx;
            }
            if (topmost !== -1)
            {
                this._currentPageIndex = topmost;
                this._emitPageInView(topmost);
            }
        }, { root: this, threshold: [0, 0.5, 1] });

        for (const section of body.querySelectorAll('.visual-editor-page'))
        {
            this._pageObserver.observe(section);
        }

        // Post-render focus + open-combobox restoration.
        if (this._postRenderFocus)
        {
            const target = this._findFocusTarget(this._postRenderFocus);
            this._postRenderFocus = null;
            if (target)
            {
                target.focus();
                if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)
                {
                    const len = target.value.length;
                    try { target.setSelectionRange(len, len); }
                    catch (_e) { /* some input types don't support selection */ }
                }
            }
        }
    }

    /**
     * Toggle .is-active on the panel card matching the given panelId.
     * @param {string|undefined} panelId
     */
    _updateActiveCard(panelId)
    {
        // Remove .is-active from all panel cards.
        for (const card of this.querySelectorAll('.panel-card.is-active'))
        {
            card.classList.remove('is-active');
        }
        // Remove .is-active from page-header-card.
        const pageHeaderCard = this.querySelector('.page-header-card.is-active');
        if (pageHeaderCard) pageHeaderCard.classList.remove('is-active');

        if (!panelId) return;

        // Handle page-header selection.
        if (panelId.endsWith('-header'))
        {
            const ph = this.querySelector(`.page-header-card[data-page-id="${panelId}"]`);
            if (ph) ph.classList.add('is-active');
            return;
        }

        // Match panel card by data-panel-id.
        const card = this.querySelector(`.panel-card[data-panel-id="${panelId}"]`);
        if (card)
        {
            card.classList.add('is-active');
        }

        // Scroll source view to the selected panel.
        if (this._suppressNextSourceScroll)
        {
            this._suppressNextSourceScroll = false;
            return;
        }

        const hostEditor = this.closest('mps-editor');
        if (!hostEditor) return;

        const panelRanges = hostEditor.getPanelRanges?.() ?? [];
        const range = panelRanges.find(r => r.panelId === panelId);
        if (!range) return;

        const lineHeightPx = hostEditor.getLineHeight?.() ?? 20;
        const measurements = hostEditor.measureLinePositions?.();
        const paddingTop = measurements?.paddingTop ?? 0;
        const tops = measurements?.tops ?? [];
        const lineTop = (tops[range.startLine] ?? 0) + paddingTop;
        const scrollTop = Math.max(0, lineTop - 40);

        const scrollWrapper = hostEditor._scrollWrapper;
        if (scrollWrapper)
        {
            scrollWrapper.scrollTo({ top: scrollTop, behavior: 'smooth' });
        }
    }

    /**
     * Resize a textarea to fit its content. Reused across panel description,
     * page direction, and any other auto-grow textarea in the visual editor.
     * @param {HTMLTextAreaElement} textarea
     */
    /**
     * Update the line-range gutter (`.panel-line-gutter`) on each panel
     * card from the host editor's current panelRanges. Cheaper than
     * `_render` and preserves the focused textarea — used after a flush
     * to reflect new source line counts without destroying the DOM.
     */
    _refreshLineGutters()
    {
        const hostEditor = this.closest('mps-editor');
        const panelRanges = hostEditor?.getPanelRanges?.() ?? [];
        const cards = this.querySelectorAll('.panel-card');
        for (const card of cards)
        {
            const panelId = card.dataset.panelId;
            const gutter = card.querySelector('.panel-line-gutter');
            if (!gutter || !panelId) continue;
            const range = panelRanges.find(r => r.panelId === panelId);
            if (!range) continue;
            const startDisplay = range.startLine + 1;
            const endDisplay = range.endLine;
            gutter.textContent = (endDisplay > startDisplay)
                ? `Lines: ${startDisplay}-${endDisplay}`
                : `Lines: ${startDisplay}`;
        }
    }

    _autosizeTextarea(textarea)
    {
        if (!textarea) return;

        const apply = () =>
        {
            textarea.style.height = 'auto';
            textarea.style.height = `${textarea.scrollHeight}px`;
        };

        // If the element isn't laid out yet (hidden parent, zero scrollHeight),
        // observe it and run once it has real dimensions. ResizeObserver fires
        // when the element transitions from 0×0 to actual size — perfect for
        // the source/visual toggle case where textareas are rendered while
        // their container is `display: none`.
        if (textarea.scrollHeight === 0)
        {
            if (textarea._autosizePending) return;
            textarea._autosizePending = true;
            const observer = new ResizeObserver((entries) =>
            {
                for (const entry of entries)
                {
                    if (entry.contentRect.width > 0)
                    {
                        observer.disconnect();
                        textarea._autosizePending = false;
                        apply();
                        return;
                    }
                }
            });
            observer.observe(textarea);
            return;
        }

        apply();

        // Re-apply once webfonts are ready — initial measurement uses the
        // fallback font; once --mps-font-script swaps in, scrollHeight is
        // smaller and the textarea should shrink to match.
        if (document.fonts && document.fonts.status !== 'loaded' && !textarea._autosizeFontRetry)
        {
            textarea._autosizeFontRetry = true;
            document.fonts.ready.then(() =>
            {
                if (textarea.isConnected) apply();
            });
        }
    }

    /**
     * Resolve a focus-spec to a DOM element after re-render.
     * @param {{ pageIndex?: number, panelIndex: number, widgetType: string, widgetIndex: number, sub: string }} spec
     */
    _findFocusTarget(spec)
    {
        const widgetSel
            = `.widget[data-panel-index="${spec.panelIndex}"]`
            + `[data-widget-type="${spec.widgetType}"]`
            + `[data-widget-index="${spec.widgetIndex}"]`;
        // Continuous-scroll renders all pages: the same data-panel-index
        // exists on every `.visual-editor-page`. Scope by pageIndex when
        // provided; fall back to a bare lookup for defence.
        let widget = null;
        if (typeof spec.pageIndex === 'number')
        {
            widget = this.querySelector(
                `.visual-editor-page[data-page-index="${spec.pageIndex}"] ${widgetSel}`
            );
        }
        if (!widget) widget = this.querySelector(widgetSel);
        if (!widget) return null;
        if (spec.sub === 'character')
        {
            return /** @type {HTMLElement|null} */ (
                widget.querySelector('.character-combobox-input')
                ?? widget.querySelector('.dialogue-character')
            );
        }
        if (spec.sub === 'text')
        {
            return /** @type {HTMLElement|null} */ (widget.querySelector('.dialogue-text'));
        }
        if (spec.sub === 'sfx')
        {
            return /** @type {HTMLElement|null} */ (widget.querySelector('.sfx-text'));
        }
        if (spec.sub === 'grip')
        {
            return /** @type {HTMLElement|null} */ (widget.querySelector('.widget-grip-rail'));
        }
        return null;
    }

    /**
     * Build the Page 0 title block.  Renders one row per `metadata.<prop>`
     * already populated, plus an `+ Add field` dropdown of the remaining
     * keys.  Edits debounce-flush through `formatScript()` → `parseScript()`
     * → `store.update()`, identical to the widget surface.
     * @param {import('@mangaplay-studio/core').ScriptAST} ast
     */
    _buildTitleBlock(ast)
    {
        if (!ast.metadata) ast.metadata = { title: '' };
        const metadata = ast.metadata;

        const card = document.createElement('article');
        card.className = 'title-block-card';

        const header = document.createElement('header');
        header.className = 'title-block-header';

        const pill = document.createElement('span');
        pill.className = 'title-block-pill';
        pill.textContent = 'TITLE';
        header.appendChild(pill);
        card.appendChild(header);

        const body = document.createElement('div');
        body.className = 'title-block-body';

        // Render one row per descriptor whose AST property is non-empty.
        const present = TITLE_BLOCK_KEYS.filter(
            (d) => titleBlockValue(metadata, d) !== ''
        );
        // Title is always shown even if empty (parser auto-fills 'Untitled').
        if (!present.find((d) => d.key === 'Title'))
        {
            present.unshift(titleBlockDesc('Title'));
        }

        for (const desc of present)
        {
            body.appendChild(this._buildTitleBlockRow(metadata, desc));
        }

        // `+ Add field` dropdown — only keys not in `present`.
        const presentKeys = new Set(present.map((d) => d.key));
        const missing = TITLE_BLOCK_KEYS.filter((d) => !presentKeys.has(d.key));
        if (missing.length > 0)
        {
            body.appendChild(this._buildTitleBlockAddRow(metadata, missing));
        }

        card.appendChild(body);
        return card;
    }

    /**
     * Build one editable title-block row.
     * @param {Object} metadata
     * @param {{ key: string, prop: string, kind: 'text' | 'number' | 'format' }} desc
     */
    _buildTitleBlockRow(metadata, desc)
    {
        const row = document.createElement('div');
        row.className = 'title-block-row';
        row.dataset.key = desc.key;

        const label = document.createElement('label');
        label.className = 'title-block-label';
        label.textContent = desc.key;
        row.appendChild(label);

        /** @type {HTMLInputElement | HTMLSelectElement} */
        let field;
        if (desc.kind === 'format')
        {
            const current = (metadata[desc.prop] === 'Comic') ? 'Comic' : 'Manga';

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'title-block-format-toggle';
            toggle.textContent = current;
            toggle.setAttribute('aria-pressed', 'true');
            toggle.title = current === 'Manga'
                ? t('ui.visualEditor.titleBlockFormat.comic', 'Switch to Comic')
                : t('ui.visualEditor.titleBlockFormat.manga', 'Switch to Manga');

            toggle.addEventListener('click', () =>
            {
                const next = current === 'Manga' ? 'Comic' : 'Manga';
                metadata[desc.prop] = next;
                // resolvePreviewMode() reads MANGA_SETTINGS.format expecting 'Manga'/'Comic'.
                const stored = PersistentStorage.get(STORAGE_KEYS.MANGA_SETTINGS, {});
                PersistentStorage.set(STORAGE_KEYS.MANGA_SETTINGS, { ...stored, format: next });
                this._flushAndRerender();
            });

            field = toggle;
        }
        else if (desc.kind === 'number')
        {
            const input = document.createElement('input');
            input.type = 'number';
            input.min = '1';
            input.className = 'title-block-value';
            const v = metadata[desc.prop];
            input.value = (typeof v === 'number' && v > 0) ? String(v) : '';
            input.addEventListener('input', () =>
            {
                const raw = input.value.trim();
                if (raw === '')
                {
                    delete metadata[desc.prop];
                    delete metadata._totalPagesImplicit;
                }
                else
                {
                    const n = parseInt(raw, 10);
                    if (Number.isFinite(n) && n >= 1)
                    {
                        metadata[desc.prop] = n;
                        delete metadata._totalPagesImplicit;
                    }
                }
                this._scheduleFlush();
            });
            field = input;
        }
        else
        {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'title-block-value';
            input.value = String(metadata[desc.prop] ?? '');
            input.addEventListener('input', () =>
            {
                const v = input.value;
                if (v === '')
                {
                    delete metadata[desc.prop];
                }
                else
                {
                    metadata[desc.prop] = v;
                }
                this._scheduleFlush();
            });
            field = input;
        }

        row.appendChild(field);
        return row;
    }

    /**
     * Build the `+ Add field` row.  Selecting a key inserts it with an
     * empty value and re-renders so the row appears.
     * @param {Object} metadata
     * @param {Array<{ key: string, prop: string, kind: string }>} missing
     */
    _buildTitleBlockAddRow(metadata, missing)
    {
        const row = document.createElement('div');
        row.className = 'title-block-add-row';

        const select = document.createElement('select');
        select.className = 'title-block-add-select';

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = t('ui.visualEditor.addField', '+ Add field');
        select.appendChild(placeholder);
        select.setAttribute(
            'aria-label',
            t('ui.visualEditor.addFieldDropdownLabel', 'Add a field')
        );

        const sorted = [...missing].sort((a, b) => a.key.localeCompare(b.key));
        for (const desc of sorted)
        {
            const opt = document.createElement('option');
            opt.value = desc.key;
            opt.textContent = desc.key;
            select.appendChild(opt);
        }

        select.addEventListener('change', () =>
        {
            const desc = titleBlockDesc(select.value);
            if (!desc) return;
            // Seed an empty value so the row renders on the next pass.
            if (desc.kind === 'number')
            {
                metadata[desc.prop] = 1;
                delete metadata._totalPagesImplicit;
            }
            else if (desc.kind === 'format')
            {
                metadata[desc.prop] = 'Manga';
            }
            else
            {
                metadata[desc.prop] = '';
            }
            // Force render-only — no flush yet (empty text values are
            // dropped by the formatter; format/pages defaults would
            // round-trip immediately, which is fine).
            if (desc.kind === 'format' || desc.kind === 'number')
            {
                this._flushAndRerender();
            }
            else
            {
                this._render();
            }
        });

        row.appendChild(select);
        return row;
    }

    /**
     * Build a page-header card for the visual editor body.
     * Represents the `# PAGE N` source line.
     * @param {import('@mangaplay-studio/core').Page} page
     * @param {number} pageIndex
     * @param {number} pageHeaderLine  Zero-based line in source where `# PAGE N` lives (-1 if not found).
     */
    _buildPageHeaderCard(page, pageIndex, pageHeaderLine)
    {
        const card = document.createElement('article');
        card.className = 'page-header-card';
        card.dataset.pageIndex = String(pageIndex);
        card.dataset.pageId = `page-${page.number ?? pageIndex + 1}-header`;

        if (pageHeaderLine >= 0)
        {
            const gutter = document.createElement('span');
            gutter.className = 'panel-line-gutter';
            gutter.textContent = `Lines: ${pageHeaderLine + 1}`;
            card.appendChild(gutter);
        }

        // Click to select this page (highlight the # PAGE line in source).
        card.addEventListener('click', (e) =>
        {
            // Don't select if the click was on a badge.
            if (e.target.closest('.page-header-card-badges')) return;
            e.stopPropagation();
            const pageId = `page-${page.number ?? pageIndex + 1}-header`;
            this._suppressNextSourceScroll = true;
            this.store.update({
                selectedPanelId: pageId,
                currentPageIndex: pageIndex
            }, 'visual-select-page');
        });

        const header = document.createElement('header');
        header.className = 'page-header-card-header';

        const pill = document.createElement('span');
        pill.className = 'page-header-pill';
        pill.textContent = `# PAGE ${page.id ?? page.number ?? pageIndex + 1}`;

        const label = document.createElement('textarea');
        label.className = 'page-header-label';
        label.rows = 1;
        label.cols = 1;
        label.placeholder = t(
            'ui.visualEditor.pageHeadingPlaceholder',
            'INT./EXT. PLACE - TIME'
        );
        label.value = formatSceneHeading(page.location);
        label.addEventListener('input', () =>
        {
            const livePage = this._ast?.pages?.[pageIndex];
            if (livePage)
            {
                livePage.location = parseSceneHeading(label.value);
            }
            this._autosizeTextarea(label);
            this._scheduleFlush();
        });
        label.addEventListener('focus', () => this._autosizeTextarea(label));

        header.appendChild(pill);
        header.appendChild(label);
        card.appendChild(header);
        requestAnimationFrame(() => this._autosizeTextarea(label));

        // Page header badge: add a new panel.
        const badges = document.createElement('div');
        badges.className = 'page-header-card-badges';

        const addPageBtn = document.createElement('button');
        addPageBtn.type = 'button';
        addPageBtn.className = 'panel-add-badge';
        addPageBtn.dataset.action = 'add-page';
        addPageBtn.textContent = t('ui.visualEditor.addNewPage', 'Add New Page');
        addPageBtn.addEventListener('click', (e) =>
        {
            e.stopPropagation();
            this._onInsertBlankPage();
        });

        const addPanelBtn = document.createElement('button');
        addPanelBtn.type = 'button';
        addPanelBtn.className = 'panel-add-badge';
        addPanelBtn.dataset.action = 'add-panel';
        addPanelBtn.textContent = t('ui.visualEditor.addPanel', 'Add Panel');
        addPanelBtn.addEventListener('click', (e) =>
        {
            e.stopPropagation();
            this._onAddPanel(page, pageIndex);
        });

        badges.appendChild(addPageBtn);
        badges.appendChild(addPanelBtn);
        card.appendChild(badges);

        return card;
    }

    /**
     * Build one panel card with editable widgets.
     * @param {import('@mangaplay-studio/core').Panel} panel
     * @param {number} panelIndex
     * @param {import('@mangaplay-studio/core').Page} page
     * @param {Array<{panelId: string, startLine: number, endLine: number}>} panelRanges
     */
    _buildPanelCard(panel, panelIndex, page, panelRanges)
    {
        const card = document.createElement('article');
        card.className = 'panel-card';
        card.dataset.panelIndex = String(panelIndex);

        // Compute panel ID matching panelRanges convention.
        const pageNum = page.number ?? (this._currentPageIndex + 1);
        const panelId = `page-${pageNum}-panel-${panelIndex}`;
        card.dataset.panelId = panelId;

        // Line-range gutter (matches source view's gutter).
        const range = panelRanges.find(r => r.panelId === panelId);
        if (range)
        {
            const gutter = document.createElement('span');
            gutter.className = 'panel-line-gutter';
            const startDisplay = range.startLine + 1;
            const endDisplay = range.endLine;
            gutter.textContent = (endDisplay > startDisplay)
                ? `Lines: ${startDisplay}-${endDisplay}`
                : `Lines: ${startDisplay}`;
            card.appendChild(gutter);
        }

        // Drag grip (visual only — wiring to actual drag-reorder is a
        // larger task; matches the dialogue/SFX widget grip pattern).
        const grip = document.createElement('div');
        grip.className = 'panel-grip-rail';
        grip.setAttribute(
            'aria-label',
            t('ui.visualEditor.dragToReorderPanel', 'Drag to reorder panel')
        );
        grip.setAttribute('role', 'button');
        grip.tabIndex = 0;
        card.appendChild(grip);

        // Click to select this panel — but not from the grip rail (drag handle).
        card.addEventListener('click', (e) =>
        {
            if (e.target.closest('.panel-grip-rail')) return;
            e.stopPropagation();
            this._suppressNextSourceScroll = true;
            this.store.update({ selectedPanelId: panelId }, 'visual-select-panel');
        });

        const header = document.createElement('header');
        header.className = 'panel-card-header';

        const pill = document.createElement('span');
        pill.className = 'panel-number-pill';
        const num = panel.displayNumber ?? (panelIndex + 1);
        pill.textContent = `PANEL ${num}`;

        const desc = document.createElement('textarea');
        desc.className = 'panel-description';
        desc.rows = 1;
        desc.cols = 1;
        desc.placeholder = t('ui.visualEditor.actionPlaceholder', 'Describe the action...');
        desc.value = panel.description ?? '';
        desc.addEventListener('input', () =>
        {
            // Re-resolve the panel from the live AST. `panel` from the
            // closure may belong to a stale AST after a flush/re-parse —
            // writing to it would silently drop the keystroke.
            const livePanel = this._ast?.pages?.[this._currentPageIndex]?.panels?.[panelIndex];
            if (livePanel)
            {
                livePanel.description = desc.value;
            }
            this._autosizeTextarea(desc);
            this._scheduleFlush();
        });
        desc.addEventListener('focus', () => this._autosizeTextarea(desc));

        header.appendChild(pill);
        header.appendChild(desc);
        card.appendChild(header);
        // Defer to next frame so the flex container has finished its layout
        // pass — otherwise scrollHeight is measured against a narrower
        // (default <textarea cols>) box and overshoots once the flex stretch
        // widens the element.
        requestAnimationFrame(() => this._autosizeTextarea(desc));

        // Border badges: visible only on .is-active card.
        const badges = document.createElement('div');
        badges.className = 'panel-card-badges';

        const addDialogueBtn = document.createElement('button');
        addDialogueBtn.type = 'button';
        addDialogueBtn.className = 'panel-add-badge';
        addDialogueBtn.dataset.action = 'add-dialogue';
        addDialogueBtn.textContent = t('ui.visualEditor.addDialogue', 'Dialogue');
        addDialogueBtn.addEventListener('click', (e) =>
        {
            e.stopPropagation();
            this._onAddDialogue(panelIndex, page);
        });

        const addSfxBtn = document.createElement('button');
        addSfxBtn.type = 'button';
        addSfxBtn.className = 'panel-add-badge';
        addSfxBtn.dataset.action = 'add-sfx';
        addSfxBtn.textContent = t('ui.visualEditor.addSfx', 'SFX');
        addSfxBtn.addEventListener('click', (e) =>
        {
            e.stopPropagation();
            this._onAddSfx(panelIndex);
        });

        badges.appendChild(addDialogueBtn);
        badges.appendChild(addSfxBtn);
        card.appendChild(badges);

        // Delete button — absolutely positioned at top-right corner.
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'panel-delete-badge';
        const panelDisplayNum = panel.displayNumber ?? (panelIndex + 1);
        const deleteTitle = t('ui.visualEditor.deletePanelTooltip', 'Delete Panel {0}?').replace('{0}', String(panelDisplayNum));
        deleteBtn.setAttribute('aria-label', deleteTitle);
        deleteBtn.title = deleteTitle;
        deleteBtn.textContent = '\u00D7';
        deleteBtn.addEventListener('click', (e) =>
        {
            e.stopPropagation();
            this._onRemovePanel(panelIndex);
        });
        card.appendChild(deleteBtn);

        // Two separate widgets-lists per panel — one for dialogue, one
        // for SFX.  Same-type-only DnD relies on the
        // `data-drop-zone-type` attribute to validate drops at
        // pointermove time.  Mirrors formatter emit order (Round-trip
        // risk #4): dialogue first, then SFX.
        const dialogueList = document.createElement('ul');
        dialogueList.className = 'widgets-list';
        dialogueList.dataset.dropZoneType = 'dialogue';
        dialogueList.dataset.panelIndex = String(panelIndex);
        dialogueList.setAttribute('role', 'list');
        dialogueList.setAttribute(
            'aria-label',
            t('ui.visualEditor.dialogueWidgetList', 'Dialogue widgets')
        );
        const dialogues = panel.dialogue ?? [];
        for (let w = 0; w < dialogues.length; w++)
        {
            dialogueList.appendChild(this._buildDialogueWidget(panel, panelIndex, dialogues[w], w, page));
        }
        card.appendChild(dialogueList);

        const sfxList = document.createElement('ul');
        sfxList.className = 'widgets-list';
        sfxList.dataset.dropZoneType = 'sfx';
        sfxList.dataset.panelIndex = String(panelIndex);
        sfxList.setAttribute('role', 'list');
        sfxList.setAttribute(
            'aria-label',
            t('ui.visualEditor.sfxWidgetList', 'Sound effects')
        );
        const sfx = panel.sfx ?? [];
        for (let w = 0; w < sfx.length; w++)
        {
            sfxList.appendChild(this._buildSfxWidget(panel, panelIndex, sfx[w], w));
        }
        card.appendChild(sfxList);

        return card;
    }

    /**
     * Build a Dialogue widget.
     * @param {import('@mangaplay-studio/core').Panel} panel
     * @param {number} panelIndex
     * @param {any} dialogue
     * @param {number} widgetIndex
     * @param {import('@mangaplay-studio/core').Page} page
     */
    _buildDialogueWidget(panel, panelIndex, dialogue, widgetIndex, page)
    {
        const li = document.createElement('li');
        li.className = 'widget dialogue-widget';
        li.dataset.panelIndex = String(panelIndex);
        li.dataset.widgetType = 'dialogue';
        li.dataset.widgetIndex = String(widgetIndex);
        li.setAttribute('role', 'listitem');
        this._applyPanelTagAttributes(li, panel);

        const grip = document.createElement('div');
        grip.className = 'widget-grip-rail';
        grip.tabIndex = 0;
        grip.setAttribute(
            'aria-label',
            t('ui.visualEditor.dragToReorder', 'Drag to reorder')
        );
        grip.setAttribute('role', 'button');
        grip.setAttribute('aria-grabbed', 'false');

        const content = document.createElement('div');
        content.className = 'widget-content';

        // Character combobox sub-widget.
        content.appendChild(this._buildCharacterCombobox(panelIndex, widgetIndex, dialogue, page));

        const text = document.createElement('textarea');
        text.className = 'dialogue-text';
        text.rows = 1;
        text.cols = 1;
        text.placeholder = 'Write script text...';
        text.value = dialogue?.text ?? '';
        text.addEventListener('input', () =>
        {
            // Resolve panel from live AST — closure refs go stale after a flush.
            const livePanel = this._ast?.pages?.[this._currentPageIndex]?.panels?.[panelIndex];
            const dList = livePanel?.dialogue ?? [];
            if (dList[widgetIndex])
            {
                dList[widgetIndex].text = text.value;
                this._autosizeTextarea(text);
                this._scheduleFlush();
            }
        });
        text.addEventListener('focus', () => this._autosizeTextarea(text));
        content.appendChild(text);
        requestAnimationFrame(() => this._autosizeTextarea(text));

        // Chip row OR custom-input mode.
        const key = `${panelIndex}:${widgetIndex}`;
        if (this._customChipEditing === key)
        {
            content.appendChild(this._buildCustomChipInput(panel, panelIndex, widgetIndex));
        }
        else
        {
            content.appendChild(this._buildChipRow(panel, panelIndex, widgetIndex, dialogue));
        }

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'widget-remove-rail';
        const dialogueRemoveTitle = t('ui.visualEditor.deleteDialogueTooltip', 'Delete this Dialogue Card?');
        remove.setAttribute('aria-label', dialogueRemoveTitle);
        remove.title = dialogueRemoveTitle;
        remove.textContent = '×';
        remove.addEventListener('click', () => this._onRemoveDialogue(panelIndex, widgetIndex));

        li.appendChild(grip);
        li.appendChild(content);
        li.appendChild(remove);
        return li;
    }

    /**
     * Build an SFX widget.
     * @param {import('@mangaplay-studio/core').Panel} panel
     * @param {number} panelIndex
     * @param {string} sfxValue
     * @param {number} widgetIndex
     */
    _buildSfxWidget(panel, panelIndex, sfxValue, widgetIndex)
    {
        const li = document.createElement('li');
        li.className = 'widget sfx-widget';
        li.dataset.panelIndex = String(panelIndex);
        li.dataset.widgetType = 'sfx';
        li.dataset.widgetIndex = String(widgetIndex);
        li.setAttribute('role', 'listitem');
        this._applyPanelTagAttributes(li, panel);

        const grip = document.createElement('div');
        grip.className = 'widget-grip-rail';
        grip.tabIndex = 0;
        grip.setAttribute(
            'aria-label',
            t('ui.visualEditor.dragToReorder', 'Drag to reorder')
        );
        grip.setAttribute('role', 'button');
        grip.setAttribute('aria-grabbed', 'false');

        const content = document.createElement('div');
        content.className = 'widget-content sfx-content';

        const label = document.createElement('label');
        label.className = 'sfx-label';
        label.textContent = 'SFX';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'sfx-text';
        input.value = sfxValue ?? '';
        // Placeholder may have been seeded by the add handler via
        // _pendingSfxPlaceholder.  Apply once and clear.
        if (this._pendingSfxPlaceholder
            && this._pendingSfxPlaceholder.panelIndex === panelIndex
            && this._pendingSfxPlaceholder.widgetIndex === widgetIndex)
        {
            input.placeholder = this._pendingSfxPlaceholder.text;
            this._pendingSfxPlaceholder = null;
        }
        input.addEventListener('input', () =>
        {
            // Resolve panel from live AST — closure refs go stale after a flush.
            const livePanel = this._ast?.pages?.[this._currentPageIndex]?.panels?.[panelIndex];
            if (livePanel)
            {
                if (!Array.isArray(livePanel.sfx)) livePanel.sfx = [];
                livePanel.sfx[widgetIndex] = input.value;
                this._scheduleFlush();
            }
        });

        content.appendChild(label);
        content.appendChild(input);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'widget-remove-rail';
        const sfxRemoveTitle = t('ui.visualEditor.deleteSfxTooltip', 'Delete this SFX Card?');
        remove.setAttribute('aria-label', sfxRemoveTitle);
        remove.title = sfxRemoveTitle;
        remove.textContent = '×';
        remove.addEventListener('click', () => this._onRemoveSfx(panelIndex, widgetIndex));

        li.appendChild(grip);
        li.appendChild(content);
        li.appendChild(remove);
        return li;
    }

    /**
     * Stamp parent-panel context onto the widget DOM.  Used by future
     * tag-editing UI without an AST round-trip.
     * @param {HTMLElement} el
     * @param {import('@mangaplay-studio/core').Panel} panel
     */
    _applyPanelTagAttributes(el, panel)
    {
        if (panel?.type)
        {
            el.dataset.panelType = String(panel.type);
        }
        const mods = Array.isArray(panel?.modifiers) ? panel.modifiers : [];
        el.dataset.panelModifiers = mods.join(',');
    }

    /**
     * Build the parenthetical chip row.
     * @param {import('@mangaplay-studio/core').Panel} panel
     * @param {number} panelIndex
     * @param {number} widgetIndex
     * @param {any} dialogue
     */
    _buildChipRow(panel, panelIndex, widgetIndex, dialogue)
    {
        const row = document.createElement('div');
        row.className = 'dialogue-chips-row';
        row.setAttribute('role', 'group');
        row.setAttribute(
            'aria-label',
            t('ui.visualEditor.dialogueParenthetical', 'Dialogue parenthetical')
        );

        // Parser contract (verified): the built-ins (thought/whisper/
        // caption) round-trip on `dialogue.type`, NOT
        // `dialogue.parenthetical`.  Custom parens live on
        // `dialogue.parenthetical`.  See parser line ~1469.
        const dialogueType = (dialogue?.type ?? 'speech').toString();
        const currentParenthetical = (dialogue?.parenthetical ?? '').toString();
        const isOffPanel = dialogue?.offPanel === true;

        for (const chip of BUILTIN_PARENTHETICALS)
        {
            // Display label localised, semantic key stays English so the
            // AST round-trips through the parser (parser maps the English
            // words to dialogue.type).
            const display = t(`ui.visualEditor.parenthetical.${chip}`, chip);
            row.appendChild(this._buildChip(
                chip,
                display,
                dialogueType === chip,
                () => this._onChipToggleBuiltin(panel, panelIndex, widgetIndex, chip)
            ));
        }

        // O.P. chip — toggles dialogue.offPanel boolean.
        row.appendChild(this._buildChip(
            'O.P.',
            t('ui.visualEditor.parenthetical.offPanel', 'O.P.'),
            isOffPanel,
            () => this._onChipToggleOffPanel(panel, panelIndex, widgetIndex)
        ));

        // Custom chip already set?  Render it as a selected 5th chip.
        if (currentParenthetical
            && !BUILTIN_PARENTHETICALS.includes(currentParenthetical))
        {
            row.appendChild(this._buildChip(
                currentParenthetical,
                currentParenthetical,
                true,
                () => this._onChipToggleCustom(
                    panel, panelIndex, widgetIndex, currentParenthetical)
            ));
        }

        // ( + ) — opens inline custom-tag input.
        const plus = document.createElement('button');
        plus.type = 'button';
        plus.className = 'parenthetical-chip parenthetical-chip-plus';
        plus.textContent = '( + )';
        plus.setAttribute('aria-pressed', 'false');
        plus.addEventListener('click', () =>
        {
            this._customChipEditing = `${panelIndex}:${widgetIndex}`;
            this._render();
            const widget = this.querySelector(
                `.widget[data-panel-index="${panelIndex}"]`
                + `[data-widget-type="dialogue"]`
                + `[data-widget-index="${widgetIndex}"]`
            );
            const input = widget?.querySelector('.custom-parenthetical-input');
            if (input instanceof HTMLInputElement) input.focus();
        });
        row.appendChild(plus);

        return row;
    }

    /**
     * Build a single chip button.
     * @param {string} label    Semantic key written to the AST (English).
     * @param {string} display  Localised on-screen label.
     * @param {boolean} active
     * @param {() => void} onClick
     */
    _buildChip(label, display, active, onClick)
    {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'parenthetical-chip';
        if (active) chip.classList.add('parenthetical-chip-active');
        chip.textContent = `( ${display} )`;
        chip.dataset.chipLabel = label;
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
        chip.addEventListener('click', onClick);
        return chip;
    }

    /**
     * Build the inline custom-parenthetical input (replaces the chip row
     * while editing).
     * @param {import('@mangaplay-studio/core').Panel} panel
     * @param {number} panelIndex
     * @param {number} widgetIndex
     */
    _buildCustomChipInput(panel, panelIndex, widgetIndex)
    {
        const row = document.createElement('div');
        row.className = 'dialogue-chips-row custom-parenthetical-input-row';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'custom-parenthetical-input';
        input.placeholder = t(
            'ui.visualEditor.parenthetical.customPlaceholder',
            'custom parenthetical'
        );

        const commit = () =>
        {
            const value = input.value.trim();
            const livePanel = this._ast?.pages?.[this._currentPageIndex]?.panels?.[panelIndex];
            const dList = livePanel?.dialogue ?? [];
            if (value && dList[widgetIndex])
            {
                dList[widgetIndex].parenthetical = value;
                dList[widgetIndex].offPanel = false;
                dList[widgetIndex].type = 'speech';
            }
            this._customChipEditing = null;
            this._flushAndRerender();
        };

        const cancel = () =>
        {
            this._customChipEditing = null;
            this._render();
        };

        input.addEventListener('keydown', (ev) =>
        {
            if (ev.key === 'Enter')
            {
                ev.preventDefault();
                commit();
            }
            else if (ev.key === 'Escape')
            {
                ev.preventDefault();
                cancel();
            }
        });

        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'custom-parenthetical-ok';
        ok.textContent = '✓';
        ok.addEventListener('click', commit);

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'custom-parenthetical-cancel';
        cancelBtn.textContent = '✕';
        cancelBtn.addEventListener('click', cancel);

        row.appendChild(input);
        row.appendChild(ok);
        row.appendChild(cancelBtn);
        return row;
    }

    /**
     * Build the character combobox sub-widget.
     * @param {number} panelIndex
     * @param {number} widgetIndex
     * @param {any} dialogue
     * @param {import('@mangaplay-studio/core').Page} page
     */
    _buildCharacterCombobox(panelIndex, widgetIndex, dialogue, page)
    {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'character-combobox-input dialogue-character';
        input.placeholder = 'Character name';
        input.value = dialogue?.character ?? '';

        input.addEventListener('blur', () =>
        {
            const newVal = input.value.trim().toUpperCase();
            const oldVal = (dialogue?.character ?? '').toString();
            if (newVal !== oldVal)
            {
                this._commitCharacterNoRerender(panelIndex, widgetIndex, newVal);
            }
        });

        return input;
    }

    /**
     * Commit a character pick (closes menu + re-renders).
     * @param {number} panelIndex
     * @param {number} widgetIndex
     * @param {string} name
     */
    _commitCharacter(panelIndex, widgetIndex, name)
    {
        this._commitCharacterNoRerender(panelIndex, widgetIndex, name);
        this._flushAndRerender();
    }

    /**
     * Write the character value to the AST without a re-render.  Used by
     * the blur handler so we don't yank focus on every tab-out.
     * @param {number} panelIndex
     * @param {number} widgetIndex
     * @param {string} name
     */
    _commitCharacterNoRerender(panelIndex, widgetIndex, name)
    {
        const ast = this._ast;
        if (!ast) return;
        const page = ast.pages?.[this._currentPageIndex];
        const panel = page?.panels?.[panelIndex];
        if (!panel) return;
        const dList = panel.dialogue ?? [];
        if (dList[widgetIndex])
        {
            dList[widgetIndex].character = name;
            // Only schedule a flush if the dialogue text is non-empty.
            // Why: an empty-text dialogue gets stripped by the round-trip
            // safety filter in _flushAstToStore (the formatter emits an
            // unmatched cue line that the parser absorbs into the panel
            // description). If the user types a character, Tabs out, then
            // pauses for >300ms before typing the dialogue body, the
            // debounce here fires during the pause and silently wipes the
            // dialogue. The character is held in the in-memory AST and
            // will be persisted to source on the first dialogue-text
            // keystroke, which schedules its own flush with both
            // character + text populated.
            const txt = typeof dList[widgetIndex].text === 'string'
                ? dList[widgetIndex].text.trim()
                : '';
            if (txt !== '')
            {
                this._scheduleFlush();
            }
        }
    }

    // -----------------------------------------------------------------
    // Mutation handlers
    // -----------------------------------------------------------------

    /**
     * Add a Dialogue widget pre-filled with the last speaker.
     * @param {number} panelIndex
     * @param {import('@mangaplay-studio/core').Page} page
     */

    /**
     * Insert a blank page after the current page.  The new page gets one
     * empty Panel 1.  All subsequent pages are renumbered (shifted +1).
     * Pagination stays on the current page.
     */
    _onInsertBlankPage()
    {
        try
        {
            const ast = this._ast;
            if (!ast) return;
            const pages = ast.pages ?? [];
            const currentIdx = this._currentPageIndex;
            if (currentIdx < 0 || currentIdx >= pages.length) return;

            // Build one blank panel matching the core Panel shape.
            const blankPanel = /** @type {import('@mangaplay-studio/core').Panel} */ ({
                index: 0,
                displayNumber: 1,
                type: 'default',
                description: '',
                dialogue: [],
                sfx: [],
                titleCards: [],
                modifiers: {}
            });

            // Build the new page.
            const newPageNum = (pages[currentIdx].number ?? (currentIdx + 1)) + 1;
            const newPageId = String(newPageNum);
            const newPage = {
                id: newPageId,
                number: newPageNum,
                panels: [blankPanel]
            };

            // Insert after current page.
            pages.splice(currentIdx + 1, 0, newPage);

            // Renumber all subsequent pages (both id and number).
            for (let i = currentIdx + 2; i < pages.length; i++)
            {
                const n = (pages[i - 1].number ?? i) + 1;
                pages[i].number = n;
                pages[i].id = String(n);
            }

            // Flush to store and re-render.  currentPageIndex stays unchanged.
            this._flushAndRerender();
        }
        catch (err)
        {
            console.error('[InsertBlankPage]', err);
        }
    }

    _onAddDialogue(panelIndex, _page)
    {
        // Cancel any pending debounced flush so prior typing is persisted
        // BEFORE we push the empty placeholder. Without this, the flush can
        // fire AFTER the push and the strip filter in _flushAstToStore
        // wipes the empty-text dialogue we just added — leaving an
        // orphaned DOM widget that silently swallows the user's keystrokes.
        if (this._editDebounceTimer)
        {
            clearTimeout(this._editDebounceTimer);
            this._editDebounceTimer = null;
            this._dirtyPending = false;
            this._flushAstToStore();
        }

        // Resolve from live AST — the `_page` closure arg may be stale,
        // and the just-fired flush above may have replaced this._ast.
        const livePage = this._ast?.pages?.[this._currentPageIndex];
        const panels = livePage?.panels ?? [];
        const panel = panels[panelIndex];
        if (!panel) return;

        // Stamp panel indent convention if unset (new document).
        if (panel._panelIndent === undefined) {
            const style = getDocumentIndentStyle(this._ast);
            panel._panelIndent = style.panelIndent;
            panel._dialogueIndent = style.dialogueIndent;
        }

        // Scan panel → page for the last speaker.
        let character = lastSpeakerInPanel(panel);
        if (!character)
        {
            for (let i = panelIndex - 1; i >= 0; i--)
            {
                character = lastSpeakerInPanel(panels[i]);
                if (character) break;
            }
        }

        if (!Array.isArray(panel.dialogue)) panel.dialogue = [];
        panel.dialogue.push({
            character,
            type: 'speech',
            text: ''
        });

        const newIndex = panel.dialogue.length - 1;
        this._postRenderFocus = {
            pageIndex: this._currentPageIndex,
            panelIndex,
            widgetType: 'dialogue',
            widgetIndex: newIndex,
            sub: character ? 'text' : 'character'
        };
        // Do NOT flush — the just-added widget has empty `.text`, which
        // the flush boundary strips (see _flushAstToStore round-trip
        // safety).  Render only; the next user keystroke triggers the
        // debounced flush with real content.
        this._render();
    }

    /**
     * Add a new Panel N line after the page header in the source.
     * @param {import('@mangaplay-studio/core').Page} page
     * @param {number} pageIndex
     */
    _onAddPanel(page, pageIndex)
    {
        const ast = this._ast;
        if (!ast) return;
        const pages = ast.pages ?? [];
        const targetPage = pages[pageIndex];
        if (!targetPage) return;

        // Determine next panel number.
        const panels = targetPage.panels ?? [];
        const nextNumber = panels.length + 1;

        // Get indent style.
        const style = getDocumentIndentStyle(ast);
        const indent = ' '.repeat(style.panelIndent);

        // Insert the new panel at the end of the page's panels.
        panels.push({
            index: panels.length,
            displayNumber: nextNumber,
            description: '',
            dialogue: [],
            sfx: [],
            _panelIndent: style.panelIndent,
            _dialogueIndent: style.dialogueIndent
        });

        // Flush to store and re-render.
        this._flushAndRerender();
    }

    /**
     * Add an SFX widget with a rotating placeholder.  Value stays empty
     * (the placeholder is just the `placeholder` attribute).
     * @param {number} panelIndex
     */
    _onAddSfx(panelIndex)
    {
        // Cancel any pending debounced flush so prior typing is persisted
        // BEFORE we push the empty placeholder. Without this, the flush can
        // fire AFTER the push and the strip filter in _flushAstToStore
        // wipes the empty-string SFX entry — leaving an orphaned DOM
        // widget that silently swallows the user's keystrokes. (The
        // earlier comment in this function acknowledged the race as
        // "documented and accepted"; in practice it caused silent data
        // loss, so we now cancel the pending flush instead.)
        if (this._editDebounceTimer)
        {
            clearTimeout(this._editDebounceTimer);
            this._editDebounceTimer = null;
            this._dirtyPending = false;
            this._flushAstToStore();
        }

        const ast = this._ast;
        if (!ast) return;
        const page = ast.pages?.[this._currentPageIndex];
        const panel = page?.panels?.[panelIndex];
        if (!panel) return;

        // Stamp panel indent convention if unset (new document).
        if (panel._panelIndent === undefined) {
            const style = getDocumentIndentStyle(this._ast);
            panel._panelIndent = style.panelIndent;
            panel._dialogueIndent = style.dialogueIndent;
        }

        if (!Array.isArray(panel.sfx)) panel.sfx = [];

        // We don't push an empty string into the AST because
        // the formatter would emit a `SFX: ` line.  Instead we DO push
        // an empty string so the widget renders, BUT the schedule-flush
        // path filters them out before re-parse.  Simpler: push a known
        // sentinel-free empty string and rely on the formatter's behaviour.
        //
        // The formatter emits `SFX: ${sfx}` for every entry — empty
        // included.  To avoid corrupting the source, we don't flush
        // until the user types.  The widget renders from the AST so we
        // must push something to make it visible.
        //
        // Resolution: push the empty string but DO NOT schedule a flush
        // here.  The first `input` event will write the typed value and
        // schedule the flush at that point.  If the user removes the
        // widget without typing, the splice happens in _onRemoveSfx.
        panel.sfx.push('');

        const widgetIndex = panel.sfx.length - 1;
        const placeholderText = sfxPlaceholderAt(
            this._sfxRotationIndex % SFX_PLACEHOLDERS_LEN
        );
        this._sfxRotationIndex++;
        this._pendingSfxPlaceholder = {
            panelIndex,
            widgetIndex,
            text: placeholderText
        };
        this._postRenderFocus = {
            pageIndex: this._currentPageIndex,
            panelIndex,
            widgetType: 'sfx',
            widgetIndex,
            sub: 'sfx'
        };

        // Render only — don't flush.  An empty SFX would otherwise emit
        // a blank `SFX: ` line on round-trip.
        this._render();
    }

    /**
     * @param {number} panelIndex
     * @param {number} widgetIndex
     */
    /**
     * Delete an entire panel and all its contents (dialogue, SFX, action
     * lines).  Splices the panel from the AST and re-renders.
     * @param {number} panelIndex
     */
    _onRemovePanel(panelIndex)
    {
        const ast = this._ast;
        if (!ast) return;
        const page = ast.pages?.[this._currentPageIndex];
        if (!page) return;
        const panels = page.panels ?? [];
        if (panelIndex < 0 || panelIndex >= panels.length) return;

        panels.splice(panelIndex, 1);

        // Renumber remaining panels to keep a clean 1..N sequence.
        for (let i = 0; i < panels.length; i++)
        {
            panels[i].displayNumber = i + 1;
            panels[i].index = i;
        }

        // Clear panel selection since the panel no longer exists.
        this.store.update({ selectedPanelId: undefined }, 'visual-delete-panel');
        this._flushAndRerender();
    }

    _onRemoveDialogue(panelIndex, widgetIndex)
    {
        const ast = this._ast;
        if (!ast) return;
        const page = ast.pages?.[this._currentPageIndex];
        const panel = page?.panels?.[panelIndex];
        if (!panel) return;
        const arr = panel.dialogue ?? [];
        if (widgetIndex < 0 || widgetIndex >= arr.length) return;
        arr.splice(widgetIndex, 1);
        this._flushAndRerender();
    }

    /**
     * @param {number} panelIndex
     * @param {number} widgetIndex
     */
    _onRemoveSfx(panelIndex, widgetIndex)
    {
        const ast = this._ast;
        if (!ast) return;
        const page = ast.pages?.[this._currentPageIndex];
        const panel = page?.panels?.[panelIndex];
        if (!panel) return;
        const arr = panel.sfx ?? [];
        if (widgetIndex < 0 || widgetIndex >= arr.length) return;
        arr.splice(widgetIndex, 1);
        // Drop any empty trailing strings so a removed-just-after-add
        // SFX doesn't leak a `SFX: ` line into the formatted source.
        for (let i = arr.length - 1; i >= 0; i--)
        {
            if (typeof arr[i] === 'string' && arr[i].trim() === '') arr.splice(i, 1);
        }
        this._flushAndRerender();
    }

    /**
     * Toggle one of the built-in parenthetical chips
     * (thought/whisper/caption).  These round-trip through
     * `dialogue.type`, not `dialogue.parenthetical` (parser maps the
     * three known names into the type field).  Clearing falls back to
     * `'speech'`.  Mutually exclusive with offPanel + custom paren.
     * @param {import('@mangaplay-studio/core').Panel} panel
     * @param {number} _panelIndex
     * @param {number} widgetIndex
     * @param {string} chip
     */
    _onChipToggleBuiltin(_panelClosure, panelIndex, widgetIndex, chip)
    {
        // Resolve from LIVE AST — `_panelClosure` may be stale after a
        // debounced flush replaced `this._ast` since the last render.
        const livePanel = this._ast?.pages?.[this._currentPageIndex]?.panels?.[panelIndex];
        const d = livePanel?.dialogue?.[widgetIndex];
        if (!d) return;
        const current = (d.type ?? 'speech').toString();
        if (current === chip)
        {
            d.type = 'speech';
        }
        else
        {
            d.type = chip;
            d.offPanel = false;
            d.parenthetical = '';
            if (Array.isArray(d.modifier)) d.modifier = [];
        }
        this._flushOrRerender(d);
    }

    /**
     * Toggle a custom parenthetical chip (anything user-typed via the
     * (+) inline input).  Writes `dialogue.parenthetical`; mutually
     * exclusive with offPanel + built-in type.
     * @param {import('@mangaplay-studio/core').Panel} panel
     * @param {number} _panelIndex
     * @param {number} widgetIndex
     * @param {string} chip
     */
    _onChipToggleCustom(_panelClosure, panelIndex, widgetIndex, chip)
    {
        const livePanel = this._ast?.pages?.[this._currentPageIndex]?.panels?.[panelIndex];
        const d = livePanel?.dialogue?.[widgetIndex];
        if (!d) return;
        const current = (d.parenthetical ?? '').toString();
        if (current === chip)
        {
            d.parenthetical = '';
        }
        else
        {
            d.parenthetical = chip;
            d.offPanel = false;
            d.type = 'speech';
            if (Array.isArray(d.modifier)) d.modifier = [];
        }
        this._flushOrRerender(d);
    }

    /**
     * Toggle the O.P. (offPanel) chip.  Mutually exclusive with
     * parenthetical chips.
     * @param {import('@mangaplay-studio/core').Panel} panel
     * @param {number} _panelIndex
     * @param {number} widgetIndex
     */
    _onChipToggleOffPanel(_panelClosure, panelIndex, widgetIndex)
    {
        const livePanel = this._ast?.pages?.[this._currentPageIndex]?.panels?.[panelIndex];
        const d = livePanel?.dialogue?.[widgetIndex];
        if (!d) return;
        if (d.offPanel === true)
        {
            d.offPanel = false;
        }
        else
        {
            d.offPanel = true;
            d.parenthetical = '';
            d.type = 'speech';
        }
        // Always strip parser-populated O.P./O.S. modifiers so the formatter
        // doesn't re-emit them on the next flush (which would force
        // offPanel back to true via the round-trip).
        if (Array.isArray(d.modifier))
        {
            d.modifier = d.modifier.filter(
                (m) => m !== 'O.P.' && m !== 'O.S.'
            );
            if (d.modifier.length === 0) delete d.modifier;
        }
        this._flushOrRerender(d);
    }

    // -----------------------------------------------------------------
    // Keyboard drag
    //
    // Activation contract:
    //   Tab → focus a .widget-grip-rail (tabindex=0).
    //   Space → enter keyboard-drag mode. Source widget marked, AST
    //           snapshot taken for Esc revert.
    //   ArrowDown/Up → move the widget within its same-type list.
    //                  Wraps to the next/prev panel's same-type list at
    //                  index 0 / last when crossing list boundaries.
    //   Enter → exit, commit (already committed per arrow).
    //   Tab   → exit cleanly without revert.
    //   Esc   → restore the snapshot, exit.
    //
    // Each arrow press mutates the AST and calls _flushAndRerender(),
    // which formats → re-parses → updates the store, then redraws.  We
    // refocus the grip in the new DOM position so subsequent arrows
    // continue to land on the same widget.
    // -----------------------------------------------------------------

    /** @param {KeyboardEvent} ev */
    _onGripKeyDown = (ev) =>
    {
        const target = /** @type {HTMLElement | null} */ (ev.target);
        if (!target) return;
        const grip = target.closest('.widget-grip-rail');
        if (!grip) return;
        const widget = /** @type {HTMLElement | null} */ (grip.closest('.widget'));
        if (!widget) return;
        const panelIndex = parseInt(widget.dataset.panelIndex ?? '-1', 10);
        const widgetIndex = parseInt(widget.dataset.widgetIndex ?? '-1', 10);
        const widgetType = widget.dataset.widgetType;
        if (panelIndex < 0 || widgetIndex < 0
            || (widgetType !== 'dialogue' && widgetType !== 'sfx'))
        {
            return;
        }

        if (ev.key === ' ' || ev.code === 'Space')
        {
            ev.preventDefault();
            if (this._kbDragOrigin)
            {
                // Already grabbed — Space again commits (same as Enter).
                this._kbDragExit(false);
                return;
            }
            this._kbDragOrigin = {
                panelIndex,
                widgetType: /** @type {'dialogue'|'sfx'} */ (widgetType),
                widgetIndex
            };
            this._kbDragAstSnapshot = this._ast
                ? JSON.stringify(this._ast)
                : null;
            widget.classList.add('kb-dragging');
            grip.setAttribute('aria-grabbed', 'true');
            grip.classList.add('dragging');
            return;
        }

        if (!this._kbDragOrigin) return;

        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')
        {
            ev.preventDefault();
            const direction = ev.key === 'ArrowDown' ? 1 : -1;
            this._kbDragMove(direction);
            return;
        }
        if (ev.key === 'Enter')
        {
            ev.preventDefault();
            this._kbDragExit(false);
            return;
        }
        if (ev.key === 'Escape')
        {
            ev.preventDefault();
            this._kbDragExit(true);
            return;
        }
        if (ev.key === 'Tab')
        {
            // Exit cleanly without revert.  Tab default behaviour fires.
            this._kbDragExit(false);
            // Do not preventDefault — the user wants to move focus.
            return;
        }
    };

    /**
     * Move the keyboard-dragged widget one slot within its same-type
     * list.  If at a list boundary, hop to the next/prev panel's
     * same-type list (index 0 on hop-down, last on hop-up).  Each step
     * mutates the AST and re-renders; focus is restored to the moved
     * grip rail at its new DOM position.
     * @param {1 | -1} direction
     */
    _kbDragMove(direction)
    {
        const ast = this._ast;
        const origin = this._kbDragOrigin;
        if (!ast || !origin) return;
        const page = ast.pages?.[this._currentPageIndex];
        if (!page) return;
        const panels = page.panels ?? [];
        const srcPanel = panels[origin.panelIndex];
        if (!srcPanel) return;
        const listKey = origin.widgetType;
        const srcArr = /** @type {any[]} */ (srcPanel[listKey] ?? []);
        if (origin.widgetIndex < 0 || origin.widgetIndex >= srcArr.length) return;

        let nextPanelIdx = origin.panelIndex;
        let nextWidgetIdx = origin.widgetIndex + direction;

        if (nextWidgetIdx < 0 || nextWidgetIdx >= srcArr.length)
        {
            // Cross-panel hop.  Find next/prev panel on this page that
            // has a same-type list (always true — every panel has both).
            let candidate = origin.panelIndex + direction;
            if (candidate < 0 || candidate >= panels.length) return;
            nextPanelIdx = candidate;
            const dstPanel = panels[nextPanelIdx];
            if (!Array.isArray(dstPanel[listKey])) dstPanel[listKey] = [];
            const dstArr = /** @type {any[]} */ (dstPanel[listKey]);
            nextWidgetIdx = direction === 1 ? 0 : dstArr.length;
        }

        // Splice + insert.  `nextWidgetIdx` is already expressed as the
        // desired final position in the post-splice destination array
        // (single-step shift, or 0 / dstArr.length on cross-panel hops)
        // so no extra adjustment is needed.
        const [entry] = srcArr.splice(origin.widgetIndex, 1);
        const dstPanel = panels[nextPanelIdx];
        const dstArr = /** @type {any[]} */ (dstPanel[listKey]);
        let insertAt = nextWidgetIdx;
        if (insertAt < 0) insertAt = 0;
        if (insertAt > dstArr.length) insertAt = dstArr.length;
        dstArr.splice(insertAt, 0, entry);

        // Update origin for the next key press.
        this._kbDragOrigin = {
            panelIndex: nextPanelIdx,
            widgetType: origin.widgetType,
            widgetIndex: insertAt
        };

        // Restore focus to the moved grip after re-render.
        this._postRenderFocus = {
            pageIndex: this._currentPageIndex,
            panelIndex: nextPanelIdx,
            widgetType: origin.widgetType,
            widgetIndex: insertAt,
            sub: 'grip'
        };
        this._flushAndRerender();
        // Re-apply the kb-dragging visual to the new widget.
        const newWidget = this.querySelector(
            `.widget[data-panel-index="${nextPanelIdx}"]`
            + `[data-widget-type="${origin.widgetType}"]`
            + `[data-widget-index="${insertAt}"]`
        );
        if (newWidget instanceof HTMLElement)
        {
            newWidget.classList.add('kb-dragging');
            const g = newWidget.querySelector('.widget-grip-rail');
            if (g)
            {
                g.setAttribute('aria-grabbed', 'true');
                g.classList.add('dragging');
            }
        }
    }

    /**
     * Exit keyboard-drag mode.  When `revert` is true, restore the AST
     * snapshot taken at grab time and re-render so all moves performed
     * during the session are undone.
     * @param {boolean} revert
     */
    _kbDragExit(revert)
    {
        const origin = this._kbDragOrigin;
        const snapshot = this._kbDragAstSnapshot;
        this._kbDragOrigin = null;
        this._kbDragAstSnapshot = null;
        if (revert && snapshot)
        {
            try
            {
                this._ast = JSON.parse(snapshot);
                this._flushAndRerender();
            }
            catch (_e)
            {
                this._render();
            }
            return;
        }
        // Non-revert: just clear visual state on whichever widget is
        // currently flagged.
        if (origin)
        {
            const w = this.querySelector(
                `.widget[data-panel-index="${origin.panelIndex}"]`
                + `[data-widget-type="${origin.widgetType}"]`
                + `[data-widget-index="${origin.widgetIndex}"]`
            );
            if (w instanceof HTMLElement)
            {
                w.classList.remove('kb-dragging');
                const g = w.querySelector('.widget-grip-rail');
                if (g)
                {
                    g.setAttribute('aria-grabbed', 'false');
                    g.classList.remove('dragging');
                }
            }
        }
    }

    // -----------------------------------------------------------------
    // DnD engine
    //
    // 7-step contract:
    //   1. Grab — pointerdown on `.widget-grip-rail` builds the ghost.
    //   2. Long-press on touch — 300ms threshold before activation.
    //   3. Multi-touch guard — second pointerdown aborts.
    //   4. Drag — elementFromPoint → resolve drop zone → validity.
    //   5. Live reorder — FLIP shift of neighbours.
    //   6. Snap-back — invalid drop / Escape / abort.
    //   7. Drop — splice AST + format + re-parse + store.update().
    // -----------------------------------------------------------------

    /** @param {PointerEvent} ev */
    _onPointerDown = (ev) =>
    {
        // Only initiate from grip rails — widget grips (dialogue/SFX) or
        // panel grips (the rail on the left edge of each panel card).
        const target = /** @type {HTMLElement | null} */ (ev.target);
        if (!target) return;
        const panelGrip = target.closest('.panel-grip-rail');
        const widgetGrip = panelGrip ? null : target.closest('.widget-grip-rail');
        const grip = panelGrip || widgetGrip;
        if (!grip) return;

        // Multi-touch guard — if a drag is already active under another
        // pointer, abort it.
        if (this._activeDragPointerId !== null
            && ev.pointerId !== this._activeDragPointerId)
        {
            this._cancelDrag(true);
            return;
        }

        let source;
        let widgetType;
        let panelIndex;
        let widgetIndex;
        if (panelGrip)
        {
            // Panel drag: source is the .panel-card; "widgetIndex" carries
            // the panel index so the existing pipeline's origin shape works.
            source = /** @type {HTMLElement | null} */ (panelGrip.closest('.panel-card'));
            if (!source) return;
            panelIndex = parseInt(source.dataset.panelIndex ?? '-1', 10);
            if (panelIndex < 0) return;
            widgetType = 'panel';
            widgetIndex = panelIndex;
        }
        else
        {
            const widget = /** @type {HTMLElement | null} */ (widgetGrip.closest('.widget'));
            if (!widget) return;
            panelIndex = parseInt(widget.dataset.panelIndex ?? '-1', 10);
            widgetIndex = parseInt(widget.dataset.widgetIndex ?? '-1', 10);
            widgetType = widget.dataset.widgetType;
            if (panelIndex < 0 || widgetIndex < 0
                || (widgetType !== 'dialogue' && widgetType !== 'sfx'))
            {
                return;
            }
            source = widget;
        }

        ev.preventDefault();

        // Clear panel selection — the user is grabbing, not selecting.
        if (this.store.state.selectedPanelId)
        {
            this.store.update({ selectedPanelId: undefined }, 'visual-drag-deselect');
        }

        this._activeDragPointerId = ev.pointerId;
        this._activeDragPointerType = /** @type {any} */ (ev.pointerType) || 'mouse';
        this._dragSourceWidget = source;
        this._dragWidgetType = /** @type {'dialogue' | 'sfx' | 'panel'} */ (widgetType);
        this._dragOrigin = { panelIndex, widgetIndex };
        this._dragDownX = ev.clientX;
        this._dragDownY = ev.clientY;
        this._dragActivated = false;
        this._dragLeftSourceZone = false;
        this._dragOverInvalidTarget = false;
        this._invalidTargetEl = null;

        try { grip.setPointerCapture(ev.pointerId); } catch (_e) {}

        // Bind document-level listeners up-front so we don't miss the
        // first move/up event on fast touches.
        this._dragMoveHandler = (e) => this._onPointerMove(e);
        this._dragUpHandler = (e) => this._onPointerUp(e);
        this._dragCancelHandler = (e) => this._onPointerCancel(e);
        this._multiTouchGuard = (e) =>
        {
            if (this._activeDragPointerId !== null
                && e.pointerId !== this._activeDragPointerId)
            {
                this._cancelDrag(true);
            }
        };
        document.addEventListener('pointermove', this._dragMoveHandler);
        document.addEventListener('pointerup', this._dragUpHandler);
        document.addEventListener('pointercancel', this._dragCancelHandler);
        document.addEventListener('pointerdown', this._multiTouchGuard);

        if (this._activeDragPointerType === 'touch')
        {
            // Long-press: arm a 300ms timer.  If pointermove fires
            // > ~5px before the timer, cancel the drag and let the
            // page scroll.  If pointerup before timer, treat as tap.
            this._longPressTimer = setTimeout(() =>
            {
                this._longPressTimer = null;
                this._activateDrag(ev.clientX, ev.clientY);
            }, 300);
        }
        else
        {
            // Mouse / pen — activate immediately.
            this._activateDrag(ev.clientX, ev.clientY);
        }
    };

    /**
     * Build the ghost and mark the drag as active.  Called either
     * immediately (mouse/pen) or after a 300ms long-press (touch).
     * @param {number} clientX
     * @param {number} clientY
     */
    _activateDrag(clientX, clientY)
    {
        const widget = this._dragSourceWidget;
        if (!widget) return;

        this._dragActivated = true;
        this._dragSourceRect = widget.getBoundingClientRect();

        // Build ghost via cloneNode(true) — no user-data injection, just
        // a visual duplicate of the source widget. Mark inert so its
        // cloned textareas/buttons can't steal focus or fire events.
        const ghost = /** @type {HTMLElement} */ (widget.cloneNode(true));
        ghost.classList.add('widget-drag-ghost');
        ghost.classList.remove('dragging-source');
        ghost.setAttribute('inert', '');
        ghost.setAttribute('aria-hidden', 'true');
        // Strip any `id` attributes on the clone so we don't end up with
        // duplicate ids in the DOM while the ghost lives.
        if (ghost.id) ghost.removeAttribute('id');
        for (const el of ghost.querySelectorAll('[id]'))
        {
            el.removeAttribute('id');
        }
        // Replace every <textarea>/<input> with a static <div> preview.
        // The visual editor's textarea CSS is scoped under
        // `mps-visual-editor textarea.…` — the ghost lives in <body>, so
        // none of those rules apply. Without replacement, the cloned
        // textarea falls back to UA defaults (cols=1 → ~15px wide,
        // resize handle, default font). Even after replacing with a
        // <div>, those rules use the `textarea` element qualifier
        // (e.g. `textarea.panel-description`), so a <div.panel-description>
        // still doesn't pick up the right font/size. Copy the computed
        // visual properties from the live element onto the preview to
        // keep the ghost visually identical to its source.
        const COPY_PROPS = [
            'font-family', 'font-size', 'font-weight', 'font-style',
            'line-height', 'letter-spacing', 'color',
            'padding', 'border', 'border-radius', 'box-sizing',
            'text-align', 'white-space', 'word-spacing'
        ];
        for (const ta of ghost.querySelectorAll('textarea, input'))
        {
            const taClass = ta.className.split(' ')[0];
            const liveCounterpart = /** @type {HTMLElement | null} */ (
                widget.querySelector(`.${taClass}`)
            );
            const preview = document.createElement('div');
            preview.textContent =
                /** @type {HTMLTextAreaElement | HTMLInputElement} */ (ta).value
                ?? ta.getAttribute('value') ?? '';
            preview.className = ta.className;
            preview.style.whiteSpace = 'pre-wrap';
            preview.style.overflow = 'hidden';
            preview.style.minHeight = '1em';
            preview.style.width = '100%';
            if (liveCounterpart)
            {
                const cs = getComputedStyle(liveCounterpart);
                for (const prop of COPY_PROPS)
                {
                    preview.style.setProperty(prop, cs.getPropertyValue(prop));
                }
                const h = liveCounterpart.offsetHeight;
                if (h > 0) preview.style.height = `${h}px`;
            }
            ta.replaceWith(preview);
        }
        ghost.style.width = `${this._dragSourceRect.width}px`;

        const offsetX = clientX - this._dragSourceRect.left;
        const offsetY = clientY - this._dragSourceRect.top;
        this._dragGhostOffsetX = offsetX;
        this._dragGhostOffsetY = offsetY;
        ghost.style.transform = `translate(${clientX - offsetX}px, ${clientY - offsetY}px)`;
        document.body.appendChild(ghost);
        // Next frame: fade in.
        requestAnimationFrame(() =>
        {
            ghost.classList.add('visible');
        });
        this._dragGhost = ghost;

        // The source widget itself acts as the in-flow placeholder at
        // opacity 0.30 (per plan).  No separate placeholder element.
        widget.classList.add('dragging-source');

        document.body.dataset.dragging = 'true';
        if (this._dragWidgetType)
        {
            document.body.dataset.draggingType = this._dragWidgetType;
        }
        const grip = widget.querySelector('.widget-grip-rail, .panel-grip-rail');
        if (grip) grip.classList.add('dragging');

        this._dragKeyHandler = (ev) =>
        {
            if (ev.key === 'Escape')
            {
                ev.preventDefault();
                this._cancelDrag(false);
            }
        };
        document.addEventListener('keydown', this._dragKeyHandler);
    }

    /** @param {PointerEvent} ev */
    _onPointerMove(ev)
    {
        if (this._activeDragPointerId === null) return;
        if (ev.pointerId !== this._activeDragPointerId) return;

        // Long-press not yet activated — if movement exceeds threshold,
        // treat as a scroll attempt and bail.
        if (!this._dragActivated && this._longPressTimer !== null)
        {
            const dx = ev.clientX - this._dragDownX;
            const dy = ev.clientY - this._dragDownY;
            if (Math.hypot(dx, dy) > 5)
            {
                this._cancelDrag(true);
            }
            return;
        }
        if (!this._dragActivated) return;

        // Update ghost position.
        const ghost = this._dragGhost;
        if (ghost)
        {
            const x = ev.clientX - this._dragGhostOffsetX;
            const y = ev.clientY - this._dragGhostOffsetY;
            ghost.style.transform = `translate(${x}px, ${y}px)`;
        }

        // Panel drag: drop zone is the visual-editor body; reorder among
        // its `.panel-card` children. The page-header card is an INVALID
        // target — hovering over it flags the drop and snaps back on release.
        if (this._dragWidgetType === 'panel')
        {
            const body = this.querySelector('.visual-editor-body');
            if (body)
            {
                this._currentDropZone = /** @type {HTMLElement} */ (body);

                const under = document.elementFromPoint(ev.clientX, ev.clientY);
                const overPageHeader = !!under?.closest?.('.page-header-card');
                this._dragOverInvalidTarget = overPageHeader;

                const prevInvalid = this._invalidTargetEl;
                const invalidEl = overPageHeader
                    ? /** @type {HTMLElement} */ (under.closest('.page-header-card'))
                    : null;
                if (prevInvalid && prevInvalid !== invalidEl)
                {
                    prevInvalid.classList.remove('drop-invalid');
                }
                if (invalidEl)
                {
                    invalidEl.classList.add('drop-invalid');
                }
                this._invalidTargetEl = invalidEl;

                if (!overPageHeader)
                {
                    this._reorderPanelPlaceholder(body, ev.clientY);
                }
            }
            return;
        }

        // Find drop zone under cursor. First try a direct hit on a
        // `.widgets-list[data-drop-zone-type]` (works when the zone has
        // content); if that misses (empty `<ul>` is 0-height), fall
        // back to the panel-card under the cursor and find its matching
        // zone by type. This lets empty zones receive drops without
        // having to inflate themselves with `min-height` (which made
        // every panel visibly grow on grab).
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        let zone = under?.closest?.('.widgets-list[data-drop-zone-type]') ?? null;
        if (!zone)
        {
            const card = under?.closest?.('.panel-card');
            if (card && this._dragWidgetType)
            {
                zone = card.querySelector(
                    `.widgets-list[data-drop-zone-type="${this._dragWidgetType}"]`
                );
            }
        }

        // Reset previous zone classes.
        if (this._currentDropZone && this._currentDropZone !== zone)
        {
            this._currentDropZone.classList.remove('drop-valid', 'drop-invalid');
        }
        this._currentDropZone = /** @type {HTMLElement | null} */ (zone);

        if (!zone)
        {
            // No zone — placeholder stays put.  Don't reorder.
            return;
        }

        // Identify whether we're over the source widget's own zone — the
        // place the widget was picked up from. Until the user has moved
        // off it at least once, suppress the highlight so the source
        // zone doesn't fight the ghost for attention.
        const sourceZone = this._dragSourceWidget?.parentElement;
        const isSourceZone = zone === sourceZone;
        if (!isSourceZone) this._dragLeftSourceZone = true;

        const zoneType = /** @type {HTMLElement} */ (zone).dataset.dropZoneType;
        const isValid = zoneType === this._dragWidgetType;
        const shouldHighlight = isValid && (!isSourceZone || this._dragLeftSourceZone);
        zone.classList.toggle('drop-valid', shouldHighlight);
        zone.classList.toggle('drop-invalid', !isValid);

        if (!isValid)
        {
            // Cross-type — show the one-shot tooltip and skip reorder.
            this._showCrossTypeTooltip(ev.clientX, ev.clientY);
            return;
        }

        // Valid zone — perform FLIP reorder for placeholder insertion.
        this._reorderPlaceholder(/** @type {HTMLElement} */ (zone), ev.clientY);
    }

    /**
     * Move the source `.panel-card` (acting as in-flow placeholder) within
     * the visual-editor body based on the cursor's Y position relative to
     * the other panel cards' centres. Mirrors `_reorderPlaceholder` but
     * for panels rather than widgets.
     * @param {HTMLElement} body
     * @param {number} clientY
     */
    _reorderPanelPlaceholder(body, clientY)
    {
        const source = this._dragSourceWidget;
        if (!source) return;
        const siblings = Array.from(body.children).filter(
            (c) => c.classList.contains('panel-card') && c !== source
        );

        // Decide insertion point by comparing clientY to each sibling's
        // mid-line.
        let insertBefore = null;
        for (const sib of siblings)
        {
            const rect = sib.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            if (clientY < mid)
            {
                insertBefore = sib;
                break;
            }
        }

        const currentNext = source.nextElementSibling;
        if (insertBefore === currentNext) return; // no change
        if (insertBefore === source) return;

        // FLIP: capture first rects, mutate, then animate the delta.
        const movers = siblings;
        const firsts = movers.map((el) => el.getBoundingClientRect());
        body.insertBefore(source, insertBefore);
        for (let i = 0; i < movers.length; i++)
        {
            const last = movers[i].getBoundingClientRect();
            const dy = firsts[i].top - last.top;
            if (dy)
            {
                const el = /** @type {HTMLElement} */ (movers[i]);
                el.style.transform = `translateY(${dy}px)`;
                el.style.transition = 'transform 0s';
                requestAnimationFrame(() =>
                {
                    el.style.transition = 'transform 180ms cubic-bezier(0.4, 0, 0.2, 1)';
                    el.style.transform = '';
                });
            }
        }
    }

    /**
     * Move the source widget (acting as in-flow placeholder) inside
     * `zone` based on the pointer's Y position relative to the
     * children's centres.  Plays a FLIP transition on the affected
     * siblings so they slide rather than jump.
     * @param {HTMLElement} zone
     * @param {number} clientY
     */
    _reorderPlaceholder(zone, clientY)
    {
        const source = this._dragSourceWidget;
        if (!source) return;

        // Compute insertion target.
        const siblings = Array.from(zone.children).filter(
            (c) => c !== source
        );
        let insertBefore = null;
        for (const sib of siblings)
        {
            const rect = sib.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2)
            {
                insertBefore = sib;
                break;
            }
        }

        // If source is already in this position, no-op.
        if (source.parentNode === zone
            && source.nextSibling === insertBefore)
        {
            return;
        }

        // FLIP: measure first.
        const measured = siblings.map((s) => /** @type {HTMLElement} */ (s));
        const firstRects = new Map();
        for (const s of measured) firstRects.set(s, s.getBoundingClientRect());

        // Move source widget to new slot.
        if (insertBefore) zone.insertBefore(source, insertBefore);
        else zone.appendChild(source);

        // Measure last + invert + play.
        for (const s of measured)
        {
            const first = firstRects.get(s);
            const last = s.getBoundingClientRect();
            const dx = first.left - last.left;
            const dy = first.top - last.top;
            if (dx === 0 && dy === 0) continue;
            s.style.transition = 'none';
            s.style.transform = `translate(${dx}px, ${dy}px)`;
            requestAnimationFrame(() =>
            {
                s.classList.add('flip-shift');
                s.style.transform = '';
                const onEnd = () =>
                {
                    s.classList.remove('flip-shift');
                    s.style.transition = '';
                    s.removeEventListener('transitionend', onEnd);
                };
                s.addEventListener('transitionend', onEnd);
            });
        }
    }

    /** @param {PointerEvent} ev */
    _onPointerUp(ev)
    {
        if (this._activeDragPointerId === null) return;
        if (ev.pointerId !== this._activeDragPointerId) return;

        // Tap (no drag activated) on a panel grip → treat as panel
        // select. Restores the natural "click to select" behaviour the
        // grip would otherwise swallow.
        if (!this._dragActivated)
        {
            if (this._dragWidgetType === 'panel' && this._dragSourceWidget)
            {
                const panelId = this._dragSourceWidget.dataset.panelId;
                if (panelId)
                {
                    this._suppressNextSourceScroll = true;
                    this.store.update({ selectedPanelId: panelId }, 'visual-grip-tap-select');
                }
            }
            this._cleanupDrag();
            return;
        }

        const zone = this._currentDropZone;

        // Resolve the panel ID to select after drop completes.
        let selectPanelId = null;
        if (this._dragWidgetType === 'panel' && this._dragSourceWidget)
        {
            selectPanelId = this._dragSourceWidget.dataset.panelId || null;
        }
        else if (zone)
        {
            const pi = parseInt(zone.dataset.panelIndex ?? '-1', 10);
            if (pi >= 0)
            {
                selectPanelId = `page-${this._currentPageIndex + 1}-panel-${pi}`;
            }
        }

        // Panel drops are always valid as long as we have a body zone AND
        // the cursor isn't over the page-header card (which is an invalid
        // target — snap back without mutating).
        if (this._dragWidgetType === 'panel')
        {
            if (!zone || this._dragOverInvalidTarget)
            {
                this._cancelDrag(false);
                return;
            }
            if (selectPanelId)
            {
                this.store.update({ selectedPanelId: selectPanelId }, 'visual-drag-select');
            }
            this._commitDrop(/** @type {HTMLElement} */ (zone));
            return;
        }

        const isValid = zone
            && zone.classList.contains('drop-valid');

        if (!isValid)
        {
            this._cancelDrag(false);
            return;
        }

        // Keep the destination panel selected after drop.
        if (selectPanelId)
        {
            this.store.update({ selectedPanelId: selectPanelId }, 'visual-drag-select');
        }

        // Valid drop — compute target panel + index from placeholder
        // position, splice AST, format + reparse, store.update().
        this._commitDrop(/** @type {HTMLElement} */ (zone));
    }

    /** @param {PointerEvent} ev */
    _onPointerCancel(ev)
    {
        if (ev.pointerId !== this._activeDragPointerId) return;
        this._cancelDrag(true);
    }

    /**
     * Splice the dragged dialogue/SFX entry from its origin and insert
     * at the source widget's current rendered position.  May be
     * within-panel or cross-panel.  Then format + re-parse + store.update().
     * @param {HTMLElement} zone
     */
    _commitDrop(zone)
    {
        const ghost = this._dragGhost;
        const source = this._dragSourceWidget;
        const origin = this._dragOrigin;
        const widgetType = this._dragWidgetType;
        const ast = this._ast;
        if (!ghost || !source || !origin || !widgetType || !ast)
        {
            this._cancelDrag(true);
            return;
        }

        // Panel reorder: splice page.panels[] based on source card's
        // current DOM position among its siblings.
        if (widgetType === 'panel')
        {
            const body = zone;
            const panelCards = Array.from(body.children).filter(
                (c) => c.classList.contains('panel-card')
            );
            const newIndex = panelCards.indexOf(source);
            const page = ast.pages?.[this._currentPageIndex];
            if (newIndex < 0 || !page)
            {
                this._cancelDrag(true);
                return;
            }
            const panels = page.panels ?? [];
            if (origin.panelIndex < 0 || origin.panelIndex >= panels.length)
            {
                this._cancelDrag(true);
                return;
            }
            if (newIndex === origin.panelIndex)
            {
                // No movement — snap-back path.
                this._cancelDrag(false);
                return;
            }

            // Snapshot displayNumbers BEFORE the splice — used to decide
            // whether to renumber after.
            const wasSequential = panels.every(
                (p, i) => p.displayNumber === i + 1
            );

            const [panelEntry] = panels.splice(origin.panelIndex, 1);
            panels.splice(newIndex, 0, panelEntry);

            // If the original numbering was a clean 1..N sequence, keep
            // it that way after the reorder — Panel 1 should always be
            // the first physical panel. If the user had intentional gaps
            // or duplicates (e.g. `Panel 2A`, missing numbers), preserve
            // their numbering instead.
            if (wasSequential)
            {
                for (let i = 0; i < panels.length; i++)
                {
                    panels[i].displayNumber = i + 1;
                    panels[i].index = i;
                }
            }
            else
            {
                // Always update the structural `index` field so it
                // matches array position — `displayNumber` is preserved.
                for (let i = 0; i < panels.length; i++)
                {
                    panels[i].index = i;
                }
            }

            // Fly the ghost back to the source rect as a cosmetic
            // background animation — but release the source/state
            // immediately so the user sees an instant snap.
            this._detachGhostWithFlyIn(ghost, source);
            this._cleanupDrag();
            this._flushAndRerender();
            return;
        }

        const targetPanelIndex = parseInt(zone.dataset.panelIndex ?? '-1', 10);
        if (targetPanelIndex < 0)
        {
            this._cancelDrag(true);
            return;
        }

        // Resolve target index from source widget's current position in
        // the destination list (siblings only, source itself excluded).
        const allChildren = Array.from(zone.children);
        const sourceIdx = allChildren.indexOf(source);
        // Target index in the AST array is the source's index among the
        // OTHER children (since source becomes the new entry at that slot).
        const targetIndex = Math.max(0, sourceIdx);

        const page = ast.pages?.[this._currentPageIndex];
        if (!page)
        {
            this._cancelDrag(true);
            return;
        }
        const srcPanel = page.panels?.[origin.panelIndex];
        const dstPanel = page.panels?.[targetPanelIndex];
        if (!srcPanel || !dstPanel)
        {
            this._cancelDrag(true);
            return;
        }

        const listKey = widgetType === 'dialogue' ? 'dialogue' : 'sfx';
        const srcArr = /** @type {any[]} */ (srcPanel[listKey] ?? []);
        if (!Array.isArray(dstPanel[listKey])) dstPanel[listKey] = [];
        const dstArr = /** @type {any[]} */ (dstPanel[listKey]);

        if (origin.widgetIndex < 0 || origin.widgetIndex >= srcArr.length)
        {
            this._cancelDrag(true);
            return;
        }

        const [entry] = srcArr.splice(origin.widgetIndex, 1);
        // Adjust target index if same-panel splice removed an entry
        // before the target slot.
        let insertAt = targetIndex;
        if (srcPanel === dstPanel && origin.widgetIndex < targetIndex)
        {
            insertAt = targetIndex - 1;
        }
        if (insertAt < 0) insertAt = 0;
        if (insertAt > dstArr.length) insertAt = dstArr.length;
        dstArr.splice(insertAt, 0, entry);

        // Fly the ghost back to the source rect as a cosmetic
        // background animation — but release the source/state
        // immediately so the user sees an instant snap.
        this._detachGhostWithFlyIn(ghost, source);
        this._cleanupDrag();
        this._flushAndRerender();
    }

    /**
     * Hand the ghost off to a background fly-in animation (commit drop).
     * The ghost owns its own removal so the main drag state can be
     * cleaned up synchronously without waiting on the animation.
     * @param {HTMLElement} ghost
     * @param {HTMLElement} source
     */
    _detachGhostWithFlyIn(ghost, source)
    {
        this._ghostAnimating = true;
        const sourceRect = source.getBoundingClientRect();
        ghost.classList.add('flying-in');
        ghost.style.transform = `translate(${sourceRect.left}px, ${sourceRect.top}px)`;
        let finished = false;
        const finish = () =>
        {
            if (finished) return;
            finished = true;
            ghost.removeEventListener('transitionend', finish);
            if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
            this._ghostAnimating = false;
        };
        ghost.addEventListener('transitionend', finish);
        setTimeout(finish, 200);
    }

    /**
     * Snap-back animation + cleanup.  No AST mutation.  Animates the
     * ghost to the source widget's current bounding rect (which may
     * have shifted via reorder), then a re-render restores DOM order
     * from the unmodified AST.
     * @param {boolean} immediate  if true, skip the snap-back animation
     */
    _cancelDrag(immediate)
    {
        if (this._longPressTimer)
        {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
        }
        // Always instant on cancel — the source springs back to its
        // original position and the ghost is removed in one tick.
        // Snap-back animations were a stutter the user noticed: 200-
        // 250ms delay between releasing and the source returning to
        // full opacity. Now: release → instant restore.
        const wasActivated = this._dragActivated;
        this._cleanupDrag();
        if (wasActivated) this._render();
        // `immediate` retained as part of the public API for callers
        // that want explicit teardown semantics; behaviour is the same
        // either way.
        void immediate;
        return;
    }

    /**
     * Tear down all drag state, listeners, ghost, placeholder, tooltip,
     * body flag, drop-zone classes, grip-active class, source opacity.
     */
    _cleanupDrag()
    {
        if (this._longPressTimer)
        {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
        }
        if (this._dragMoveHandler)
        {
            document.removeEventListener('pointermove', this._dragMoveHandler);
            this._dragMoveHandler = null;
        }
        if (this._dragUpHandler)
        {
            document.removeEventListener('pointerup', this._dragUpHandler);
            this._dragUpHandler = null;
        }
        if (this._dragCancelHandler)
        {
            document.removeEventListener('pointercancel', this._dragCancelHandler);
            this._dragCancelHandler = null;
        }
        if (this._multiTouchGuard)
        {
            document.removeEventListener('pointerdown', this._multiTouchGuard);
            this._multiTouchGuard = null;
        }
        if (this._dragKeyHandler)
        {
            document.removeEventListener('keydown', this._dragKeyHandler);
            this._dragKeyHandler = null;
        }
        // Remove the ghost only if it hasn't been handed off to a
        // background animation. Animated handoffs set `_ghostAnimating`
        // and own the cleanup themselves; we only blow it away here on
        // an immediate cleanup path.
        if (this._dragGhost && this._dragGhost.parentNode && !this._ghostAnimating)
        {
            this._dragGhost.parentNode.removeChild(this._dragGhost);
        }
        this._dragGhost = null;
        if (this._dragSourceWidget)
        {
            this._dragSourceWidget.classList.remove('dragging-source');
            this._dragSourceWidget.style.display = '';
            const grip = this._dragSourceWidget.querySelector('.widget-grip-rail, .panel-grip-rail');
            if (grip) grip.classList.remove('dragging');
        }
        this._dragSourceWidget = null;
        if (this._currentDropZone)
        {
            this._currentDropZone.classList.remove('drop-valid', 'drop-invalid');
        }
        this._currentDropZone = null;
        // Clear all drop-zone classes defensively.
        for (const z of this.querySelectorAll('.widgets-list[data-drop-zone-type]'))
        {
            z.classList.remove('drop-valid', 'drop-invalid');
        }
        if (this._invalidTargetEl)
        {
            this._invalidTargetEl.classList.remove('drop-invalid');
            this._invalidTargetEl = null;
        }
        delete document.body.dataset.dragging;
        delete document.body.dataset.draggingType;
        this._activeDragPointerId = null;
        this._activeDragPointerType = null;
        this._dragWidgetType = null;
        this._dragOrigin = null;
        this._dragSourceRect = null;
        this._dragActivated = false;
        this._dragLeftSourceZone = false;
        this._dragOverInvalidTarget = false;
        this._hideCrossTypeTooltip();

        // Replay any re-render that was suppressed during the drag.
        // _commitDrop already calls _flushAndRerender, which calls
        // _render — that one is intentional and will run here too.
        if (this._pendingRenderAfterDrag)
        {
            this._pendingRenderAfterDrag = false;
            this._render();
        }
    }

    /**
     * Show a one-shot tooltip explaining the cross-type restriction.
     * Shown only once per component instance per session.
     * @param {number} clientX
     * @param {number} clientY
     */
    _showCrossTypeTooltip(clientX, clientY)
    {
        if (this._crossTypeTooltipShown) return;
        if (this._crossTypeTooltipEl) return;
        this._crossTypeTooltipShown = true;
        const tip = document.createElement('div');
        tip.className = 'widget-drag-tooltip';
        tip.setAttribute('role', 'status');
        tip.textContent = t(
            'ui.visualEditor.crossTypeDragTooltip',
            "Dragging between dialogue and sound effects isn't supported yet."
        );
        const x = Math.min(clientX + 12, window.innerWidth - 280);
        const y = Math.min(clientY + 16, window.innerHeight - 60);
        tip.style.left = `${x}px`;
        tip.style.top = `${y}px`;
        document.body.appendChild(tip);
        this._crossTypeTooltipEl = tip;
        setTimeout(() => this._hideCrossTypeTooltip(), 2000);
    }

    _hideCrossTypeTooltip()
    {
        if (this._crossTypeTooltipEl && this._crossTypeTooltipEl.parentNode)
        {
            this._crossTypeTooltipEl.parentNode.removeChild(this._crossTypeTooltipEl);
        }
        this._crossTypeTooltipEl = null;
    }

    /**
     * Close the open combobox / custom-chip edit mode when the user
     * clicks outside the visual editor.
     * @param {MouseEvent} ev
     */
    _onDocumentClick(ev)
    {
        const path = ev.composedPath ? ev.composedPath() : [];
        const insideMe = path.includes(this);
        if (insideMe) return;
        let dirty = false;
        if (this._customChipEditing !== null)
        {
            this._customChipEditing = null;
            dirty = true;
        }
        if (dirty) this._render();
    }

    /**
     * Build the diagnostic list for the visual editor banner. Runs the same
     * parser warnings + editor-side checks as `runParserLinter()` but skips
     * CM6 range mapping — the visual editor doesn't paint squiggles, only a
     * summary strip above the page.
     * @returns {Array<{ code: string, severity: "error"|"warning"|"info", message: string, line: number }>}
     */
    _collectDiagnostics()
    {
        const ast = this._ast;
        if (!ast) return [];

        /** @type {any[]} */
        const allWarnings = [];
        if (Array.isArray(ast.warnings))
        {
            for (const w of ast.warnings) allWarnings.push(w);
        }
        let source = "";
        try { source = formatScript(ast); }
        catch (_) { source = ""; }
        try
        {
            for (const w of sequentialPages(ast))           allWarnings.push(w);
            for (const w of sequentialPanels(ast))          allWarnings.push(w);
            for (const w of unknownPanelTags(ast, source))  allWarnings.push(w);
            for (const w of characterCueCase(ast))          allWarnings.push(w);
        }
        catch (_) { /* defensive — never block render on a check throw */ }

        /** @type {Array<{ code: string, severity: "error"|"warning"|"info", message: string, line: number }>} */
        const out = [];
        for (const w of allWarnings)
        {
            const meta = CODE_META[w.code];
            if (!meta) continue;
            const params = visualArgsToParams(w.args);
            const message = resolveDiagnosticMessage(
                {
                    messageKey: meta.messageKey,
                    message: w.message || w.code,
                    messageParams: params
                },
                visualTranslate
            );
            out.push({
                code: w.code,
                severity: meta.severity,
                message,
                line: (typeof w.line === "number" ? w.line : 0) + 1
            });
        }
        return out;
    }
}

/**
 * `{0}`/`{1}` placeholder shim — matches the format used in en.json so the
 * resolver hands them straight through.
 * @param {Array<string|number> | undefined} args
 * @returns {Record<string, string|number>}
 */
function visualArgsToParams(args)
{
    /** @type {Record<string, string|number>} */
    const params = {};
    if (!Array.isArray(args)) return params;
    for (let i = 0; i < args.length; i++)
    {
        params[String(i)] = args[i];
    }
    return params;
}

function visualTranslate(key, fallback)
{
    try { return t(key, fallback); }
    catch (_) { return fallback; }
}

if (!customElements.get('mps-visual-editor'))
{
    customElements.define('mps-visual-editor', MPSVisualEditor);
}
