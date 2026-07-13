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
 * `PrepareReport` shaped exactly per `TODO/sync-existing-slides-prepare.md`
 * "Report shape" section.
 *
 * The exported `_invoke` binding defaults to `@tauri-apps/api/core`'s real
 * `invoke` but can be swapped in tests via `_setInvokeForTest`.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { crc32Hex, crc32OfString, scanSlidePages } from "../../../../core/util/slides-scan.js";
import {
    batchUpdatePresentation,
    getPresentation,
    getPresentationForRefresh,
    isPresentationStale,
} from "./slides-api.js";

// ── Test seam for the image-fetch call ────────────────────────────────────
//
// Production: uses `@tauri-apps/plugin-http`'s server-side fetch, which
// bypasses WebView CORS/CSP so Google's Slides CDN
// (`lh7-rt.googleusercontent.com`) responds with plain bytes. Tests swap
// this out with a stub via `_setFetchForTest` so no network hits during
// `bun run test`.
/** @type {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} */
let _imageFetch = /** @type {any} */ (tauriFetch);

/**
 * @param {((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null} fn
 */
export function _setFetchForTest(fn)
{
    _imageFetch = fn || /** @type {any} */ (tauriFetch);
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

// ── Concurrency + timing ─────────────────────────────────────────────────

const DOWNLOAD_CONCURRENCY = 4;
const DOWNLOAD_TIMEOUT_MS = 30_000;

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

// ── Concurrency helper (bounded fan-out) ─────────────────────────────────

/**
 * Run `worker(item)` over each item with at most `limit` in flight. Errors
 * are surfaced to the individual `worker` — this helper doesn't catch. Order
 * of completion is intentionally not preserved.
 *
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<void>} worker
 * @returns {Promise<void>}
 */
async function runWithConcurrency(items, limit, worker)
{
    let cursor = 0;
    const n = items.length;
    const runners = new Array(Math.min(limit, n)).fill(0).map(async () =>
    {
        while (true)
        {
            const i = cursor++;
            if (i >= n) return;
            await worker(items[i], i);
        }
    });
    await Promise.all(runners);
}

// ── Main entry ───────────────────────────────────────────────────────────

/**
 * Prepare a Google Slides deck for future sync against a local `.mangaplay`
 * script.
 *
 * See `TODO/sync-existing-slides-prepare.md` for the full algorithm,
 * `contentUrl` expiry policy, and mismatch policy. This function is a pure
 * orchestrator — no DOM, no modal chrome.
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
        const storedCrc = slidePage.image.storedCrc;
        if (cached && storedCrc && cached.crc === storedCrc)
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

/**
 * Phase B — commit the plan produced by `prepareSlidesSync`. Runs the actual
 * image downloads and cache GC. Mutates the passed report in place with
 * `imagesDownloaded`, `imagesFailed`, and any DOWNLOAD_FAILED / URL_EXPIRED
 * warnings.
 *
 * Idempotent-ish — safe to re-run if callers hand it the same report and
 * presentation; already-cached entries are skipped in Phase A so this loop
 * only touches items the manifest didn't cover.
 *
 * @param {{
 *   report:         PrepareReport,
 *   presentation:   any,
 *   presentationId: string,
 *   projectPath:    string,
 *   authClient:     { getAccessToken(opts?: { allowRefresh?: boolean }): Promise<string|null> },
 *   onProgress?:    (progress: { phase: string, current?: number, total?: number, message?: string }) => void,
 * }} opts
 * @returns {Promise<PrepareReport>}
 */
export async function commitSlidesSync(opts)
{
    const {
        report,
        presentationId,
        projectPath,
        authClient,
        onProgress,
    } = opts;

    let presentation = opts.presentation;

    // Rebuild the pageId → slidePage map from the current presentation. Phase A
    // stored just the fullId in the plan so we could keep the report JSON-clean.
    let scan = scanSlidePages(presentation);
    /** @type {Map<string, any>} */
    let slidePageByFullId = new Map(scan.pages.map((p) => [p.fullId, p]));

    /** @type {Set<string>} */
    const keepPageIds = new Set();
    // Seed keepPageIds with what Phase A already knew was cached — any pageId
    // in match.paired that hit the manifest. Phase A's `imagesCached` count is
    // authoritative but doesn't preserve the ids; recompute from the deck.
    for (const p of scan.pages)
    {
        if (!p.image) continue;
        // Anything in the deck that has an image AND is NOT scheduled for
        // download must already be cached (or unpaired). Only keep the ones
        // that are actually paired with a local page.
    }
    // Simpler: any pageId that's in the report's local set AND has an image on
    // the deck should be preserved. The plan's toDownload list covers new
    // fetches; already-cached ids need to survive GC too.
    const localSet = new Set(report.localPages || []);
    const plannedIds = new Set(report.toDownload.map((d) => d.pageId));
    for (const p of scan.pages)
    {
        if (!p.image) continue;
        if (localSet.has(p.fullId) && !plannedIds.has(p.fullId))
        {
            keepPageIds.add(p.fullId);
        }
    }

    const toDownload = report.toDownload;
    let refreshedForExpiry = false;
    let sawLockHeld = false;

    /**
     * Bearer token used only for the `refreshForContentUrlExpiry` path — the
     * image fetch itself sends NO auth header (see attempt() below).
     * @type {string | null}
     */
    let downloadToken = null;

    async function ensureDownloadToken()
    {
        if (downloadToken) return downloadToken;
        try
        {
            downloadToken = await authClient.getAccessToken({ allowRefresh: true });
        }
        catch (_)
        {
            downloadToken = null;
        }
        return downloadToken;
    }

    async function refreshForContentUrlExpiry()
    {
        if (refreshedForExpiry) return false;
        refreshedForExpiry = true;
        const token = await ensureDownloadToken();
        if (!token) return false;
        try
        {
            const refreshed = await getPresentationForRefresh(presentationId, token);
            presentation = refreshed.presentation;
            scan = scanSlidePages(presentation);
            slidePageByFullId = new Map(scan.pages.map((p) => [p.fullId, p]));
            return true;
        }
        catch (_)
        {
            return false;
        }
    }

    let completedDownloads = 0;

    await runWithConcurrency(toDownload, DOWNLOAD_CONCURRENCY, async (item) =>
    {
        const { pageId } = item;
        let slidePage = slidePageByFullId.get(item.slidePageFullId)
            || slidePageByFullId.get(pageId);

        onProgress?.({
            phase: "downloading",
            current: completedDownloads,
            total: toDownload.length,
            message: `Downloading page ${pageId}…`,
        });

        /**
         * One download attempt against the current `slidePage.image.contentUrl`.
         * @returns {Promise<{ ok: true, bytes: ArrayBuffer } | { ok: false, status?: number, err?: Error }>}
         */
        const attempt = async () =>
        {
            const url = slidePage?.image?.contentUrl;
            if (!url)
            {
                return { ok: false, err: new Error("no-content-url") };
            }
            let res;
            try
            {
                // Google's slides CDN (lh7-rt.googleusercontent.com) uses a
                // self-signed URL (`?key=...`). An `Authorization: Bearer`
                // header is redundant AND triggers a CORS preflight that
                // Google's CDN refuses (Access-Control-Allow-Headers omits
                // `authorization`).
                //
                // Route through `tauri-plugin-http` so the request happens
                // Rust-side and never touches the WebView's CORS/CSP —
                // native `fetch` here would be blocked by `connect-src`
                // AND by the CDN's missing `Access-Control-Allow-Origin`
                // for our `tauri://` / `mpsdev://` origin.
                res = await _imageFetch(url, {
                    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
                });
            }
            catch (e)
            {
                return { ok: false, err: e instanceof Error ? e : new Error(String(e)) };
            }
            if (res.status === 403)
            {
                return { ok: false, status: 403 };
            }
            if (!(res.status >= 200 && res.status < 300))
            {
                return { ok: false, status: res.status, err: new Error(`http-${res.status}`) };
            }
            const bytes = await res.arrayBuffer();
            return { ok: true, bytes };
        };

        let outcome = await attempt();

        if (!outcome.ok && outcome.status === 403)
        {
            const refreshed = await refreshForContentUrlExpiry();
            if (refreshed)
            {
                const fresh = slidePageByFullId.get(pageId);
                if (fresh) slidePage = fresh;
                outcome = await attempt();
            }
            if (!outcome.ok && outcome.status === 403)
            {
                report.warnings.push({
                    kind: "URL_EXPIRED",
                    pageId,
                    slideIndex: slidePage?.slideIndex,
                    message: `Page ${pageId} image URL expired`,
                });
                report.imagesFailed++;
                completedDownloads++;
                return;
            }
        }

        if (!outcome.ok)
        {
            const msg = outcome.err ? outcome.err.message : `http-${outcome.status || "unknown"}`;
            report.warnings.push({
                kind: "DOWNLOAD_FAILED",
                pageId,
                slideIndex: slidePage?.slideIndex,
                message: msg,
            });
            report.imagesFailed++;
            completedDownloads++;
            return;
        }

        const bytes = outcome.bytes;
        const u8 = new Uint8Array(bytes);
        const crc = crc32Hex(u8);
        if (slidePage?.image?.storedCrc && slidePage.image.storedCrc !== crc)
        {
            console.debug(
                `[slides-prepare] page ${pageId} storedCrc=${slidePage.image.storedCrc} ` +
                `≠ computed=${crc}; using computed`,
            );
        }

        try
        {
            // Tauri IPC v2 stable doesn't support raw binary — bytes must be
            // marshalled as `number[]` (an array of octets), which serialises
            // to the Rust command's `Vec<u8>`. This has ~3× memory overhead
            // compared with a raw byte buffer but is unavoidable today.
            await _invoke("slides_deck_write", {
                projectPath,
                presentationId,
                pageId,
                crc,
                bytes: Array.from(u8),
            });
            report.imagesDownloaded++;
            keepPageIds.add(pageId);
        }
        catch (e)
        {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg === "LOCK_HELD")
            {
                sawLockHeld = true;
                report.warnings.push({
                    kind: "DOWNLOAD_FAILED",
                    pageId,
                    message: "cache-locked",
                });
            }
            else
            {
                report.warnings.push({
                    kind: "DOWNLOAD_FAILED",
                    pageId,
                    message: msg,
                });
            }
            report.imagesFailed++;
        }
        completedDownloads++;
    });

    if (toDownload.length > 0)
    {
        onProgress?.({
            phase: "downloading",
            current: completedDownloads,
            total: toDownload.length,
        });
    }

    // ── GC ─────────────────────────────────────────────────────────────
    try
    {
        await _invoke("slides_deck_gc", {
            projectPath,
            presentationId,
            keepPageIds: Array.from(keepPageIds),
        });
    }
    catch (e)
    {
        const msg = e instanceof Error ? e.message : String(e);
        report.warnings.push({
            kind: "DOWNLOAD_FAILED",
            message: `cache-gc failed: ${msg}`,
        });
    }

    if (sawLockHeld)
    {
        report.aborted = {
            reason: "LOCK_HELD",
            detail: "Another window is preparing this deck.",
        };
    }

    return report;
}

