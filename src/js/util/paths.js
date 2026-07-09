// @ts-check
/**
 * Path normalisation helpers shared by JS-side filesystem code.
 *
 * Why: the Rust↔JS boundary serialises `PathBuf` as a string with platform-
 * native separators (backslashes on Windows, forward slashes on Unix). JS
 * comparisons that don't normalise can silently drop legitimate matches
 * when one path was sourced via a route that flipped the separator.
 *
 * Convention: ALL functions here treat forward slash as canonical. Callers
 * pass native paths in; helpers normalise internally.
 *
 * Boot-time wiring: call `initPathHelpers({ platform })` once during app
 * boot with the value from the existing `app_platform` Tauri command
 * (see app.js — search for `app_platform` for the call site). Platform
 * values follow the convention used by user-settings: "windows" | "osx" |
 * "linux". This sets the host case-insensitivity flag used by
 * pathEqCaseless. Default before init is true (biases toward Windows /
 * macOS semantics — the case where mistreating two paths as different is
 * the worse failure).
 */

// Module-cached host case-insensitivity flag. See initPathHelpers above.
let __hostCaseInsensitive = true;

/**
 * Boot-time init. Call once with the result of the `app_platform` Tauri
 * command. Idempotent — calling again with a different value updates the
 * flag (useful for tests).
 *
 * @param {{ platform: "windows" | "osx" | "linux" | string }} opts
 */
export function initPathHelpers({ platform })
{
    __hostCaseInsensitive = platform === "windows" || platform === "osx";
}

/**
 * Convert all backslashes to forward slashes. Idempotent. Returns the
 * input verbatim if it's null/undefined/empty.
 *
 * @param {string | null | undefined} p
 * @returns {string}
 */
export function normalizePath(p)
{
    if (!p) return /** @type {string} */ (p ?? "");
    return String(p).replace(/\\/g, "/");
}

/**
 * True if `child` is `parent` OR a descendant of `parent`. Both inputs are
 * normalised to forward slashes before comparison. Guards against the
 * sibling-prefix false-positive ("/a/b" is NOT a parent of "/a/bc").
 *
 * @param {string | null | undefined} child
 * @param {string | null | undefined} parent
 * @returns {boolean}
 */
export function pathIsDescendant(child, parent)
{
    if (!child || !parent) return false;
    const c = normalizePath(child);
    const p = normalizePath(parent);
    if (c === p) return true;
    return c.startsWith(p + "/");
}

/**
 * Convert an absolute file path under `projectRoot` into the project-
 * relative forward-slash form that matches Rust's scriptMap / artMap /
 * session.json key convention (e.g. `"Chapter1/BETRAY.fountain.md"`).
 *
 * When `absPath` isn't under `projectRoot` (unusual — usually a symptom of
 * a caller passing a stale path), falls back to the basename so downstream
 * lookups still resolve SOMETHING rather than throwing. Callers that need
 * strict behaviour should check the return value for a `/` before use.
 *
 * @param {string | null | undefined} projectRoot
 * @param {string | null | undefined} absPath
 * @returns {string}
 */
export function scriptRelPathOf(projectRoot, absPath)
{
    if (!absPath) return "";
    const abs = normalizePath(absPath);
    if (!projectRoot) return abs.slice(abs.lastIndexOf("/") + 1);
    const root = normalizePath(projectRoot).replace(/\/+$/, "");
    if (abs === root) return "";
    if (abs.startsWith(root + "/")) return abs.slice(root.length + 1);
    // Host-case-insensitive fallback (Windows/macOS): a mixed-case root
    // shouldn't defeat the prefix test.
    if (__hostCaseInsensitive)
    {
        const rootLower = root.toLowerCase();
        const absLower = abs.toLowerCase();
        if (absLower.startsWith(rootLower + "/")) return abs.slice(root.length + 1);
    }
    return abs.slice(abs.lastIndexOf("/") + 1);
}

/**
 * Path-equality with host-aware case-sensitivity. On Windows/macOS the
 * comparison is case-insensitive; on Linux it's case-sensitive. Both
 * inputs are separator-normalised first.
 *
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {boolean}
 */
export function pathEqCaseless(a, b)
{
    if (!a || !b) return a === b;
    const na = normalizePath(a);
    const nb = normalizePath(b);
    if (na === nb) return true;
    if (!__hostCaseInsensitive) return false;
    return na.toLowerCase() === nb.toLowerCase();
}
