// @ts-check
/**
 * slides-prepare.js — orchestrator for the "Sync Existing Slides" preparation
 * pass.
 *
 * Consumes a already-fetched `presentations.get` payload plus the local
 * `.mangaplay` ScriptAST, scans the deck, matches its pages against the
 * script, and downloads / caches any missing images into the project's
 * per-presentation deck-image dir via the `slides_deck_*` Tauri commands.
 *
 * Pure orchestration — NO DOM, NO modal-specific logic. Returns a
 * `PrepareReport` (see `render-preference.js` for shape contract).
 *
 * The exported `_invoke` binding defaults to `@tauri-apps/api/core`'s real
 * `invoke` but can be swapped in tests via `_setInvokeForTest`.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { crc32OfString, scanSlidePages } from "../../../../core/util/slides-scan.js";
import {
    getPresentationForRefresh,
    isPresentationStale,
} from "./slides-api.js";
// Phase-B download / upload orchestration lives in slides-prepare-download.js
// and is re-exported below so this file stays the public entry point (its
// co-located test imports these four names from here).
import {
    commitSlidesSync,
    commitLocalUpload,
    verifyDeckText,
    runCommit,
} from "./slides-prepare-download.js";
export { commitSlidesSync, commitLocalUpload, verifyDeckText, runCommit };

// ── Test seam for the image-fetch call ────────────────────────────────────
//
// Production path: the Rust `slides_image_fetch` command (see
// `src-tauri/src/commands/slides_image_fetch.rs`) — a shared `reqwest`
// client with keep-alive, gzip, HTTP/2, per-request 60s timeout, and
// truncated-exponential backoff on 429/5xx. Replaces the previous
// `@tauri-apps/plugin-http` fetch path, which suffered from a
// resource-id race in `dropBody()` under our 4-way / 30s regime.
//
// Test seam: `_setFetchForTest(fn)` intercepts the call. When set, the
// stub is called with `(url, init)` and MUST return a Response-like
// object (`{ status, arrayBuffer() }`). Existing tests already stub this
// way. When null, the Rust command owns the download.
/** @type {((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null} */
let _imageFetch = null;

/**
 * @param {((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null} fn
 */
export function _setFetchForTest(fn)
{
    _imageFetch = fn || null;
}

/**
 * Read the current image-fetch seam. The download orchestrator in
 * slides-prepare-download.js reads this fresh on every call so
 * `_setFetchForTest` mutations land on the same binding both sides share.
 * @returns {((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null}
 */
export function _getFetchForTest()
{
    return _imageFetch;
}

// ── Test seam for Tauri `invoke` ─────────────────────────────────────────

/** @type {(cmd: string, args?: Record<string, unknown>) => Promise<any>} */
let _invoke = /** @type {any} */ (tauriInvoke);

/**
 * Swap the Tauri `invoke` binding for tests. Restore by passing `null` /
 * the real `tauriInvoke`.
 *
 * @param {((cmd: string, args?: Record<string, unknown>) => Promise<any>) | null} fn
 */
export function _setInvokeForTest(fn)
{
    _invoke = fn || /** @type {any} */ (tauriInvoke);
}

/**
 * Read the current `invoke` binding — exported for symmetry with the setter.
 * @returns {(cmd: string, args?: Record<string, unknown>) => Promise<any>}
 */
export function _getInvokeForTest()
{
    return _invoke;
}

// ── Upload feature flag ──────────────────────────────────────────────────
//
// Mirrors the `renderGroupsAsOne` pattern in `aggregate-view.js`: an
// export const that ships as `false` and gets flipped to `true` once the
// full upload path (progress UI, smoke, integration tests) passes.
//
// When `false`, the "Use Local Version" branch in `publish-slides-modal.js`
// surfaces a "not yet available" caption and no-ops. The stub Rust command
// `slides_upload_images` also returns `not-implemented` until a follow-up
// plan adds the HTTP client dep.
export const uploadEnabled = true;

/** @returns {boolean} */
export function isUploadEnabled()
{
    return uploadEnabled;
}