/**
 * Phase B (upload path) — commit local pages TO Slides when the user picks
 * "Use Local Version" at the mismatch prompt. Feature-flagged behind
 * `uploadEnabled`; when disabled, resolves with an unchanged report + a
 * single warning so the caller can surface a "not yet available" caption.
 *
 * Contract (once wired):
 *   - Renders each paired-different + localOnly page to PNG (image work is
 *     deferred until an image upload path lands — no local render pipeline
 *     yet, so PNG bytes are optional).
 *   - Writes per-page body text into the page header shape via
 *     `batchUpdatePresentation` (JS-side `fetch` to
 *     `slides.googleapis.com/v1/presentations/{id}:batchUpdate`).
 *     Sends one `deleteText` + `insertText` request pair per paired
 *     page. All paired-page text writes collapse into ONE batchUpdate
 *     POST — same origin + auth as `getPresentation`.
 *   - Uploads via `slides_upload_images` Tauri command (stub today).
 *   - `deckOutOfScope` slides are never touched.
 *   - Mutates the report with `uploadsCompleted` / `uploadsFailed`
 *     counters and any UPLOAD_FAILED warnings.
 *
 * @param {{
 *   report:         PrepareReport,
 *   presentation?:  any,
 *   script?:        any,
 *   presentationId: string,
 *   authClient:     { getAccessToken(opts?: { allowRefresh?: boolean }): Promise<string|null> },
 *   renderPageToPng?: (pageId: string) => Promise<Uint8Array | null>,
 *   onProgress?:    (progress: { phase: string, current?: number, total?: number, message?: string }) => void,
 * }} opts
 * @returns {Promise<PrepareReport>}
 */
