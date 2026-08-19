// @ts-check
/**
 * skins.js — runtime skin registry + live swap.
 *
 * Replaces the previous `theme.js` module. Ships the two first-party
 * skins statically-imported from JSON, exposes a registry API that the
 * future marketplace (`user-skins/<id>/skin.json`) can extend via
 * `registerSkin(manifest)`, and swaps every skin-owned DOM surface
 * (active-skin <link>, mascot / splash <img> src+srcset) on demand.
 *
 * Called by:
 *  - boot, with settings.skin, BEFORE the chrome unhides (FOUC fix).
 *  - the settings modal's Skin dropdown, on change.
 *  - the inline boot stamper in index.html (pre-paint, from
 *    window.__MPS_LAST_SKIN__).
 */

import defaultManifest from "../../default-skins/default/skin.json";
import nightManifest from "../../default-skins/night/skin.json";
import oragepadManifest from "../../default-skins/oragepad/skin.json";
import cyberpunkManifest from "../../default-skins/cyberpunk/skin.json";
import academiaManifest from "../../default-skins/academia/skin.json";

/**
 * @typedef {Object} SkinManifest
 * @property {string} id
 * @property {string} displayName
 * @property {string} author
 * @property {string} version
 * @property {"light"|"dark"} baseVariant
 * @property {string} cssFile
 * @property {string} [mainMascotFile]
 * @property {string} mascotHeadFile
 * @property {string} mascotBodyFile
 * @property {string} splashFile
 * @property {string} [splashFile2x]
 * @property {string} minAppVersion
 * @property {string} [license]
 */

/** Base URL each first-party skin bundle resolves against in the built app. */
const FIRST_PARTY_BASE = "./default-skins/";

/**
 * Registry entry. Combines the manifest with a resolved base URL so
 * marketplace-installed skins (served from a user-data path) can register
 * without hardcoding the FIRST_PARTY_BASE.
 * @typedef {Object} SkinEntry
 * @property {SkinManifest} manifest
 * @property {string} baseUrl
 */

/** @type {Map<string, SkinEntry>} */
const registry = new Map();

/** Mascot / splash <img> elements the shell registers for live swap. */
const skinnedImages = new Set();

/**
 * Validate a manifest — synchronous schema check. Runs on first-party
 * skins in-tree so drift is caught before it ships. Returns an array of
 * error strings (empty on success). Never throws.
 * @param {any} m
 * @returns {string[]}
 */
export function validateManifest(m)
{
    const errs = [];
    if (!m || typeof m !== "object")
    {
        errs.push("manifest must be an object");
        return errs;
    }
    const required = ["id", "displayName", "author", "version", "baseVariant", "cssFile", "mascotHeadFile", "mascotBodyFile", "splashFile", "minAppVersion"];
    for (const key of required)
    {
        if (typeof m[key] !== "string" || m[key].length === 0)
        {
            errs.push(`missing or empty string field: ${key}`);
        }
    }
    if (typeof m.id === "string")
    {
        if (m.id.length > 64) errs.push("id exceeds 64 chars");
        if (!/^[a-z0-9][a-z0-9-]*$/.test(m.id)) errs.push("id must be lowercase alphanumeric + dashes, starting with alphanumeric");
    }
    if (typeof m.displayName === "string" && m.displayName.length > 64)
    {
        errs.push("displayName exceeds 64 chars");
    }
    if (m.baseVariant !== "light" && m.baseVariant !== "dark")
    {
        errs.push("baseVariant must be 'light' or 'dark'");
    }
    if (typeof m.version === "string" && !/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(m.version))
    {
        errs.push("version must be semver (e.g. 1.0.0)");
    }
    if (typeof m.minAppVersion === "string" && !/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(m.minAppVersion))
    {
        errs.push("minAppVersion must be semver (e.g. 0.0.0)");
    }
    // Path-traversal guard + forbidden extensions.
    const FORBIDDEN = /\.(js|html|wasm)$/i;
    for (const key of ["cssFile", "mainMascotFile", "mascotHeadFile", "mascotBodyFile", "splashFile", "splashFile2x"])
    {
        const v = m[key];
        if (typeof v !== "string" || v.length === 0) continue;
        if (v.includes("..") || v.includes("\\") || v.startsWith("/"))
        {
            errs.push(`${key} must be a relative path inside the skin folder`);
        }
        if (FORBIDDEN.test(v))
        {
            errs.push(`${key} has forbidden extension (${v}). Skin bundles are CSS+JSON+PNG only.`);
        }
    }
    if (typeof m.cssFile === "string" && !/\.css$/i.test(m.cssFile))
    {
        errs.push("cssFile must end in .css");
    }
    for (const key of ["mainMascotFile", "mascotHeadFile", "mascotBodyFile", "splashFile", "splashFile2x"])
    {
        const v = m[key];
        if (typeof v !== "string" || v.length === 0) continue;
        if (!/\.(png|webp|jpe?g)$/i.test(v))
        {
            errs.push(`${key} must be a PNG/WEBP/JPEG image`);
        }
    }
    return errs;
}

