// @ts-check
/**
 * pkce.js — RFC 7636 PKCE helpers + CSRF nonce.
 *
 * Pure Web Crypto API — runs identically in Tauri WebView2 / WKWebView /
 * Chromium-on-Linux. Lifted near-verbatim from
 * extension-fountain-studio/adapters/fps-auth.js:171-189 so behaviour matches
 * Fountain+ Studio exactly (a shared `client_id` means Google's consent state
 * carries across products — diverging PKCE behaviour would double-prompt).
 */

/**
 * 64 random bytes → base64url, no padding. 86 chars (within RFC 7636 43-128).
 * @returns {string}
 */
export function generateCodeVerifier()
{
    const buf = new Uint8Array(64);
    crypto.getRandomValues(buf);
    const b64 = btoa(String.fromCharCode(...buf));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * SHA-256 of the verifier → base64url, no padding. Sent as
 * `code_challenge` with `code_challenge_method=S256`.
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export async function codeChallenge(verifier)
{
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 16 random bytes → hex string. Used for the OAuth `state` CSRF parameter.
 * Captured per-call (locally, not in a module slot) so a concurrent silent
 * refresh during an interactive flow cannot overwrite the expected value.
 * @returns {string}
 */
export function randomNonce()
{
    try
    {
        const buf = new Uint8Array(16);
        crypto.getRandomValues(buf);
        return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    catch (_)
    {
        return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
}