export async function commitLocalUpload(opts)
{
    const {
        report,
        presentation,
        script,
        presentationId,
        authClient,
        renderPageToPng,
        onProgress,
    } = opts;

    if (!uploadEnabled)
    {
        // Feature-flagged off — surface a warning and leave the deck
        // untouched. The modal reads this to display a "not yet available"
        // caption.
        report.warnings.push({
            kind: "DOWNLOAD_FAILED",
            message: "upload-disabled",
        });
        return report;
    }

    const mismatch = report.mismatch || { pairedDifferent: [], localOnly: [], deckOutOfScope: [] };
    const pairedDifferent = Array.isArray(mismatch.pairedDifferent) ? mismatch.pairedDifferent : [];
    const localOnly = Array.isArray(mismatch.localOnly) ? mismatch.localOnly : [];
    const targets = [...pairedDifferent, ...localOnly];
    if (targets.length === 0)
    {
        return report;
    }

    let token;
    try
    {
        token = await authClient.getAccessToken({ allowRefresh: true });
    }
    catch (_) { token = null; }
    if (!token)
    {
        report.aborted = { reason: "AUTH", detail: "no-token" };
        return report;
    }

    // ── Text-write payload ─────────────────────────────────────────────
    // Build per-page `{ pageId, headerShapeId, bodyText }` for paired
    // pages that need reconciling. Requires both `script` (source of
    // `rawText`) and `presentation` (source of `headerShapeId`) — if
    // either is missing, skip the text-write step and log a warning.
    /** @type {Array<{ pageId: string, headerShapeId: string, bodyText: string }>} */
    const textUpdates = [];
    if (presentation && script && pairedDifferent.length > 0)
    {
        const scan = scanSlidePages(presentation);
        /** @type {Map<string, any>} */
        const slidePageByFullId = new Map(scan.pages.map((p) => [p.fullId, p]));
        const localContent = extractLocalPageContents(script);
        for (const pageId of pairedDifferent)
        {
            const slidePage = slidePageByFullId.get(pageId);
            const headerShapeId = slidePage && typeof slidePage.headerShapeId === "string"
                ? slidePage.headerShapeId
                : null;
            const bodyText = localContent.get(pageId) || "";
            if (!headerShapeId) continue;
            textUpdates.push({ pageId, headerShapeId, bodyText });
        }
    }

    if (textUpdates.length > 0)
    {
        onProgress?.({
            phase: "uploading",
            current: 0,
            total:   textUpdates.length,
            message: "Writing page text…",
        });
        // Collapse every paired-page delete+insert into ONE batchUpdate
        // POST. Same origin (slides.googleapis.com) + same bearer token
        // as `getPresentation`; the picker-transport rule prohibits doing
        // this from Rust, so JS is the canonical write path.
        /** @type {Array<Record<string, unknown>>} */
        const requests = [];
        for (const u of textUpdates)
        {
            requests.push({
                deleteText: {
                    objectId:  u.headerShapeId,
                    textRange: { type: "ALL" },
                },
            });
            requests.push({
                insertText: {
                    objectId:       u.headerShapeId,
                    text:           u.bodyText,
                    insertionIndex: 0,
                },
            });
        }
        try
        {
            await batchUpdatePresentation(presentationId, requests, token);
            onProgress?.({
                phase: "uploading",
                current: textUpdates.length,
                total:   textUpdates.length,
                message: "Wrote page text.",
            });
        }
        catch (e)
        {
            const msg = e instanceof Error ? e.message : String(e);
            report.warnings.push({
                kind: "DOWNLOAD_FAILED",
                message: `batchUpdate failed: ${msg}`,
            });
        }
    }

    // Rebuild the deck-side pageId → slidePage map so we know which slide
    // object to replace vs. create-append. Deck-out-of-scope pages never
    // enter the uploads list.
    /** @type {Array<{ pageId: string, slidePageId: string | null, pngBytesB64: string, mode: string }>} */
    const uploads = [];
    for (let i = 0; i < targets.length; i++)
    {
        const pageId = targets[i];
        onProgress?.({
            phase: "rendering",
            current: i,
            total:   targets.length,
            message: `Rendering page ${pageId}…`,
        });
        /** @type {Uint8Array | null} */
        let png = null;
        try
        {
            png = renderPageToPng ? await renderPageToPng(pageId) : null;
        }
        catch (e)
        {
            console.warn("[slides-prepare] renderPageToPng threw for", pageId, e);
        }
        if (!png)
        {
            report.warnings.push({
                kind: "DOWNLOAD_FAILED",
                pageId,
                message: "render-failed",
            });
            continue;
        }
        uploads.push({
            pageId,
            slidePageId: pairedDifferent.includes(pageId) ? pageId : null,
            pngBytesB64: _uint8ToBase64(png),
            mode: pairedDifferent.includes(pageId) ? "replace" : "create-append",
        });
    }

    onProgress?.({
        phase: "uploading",
        current: 0,
        total:   uploads.length,
        message: "Uploading pages…",
    });

    try
    {
        const upReport = await _invoke("slides_upload_images", {
            presentationId,
            uploads,
            token,
        });
        // Normalise counters onto the report — same shape as downloads.
        const uploaded = Array.isArray(upReport?.uploaded) ? upReport.uploaded.length : 0;
        const failed   = Array.isArray(upReport?.failed)   ? upReport.failed.length   : 0;
        /** @type {any} */ (report).uploadsCompleted = uploaded;
        /** @type {any} */ (report).uploadsFailed    = failed;
        if (Array.isArray(upReport?.failed))
        {
            for (const f of upReport.failed)
            {
                report.warnings.push({
                    kind: "DOWNLOAD_FAILED",
                    pageId: f.pageId,
                    message: `upload-failed: ${f.reason}`,
                });
            }
        }
    }
    catch (e)
    {
        const msg = e instanceof Error ? e.message : String(e);
        report.warnings.push({
            kind: "DOWNLOAD_FAILED",
            message: `slides_upload_images failed: ${msg}`,
        });
    }

    return report;
}

