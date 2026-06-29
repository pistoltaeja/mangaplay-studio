/**
 * Desktop i18n adapter.
 *
 * Static-imports only the English dictionary as the boot floor + fallback.
 * The other 13 locale JSONs are wired through `LOADERS` so Bun emits one
 * chunk per locale and only the active language ships to first paint.
 *
 * Detection priority on first launch:
 *   1. localStorage 'mps_desktop_lang' (mirrored from app_settings.language)
 *   2. navigator.language → matchSupportedLanguage()
 *   3. navigator.languages[*] (in order, first match wins)
 *   4. 'en'
 *
 * setLanguage(code) is async — it awaits the dictionary chunk before swapping
 * currentLang + notifying subscribers, so the first `t()` call on the new
 * locale always finds its strings. `t()` itself stays synchronous.
 *
 * Mirrors the API surface of `extension-mangaplay-studio/adapters/ext-i18n.js`.
 */

import en from '../../../localisation/en.json';

import {
    SUPPORTED_LANGUAGES_LIST,
    SUPPORTED_LANGUAGE_CODES,
    matchSupportedLanguage,
} from './languages.js';

const STORAGE_KEY = 'mps_desktop_lang';

/**
 * Lazy loaders for the 13 non-English dictionaries. Each invocation returns
 * a Promise that resolves to the module record; Bun code-splits these into
 * one chunk per locale at build time.
 * @type {Record<string, () => Promise<any>>}
 */
const LOADERS = {
    'ja':    () => import('../../../localisation/ja.json'),
    'ko':    () => import('../../../localisation/ko.json'),
    'es':    () => import('../../../localisation/es.json'),
    'fr':    () => import('../../../localisation/fr.json'),
    'it':    () => import('../../../localisation/it.json'),
    'id':    () => import('../../../localisation/id.json'),
    'ru':    () => import('../../../localisation/ru.json'),
    'pt':    () => import('../../../localisation/pt.json'),
    'th':    () => import('../../../localisation/th.json'),
    'zh-CN': () => import('../../../localisation/zh-CN.json'),
    'zh-TW': () => import('../../../localisation/zh-TW.json'),
    'de':    () => import('../../../localisation/de.json'),
    'vi':    () => import('../../../localisation/vi.json'),
};

/** @type {Record<string, any>} */
const DICTS = { 'en': en };

/** @type {Map<string, Promise<any>>} */
const inflight = new Map();

/**
 * Ensure the dictionary for `code` is resident in `DICTS`. Idempotent.
 * Concurrent calls share a single inflight promise so we never double-fetch.
 * @param {string} code
 * @returns {Promise<void>}
 */
async function ensureLoaded(code)
{
    if (code === 'en' || DICTS[code]) return;
    const loader = LOADERS[code];
    if (!loader) return; // Unknown code — caller falls back to 'en'.
    let p = inflight.get(code);
    if (!p)
    {
        p = loader().then((mod) =>
        {
            DICTS[code] = mod && mod.default ? mod.default : mod;
        }).finally(() => { inflight.delete(code); });
        inflight.set(code, p);
    }
    await p;
}

/** Back-compat shape for consumers that list languages. */
export const LANGUAGES = SUPPORTED_LANGUAGES_LIST.map((l) => ({
    code: l.code,
    name: l.name,
    nativeName: l.nativeName,
    flag: l.flagSvg,
}));

/** @type {string} */
let currentLang = 'en';

/** @type {Set<(lang: string) => void>} */
const subscribers = new Set();

/**
 * Walk a dot-path against a nested object.
 * @param {any} obj @param {string[]} parts @returns {any}
 */
function walk(obj, parts)
{
    let cur = obj;
    for (const p of parts)
    {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[p];
    }
    return cur;
}

/**
 * Resolve a dot-path against the active dictionary. Tries `shared.<path>`
 * first, then a raw walk from the root.
 * @param {string} path @returns {string|undefined}
 */
