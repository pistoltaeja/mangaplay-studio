// @ts-check
/**
 * push-pull.test.js — Bun tests for the Google Docs round-trip workers.
 *
 * Coverage:
 *   - extractTextFromTab + findTabByName pure helpers.
 *   - push() happy path: no conflict (revs match) → no sidecar, doc rewritten.
 *   - push() with conflict (revs differ) → remote sidecar saved BEFORE the
 *     destructive batchUpdate runs.
 *   - pull() writes remote text into local path.
 *   - pull() with localDirty=true → local sidecar saved BEFORE the overwrite.
 *   - Fixture parity: tabwalk + sidecar against gdocs-tabwalk-fixtures.json
 *     and gdocs-sidecar-fixtures.json.
 */

import { describe, test, expect } from "bun:test";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import {
    push,
    pull,
    extractTextFromTab,
    findTabByName
} from "./push-pull.js";

// Load fixtures from core/ (four directories up from src/js/google-docs-sync/).
const __dirname_file = dirname(fileURLToPath(import.meta.url));
const coreDir = resolve(__dirname_file, "../../../../core");
const tabwalkFixtures = JSON.parse(readFileSync(resolve(coreDir, "gdocs-tabwalk-fixtures.json"), "utf-8"));
const sidecarFixtures = JSON.parse(readFileSync(resolve(coreDir, "gdocs-sidecar-fixtures.json"), "utf-8"));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @param {string} text
 * @param {string} [tabId]
 * @param {string} [title]
 * @returns {any}
 */
function makeTab(text, tabId, title)
{
    const documentTab =
    {
        body:
        {
            content:
            [
                {
                    startIndex: 1,
                    endIndex: text.length + 2,
                    paragraph:
                    {
                        elements:
                        [
                            { textRun: { content: text } },
                            // Trailing newline shape Docs sends back.
                            { textRun: { content: "\n" } }
                        ]
                    }
                }
            ]
        }
    };
    /** @type {any} */
    const tab = { documentTab };
    if (tabId || title) tab.tabProperties = { tabId, title };
    return tab;
}

function emptyTab(tabId, title)
{
    return {
        tabProperties: tabId || title ? { tabId, title } : undefined,
        documentTab: { body: { content: [] } }
    };
}

/**
 * Capture every call so the test can assert ordering.
 */
function buildSpyApis({ headBefore, headAfter, tabs })
{
    /** @type {Array<{ kind: string, args: any }>} */
    const calls = [];
    let getCount = 0;
    const docsApi =
    {
        async documentsGet(args)
        {
            calls.push({ kind: "documentsGet", args });
            return { tabs };
        },
        async documentsBatchUpdate(args)
        {
            calls.push({ kind: "documentsBatchUpdate", args });
            return { documentId: args.documentId, replies: [] };
        }
    };
    const driveApi =
    {
        async filesGet(args)
        {
            calls.push({ kind: "filesGet", args });
            getCount++;
            return getCount === 1
                ? { headRevisionId: headBefore, appProperties: {} }
                : { headRevisionId: headAfter };
        }
    };
    return { calls, docsApi, driveApi };
}

// ── findTabByName / extractTextFromTab ───────────────────────────────────────

describe("findTabByName / extractTextFromTab", () =>
{
    test("findTabByName returns the named tab", () =>
    {
        const a = makeTab("A", "tabA", "Screenplay");
        const b = makeTab("B", "tabB", "Mangaplay");
        expect(findTabByName([a, b], "Mangaplay")).toBe(b);
    });

    test("findTabByName returns null when no match", () =>
    {
        const a = makeTab("A", "tabA", "Other");
        expect(findTabByName([a], "Mangaplay")).toBe(null);
    });

    test("findTabByName tolerates null / non-array input", () =>
    {
        expect(findTabByName(null, "Mangaplay")).toBe(null);
        expect(findTabByName(undefined, "Mangaplay")).toBe(null);
    });

    test("extractTextFromTab concatenates textRun content across paragraphs", () =>
    {
        const tab =
        {
            documentTab:
            {
                body:
                {
                    content:
                    [
                        { paragraph: { elements: [{ textRun: { content: "Hello " } }] } },
                        { paragraph: { elements: [{ textRun: { content: "world\n" } }] } }
                    ]
                }
            }
        };
        expect(extractTextFromTab(tab)).toBe("Hello world\n");
    });

    test("extractTextFromTab returns empty string for empty / malformed input", () =>
    {
        expect(extractTextFromTab(null)).toBe("");
        expect(extractTextFromTab({})).toBe("");
        expect(extractTextFromTab({ documentTab: { body: { content: [] } } })).toBe("");
    });
});