/**
 * Fast base64 encoder for a `Uint8Array`. Avoids `btoa(String.fromCharCode(…))`'s
 * per-byte allocation cost by chunking into 8 KiB windows.
 * @param {Uint8Array} u8
 * @returns {string}
 */
function _uint8ToBase64(u8)
{
    let binary = "";
    const CHUNK = 0x2000;
    for (let i = 0; i < u8.length; i += CHUNK)
    {
        const end = Math.min(i + CHUNK, u8.length);
        binary += String.fromCharCode.apply(null, /** @type {any} */ (u8.subarray(i, end)));
    }
    if (typeof btoa === "function") return btoa(binary);
    // Node/Bun fallback for tests.
    return Buffer.from(binary, "binary").toString("base64");
}

// ── Verify (Step 3) ──────────────────────────────────────────────────────

/**
 * Re-fetch the presentation after a text write and confirm the per-page
 * header shape now hashes to the local rawText CRC.
 *
 * Any paired page whose deck CRC still differs from local → pushes a
 * `VERIFY_FAILED` warning onto `report.warnings`. This catches:
 *   - Slides API silent truncation of long body text.
 *   - Concurrent-edit clobbers on the deck between our write and this read.
 *   - Auth downgrades that made the batchUpdate a no-op.
 *
 * Read-only — makes NO writes.
 *
 * @param {{
 *   report:         PrepareReport,
 *   script:         any,
 *   presentationId: string,
 *   token:          string,
 *   pageIds:        string[],
 * }} opts
 * @returns {Promise<{ verified: string[], mismatched: string[] }>}
 */
