// @ts-check
/**
 * publish-workers.js — production wiring for the Publish state machine.
 *
 * Each export is an async function that the state machine calls. Splitting
 * the workers out keeps the state machine testable (the test suite injects
 * mocks instead of these) and keeps THIS file as the only place that
 * touches `core/google-docs`, the auth client, and the Tauri-side
 * filesystem.
 *
 * Five "preflight" workers mirror the names in §3a; five "publish" workers
 * cover the steps that actually mutate Drive state (createDoc, writeTabs,
 * writeAppProps, applySharing, acquireLock), plus fetchHeadRevisionId +
 * persistCacheEntry as post-publish helpers.
 *
 * The factory `buildPublishWorkers({ authClient })` returns an object that
 * the state machine accepts as its `workers` constructor argument.
 */

import {
    documentsCreate,
    documentsBatchUpdate,
    filesUpdate,
    filesGet,
    permissionsCreate,
    emitSingleTab,
    emitTwoTabs,
    buildAppProperties,
    driveClient as driveClientApi
} from "../../../../core/google-docs/index.js";
import {
    preflightNetwork as _preflightNetwork,
    preflightGoogleAccess as _preflightGoogleAccess,
    preflightToken as _preflightToken,
    preflightFile as _preflightFile,
    preflightDestFolder as _preflightDestFolder,
    preflightQuota as _preflightQuota
} from "./preflight.js";
import { uuid } from "./uuid.js";
import { setSyncEntry as projectSetSyncEntry } from "../project/project.js";
import { getCurrentProfile } from "../auth/google-oauth.js";
import { appendPublishLog as _appendLog, _toEntry } from "./publish-log.js";

/**
 * Build the worker set the state machine consumes. `authClient` must
 * expose `getAccessToken({ allowRefresh })` returning a string|null.
 *
 * @param {{ authClient: { getAccessToken: (opts?: { allowRefresh?: boolean }) => Promise<string|null> } }} opts
 * @returns {object}
 */