// ── push happy path ──────────────────────────────────────────────────────────

describe("push — happy path (no conflict)", () =>
{
    test("matching revisions → no sidecar saved, doc cleared+rewritten", async () =>
    {
        const writes = /** @type {Array<{ path: string, contents: string }>} */ ([]);
        const writeFile = async (path, contents) => { writes.push({ path, contents }); };

        const tab = makeTab("old body", "tab1");
        const { calls, docsApi, driveApi } = buildSpyApis({
            headBefore: "rev-100",
            headAfter: "rev-101",
            tabs: [tab]
        });

        const result = await push({
            token: "T",
            docId: "doc-1",
            format: "text",
            localSourceText: "fresh text",
            expectedRevisionId: "rev-100",
            localPath: "/proj/script.fountain",
            docsApi,
            driveApi,
            writeFile
        });

        expect(result.newRevisionId).toBe("rev-101");
        expect(result.conflictSidecarPath).toBe(null);
        expect(writes.length).toBe(0);

        // We expect: 1 filesGet (head), 1 documentsGet (full tabs),
        // 1 batchUpdate (clear), 1 batchUpdate (write), 1 filesGet (head after).
        const kinds = calls.map(c => c.kind);
        expect(kinds[0]).toBe("filesGet");
        expect(kinds[1]).toBe("documentsGet");
        expect(kinds[kinds.length - 1]).toBe("filesGet");
        expect(kinds.includes("documentsBatchUpdate")).toBe(true);
    });
});

// ── push with conflict ──────────────────────────────────────────────────────

describe("push — conflict (revisions differ)", () =>
{
    test("remote sidecar saved BEFORE the destructive batchUpdate", async () =>
    {
        const writes = /** @type {Array<{ path: string, contents: string }>} */ ([]);
        const writeFile = async (path, contents) => { writes.push({ path, contents }); };

        const tab = makeTab("REMOTE WINS", "tab1");
        const calls = /** @type {Array<{ kind: string, args: any }>} */ ([]);
        let getCount = 0;

        const docsApi =
        {
            async documentsGet(args)
            {
                calls.push({ kind: "documentsGet", args });
                return { tabs: [tab] };
            },
            async documentsBatchUpdate(args)
            {
                calls.push({ kind: "documentsBatchUpdate", args });
                return { documentId: args.documentId, replies: [] };
            }
        };
        const driveApi =
        {
            async filesGet(args)
            {
                calls.push({ kind: "filesGet", args });
                getCount++;
                return getCount === 1
                    ? { headRevisionId: "rev-200" }
                    : { headRevisionId: "rev-201" };
            }
        };

        const fixedDate = new Date("2026-06-29T12:00:00.000Z");
        const result = await push({
            token: "T",
            docId: "doc-conflict",
            format: "text",
            localSourceText: "new local",
            expectedRevisionId: "rev-100",  // stale; remote is rev-200
            localPath: "/proj/script.fountain",
            docsApi,
            driveApi,
            writeFile,
            now: () => fixedDate
        });

        // Sidecar saved.
        expect(writes.length).toBe(1);
        expect(writes[0].path).toBe("/proj/script.fountain.remote-2026-06-29T12-00-00-000Z.conflict");
        expect(writes[0].contents).toContain("REMOTE WINS");

        // Sidecar write must happen BEFORE the first batchUpdate.
        const firstBatchUpdateIdx = calls.findIndex(c => c.kind === "documentsBatchUpdate");
        // Our write isn't on `calls`, but we can verify the call order on the
        // spy: the documentsGet that read the remote text is at index 1, then
        // sidecar was written, then the full-doc documentsGet at index 2, then
        // batchUpdate(s).
        // Specifically: the second documentsGet (full tabs for rewrite) must
        // come AFTER the conflict documentsGet.
        const docsGetIndices = calls
            .map((c, i) => c.kind === "documentsGet" ? i : -1)
            .filter(i => i >= 0);
        expect(docsGetIndices.length).toBeGreaterThanOrEqual(2);
        expect(firstBatchUpdateIdx).toBeGreaterThan(docsGetIndices[1]);

        expect(result.newRevisionId).toBe("rev-201");
        expect(result.conflictSidecarPath).toBe(writes[0].path);
    });

    test("expectedRevisionId null → no conflict path even if remote drifted", async () =>
    {
        const writes = /** @type {Array<{ path: string, contents: string }>} */ ([]);
        const writeFile = async (path, contents) => { writes.push({ path, contents }); };

        const tab = makeTab("body", "tab1");
        const { docsApi, driveApi } = buildSpyApis({
            headBefore: "rev-500",
            headAfter: "rev-501",
            tabs: [tab]
        });

        const result = await push({
            token: "T",
            docId: "doc",
            format: "text",
            localSourceText: "x",
            expectedRevisionId: null,
            localPath: "/proj/s.txt",
            docsApi,
            driveApi,
            writeFile
        });

        expect(writes.length).toBe(0);
        expect(result.conflictSidecarPath).toBe(null);
    });
});