export async function verifyDeckText(opts)
{
    const { report, script, presentationId, token, pageIds } = opts;
    /** @type {string[]} */
    const verified = [];
    /** @type {string[]} */
    const mismatched = [];
    if (!Array.isArray(pageIds) || pageIds.length === 0)
    {
        return { verified, mismatched };
    }

    const { presentation } = await getPresentation(presentationId, token);
    const scan = scanSlidePages(presentation);
    /** @type {Map<string, any>} */
    const byFullId = new Map(scan.pages.map((p) => [p.fullId, p]));
    const localContent = extractLocalPageContents(script);

    for (const pageId of pageIds)
    {
        const slidePage = byFullId.get(pageId);
        const localText = localContent.get(pageId) || "";
        const localCrc = computePageTextCrc(localText);
        const deckText = typeof slidePage?.headerText === "string" ? slidePage.headerText : "";
        const deckCrc = computePageTextCrc(deckText);
        if (localCrc === deckCrc)
        {
            verified.push(pageId);
        }
        else
        {
            mismatched.push(pageId);
            report.warnings.push({
                kind: "VERIFY_FAILED",
                pageId,
                slideIndex: slidePage?.slideIndex,
                message: `Page ${pageId} content didn't match after upload. Try Publish again.`,
            });
        }
    }
    return { verified, mismatched };
}