export function buildPublishWorkers(opts)
{
    const { authClient } = opts;

    // ── Preflight ───────────────────────────────────────────────────────
    async function preflightNetwork()
    {
        const r = await _preflightNetwork({});
        return r;
    }

    async function preflightGoogle({ response })
    {
        const r = await _preflightGoogleAccess({ response });
        return r;
    }

    async function preflightToken()
    {
        const r = await _preflightToken({ authClient });
        return r;
    }

    async function preflightFile({ localPath })
    {
        const r = await _preflightFile({ localPath });
        return r;
    }

    async function preflightDest({ token, folderId })
    {
        await _preflightDestFolder({ driveClient: driveClientApi, token, folderId });
        const q = await _preflightQuota({ driveClient: driveClientApi, token });
        return { ok: true, warning: q && q.warning };
    }

    // ── Publish ─────────────────────────────────────────────────────────
    /**
     * Create a new Google Doc and return both the document id and the
     * auto-created root tab's id. The root tab id is taken straight from
     * the create response's `tabs[0].tabId` — no separate documents.get
     * round trip needed. The follow-up batchUpdate uses this id to rename
     * the root tab from Google's default "Tab 1" to "Mangaplay".
     *
     * @param {{ token: string, title: string }} args
     * @returns {Promise<{ documentId: string, rootTabId: string }>}
     */
    async function createDoc({ token, title })
    {
        const resp = await documentsCreate({ token, title });
        if (!resp || !resp.documentId) throw _err("DocsApiError", "create returned no documentId");
        const rootTabId = resp.tabs && resp.tabs[0] && resp.tabs[0].tabProperties
                && resp.tabs[0].tabProperties.tabId
            ? String(resp.tabs[0].tabProperties.tabId)
            : null;
        if (!rootTabId) throw _err("DocsApiError", "create response missing tabs[0].tabProperties.tabId");
        console.debug("[mps:gdocs:publish] documents.create returned",
            { tabs: (resp.tabs && resp.tabs.length) || 0, rootTabId });
        return { documentId: resp.documentId, rootTabId };
    }

    /**
     * Write tab content. For mangaplay this is TWO batchUpdate calls:
     * batch #1 inserts root + renames root + addDocumentTab (server assigns
     * the new tabId); we read that tabId from the reply, then batch #2
     * inserts the screenplay text into it. The server-assigned id is
     * returned so the caller can persist it in the sync cache.
     *
     * For fountain / text it's one batchUpdate with a single insertText.
     *
     * @param {{ token: string, docId: string, rootTabId: string, sourceText: string, format: "mangaplay"|"fountain"|"text" }} args
     * @returns {Promise<{ screenplayTabId: string|null }>}
     */
    async function writeTabs({ token, docId, rootTabId, sourceText, format })
    {
        if (format === "mangaplay")
        {
            const { firstBatch, secondBatchFor } = emitTwoTabs(sourceText, rootTabId);
            const reply = await documentsBatchUpdate({
                token, documentId: docId, requests: firstBatch
            });
            const screenplayTabId = _extractAddedTabId(reply);
            if (!screenplayTabId)
            {
                throw _err("DocsApiError",
                    "addDocumentTab reply did not include a server-assigned tabId");
            }
            const second = secondBatchFor(screenplayTabId);
            if (second.length)
            {
                await documentsBatchUpdate({
                    token, documentId: docId, requests: second
                });
            }
            console.debug("[mps:gdocs:publish] published with screenplay tabId", screenplayTabId);
            return { screenplayTabId };
        }

        // Fountain / text — single tab, no addDocumentTab.
        const reqs = emitSingleTab(sourceText);
        if (reqs.length) await documentsBatchUpdate({ token, documentId: docId, requests: reqs });
        return { screenplayTabId: null };
    }

    /**
     * @param {{ token: string, docId: string, formValues: any }} args
     */
    async function writeAppProps({ token, docId, formValues })
    {
        const appProps = buildAppProperties({
            projectId:     formValues.projectId || "",
            scriptRelPath: formValues.scriptRelPath || "",
            format:        formValues.format,
            clientId:      formValues.clientId || ""
        });

        /** @type {{ appProperties: Record<string, string> }} */
        const body = { appProperties: appProps };

        // `parents` lives at the file root, not inside `appProperties`.
        // We use `addParents` so we don't have to know the original parent
        // (Drive defaults to "root" on documents.create).
        const addParents = (formValues.folderId && formValues.folderId !== "root")
            ? formValues.folderId
            : undefined;

        await filesUpdate({ token, fileId: docId, body, addParents });
    }

    /**
     * Map the sharing radio selection to permissions.create calls.
     * Per-email failures are collected into `failedEmails` so the modal can
     * surface them without aborting the rest of the publish.
     *
     * @param {{ token: string, docId: string, sharing: string, emails: Array<string> }} args
     * @returns {Promise<{ failedEmails: Array<string> }>}
     */
    async function applySharing({ token, docId, sharing, emails })
    {
        if (sharing === "private") return { failedEmails: [] };

        if (sharing === "viewLink")
        {
            await permissionsCreate({
                token,
                fileId: docId,
                body: { type: "anyone", role: "reader" }
            });
            return { failedEmails: [] };
        }

        if (sharing === "commentLink")
        {
            await permissionsCreate({
                token,
                fileId: docId,
                body: { type: "anyone", role: "commenter" }
            });
            return { failedEmails: [] };
        }

        if (sharing === "specific")
        {
            const failedEmails = [];
            for (const email of (emails || []))
            {
                const trimmed = String(email || "").trim();
                if (!trimmed) continue;
                try
                {
                    await permissionsCreate({
                        token,
                        fileId: docId,
                        body: { type: "user", role: "writer", emailAddress: trimmed }
                    });
                }
                catch (err)
                {
                    console.warn("[mps:gdocs:publish] share to", trimmed, "failed:", err);
                    failedEmails.push(trimmed);
                }
            }
            return { failedEmails };
        }

        return { failedEmails: [] };
    }

    /**
     * Acquire the Mangaplay Studio lock. Writes contentRestrictions +
     * appProperties (lockToken / lockedAt / lockedBy / clientId), then
     * re-reads to verify our token won the race. Throws
     * `permissions.doc_picker_denied`-shaped error if contested.
     *
     * @param {{ token: string, docId: string, userName: string, clientId: string }} args
     * @returns {Promise<{ lockToken: string, lockedAt: string }>}
     */
    async function acquireLock({ token, docId, userName, clientId })
    {
        const lockToken = uuid();
        const lockedAt = new Date().toISOString();
        const reason = `Locked by ${userName} in Mangaplay Studio`;
        const profile = getCurrentProfile();
        const lockedBySub = (profile && profile.sub) || "";

        await filesUpdate({
            token,
            fileId: docId,
            body:
            {
                contentRestrictions: [{ readOnly: true, reason }],
                appProperties: Object.assign(
                    buildAppProperties({
                        projectId:     "",
                        scriptRelPath: "",
                        format:        /** @type {any} */ (null),
                        clientId,
                        lockToken,
                        lockedAt,
                        lockedBy:      userName
                    }),
                    { mpsLockedBySub: lockedBySub }
                )
            }
        });

        // Race-detect: re-read and confirm our token survived.
        const verify = await filesGet({ token, fileId: docId, fields: "appProperties" });
        const got = verify && verify.appProperties && verify.appProperties.mpsLockToken;
        if (got !== lockToken)
        {
            const e = _err("FileNotGrantedError",
                `Lock contested — another session won the race on ${docId}`);
            throw e;
        }
        return { lockToken, lockedAt };
    }

    /**
     * Read the freshly-created Doc's `headRevisionId` so the publish-success
     * cache write can seed `lastKnownRevisionId`. Without this, the first L1
     * check after publish would compare `null !== <head>` and falsely
     * transition to `remote-ahead`. See BUG-003.
     *
     * Returns null when the Drive response lacks the field — the caller
     * treats that as "publish succeeded, cache will boot to remote-ahead on
     * first L1, not fatal".
     *
     * @param {{ token: string, docId: string }} args
     * @returns {Promise<string|null>}
     */
    async function fetchHeadRevisionId({ token, docId })
    {
        const file = await filesGet({ token, fileId: docId, fields: "headRevisionId" });
        return file && file.headRevisionId ? String(file.headRevisionId) : null;
    }

    /**
     * Persist the post-publish sync cache entry into the project's
     * `project.json` `googleDocsSync` map. Defensive guards: if
     * `projectPath` or `scriptRelPath` are missing (e.g. the editor-menu
     * callsite couldn't supply them), early-return so publish still reports
     * success. See BUG-001.
     *
     * @param {{ projectPath: string, scriptRelPath: string, entry: import("../project/project.js").GoogleDocsSyncEntry }} args
     * @returns {Promise<void>}
     */
    async function persistCacheEntry({ projectPath, scriptRelPath, entry })
    {
        if (!projectPath || !scriptRelPath)
        {
            console.warn("[mps:gdocs:publish] persistCacheEntry skipped — missing projectPath/scriptRelPath");
            return;
        }
        await projectSetSyncEntry(projectPath, scriptRelPath, entry);
    }

    /**
     * Append a best-effort entry to the rolling publish log. Reads the
     * currently-cached Google profile so the Settings tab can render the
     * publishing account's avatar / email. Failures are swallowed inside
     * `_appendLog`; the state machine's try/catch is belt-and-braces.
     *
     * @param {{ fileName: string, docId: string, docUrl: string, format: "mangaplay"|"fountain"|"text", intent: "publish"|"collaborate" }} args
     * @returns {Promise<void>}
     */
    async function appendPublishLog(args)
    {
        const profile = getCurrentProfile();
        const formValues = {
            title:  args.fileName,
            format: args.format,
            intent: args.intent
        };
        const entry = _toEntry({
            formValues,
            docId:  args.docId,
            docUrl: args.docUrl,
            profile
        });
        await _appendLog(entry);
    }

    return {
        preflightNetwork,
        preflightGoogle,
        preflightToken,
        preflightFile,
        preflightDest,
        createDoc,
        writeTabs,
        writeAppProps,
        applySharing,
        acquireLock,
        fetchHeadRevisionId,
        persistCacheEntry,
        appendPublishLog
    };
}

/**
 * Pull the server-assigned tabId out of a `documents.batchUpdate` reply.
 * The addDocumentTab response lands at
 * `replies[N].addDocumentTab.tabProperties.tabId` — N depends on its
 * position in the request array, so scan rather than index.
 *
 * @param {any} reply
 * @returns {string|null}
 */
function _extractAddedTabId(reply)
{
    const replies = reply && reply.replies;
    if (!Array.isArray(replies)) return null;
    for (const r of replies)
    {
        const id = r && r.addDocumentTab
            && r.addDocumentTab.tabProperties
            && r.addDocumentTab.tabProperties.tabId;
        if (id) return String(id);
    }
    return null;
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