// ── pull happy path + dirty ─────────────────────────────────────────────────

describe("pull — writes local, optional sidecar when dirty", () =>
{
    test("happy path → writes remote text to local path, no sidecar", async () =>
    {
        const writes = /** @type {Array<{ path: string, contents: string }>} */ ([]);
        const writeFile = async (path, contents) => { writes.push({ path, contents }); };

        const tab = makeTab("Doc text from Drive", "tabA", "Mangaplay");
        const { docsApi, driveApi } = buildSpyApis({
            headBefore: "rev-1",
            headAfter: "rev-9",
            tabs: [tab]
        });

        const result = await pull({
            token: "T",
            docId: "doc-1",
            format: "mangaplay",
            localSourceText: "old local",
            localDirty: false,
            localPath: "/proj/script.mangaplay.md",
            docsApi,
            driveApi,
            writeFile
        });

        // One write: the overwrite of the local file.
        expect(writes.length).toBe(1);
        expect(writes[0].path).toBe("/proj/script.mangaplay.md");
        expect(writes[0].contents).toContain("Doc text from Drive");
        // pull only calls filesGet once (post-write), so the spy returns the
        // first value: `headBefore`. That's the "new revision" by definition.
        expect(result.newRevisionId).toBe("rev-1");
        expect(result.conflictSidecarPath).toBe(null);
    });

    test("localDirty=true → sidecar saved BEFORE local overwrite", async () =>
    {
        const writes = /** @type {Array<{ path: string, contents: string }>} */ ([]);
        const writeFile = async (path, contents) => { writes.push({ path, contents }); };

        const tab = makeTab("Drive body", "tabA", "Mangaplay");
        const { docsApi, driveApi } = buildSpyApis({
            headBefore: "rev-50",
            headAfter: "rev-50",
            tabs: [tab]
        });

        const fixedDate = new Date("2026-06-29T15:30:00.000Z");
        const result = await pull({
            token: "T",
            docId: "doc-1",
            format: "mangaplay",
            localSourceText: "DIRTY LOCAL",
            localDirty: true,
            localPath: "C:\\users\\me\\proj\\script.mangaplay.md",
            docsApi,
            driveApi,
            writeFile,
            now: () => fixedDate
        });

        expect(writes.length).toBe(2);
        // First write: sidecar.
        expect(writes[0].path)
            .toBe("C:\\users\\me\\proj\\script.mangaplay.md.local-2026-06-29T15-30-00-000Z.conflict");
        expect(writes[0].contents).toBe("DIRTY LOCAL");
        // Second write: the local overwrite.
        expect(writes[1].path).toBe("C:\\users\\me\\proj\\script.mangaplay.md");
        expect(writes[1].contents).toContain("Drive body");
        expect(result.conflictSidecarPath).toBe(writes[0].path);
    });

    test("mangaplay format picks the Mangaplay tab, not the first tab", async () =>
    {
        const writes = /** @type {Array<{ path: string, contents: string }>} */ ([]);
        const writeFile = async (path, contents) => { writes.push({ path, contents }); };

        const screenplayTab = makeTab("SCREENPLAY RENDER", "tabSP", "Screenplay");
        const mangaplayTab = makeTab("# Page 1\nPanel 1\n", "tabMP", "Mangaplay");

        const { docsApi, driveApi } = buildSpyApis({
            headBefore: "r1",
            headAfter: "r2",
            tabs: [screenplayTab, mangaplayTab]
        });

        await pull({
            token: "T",
            docId: "doc-1",
            format: "mangaplay",
            localSourceText: "",
            localDirty: false,
            localPath: "/p/s.mangaplay.md",
            docsApi,
            driveApi,
            writeFile
        });

        expect(writes.length).toBe(1);
        expect(writes[0].contents).toContain("Panel 1");
        expect(writes[0].contents).not.toContain("SCREENPLAY RENDER");
    });
});