/**
 * Register a skin. Throws if `validateManifest` fails or the id is
 * already present. First-party skins register on module load below;
 * marketplace-installed skins call this at runtime after fetching their
 * `skin.json`.
 * @param {SkinManifest} manifest
 * @param {string} [baseUrl] Defaults to the first-party base.
 */
export function registerSkin(manifest, baseUrl = FIRST_PARTY_BASE + manifest.id + "/")
{
    const errs = validateManifest(manifest);
    if (errs.length > 0)
    {
        throw new Error(`invalid skin manifest for '${manifest && manifest.id}': ${errs.join("; ")}`);
    }
    if (registry.has(manifest.id))
    {
        throw new Error(`skin id already registered: ${manifest.id}`);
    }
    registry.set(manifest.id, { manifest, baseUrl });
}

/**
 * Return the registry entry for `id`, or the Default entry when `id`
 * doesn't resolve. Callers that need to know whether the requested id
 * existed should check the returned entry's manifest id against their
 * input.
 * @param {string} id
 * @returns {SkinEntry}
 */
export function getSkin(id)
{
    const hit = registry.get(id);
    if (hit) return hit;
    return /** @type {SkinEntry} */ (registry.get("default"));
}

/** @returns {SkinManifest[]} All registered manifests, insertion order. */
export function listSkins()
{
    return Array.from(registry.values()).map((e) => e.manifest);
}

/**
 * Register a mascot/splash <img> element so `applySkin()` can rewrite
 * its src/srcset when the skin changes. Idempotent — registering the
 * same element twice is a no-op.
 * @param {HTMLImageElement} img
 * @param {"mascotHead"|"mascotBody"|"splash"} kind
 */
export function registerSkinnedImage(img, kind)
{
    // Duck-typed IMG check — `instanceof HTMLImageElement` fails in test
    // environments (bun happy-dom, jsdom without HTMLImageElement global).
    if (!img || typeof img !== "object" || img.tagName !== "IMG") return;
    if (img.dataset) img.dataset.skinnedKind = kind;
    skinnedImages.add(img);
}

/** Drop dead <img> references (elements no longer connected to the doc). */
function pruneSkinnedImages()
{
    for (const img of skinnedImages)
    {
        if (!img.isConnected) skinnedImages.delete(img);
    }
}

/**
 * Resolve the URL to a skin's mascot / splash / splash@2x / css.
 * @param {SkinEntry} entry
 * @param {"cssFile"|"mascotHeadFile"|"mascotBodyFile"|"splashFile"|"splashFile2x"} key
 * @returns {string|null}
 */
function skinAssetUrl(entry, key)
{
    const file = entry.manifest[key];
    if (typeof file !== "string" || file.length === 0) return null;
    return entry.baseUrl + file;
}

/**
 * Apply the named skin. Sets `<html data-skin>`, toggles the
 * `.skin-default` class (matches the website's prefers-color-scheme
 * guard), swaps `<link id="active-skin">`, and
 * rewrites every registered mascot/splash <img>.
 * @param {string} id
 */