// ── Types (JSDoc) ────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   kind: "PARSE_ERROR" | "DUPLICATE" | "NO_IMAGE_ON_SLIDE"
 *       | "URL_EXPIRED"  | "DOWNLOAD_FAILED" | "NO_DECK_HEADER_TEXT"
 *       | "VERIFY_FAILED",
 *   pageId?: string,
 *   slideIndex?: number,
 *   message: string,
 * }} PrepareWarning
 */

/**
 * @typedef {{
 *   presentationTitle: string,
 *   presentationId:    string,
 *   deckPages:         string[],
 *   localPages:        string[],
 *   imagesFound:       number,
 *   imagesCached:      number,
 *   imagesToDownload:  number,
 *   imagesDownloaded:  number,
 *   imagesFailed:      number,
 *   toDownload:        Array<{ pageId: string, slidePageFullId: string }>,
 *   warnings:          PrepareWarning[],
 *   mismatch:          null | { pairedDifferent: string[], localOnly: string[], deckOutOfScope: string[] },
 *   aborted?: { reason: "EMPTY_DECK"|"FETCH_FAILED"|"LOCK_HELD"|"AUTH", detail: string },
 * }} PrepareReport
 */

// ── Local page-id extraction ─────────────────────────────────────────────

/**
 * Build a fullId string matching the shape produced by
 * `parsePageHeader` in `core/util/slides-scan.js`:
 *
 *   - plain page  → `String(baseNumber)`         (e.g. `"1"`, `"17"`)
 *   - sub-page    → `${baseNumber}-${sub}`        (numeric suffix, e.g. `"10-2"`)
 *   - cover       → `${baseNumber}-COVER`         (`"1-COVER"`)
 *   - appendix    → `${baseNumber}-${roman}`      (roman upper, e.g. `"1-II"`)
 *
 * The scan side always emits COVER + roman uppercase, so any suffix from the
 * local AST is upper-cased for consistent matching.
 *
 * @param {number} baseNumber
 * @param {string} suffix
 * @returns {string | null}
 */
function buildLocalFullId(baseNumber, suffix)
{
    if (typeof baseNumber !== "number" || !Number.isFinite(baseNumber)) return null;
    const s = (typeof suffix === "string" ? suffix : "").trim();
    if (!s) return String(baseNumber);
    return `${baseNumber}-${s.toUpperCase()}`;
}

/**
 * Walk a ScriptAST from `parseScript()` and produce the ordered list of page
 * fullIds. The AST shape is `{ pages: Array<{ baseNumber, suffix?, ... }> }`
 * — see `Fountain-Plus/Storyboard/core/parser/fountain-plus-mangaplay-parser.js`
 * where pages are pushed with a `baseNumber` (integer) and optional string
 * `suffix`.
 *
 * Pages without a parseable baseNumber are skipped silently — the parser only
 * emits page nodes for lines that actually matched `# Page N`.
 *
 * @param {any} script — output of `parseScript()`
 * @returns {string[]}
 */
export function extractLocalPageIds(script)
{
    if (!script || !Array.isArray(script.pages)) return [];
    /** @type {string[]} */
    const out = [];
    for (const page of script.pages)
    {
        if (!page) continue;
        const id = buildLocalFullId(page.baseNumber, page.suffix || "");
        if (id) out.push(id);
    }
    return out;
}

/**
 * Walk a ScriptAST and produce a Map of fullId → raw source slice for each
 * page. The parser attaches `page.rawText` at parse time; this is a thin
 * shim so `prepareSlidesSync` can pair rawText onto matched pages for the
 * text-diff pass.
 *
 * Pages missing `rawText` (older parser output, defensively) map to an
 * empty string.
 *
 * @param {any} script — output of `parseScript()`
 * @returns {Map<string, string>}
 */
export function extractLocalPageContents(script)
{
    /** @type {Map<string, string>} */
    const out = new Map();
    if (!script || !Array.isArray(script.pages)) return out;
    for (const page of script.pages)
    {
        if (!page) continue;
        const id = buildLocalFullId(page.baseNumber, page.suffix || "");
        if (!id) continue;
        // Pages without rawText (legacy parser output, unit-test fixtures)
        // are skipped — the matcher treats "not in map" as "no local text
        // to compare" and won't force pairedDifferent. Once the parser is
        // universally attaching rawText this branch is dead.
        if (typeof page.rawText !== "string") continue;
        out.set(id, page.rawText);
    }
    return out;
}