// ── BUG-004: Mangaplay tab missing ──────────────────────────────────────────

describe("push — Mangaplay tab missing (BUG-004)", () =>
{
    test("throws MangaplayTabMissing instead of silently degrading", async () =>
    {
        const writes = /** @type {Array<{ path: string, contents: string }>} */ ([]);
        const writeFile = async (path, contents) => { writes.push({ path, contents }); };

        // Doc has only a Screenplay tab — no Mangaplay tab.
        const screenplayTab = makeTab("old screenplay", "tabSP", "Screenplay");
        const { calls, docsApi, driveApi } = buildSpyApis({
            headBefore: "rev-1",
            headAfter: "rev-2",
            tabs: [screenplayTab]
        });

        await expect(push({
            token: "T",
            docId: "doc-1",
            format: "mangaplay",
            localSourceText: "# Page 1\n\nPanel 1\n",
            expectedRevisionId: "rev-1",
            localPath: "/proj/script.mangaplay.md",
            docsApi,
            driveApi,
            writeFile
        })).rejects.toMatchObject({ name: "MangaplayTabMissing" });

        // Data-loss invariant: zero batchUpdate calls after the throw.
        // The original BUG-004 was push silently writing the screenplay
        // tab then reporting success — locking this in prevents regression.
        expect(calls.filter(c => c.kind === "documentsBatchUpdate").length).toBe(0);
    });

    test("stale expectedRevisionId AND missing Mangaplay tab — throws after writing remote.conflict sidecar", async () =>
    {
        const writes = /** @type {Array<{ path: string, contents: string }>} */ ([]);
        const writeFile = async (path, contents) => { writes.push({ path, contents }); };

        // Remote drifted (headRev "rev-2" != expectedRevisionId "rev-1")
        // AND the Mangaplay tab is missing. The sidecar-before-throw
        // ordering means the .remote.conflict file gets written, then
        // the tab-check throws. See comment at push-pull.js:211.
        const screenplayTab = makeTab("remote screenplay body", "tabSP", "Screenplay");
        const { calls, docsApi, driveApi } = buildSpyApis({
            headBefore: "rev-2",
            headAfter: "rev-3",
            tabs: [screenplayTab]
        });

        await expect(push({
            token: "T",
            docId: "doc-1",
            format: "mangaplay",
            localSourceText: "# Page 1\n\nPanel 1\n",
            expectedRevisionId: "rev-1",
            localPath: "/proj/script.mangaplay.md",
            docsApi,
            driveApi,
            writeFile
        })).rejects.toMatchObject({ name: "MangaplayTabMissing" });

        // Sidecar WAS written (the harmless-wart documented in the source).
        // For mangaplay format, the sidecar fetches the (missing) Mangaplay
        // tab's text, which yields empty — but the file is still emitted.
        const sidecarWrites = writes.filter(w => w.path.includes(".remote-") && w.path.endsWith(".conflict"));
        expect(sidecarWrites.length).toBe(1);

        // But no batchUpdate ran — the doc itself is unchanged.
        expect(calls.filter(c => c.kind === "documentsBatchUpdate").length).toBe(0);
    });

    test("non-mangaplay format with single tab still pushes", async () =>
    {
        // Sanity — fountain / text path must remain unaffected by the
        // mangaplay-tab check.
        const writes = /** @type {Array<{ path: string, contents: string }>} */ ([]);
        const writeFile = async (path, contents) => { writes.push({ path, contents }); };

        const onlyTab = makeTab("old body", "tab1");
        const { docsApi, driveApi } = buildSpyApis({
            headBefore: "rev-1",
            headAfter: "rev-2",
            tabs: [onlyTab]
        });

        const result = await push({
            token: "T",
            docId: "doc-1",
            format: "fountain",
            localSourceText: "FADE IN:\n",
            expectedRevisionId: "rev-1",
            localPath: "/proj/script.fountain",
            docsApi,
            driveApi,
            writeFile
        });

        expect(result.newRevisionId).toBe("rev-2");
    });
});