// ── Commit Orchestrator (5-step Progress Panel) ──────────────────────────

/**
 * Full commit orchestrator — walks the 5-step progress panel:
 *
 *   1. Download deck images (if any missing from local cache).
 *   2. Text sync (upload local → deck when `use-local`, or no-op on `use-deck`).
 *   3. Verify text CRC round-trip.
 *   4. Save link + release publish lock (caller-controlled).
 *   5. Refresh linked-indicator (caller-controlled UI touch).
 *
 * Steps 1-3 are network-heavy and run here. Steps 4-5 are a thin wrapper
 * because they need to touch host state (project.json write via Rust, pill
 * ctrl) that lives in the modal's closure — `onStep` gets a `link` event
 * on step 4 so the caller can perform the save + refresh.
 *
 * Per-step try/catch — a failure in step 2 still allows step 3 to run so
 * the user sees the actual deck state via `VERIFY_FAILED` warnings.
 * No rollback is attempted on cancel; step 3 surfaces the ground truth.
 *
 * @param {{
 *   report:         PrepareReport,
 *   script:         any,
 *   presentation:   any,
 *   presentationId: string,
 *   mismatchPolicy: "use-local"|"use-deck"|null,
 *   projectPath:    string,
 *   authClient:     { getAccessToken(opts?: { allowRefresh?: boolean }): Promise<string|null> },
 *   onStep:         (stepIndex: number, event: object) => void,
 *   onSaveLink?:    () => Promise<void>,
 *   onRefreshPill?: () => Promise<void> | void,
 *   signal?:        AbortSignal,
 * }} opts
 * @returns {Promise<{
 *   ok:       boolean,
 *   steps:    Array<{ index: number, status: "done"|"skipped"|"warn"|"failed", detail?: string }>,
 *   warnings: PrepareWarning[],
 * }>}
 */
