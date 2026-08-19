// @ts-check
/**
 * push-pull.js — round-trip workers for Google Docs sync.
 *
 * Two operations:
 *
 *   push({ token, docId, format, localSourceText, expectedRevisionId, ... })
 *     Force local → remote. If the doc has drifted since our cached
 *     `expectedRevisionId`, we first read the remote text out and save it as
 *     a `<basename>.remote-<ISO8601>.conflict` sidecar before overwriting —
 *     nothing is silently lost ("Dropbox conflicted copy" pattern).
 *
 *   pull({ token, docId, format, localSourceText, localDirty, ... })
 *     Force remote → local. If `localDirty` was true, save local to a
 *     `<basename>.local-<ISO8601>.conflict` sidecar before overwriting.
 *
 * Both return the new `headRevisionId` so the caller can update the sync
 * cache via `notifyPushSucceeded` / `notifyPullSucceeded`.
 *
 * All Drive / Docs traffic goes through the shared
 * `core/google-docs/index.js` clients; the only Tauri-side dependency is
 * `atomic_write_project_file` for the local + sidecar writes.
 */

import {
    documentsGet,
    documentsBatchUpdate,
    filesGet,
    filesUpdate as driveFilesUpdate,
    emitSingleTab
} from "../../../../core/google-docs/index.js";
import { generateFountain } from "../../../../core/export/fountain-writer.js";
import { liftRestriction, applyRestriction } from "./lock-engine.js";

/**
 * Soft Tauri-invoke import — kept dynamic so this module loads in unit-test
 * contexts that have no `@tauri-apps/api` available. Tests inject a fake
 * `writeFile` via the worker options instead.
 *
 * @param {string} path
 * @param {string} contents
 * @returns {Promise<void>}
 */
async function _tauriWriteText(path, contents)
{
    const mod = await import("@tauri-apps/api/core");
    await mod.invoke("atomic_write_project_file", { path, contents });
}

/**
 * Render an ISO-8601 stamp safe to embed in a filename. Replaces colons and
 * dots with hyphens for Windows compatibility. Millisecond digits are retained
 * (matches the iOS ObjC format used by MPSConflictSidecar).
 * @param {Date} [d]
 */