describe("pull — Mangaplay tab missing (BUG-004)", () =>
{
    test("throws MangaplayTabMissing instead of blanking local file", async () =>
    {
        const writes = /** @type {Array<{ path: string, contents: string }>} */ ([]);
        const writeFile = async (path, contents) => { writes.push({ path, contents }); };

        const screenplayTab = makeTab("screenplay only", "tabSP", "Screenplay");
        const { docsApi, driveApi } = buildSpyApis({
            headBefore: "rev-1",
            headAfter: "rev-2",
            tabs: [screenplayTab]
        });

        await expect(pull({
            token: "T",
            docId: "doc-1",
            format: "mangaplay",
            localSourceText: "PRECIOUS LOCAL WORK",
            localDirty: false,
            localPath: "/proj/script.mangaplay.md",
            docsApi,
            driveApi,
            writeFile
        })).rejects.toMatchObject({ name: "MangaplayTabMissing" });

        // No write to args.localPath — local file is untouched.
        const overwrites = writes.filter(w => w.path === "/proj/script.mangaplay.md");
        expect(overwrites.length).toBe(0);
    });

    test("localDirty=true sidecar exists but main file NOT overwritten on throw", async () =>
    {
        const writes = /** @type {Array<{ path: string, contents: string }>} */ ([]);
        const writeFile = async (path, contents) => { writes.push({ path, contents }); };

        const screenplayTab = makeTab("screenplay only", "tabSP", "Screenplay");
        const { docsApi, driveApi } = buildSpyApis({
            headBefore: "rev-1",
            headAfter: "rev-2",
            tabs: [screenplayTab]
        });

        const fixedDate = new Date("2026-06-29T18:00:00.000Z");
        await expect(pull({
            token: "T",
            docId: "doc-1",
            format: "mangaplay",
            localSourceText: "DIRTY LOCAL",
            localDirty: true,
            localPath: "/proj/script.mangaplay.md",
            docsApi,
            driveApi,
            writeFile,
            now: () => fixedDate
        })).rejects.toMatchObject({ name: "MangaplayTabMissing" });

        // Sidecar was written before the throw — harmless, user can delete.
        expect(writes.length).toBe(1);
        expect(writes[0].path)
            .toBe("/proj/script.mangaplay.md.local-2026-06-29T18-00-00-000Z.conflict");
        expect(writes[0].contents).toBe("DIRTY LOCAL");
        // Critical: the main local file was NOT overwritten.
        const overwrites = writes.filter(w => w.path === "/proj/script.mangaplay.md");
        expect(overwrites.length).toBe(0);
    });

    test("non-mangaplay format with single tab still pulls", async () =>
    {
        const writes = /** @type {Array<{ path: string, contents: string }>} */ ([]);
        const writeFile = async (path, contents) => { writes.push({ path, contents }); };

        const onlyTab = makeTab("Drive body", "tab1");
        const { docsApi, driveApi } = buildSpyApis({
            headBefore: "rev-1",
            headAfter: "rev-2",
            tabs: [onlyTab]
        });

        await pull({
            token: "T",
            docId: "doc-1",
            format: "fountain",
            localSourceText: "",
            localDirty: false,
            localPath: "/proj/script.fountain",
            docsApi,
            driveApi,
            writeFile
        });

        expect(writes.length).toBe(1);
        expect(writes[0].path).toBe("/proj/script.fountain");
        expect(writes[0].contents).toContain("Drive body");
    });
});

// ── Fixture parity: tabwalk ───────────────────────────────────────────────────

describe("extractTextFromTab — fixture parity", () =>
{
    for (const c of tabwalkFixtures.extract_text)
    {
        test(c.label, () =>
        {
            expect(extractTextFromTab(c.tab)).toBe(c.expected);
        });
    }
});

describe("findTabByName — fixture parity", () =>
{
    for (const c of tabwalkFixtures.find_tab_by_name)
    {
        test(c.label, () =>
        {
            const result = findTabByName(c.tabs, c.name);
            if (c.expected === null)
            {
                expect(result).toBeNull();
            }
            else
            {
                expect(result).toEqual(c.expected);
            }
        });
    }
});

// ── Fixture parity: sidecar stamp ────────────────────────────────────────────

describe("_stampForFilename (sidecar) — fixture parity", () =>
{
    for (const c of sidecarFixtures)
    {
        test(`iso: ${c.iso} is_remote: ${c.is_remote}`, () =>
        {
            // Test the stamp via the expected_stamp value: Date.toISOString() of
            // the fixed ISO date should produce expected_stamp when transformed.
            const date = new Date(c.iso);
            const stamp = date.toISOString().replace(/[:.]/g, "-");
            expect(stamp).toBe(c.expected_stamp);

            // Build full conflict filename matching the expected_filename.
            const side = c.is_remote ? "remote" : "local";
            const filename = `${c.basename}.${side}-${stamp}.conflict`;
            expect(filename).toBe(c.expected_filename);
        });
    }
});