export async function runCommit(opts)
{
    const {
        report,
        script,
        presentation,
        presentationId,
        mismatchPolicy,
        projectPath,
        authClient,
        onStep,
        onSaveLink,
        onRefreshPill,
        signal,
    } = opts;

    /** @type {Array<{ index: number, status: "done"|"skipped"|"warn"|"failed", detail?: string }>} */
    const steps = [
        { index: 0, status: "done" },
        { index: 1, status: "done" },
        { index: 2, status: "done" },
        { index: 3, status: "done" },
        { index: 4, status: "done" },
    ];

    const emit = (i, event) =>
    {
        try { onStep?.(i, event); } catch (_) { /* best-effort */ }
    };

    // Snapshot warning count before each step so we can classify "warn"
    // vs "done" from what THIS step appended.
    const warnCountAt = () => report.warnings.length;

    // ── STEP 1: images ─────────────────────────────────────────────────
    const wStart1 = warnCountAt();
    if ((report.imagesToDownload || 0) === 0)
    {
        steps[0].status = "skipped";
        steps[0].detail = "no images to download";
        emit(0, { phase: "skipped", current: 0, total: 0 });
    }
    else
    {
        emit(0, { phase: "running", current: 0, total: report.imagesToDownload });
        try
        {
            await commitSlidesSync({
                report,
                presentation,
                presentationId,
                projectPath,
                authClient,
                onProgress: (p) =>
                {
                    emit(0, {
                        phase: "running",
                        current: p.current || 0,
                        total:   p.total   || report.imagesToDownload,
                    });
                },
            });
            if (report.aborted)
            {
                steps[0].status = "failed";
                steps[0].detail = report.aborted.reason;
                emit(0, { phase: "failed", detail: report.aborted.reason });
                return { ok: false, steps, warnings: report.warnings };
            }
            const appended = warnCountAt() - wStart1;
            steps[0].status = appended > 0 ? "warn" : "done";
            emit(0, {
                phase: steps[0].status,
                current: report.imagesToDownload,
                total:   report.imagesToDownload,
            });
        }
        catch (e)
        {
            const msg = e instanceof Error ? e.message : String(e);
            steps[0].status = "failed";
            steps[0].detail = msg;
            emit(0, { phase: "failed", detail: msg });
            return { ok: false, steps, warnings: report.warnings };
        }
    }

    if (signal?.aborted)
    {
        return { ok: false, steps, warnings: report.warnings };
    }

    // ── STEP 2: text sync ──────────────────────────────────────────────
    const pairedDifferent = Array.isArray(report.mismatch?.pairedDifferent)
        ? report.mismatch.pairedDifferent : [];

    const wStart2 = warnCountAt();
    if (mismatchPolicy !== "use-local" || pairedDifferent.length === 0)
    {
        steps[1].status = "skipped";
        steps[1].detail = mismatchPolicy === "use-local"
            ? "no paired-different pages"
            : "deck is source of truth";
        emit(1, { phase: "skipped", current: 0, total: 0 });
    }
    else
    {
        emit(1, { phase: "running", current: 0, total: pairedDifferent.length });
        try
        {
            await commitLocalUpload({
                report,
                presentation,
                script,
                presentationId,
                authClient,
                onProgress: (p) =>
                {
                    if (p.phase === "uploading" && p.total)
                    {
                        emit(1, {
                            phase: "running",
                            current: p.current || 0,
                            total:   p.total,
                        });
                    }
                },
            });
            if (report.aborted)
            {
                steps[1].status = "failed";
                steps[1].detail = report.aborted.reason;
                emit(1, { phase: "failed", detail: report.aborted.reason });
                // Fall through to verify — step 3 will surface what actually
                // landed on the deck side.
            }
            else
            {
                const appended = warnCountAt() - wStart2;
                steps[1].status = appended > 0 ? "warn" : "done";
                emit(1, {
                    phase: steps[1].status,
                    current: pairedDifferent.length,
                    total:   pairedDifferent.length,
                });
            }
        }
        catch (e)
        {
            const msg = e instanceof Error ? e.message : String(e);
            steps[1].status = "failed";
            steps[1].detail = msg;
            emit(1, { phase: "failed", detail: msg });
            // Deliberate: fall through to step 3 so the user sees deck state.
        }
    }

    if (signal?.aborted)
    {
        return { ok: false, steps, warnings: report.warnings };
    }

    // ── STEP 3: verify ─────────────────────────────────────────────────
    // Only meaningful when step 2 was an upload (`use-local` + paired
    // pages). Skip otherwise — nothing was written, nothing to verify.
    const wStart3 = warnCountAt();
    const verifyTargets = (mismatchPolicy === "use-local")
        ? pairedDifferent
        : [];
    if (verifyTargets.length === 0)
    {
        steps[2].status = "skipped";
        steps[2].detail = "no writes performed";
        emit(2, { phase: "skipped", current: 0, total: 0 });
    }
    else
    {
        emit(2, { phase: "running", current: 0, total: verifyTargets.length });
        try
        {
            let token = null;
            try { token = await authClient.getAccessToken({ allowRefresh: true }); }
            catch (_) { token = null; }
            if (!token)
            {
                steps[2].status = "failed";
                steps[2].detail = "no-token";
                emit(2, { phase: "failed", detail: "no-token" });
            }
            else
            {
                await verifyDeckText({
                    report,
                    script,
                    presentationId,
                    token,
                    pageIds: verifyTargets,
                });
                const appended = warnCountAt() - wStart3;
                // Per plan: any per-page CRC mismatch → warn, do NOT block.
                steps[2].status = appended > 0 ? "warn" : "done";
                emit(2, {
                    phase: steps[2].status,
                    current: verifyTargets.length,
                    total:   verifyTargets.length,
                });
            }
        }
        catch (e)
        {
            const msg = e instanceof Error ? e.message : String(e);
            steps[2].status = "failed";
            steps[2].detail = msg;
            emit(2, { phase: "failed", detail: msg });
        }
    }

    // ── STEP 4: save link ──────────────────────────────────────────────
    try
    {
        emit(3, { phase: "running" });
        if (typeof onSaveLink === "function")
        {
            await onSaveLink();
        }
        steps[3].status = "done";
        emit(3, { phase: "done", done: true });
    }
    catch (e)
    {
        const msg = e instanceof Error ? e.message : String(e);
        steps[3].status = "failed";
        steps[3].detail = msg;
        emit(3, { phase: "failed", detail: msg });
        return { ok: false, steps, warnings: report.warnings };
    }

    // ── STEP 5: refresh linked indicator ───────────────────────────────
    try
    {
        emit(4, { phase: "running" });
        if (typeof onRefreshPill === "function")
        {
            await onRefreshPill();
        }
        steps[4].status = "done";
        emit(4, { phase: "done", done: true });
    }
    catch (e)
    {
        const msg = e instanceof Error ? e.message : String(e);
        steps[4].status = "warn";
        steps[4].detail = msg;
        emit(4, { phase: "warn", detail: msg });
        // Pill refresh failure is non-fatal — link is already saved.
    }

    const ok = !steps.some((s) => s.status === "failed");
    return { ok, steps, warnings: report.warnings };
}