export function applySkin(id)
{
    const entry = getSkin(id);
    const target = entry.manifest.id;
    const html = document.documentElement;
    html.setAttribute("data-skin", target);
    // Toggle .skin-default on <html> so the website's
    // @media (prefers-color-scheme: dark) { :root:not(.skin-default) { ... } }
    // guard defers to the app's explicit skin choice. Without this,
    // macOS system dark mode overrides the Default skin's CSS variables.
    // Named `.skin-default` to match the skin naming convention.
    html.classList.toggle("skin-default", target === "default");

    // <link> href swap.
    const link = document.getElementById("active-skin");
    if (link && link.tagName === "LINK")
    {
        const wanted = skinAssetUrl(entry, "cssFile");
        if (wanted && link.getAttribute("href") !== wanted)
        {
            link.setAttribute("href", wanted);
        }
    }

    // Mascot / splash swap on every registered <img>.
    pruneSkinnedImages();
    const mainMascotUrl = skinAssetUrl(entry, "mainMascotFile");
    const mascotHeadUrl = skinAssetUrl(entry, "mascotHeadFile");
    const mascotBodyUrl = skinAssetUrl(entry, "mascotBodyFile");
    const splashUrl = skinAssetUrl(entry, "splashFile");
    const splash2xUrl = skinAssetUrl(entry, "splashFile2x");
    for (const img of skinnedImages)
    {
        const kind = img.dataset.skinnedKind;
        if (kind === "mainMascot" && mainMascotUrl)
        {
            if (img.getAttribute("src") !== mainMascotUrl) img.setAttribute("src", mainMascotUrl);
            if (img.hasAttribute("srcset")) img.removeAttribute("srcset");
        }
        else if (kind === "mascotHead" && mascotHeadUrl)
        {
            if (img.getAttribute("src") !== mascotHeadUrl) img.setAttribute("src", mascotHeadUrl);
            if (img.hasAttribute("srcset")) img.removeAttribute("srcset");
        }
        else if (kind === "mascotBody" && mascotBodyUrl)
        {
            if (img.getAttribute("src") !== mascotBodyUrl) img.setAttribute("src", mascotBodyUrl);
            if (img.hasAttribute("srcset")) img.removeAttribute("srcset");
        }
        else if (kind === "splash" && splashUrl)
        {
            if (img.getAttribute("src") !== splashUrl) img.setAttribute("src", splashUrl);
            if (splash2xUrl)
            {
                const srcset = `${splashUrl} 1x, ${splash2xUrl} 2x`;
                if (img.getAttribute("srcset") !== srcset) img.setAttribute("srcset", srcset);
            }
        }
    }

    // Notify observers (currently the aggregate view's height-cache
    // generation bumper) that the skin changed. CM6 line-height + gutter
    // metrics vary per skin so cached placeholder heights are stale until
    // the next mount re-measures. Pre-body invocations (early boot) are
    // suppressed because no listener can attach before DOM ready anyway.
    if (typeof window !== "undefined" && document.body)
    {
        try
        {
            window.dispatchEvent(new CustomEvent("mps:skin-change", {
                detail: { id: target }
            }));
        }
        catch (_) { /* non-fatal */ }
    }

    // macOS: sync the native title-bar chrome to the skin's baseVariant
    // so the traffic-light bar matches the editor surface.
    try
    {
        const variant = entry.manifest.baseVariant || "light";
        import("@tauri-apps/api/core").then(({ invoke }) =>
        {
            invoke("set_window_theme", { variant }).catch(() => {});
        }).catch(() => {});
    }
    catch (_) { /* non-fatal — website / non-Tauri context */ }
}

/** Current active skin id (reads `<html data-skin>` — falls back to default). */
export function getCurrentSkinId()
{
    return document.documentElement.getAttribute("data-skin") || "default";
}

// ── First-party registration on module load ────────────────────────────
// validateManifest runs on both so drift is caught in-tree.
registerSkin(/** @type {SkinManifest} */ (defaultManifest));
registerSkin(/** @type {SkinManifest} */ (nightManifest));
// Premium skins resolve from their own id-folder (default baseUrl). Each folder
// is self-contained: its own <id>.css palette plus the default-named mascot/
// splash PNGs (copied in). Registering against the "default/" folder was the
// old stub — it 404'd every premium <id>.css (they don't live in default/),
// leaving the window unstyled ("transparent") when selected.
registerSkin(/** @type {SkinManifest} */ (oragepadManifest));
registerSkin(/** @type {SkinManifest} */ (cyberpunkManifest));
registerSkin(/** @type {SkinManifest} */ (academiaManifest));