function _stampForFilename(d)
{
    const date = d || new Date();
    return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Walk a Docs `tab.documentTab.body.content[]` tree and concatenate every
 * `textRun.content` it can find. Pure — no I/O. Used by both push (to back
 * up the remote before overwriting) and pull (to seed the local file).
 *
 * @param {any} tab
 * @returns {string}
 */
export function extractTextFromTab(tab)
{
    if (!tab) return "";
    const documentTab = tab.documentTab || tab;
    const body = documentTab && documentTab.body;
    const content = body && body.content;
    if (!Array.isArray(content)) return "";

    let out = "";
    for (const block of content)
    {
        const para = block && block.paragraph;
        const elements = para && para.elements;
        if (!Array.isArray(elements)) continue;
        for (const el of elements)
        {
            const run = el && el.textRun;
            if (run && typeof run.content === "string") out += run.content;
        }
    }
    return out;
}

/**
 * Locate a tab in the Docs document by its `tabProperties.title`. Returns
 * `null` when no matching tab exists. The returned reference includes the
 * server-assigned `tabId` so callers can target subsequent batchUpdate ops.
 *
 * @param {Array<any>|null|undefined} tabs
 * @param {string} name
 * @returns {any|null}
 */
export function findTabByName(tabs, name)
{
    if (!Array.isArray(tabs) || !name) return null;
    for (const tab of tabs)
    {
        const props = tab && tab.tabProperties;
        if (props && props.title === name) return tab;
    }
    return null;
}

/**
 * Compute the end-of-body index for a Docs tab. `deleteContentRange` needs
 * `[startIndex, endIndex)`; the body's last `endIndex` is its trailing
 * newline, which Docs forbids deleting — we subtract 1 to keep it.
 *
 * @param {any} tab
 * @returns {number}  end index (exclusive) — 1 = empty body
 */
function _endIndexOfTab(tab)
{
    if (!tab) return 1;
    const documentTab = tab.documentTab || tab;
    const body = documentTab && documentTab.body;
    const content = body && body.content;
    if (!Array.isArray(content) || content.length === 0) return 1;
    let max = 1;
    for (const block of content)
    {
        if (block && typeof block.endIndex === "number" && block.endIndex > max)
        {
            max = block.endIndex;
        }
    }
    // Trailing newline is at endIndex - 1 — we keep that newline.
    return Math.max(1, max - 1);
}

/**
 * Build a `deleteContentRange` request scoped to a single tab.
 * Skipped (returns `null`) when the tab is already empty.
 *
 * @param {any} tab
 * @param {string|null} [tabId]
 * @returns {object|null}
 */
function _clearTabRequest(tab, tabId)
{
    const end = _endIndexOfTab(tab);
    if (end <= 1) return null;
    /** @type {Record<string, any>} */
    const range = { startIndex: 1, endIndex: end };
    if (tabId) range.tabId = tabId;
    return { deleteContentRange: { range } };
}

/**
 * Convenience — get the basename portion of an absolute path with the file
 * extension intact. Used to build `<basename>.remote-…conflict` sidecars
 * regardless of platform.
 *
 * @param {string} localPath
 * @returns {{ dir: string, base: string, sep: string }}
 */
function _splitPath(localPath)
{
    const sep = localPath.includes("\\") ? "\\" : "/";
    const i = localPath.lastIndexOf(sep);
    if (i < 0) return { dir: "", base: localPath, sep };
    return { dir: localPath.slice(0, i), base: localPath.slice(i + 1), sep };
}

/**
 * @typedef {Object} PushArgs
 * @property {string} token
 * @property {string} docId
 * @property {"mangaplay"|"fountain"|"text"} format
 * @property {string} localSourceText
 * @property {string|null} expectedRevisionId
 * @property {string} localPath              — absolute path of the script (for sidecar)
 * @property {string} rootTabId
 * @property {string|null} screenplayTabId
 * @property {boolean} [hasOwnLock]          — when true, push lifts the file's
 *   contentRestriction before batchUpdate and re-applies it after (best-effort).
 *   Lock identity in appProperties is preserved across the lift/reapply.
 * @property {string} [userName]             — for the re-apply's `reason` string.
 * @property {object} [docsApi]              — `{ documentsGet, documentsBatchUpdate }` override (tests)
 * @property {object} [driveApi]             — `{ filesGet, filesUpdate }` override (tests)
 * @property {(path: string, contents: string) => Promise<void>} [writeFile]
 * @property {() => Date} [now]
 */

/**
 * Force local → remote. See module header for the conflict-sidecar contract.
 *
 * @param {PushArgs} args
 * @returns {Promise<{ newRevisionId: string|null, conflictSidecarPath: string|null }>}
 */
export async function push(args)
{
    if (!args || !args.token) throw _err("DocsApiError", "push: token required");
    if (!args.docId)          throw _err("DocsApiError", "push: docId required");
    if (!args.localPath)      throw _err("DocsApiError", "push: localPath required");

    const docsApi = args.docsApi || { documentsGet, documentsBatchUpdate };
    const driveApi = args.driveApi || { filesGet, filesUpdate: driveFilesUpdate };
    const writeFile = args.writeFile || _tauriWriteText;
    const now = args.now || (() => new Date());

    // 1. Read current head revision + appProperties.
    const meta = await driveApi.filesGet({
        token: args.token,
        fileId: args.docId,
        fields: "headRevisionId,appProperties"
    });
    const headRev = meta && meta.headRevisionId ? String(meta.headRevisionId) : null;

    // 2. If remote drifted, back it up to a sidecar BEFORE we clobber it.
    // NOTE: when this sidecar is written but the push then throws (e.g.
    // MangaplayTabMissing below at BUG-004), no batchUpdate runs — but a
    // harmless .remote.conflict sidecar exists. The user can delete it.
    let conflictSidecarPath = null;
    if (headRev && args.expectedRevisionId && headRev !== args.expectedRevisionId)
    {
        if (!args.rootTabId)
        {
            throw _err(
                "MissingTabIdInCache",
                "This doc was published before tab-id tracking landed — please re-publish to enable sync.");
        }
        const doc = await docsApi.documentsGet({
            token: args.token,
            documentId: args.docId,
            includeTabsContent: true
        });
        const tabs = (doc && doc.tabs) || [];
        const targetTabId = (args.format === "mangaplay")
            ? args.rootTabId
            : args.rootTabId;
        const remoteTab = tabs.find(t => t && t.tabProperties && t.tabProperties.tabId === targetTabId) || null;
        const remoteText = extractTextFromTab(remoteTab);

        const { dir, base, sep } = _splitPath(args.localPath);
        const stamp = _stampForFilename(now());
        const sidecarBase = `${base}.remote-${stamp}.conflict`;
        conflictSidecarPath = dir ? `${dir}${sep}${sidecarBase}` : sidecarBase;
        await writeFile(conflictSidecarPath, remoteText);
    }

    // 3. Fetch the full tab tree so we can target the existing Mangaplay tab
    //    (mangaplay format) and know the current end-of-body index for the
    //    deleteContentRange.
    const fullDoc = await docsApi.documentsGet({
        token: args.token,
        documentId: args.docId,
        includeTabsContent: true
    });
    const allTabs = (fullDoc && fullDoc.tabs) || [];

    // Lift the file's readonly contentRestriction before any batchUpdate
    // when we own the lock. Drive blocks batchUpdate while readOnly is on
    // — even for the client that set it. We re-apply it in the finally
    // block so the lock state survives the round-trip. Best-effort: a
    // re-apply failure is logged but never rethrown (the success path has
    // already moved on; the heartbeat will resync lock state).
    const didLift = !!args.hasOwnLock;
    if (didLift)
    {
        await liftRestriction({
            token: args.token,
            docId: args.docId,
            driveClient: { filesUpdate: driveApi.filesUpdate }
        });
    }
    try
    {
        if (args.format === "mangaplay")
        {
            // Two-tab path. Targeting is now by stored tabIds from the cache
            // entry (rootTabId = Mangaplay tab; screenplayTabId = Screenplay
            // tab) — collaborators can rename or reorder tabs freely.
            const mangaplayTabId = args.rootTabId;
            const screenplayTabId = args.screenplayTabId;

            if (!mangaplayTabId || !screenplayTabId)
            {
                throw _err(
                    "MissingTabIdInCache",
                    "This doc was published before tab-id tracking landed — please re-publish to enable sync.");
            }

            // Look up the tab objects from allTabs for _clearTabRequest (which
            // needs the tab body to compute end-of-body for deleteContentRange).
            const mangaplayTab = allTabs.find(t => t && t.tabProperties && t.tabProperties.tabId === mangaplayTabId) || null;
            const screenplayTab = allTabs.find(t => t && t.tabProperties && t.tabProperties.tabId === screenplayTabId) || null;

            // Clear both tabs in one batchUpdate.
            const clearReqs = [];
            const clearScreen = _clearTabRequest(screenplayTab, screenplayTabId);
            const clearManga = _clearTabRequest(mangaplayTab, mangaplayTabId);
            if (clearScreen) clearReqs.push(clearScreen);
            if (clearManga) clearReqs.push(clearManga);
            if (clearReqs.length)
            {
                console.debug("[mps:gdocs:update] batchUpdate clear (mangaplay) starting",
                    { docId: args.docId, ops: clearReqs.length });
                try
                {
                    await docsApi.documentsBatchUpdate({
                        token: args.token,
                        documentId: args.docId,
                        requests: clearReqs
                    });
                    console.debug("[mps:gdocs:update] batchUpdate clear (mangaplay) ok");
                }
                catch (e)
                {
                    const ee = /** @type {any} */ (e);
                    console.warn("[mps:gdocs:update] batchUpdate clear (mangaplay) failed",
                        { status: ee && ee.status, name: ee && ee.name, message: ee && ee.message });
                    throw e;
                }
            }

            // Re-emit inline. RAW .mangaplay → "Mangaplay" tab,
            // Fountain render → "Screenplay" tab. Matches the publish flow's
            // tab-content mapping.
            const rawText = args.localSourceText || "";
            const fountainText = generateFountain(rawText);

            const writeReqs = [];
            if (rawText && mangaplayTabId)
            {
                writeReqs.push({
                    insertText:
                    {
                        location: { index: 1, tabId: mangaplayTabId },
                        text: rawText
                    }
                });
            }
            if (fountainText && screenplayTabId)
            {
                writeReqs.push({
                    insertText:
                    {
                        location: { index: 1, tabId: screenplayTabId },
                        text: fountainText
                    }
                });
            }

            if (writeReqs.length)
            {
                console.debug("[mps:gdocs:update] batchUpdate write (mangaplay) starting",
                    { docId: args.docId, ops: writeReqs.length });
                try
                {
                    await docsApi.documentsBatchUpdate({
                        token: args.token,
                        documentId: args.docId,
                        requests: writeReqs
                    });
                    console.debug("[mps:gdocs:update] batchUpdate write (mangaplay) ok");
                }
                catch (e)
                {
                    const ee = /** @type {any} */ (e);
                    console.warn("[mps:gdocs:update] batchUpdate write (mangaplay) failed",
                        { status: ee && ee.status, name: ee && ee.name, message: ee && ee.message });
                    throw e;
                }
            }
        }
        else
        {
            // Single-tab path (fountain / text). Targeting by stored rootTabId
            // from the cache entry — no positional / name lookup.
            const onlyTabId = args.rootTabId;
            if (!onlyTabId)
            {
                throw _err(
                    "MissingTabIdInCache",
                    "This doc was published before tab-id tracking landed — please re-publish to enable sync.");
            }
            const onlyTab = allTabs.find(t => t && t.tabProperties && t.tabProperties.tabId === onlyTabId) || null;
            const clearReq = _clearTabRequest(onlyTab, onlyTabId);
            if (clearReq)
            {
                console.debug("[mps:gdocs:update] batchUpdate clear (single-tab) starting", { docId: args.docId });
                try
                {
                    await docsApi.documentsBatchUpdate({
                        token: args.token,
                        documentId: args.docId,
                        requests: [clearReq]
                    });
                    console.debug("[mps:gdocs:update] batchUpdate clear (single-tab) ok");
                }
                catch (e)
                {
                    const ee = /** @type {any} */ (e);
                    console.warn("[mps:gdocs:update] batchUpdate clear (single-tab) failed",
                        { status: ee && ee.status, name: ee && ee.name, message: ee && ee.message });
                    throw e;
                }
            }
            const baseReqs = emitSingleTab(args.localSourceText);
            const writeReqs = baseReqs.map(r =>
            {
                // Re-target onto the discovered tab when possible so the write
                // lands inside the correct tab even if Docs added more.
                if (onlyTabId && r && r.insertText && r.insertText.location)
                {
                    return {
                        insertText:
                        {
                            location: { ...r.insertText.location, tabId: onlyTabId },
                            text: r.insertText.text
                        }
                    };
                }
                return r;
            });
            if (writeReqs.length)
            {
                console.debug("[mps:gdocs:update] batchUpdate write (single-tab) starting",
                    { docId: args.docId, ops: writeReqs.length });
                try
                {
                    await docsApi.documentsBatchUpdate({
                        token: args.token,
                        documentId: args.docId,
                        requests: writeReqs
                    });
                    console.debug("[mps:gdocs:update] batchUpdate write (single-tab) ok");
                }
                catch (e)
                {
                    const ee = /** @type {any} */ (e);
                    console.warn("[mps:gdocs:update] batchUpdate write (single-tab) failed",
                        { status: ee && ee.status, name: ee && ee.name, message: ee && ee.message });
                    throw e;
                }
            }
        }
    }
    finally
    {
        if (didLift)
        {
            try
            {
                await applyRestriction({
                    token: args.token,
                    docId: args.docId,
                    userName: args.userName || "",
                    driveClient: { filesUpdate: driveApi.filesUpdate }
                });
            }
            catch (_) { /* best-effort re-lock */ }
        }
    }

    // 4. Read the new head revision.
    const after = await driveApi.filesGet({
        token: args.token,
        fileId: args.docId,
        fields: "headRevisionId"
    });
    const newRevisionId = after && after.headRevisionId ? String(after.headRevisionId) : null;
    return { newRevisionId, conflictSidecarPath };
}

/**
 * @typedef {Object} PullArgs
 * @property {string} token
 * @property {string} docId
 * @property {"mangaplay"|"fountain"|"text"} format
 * @property {string} localSourceText
 * @property {boolean} localDirty
 * @property {string} localPath
 * @property {string} rootTabId
 * @property {string|null} screenplayTabId
 * @property {object} [docsApi]
 * @property {object} [driveApi]
 * @property {(path: string, contents: string) => Promise<void>} [writeFile]
 * @property {() => Date} [now]
 */

/**
 * Force remote → local. Writes a `<basename>.local-<ISO8601>.conflict`
 * sidecar before overwriting if `localDirty` was true.
 *
 * @param {PullArgs} args
 * @returns {Promise<{ newRevisionId: string|null, conflictSidecarPath: string|null }>}
 */
export async function pull(args)
{
    if (!args || !args.token) throw _err("DocsApiError", "pull: token required");
    if (!args.docId)          throw _err("DocsApiError", "pull: docId required");
    if (!args.localPath)      throw _err("DocsApiError", "pull: localPath required");

    const docsApi = args.docsApi || { documentsGet };
    const driveApi = args.driveApi || { filesGet };
    const writeFile = args.writeFile || _tauriWriteText;
    const now = args.now || (() => new Date());

    // 1. Back up local if it was dirty.
    // NOTE: when this sidecar is written but the pull then throws (e.g.
    // MangaplayTabMissing below), the main local file is untouched — but a
    // harmless .conflict sidecar exists. The user can delete it.
    let conflictSidecarPath = null;
    if (args.localDirty)
    {
        const { dir, base, sep } = _splitPath(args.localPath);
        const stamp = _stampForFilename(now());
        const sidecarBase = `${base}.local-${stamp}.conflict`;
        conflictSidecarPath = dir ? `${dir}${sep}${sidecarBase}` : sidecarBase;
        await writeFile(conflictSidecarPath, args.localSourceText || "");
    }

    // 2. Pull the doc body.
    const doc = await docsApi.documentsGet({
        token: args.token,
        documentId: args.docId,
        includeTabsContent: true
    });
    const tabs = (doc && doc.tabs) || [];
    if (!args.rootTabId)
    {
        throw _err(
            "MissingTabIdInCache",
            "This doc was published before tab-id tracking landed — please re-publish to enable sync.");
    }
    const targetTab = tabs.find(t => t && t.tabProperties && t.tabProperties.tabId === args.rootTabId) || null;

    // If the cached rootTabId no longer exists in the doc (collaborator
    // deleted the tab after our cache was written), extractTextFromTab(null)
    // would return "" and we'd silently blank the user's local file. Refuse
    // instead. See BUG-004 (originally MangaplayTabMissing).
    if (args.format === "mangaplay" && !targetTab)
    {
        throw _err(
            "MangaplayTabMissing",
            "The Mangaplay tab is missing from the Google Doc. " +
            "Someone may have renamed or deleted it.");
    }

    const remoteText = extractTextFromTab(targetTab);

    // 3. Overwrite local.
    await writeFile(args.localPath, remoteText);

    // 4. New head revision.
    const after = await driveApi.filesGet({
        token: args.token,
        fileId: args.docId,
        fields: "headRevisionId"
    });
    const newRevisionId = after && after.headRevisionId ? String(after.headRevisionId) : null;

    return { newRevisionId, conflictSidecarPath };
}

/**
 * @param {string} name
 * @param {string} message
 * @returns {Error}
 */
function _err(name, message)
{
    const e = new Error(message);
    e.name = name;
    return e;
}
