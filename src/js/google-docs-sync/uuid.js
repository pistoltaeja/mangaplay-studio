// @ts-check
/**
 * uuid.js — shared RFC 4122 v4 UUID generator for the google-docs-sync feature.
 *
 * `crypto.randomUUID()` is available in modern browsers and Bun; we fall back
 * to a manual builder when it isn't, so the file imports cleanly in unit-test
 * contexts that stub `globalThis.crypto`.
 */

/**
 * @returns {string}
 */
export function uuid()
{
    const c = /** @type {any} */ (globalThis.crypto);
    if (c && typeof c.randomUUID === "function") return c.randomUUID();

    const hex = "0123456789abcdef";
    let s = "";
    for (let i = 0; i < 36; i++)
    {
        if (i === 8 || i === 13 || i === 18 || i === 23) { s += "-"; continue; }
        if (i === 14) { s += "4"; continue; }
        const r = Math.floor(Math.random() * 16);
        if (i === 19) { s += hex[(r & 0x3) | 0x8]; continue; }
        s += hex[r];
    }
    return s;
}