function lookup(path)
{
    if (typeof path !== 'string' || path.length === 0) return undefined;
    const dict = DICTS[currentLang] || DICTS.en;
    const parts = path.split('.');

    const inShared = walk(dict && dict.shared, parts);
    if (typeof inShared === 'string') return inShared;

    // Fallback to English if the active dictionary is missing the key.
    if (currentLang !== 'en')
    {
        const enShared = walk(DICTS.en && DICTS.en.shared, parts);
        if (typeof enShared === 'string') return enShared;
    }

    const fromRoot = walk(dict, parts);
    if (typeof fromRoot === 'string') return fromRoot;

    return undefined;
}

/**
 * Detect a sensible default language from the OS / browser.
 * @returns {string}
 */
function detectLanguage()
{
    // Stored choice wins, but only if it's a recognised code.
    try
    {
        const raw = globalThis.localStorage?.getItem?.(STORAGE_KEY);
        if (raw && SUPPORTED_LANGUAGE_CODES.includes(raw)) return raw;
    }
    catch (_) { /* ignore */ }

    if (typeof navigator !== 'undefined')
    {
        if (navigator.language)
        {
            const m = matchSupportedLanguage(navigator.language);
            if (m) return m;
        }
        if (Array.isArray(navigator.languages))
        {
            for (const tag of navigator.languages)
            {
                const m = matchSupportedLanguage(tag);
                if (m) return m;
            }
        }
    }

    return 'en';
}

function isValidLanguage(code)
{
    return SUPPORTED_LANGUAGE_CODES.includes(code);
}

function getLanguage()
{
    return currentLang;
}

function notify()
{
    for (const fn of subscribers)
    {
        try { fn(currentLang); }
        catch (e) { console.error('[tauri-i18n] subscriber threw:', e); }
    }
    // Also fire a DOM CustomEvent so non-subscriber consumers (eg. the
    // picker shell) can listen on document.
    try
    {
        if (typeof document !== 'undefined')
        {
            document.dispatchEvent(new CustomEvent('mps-lang-change', {
                detail: { code: currentLang },
            }));
        }
    }
    catch (_) { /* ignore */ }
}

/**
 * Switch the active language. Awaits the locale chunk before mutating state
 * so subscribers (and the immediately-following `t()` calls) always observe
 * the new dictionary as loaded.
 * @param {string} lang
 * @returns {Promise<void>}
 */
async function setLanguage(lang)
{
    const next = isValidLanguage(lang) ? lang : 'en';
    if (next === currentLang) return;

    await ensureLoaded(next);

    currentLang = next;

    try { globalThis.localStorage?.setItem?.(STORAGE_KEY, next); }
    catch (_) { /* ignore */ }

    if (typeof document !== 'undefined')
    {
        document.documentElement.lang = next;
        document.documentElement.dataset.lang = next;
    }

    notify();
}

function interpolate(template, params)
{
    if (!params || typeof template !== 'string') return template;
    return template.replace(/\{(\w+)\}/g, (_, key) =>
    {
        const val = params[key];
        return val == null ? '' : String(val);
    });
}

function t(path, fallbackOrParams, params)
{
    let fallback;
    if (typeof fallbackOrParams === 'string')
    {
        fallback = fallbackOrParams;
    }
    else if (fallbackOrParams && typeof fallbackOrParams === 'object')
    {
        params = fallbackOrParams;
    }

    const found = lookup(path);
    if (typeof found === 'string') return interpolate(found, params);
    if (typeof fallback === 'string') return interpolate(fallback, params);
    return interpolate(path, params);
}

function subscribe(cb)
{
    subscribers.add(cb);
    return () => subscribers.delete(cb);
}

/**
 * Detect the boot-time language and ensure its dictionary is loaded before
 * any consumer can call `t()`. Caller must `await` this in the boot path.
 * @returns {Promise<void>}
 */
async function initialise()
{
    const detected = detectLanguage();
    await ensureLoaded(detected);
    currentLang = detected;

    if (typeof document !== 'undefined')
    {
        document.documentElement.lang = currentLang;
        document.documentElement.dataset.lang = currentLang;
    }
}

export {
    detectLanguage,
    getLanguage,
    setLanguage,
    t,
    subscribe,
    initialise,
};