/**
 * CRC-32 hex of a page body text. Normalises CRLF → LF before hashing so
 * files edited on Windows and files edited on Unix hash identically. Case,
 * whitespace, tabs are all significant.
 *
 * Empty / nullish input hashes to `"00000000"` — sentinel used by the diff
 * pass to detect "deck side never had text written".
 *
 * @param {string | null | undefined} rawText
 * @returns {string}
 */
export function computePageTextCrc(rawText)
{
    if (!rawText) return "00000000";
    const normalised = rawText.replace(/\r\n/g, "\n");
    return crc32OfString(normalised);
}

/**
 * Is the deck-side header shape empty of body text — i.e. only the
 * `# PAGE N` header line survives? Used to trigger a NO_DECK_HEADER_TEXT
 * warning and force the page into pairedDifferent.
 *
 * @param {string} headerText
 * @returns {boolean}
 */
function isDeckHeaderOnly(headerText)
{
    if (!headerText) return true;
    const trimmed = headerText.replace(/\r\n/g, "\n").trim();
    if (!trimmed) return true;
    // Split into non-blank lines. If only the `# PAGE …` line remains, treat
    // as header-only.
    const nonBlank = trimmed.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (nonBlank.length === 0) return true;
    if (nonBlank.length === 1 && /^# PAGE\s/i.test(nonBlank[0])) return true;
    return false;
}

// ── Match local vs deck ──────────────────────────────────────────────────

/**
 * @typedef {{
 *   paired:          Array<{ localPageId: string, slidePage: any }>,
 *   pairedDifferent: string[],
 *   localOnly:       string[],
 *   deckOutOfScope:  string[],
 *   warnings:        PrepareWarning[],
 * }} MatchResult
 */

/**
 * Pair local page fullIds against scanned slide pages by exact fullId
 * equality. Order of `paired` follows the local list; `localOnly` /
 * `deckOutOfScope` preserve source order.
 *
 * Four buckets:
 *  - `paired` — full match.
 *  - `pairedDifferent` — paired by id, but local `rawText` CRC ≠ deck header
 *    shape text CRC. Populated when `localContentByFullId` is supplied.
 *    Image-diff is deferred — there is no local image upload path yet, so
 *    there's nothing to CRC on the local side.
 *  - `localOnly` — in script, not in deck.
 *  - `deckOutOfScope` — in deck, not in script (informational, NOT a mismatch).
 *
 * When the deck-side header shape has no body text past the `# PAGE N`
 * header line, the page is forced into `pairedDifferent` AND a
 * `NO_DECK_HEADER_TEXT` warning is pushed into `warnings`.
 *
 * @param {string[]} localPageIds
 * @param {Array<{ fullId: string, [k: string]: any }>} slidePages
 * @param {Map<string, string>} [localContentByFullId] — optional; when
 *   supplied, populates `pairedDifferent` via text-CRC compare.
 * @returns {MatchResult}
 */
export function matchScriptToSlides(localPageIds, slidePages, localContentByFullId)
{
    /** @type {Map<string, any>} */
    const deckMap = new Map();
    for (const sp of slidePages) deckMap.set(sp.fullId, sp);

    const localSet = new Set(localPageIds);

    /** @type {Array<{ localPageId: string, slidePage: any }>} */
    const paired = [];
    /** @type {string[]} */
    const localOnly = [];
    for (const id of localPageIds)
    {
        const sp = deckMap.get(id);
        if (sp) paired.push({ localPageId: id, slidePage: sp });
        else localOnly.push(id);
    }
    /** @type {string[]} */
    const deckOutOfScope = [];
    for (const sp of slidePages)
    {
        if (!localSet.has(sp.fullId)) deckOutOfScope.push(sp.fullId);
    }

    /** @type {string[]} */
    const pairedDifferent = [];
    /** @type {PrepareWarning[]} */
    const warnings = [];
    if (localContentByFullId instanceof Map)
    {
        for (const entry of paired)
        {
            const { localPageId, slidePage } = entry;
            // Only diff when the local side has a rawText slice. Callers
            // that don't want text-diff pass an empty map (or omit the
            // arg); fixtures / legacy paths that didn't record rawText
            // don't accidentally trigger reconciliation.
            if (!localContentByFullId.has(localPageId)) continue;
            const localText = localContentByFullId.get(localPageId) || "";
            const deckText = typeof slidePage?.headerText === "string" ? slidePage.headerText : "";
            if (isDeckHeaderOnly(deckText))
            {
                warnings.push({
                    kind: "NO_DECK_HEADER_TEXT",
                    pageId: localPageId,
                    slideIndex: slidePage?.slideIndex,
                    message: `Page ${localPageId} has no body text on the slide — treated as differing from local.`,
                });
                pairedDifferent.push(localPageId);
                continue;
            }
            const localCrc = computePageTextCrc(localText);
            const deckCrc = computePageTextCrc(deckText);
            if (localCrc !== deckCrc) pairedDifferent.push(localPageId);
        }
    }

    return { paired, pairedDifferent, localOnly, deckOutOfScope, warnings };
}

// ── Empty-report helpers ─────────────────────────────────────────────────

/**
 * Build a zeroed PrepareReport shell. Callers overlay their own fields on
 * top before returning.
 *
 * @param {string} presentationId
 * @param {string} presentationTitle
 * @returns {PrepareReport}
 */
function emptyReport(presentationId, presentationTitle)
{
    return {
        presentationTitle,
        presentationId,
        deckPages: [],
        localPages: [],
        imagesFound: 0,
        imagesCached: 0,
        imagesToDownload: 0,
        imagesDownloaded: 0,
        imagesFailed: 0,
        toDownload: [],
        warnings: [],
        mismatch: null,
    };
}

// ── Main entry ───────────────────────────────────────────────────────────

/**
 * Prepare a Google Slides deck for future sync against a local `.mangaplay`
 * script.
 *
 * Pure orchestrator — no DOM, no modal chrome. `contentUrl` expiry policy:
 * treat URLs as potentially expired after 30 min; refresh on 403.
 *
 * @param {{
 *   presentation:   any,
 *   refreshedAt:    number,
 *   presentationId: string,
 *   script:         any,
 *   projectPath:    string,
 *   authClient:     { getAccessToken(opts?: { allowRefresh?: boolean }): Promise<string|null> },
 *   onProgress?:    (progress: { phase: string, current?: number, total?: number, message?: string }) => void,
 * }} opts
 * @returns {Promise<PrepareReport>}
 */
export async function prepareSlidesSync(opts)
{
    const {
        presentationId,
        script,
        projectPath,
        authClient,
        onProgress,
    } = opts;

    let presentation = opts.presentation;
    let refreshedAt = opts.refreshedAt;

    const initialTitle = String((presentation && presentation.title) || "");

    // ── 1. Empty-deck guard ─────────────────────────────────────────────
    if (!presentation
        || !Array.isArray(presentation.slides)
        || presentation.slides.length === 0)
    {
        const rep = emptyReport(presentationId, initialTitle);
        rep.aborted = {
            reason: "EMPTY_DECK",
            detail: "The presentation has no slides.",
        };
        return rep;
    }

    // ── 2. Staleness refresh ────────────────────────────────────────────
    if (isPresentationStale(refreshedAt))
    {
        onProgress?.({ phase: "refreshing", message: "Refreshing presentation…" });
        let token = null;
        try
        {
            token = await authClient.getAccessToken({ allowRefresh: true });
        }
        catch (e)
        {
            const detail = e instanceof Error ? e.message : String(e);
            const rep = emptyReport(presentationId, initialTitle);
            rep.aborted = { reason: "AUTH", detail };
            return rep;
        }
        if (!token)
        {
            const rep = emptyReport(presentationId, initialTitle);
            rep.aborted = { reason: "AUTH", detail: "no-token" };
            return rep;
        }
        try
        {
            const refreshed = await getPresentationForRefresh(presentationId, token);
            presentation = refreshed.presentation;
            refreshedAt = refreshed.refreshedAt;
        }
        catch (e)
        {
            const kind = (e && typeof e === "object")
                ? /** @type {any} */ (e).kind
                : undefined;
            const detail = e instanceof Error ? e.message : String(e);
            const rep = emptyReport(presentationId, initialTitle);
            if (kind === "auth") rep.aborted = { reason: "AUTH", detail };
            else if (kind === "network" || kind === "http")
            {
                rep.aborted = { reason: "FETCH_FAILED", detail };
            }
            else
            {
                // no-access / not-found also mean we can't proceed — surface
                // as FETCH_FAILED so the modal keeps the user on the input
                // panel with a generic "couldn't reach" message.
                rep.aborted = { reason: "FETCH_FAILED", detail };
            }
            return rep;
        }
    }

    const presentationTitle = String((presentation && presentation.title) || "");

    // ── 3. Scan the deck ────────────────────────────────────────────────
    onProgress?.({ phase: "scanning", message: "Scanning slides…" });
    /** @type {{ pages: any[], errors: any[] }} */
    let scan = scanSlidePages(presentation);
    const report = emptyReport(presentationId, presentationTitle);
    report.deckPages = scan.pages.map((p) => p.fullId);
    for (const err of scan.errors)
    {
        /** @type {PrepareWarning["kind"]} */
        const kind = (err.type === "DUPLICATE") ? "DUPLICATE" : "PARSE_ERROR";
        report.warnings.push({
            kind,
            slideIndex: err.slideIndex,
            message: String(err.message || ""),
        });
    }

    // ── 4. Local page ids ───────────────────────────────────────────────
    const localPageIds = extractLocalPageIds(script);
    const localContentByFullId = extractLocalPageContents(script);
    report.localPages = localPageIds;

    // ── 5. Match ────────────────────────────────────────────────────────
    // `pairedDifferent` is populated by text-diff (CRC of local `rawText`
    // vs CRC of deck header-shape text, computed fresh on both sides —
    // no stored CRC). Image-diff is deferred until an image upload path
    // lands in mangaplay-studio; today `commitSlidesSync` only downloads
    // images and there's nothing to CRC on the local side.
    const match = matchScriptToSlides(localPageIds, scan.pages, localContentByFullId);
    for (const w of match.warnings) report.warnings.push(w);

    // ── 6. Mismatch ─────────────────────────────────────────────────────
    // Emit the mismatch bucket whenever ANY of the three sub-buckets are
    // non-empty. Summary UI treats `pairedDifferent + localOnly` as the
    // real mismatch count and `deckOutOfScope` as an informational line.
    if (match.pairedDifferent.length > 0
        || match.localOnly.length > 0
        || match.deckOutOfScope.length > 0)
    {
        report.mismatch = {
            pairedDifferent: match.pairedDifferent,
            localOnly:       match.localOnly,
            deckOutOfScope:  match.deckOutOfScope,
        };
    }

    // ── 7. Stat cache ──────────────────────────────────────────────────
    /** @type {{ manifest: Record<string, { crc: string, path: string }>, orphanPaths: string[], cacheDirExists: boolean }} */
    let stat;
    try
    {
        stat = await _invoke("slides_deck_stat", {
            projectPath,
            presentationId,
        });
    }
    catch (e)
    {
        // Fatal — we can't reason about the cache. Bail out but preserve the
        // scan / match data we already have.
        const detail = e instanceof Error ? e.message : String(e);
        report.aborted = { reason: "LOCK_HELD", detail };
        return report;
    }
    const manifest = stat && stat.manifest ? stat.manifest : {};

    // ── 8. Plan downloads (Phase A — read-only) ────────────────────────
    for (const entry of match.paired)
    {
        const { localPageId, slidePage } = entry;
        if (!slidePage.image)
        {
            report.warnings.push({
                kind: "NO_IMAGE_ON_SLIDE",
                pageId: localPageId,
                slideIndex: slidePage.slideIndex,
                message: `Page ${localPageId} has no image on the slide`,
            });
            continue;
        }
        report.imagesFound++;
        const cached = manifest[localPageId];
        // Trust the local cache when we've ever downloaded this pageId.
        // The deck-side `storedCrc` alt-text stamp isn't populated by any
        // production writer today, so the strict `cached.crc === storedCrc`
        // check never fires and forced a full re-download every sync.
        // Force-refresh is a future summary-panel action, not this hot path.
        if (cached)
        {
            report.imagesCached++;
            continue;
        }
        report.toDownload.push({
            pageId: localPageId,
            slidePageFullId: slidePage.fullId,
        });
    }
    report.imagesToDownload = report.toDownload.length;

    return report;
}
