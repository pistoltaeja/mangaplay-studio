/**
 * Desktop i18n adapter.
 *
 * Loads all 14 `localisation/<code>.json` dictionaries at build time (Bun
 * inlines the imports) and resolves `t(path)` against the active dictionary.
 *
 * Detection priority on first launch:
 *   1. localStorage 'mps_desktop_lang' (mirrored from app_settings.language)
 *   2. navigator.language → matchSupportedLanguage()
 *   3. navigator.languages[*] (in order, first match wins)
 *   4. 'en'
 *
 * setLanguage(code) updates the active dictionary, mirrors to localStorage,
 * dispatches a 'mps-lang-change' CustomEvent on document, and notifies
 * subscribe() listeners. Persistence to app_settings is the caller's job
 * (see <mps-lang-select>).
 *
 * Mirrors the API surface of `extension-mangaplay-studio/adapters/ext-i18n.js`.
 */

import en from '../../../localisation/en.json';
import ja from '../../../localisation/ja.json';
import ko from '../../../localisation/ko.json';
import es from '../../../localisation/es.json';
import fr from '../../../localisation/fr.json';
import it from '../../../localisation/it.json';
import id from '../../../localisation/id.json';
import ru from '../../../localisation/ru.json';
import pt from '../../../localisation/pt.json';
import th from '../../../localisation/th.json';
import zhCN from '../../../localisation/zh-CN.json';
import zhTW from '../../../localisation/zh-TW.json';
import de from '../../../localisation/de.json';
import vi from '../../../localisation/vi.json';

import {
    SUPPORTED_LANGUAGES_LIST,
    SUPPORTED_LANGUAGE_CODES,
    matchSupportedLanguage,
} from './languages.js';

const STORAGE_KEY = 'mps_desktop_lang';

/** @type {Record<string, any>} */
const DICTS = {
    'en':    en,
    'ja':    ja,
    'ko':    ko,
    'es':    es,
    'fr':    fr,
    'it':    it,
    'id':    id,
    'ru':    ru,
    'pt':    pt,
    'th':    th,
    'zh-CN': zhCN,
    'zh-TW': zhTW,
    'de':    de,
    'vi':    vi,
};

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

function matchBrowserLanguage(tag)
{
    return matchSupportedLanguage(tag) || 'en';
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
 * @param {string} lang
 */
function setLanguage(lang)
{
    const next = isValidLanguage(lang) ? lang : 'en';
    if (next === currentLang) return;
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

function getTranslations()
{
    return (DICTS[currentLang] && DICTS[currentLang].shared) || {};
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

function getLanguageConfig(code)
{
    const want = code || currentLang;
    return LANGUAGES.find((l) => l.code === want);
}

function initialise()
{
    currentLang = detectLanguage();

    if (typeof document !== 'undefined')
    {
        document.documentElement.lang = currentLang;
        document.documentElement.dataset.lang = currentLang;
    }
}

function initialiseAsync()
{
    initialise();
    return Promise.resolve(currentLang);
}

function i18nReady()
{
    return initialiseAsync();
}

function format(template, ...args)
{
    return template.replace(/\{(\d+)\}/g, (m, i) =>
    {
        const v = args[Number(i)];
        return v === undefined ? m : String(v);
    });
}

export {
    matchBrowserLanguage,
    detectLanguage,
    isValidLanguage,
    getLanguage,
    setLanguage,
    getTranslations,
    t,
    format,
    interpolate,
    subscribe,
    getLanguageConfig,
    initialise,
    initialiseAsync,
    i18nReady,
};
