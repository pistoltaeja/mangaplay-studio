/**
 * Supported-language enum for the Mangaplay Studio desktop app.
 *
 * Mirrors `extension-mangaplay-studio/adapters/languages.js`, but resolves
 * flag SVG URLs against `./img/flags/` instead of the chrome.runtime URL
 * scheme. Keep the locale list in sync with the extension — adding a locale
 * here requires the same entry there and a matching `localisation/<code>.json`.
 *
 * "Mangaplay" / "Mangaplay Studio" stay English literally — do not translate.
 */

/**
 * @typedef {Object} LanguageDescriptor
 * @property {string} code BCP-47 tag.
 * @property {string} name English name.
 * @property {string} nativeName Native spelling for switcher UI.
 * @property {string} flagSvg SVG filename in /img/flags/ (lipis/flag-icons MIT).
 */

/** @type {Readonly<Record<string, LanguageDescriptor>>} */
export const SupportedLanguages = Object.freeze({
    EN:    { code: 'en',    name: 'English',                nativeName: 'English',          flagSvg: 'gb.svg' },
    KO:    { code: 'ko',    name: 'Korean',                 nativeName: '한국어',            flagSvg: 'kr.svg' },
    JA:    { code: 'ja',    name: 'Japanese',               nativeName: '日本語',            flagSvg: 'jp.svg' },
    ID:    { code: 'id',    name: 'Indonesian',             nativeName: 'Bahasa Indonesia', flagSvg: 'id.svg' },
    ES:    { code: 'es',    name: 'Spanish',                nativeName: 'Español',          flagSvg: 'es.svg' },
    FR:    { code: 'fr',    name: 'French',                 nativeName: 'Français',         flagSvg: 'fr.svg' },
    IT:    { code: 'it',    name: 'Italian',                nativeName: 'Italiano',         flagSvg: 'it.svg' },
    RU:    { code: 'ru',    name: 'Russian',                nativeName: 'Русский',          flagSvg: 'ru.svg' },
    PT:    { code: 'pt',    name: 'Portuguese',             nativeName: 'Português',        flagSvg: 'br.svg' },
    TH:    { code: 'th',    name: 'Thai',                   nativeName: 'ไทย',              flagSvg: 'th.svg' },
    ZH_CN: { code: 'zh-CN', name: 'Chinese (Simplified)',   nativeName: '简体中文',          flagSvg: 'zh-hans.svg' },
    ZH_TW: { code: 'zh-TW', name: 'Chinese (Traditional)',  nativeName: '繁體中文',          flagSvg: 'zh-hant.svg' },
    DE:    { code: 'de',    name: 'German',                 nativeName: 'Deutsch',          flagSvg: 'de.svg' },
    VI:    { code: 'vi',    name: 'Vietnamese',             nativeName: 'Tiếng Việt',       flagSvg: 'vn.svg' },
});

export const FLAG_ASSET_BASE = './img/flags';

/** @type {Readonly<string[]>} */
export const SUPPORTED_LANGUAGE_CODES = Object.freeze(
    Object.values(SupportedLanguages).map((l) => l.code)
);

/** @type {Readonly<LanguageDescriptor[]>} */
export const SUPPORTED_LANGUAGES_LIST = Object.freeze(Object.values(SupportedLanguages));

/**
 * Resolve a flag SVG URL for a locale code. Falls back to English when unknown.
 * @param {string} code
 * @returns {string}
 */
export function getFlagSvgUrl(code)
{
    const cfg = SUPPORTED_LANGUAGES_LIST.find((l) => l.code === code) || SupportedLanguages.EN;
    return `${FLAG_ASSET_BASE}/${cfg.flagSvg}`;
}

/**
 * Match priority: exact → prefix ("ko-KR" → "ko") → base ("en-GB" → "en") → null.
 * Handles `zh` script tags via Hant/HK/MO → zh-TW, otherwise zh-CN.
 * @param {string} browserLang
 * @returns {string|null}
 */
export function matchSupportedLanguage(browserLang)
{
    if (!browserLang || typeof browserLang !== 'string') return null;
    const normalized = browserLang.trim();
    if (!normalized) return null;
    const lower = normalized.toLowerCase();

    const exact = SUPPORTED_LANGUAGE_CODES.find((c) => c.toLowerCase() === lower);
    if (exact) return exact;

    const prefix = SUPPORTED_LANGUAGE_CODES.find((c) => lower.startsWith(c.toLowerCase() + '-'));
    if (prefix) return prefix;

    const base = lower.split('-')[0];
    const baseMatch = SUPPORTED_LANGUAGE_CODES.find((c) => c.toLowerCase() === base);
    if (baseMatch) return baseMatch;

    if (base === 'zh')
    {
        if (lower.includes('hant') || lower.includes('hk') || lower.includes('mo'))
        {
            const tw = SUPPORTED_LANGUAGE_CODES.find((c) => c === 'zh-TW');
            if (tw) return tw;
        }
        const cn = SUPPORTED_LANGUAGE_CODES.find((c) => c === 'zh-CN');
        if (cn) return cn;
    }

    return null;
}
