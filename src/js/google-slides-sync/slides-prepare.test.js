/**
 * Unit tests for slides-prepare.js.
 *
 * Not wired into the harness `bun run test` script — invoke directly:
 *   bun test ./src/js/google-slides-sync/slides-prepare.test.js
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
    prepareSlidesSync,
    commitSlidesSync,
    commitLocalUpload,
    extractLocalPageIds,
    extractLocalPageContents,
    computePageTextCrc,
    matchScriptToSlides,
    runCommit,
    uploadEnabled,
    verifyDeckText,
    _setInvokeForTest,
    _setFetchForTest,
} from "./slides-prepare.js";
import { crc32Hex } from "../../../../core/util/slides-scan.js";

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Build a stub authClient that always resolves to `token`.
 * @param {string | null} token
 */
function stubAuth(token)
{
    return {
        async getAccessToken() { return token; },
    };
}

/**
 * Convenience — assemble a `presentations.get` REST payload with one image
 * per slide, each carrying a `# PAGE N` marker.
 *
 * @param {Array<{ pageId: string, imgBytes?: Uint8Array | null, storedCrc?: string | null }>} slides
 * @param {string} [title]
 */
function buildPresentation(slides, title = "Deck")
{
    return {
        title,
        pageSize: {
            width:  { magnitude: 9144000, unit: "EMU" },
            height: { magnitude: 5143500, unit: "EMU" },
        },
        slides: slides.map((s, i) =>
        {
            const els = [];
            // # PAGE marker shape (left column)
            els.push({
                objectId: `shape-${i}`,
                shape: {
                    text: {
                        textElements: [
                            { textRun: { content: `# PAGE ${s.pageId}\n` } },
                        ],
                    },
                },
            });
            // Image element in the top-right, large enough to survive filter.
            if (s.imgBytes !== null)
            {
                let description = "";
                if (s.storedCrc)
                {
                    description = `mps-image-crc:${s.storedCrc}`;
                }
                else if (s.imgBytes)
                {
                    description = `mps-image-crc:${crc32Hex(s.imgBytes)}`;
                }
                els.push({
                    objectId: `img-${i}`,
                    // Position: left = 60% of page width, top = 10% of page height.
                    transform: {
                        translateX: 9144000 * 0.6,
                        translateY: 5143500 * 0.1,
                        scaleX: 1,
                        scaleY: 1,
                    },
                    size: {
                        width:  { magnitude: 3000000, unit: "EMU" },
                        height: { magnitude: 2000000, unit: "EMU" },
                    },
                    image: {
                        contentUrl: `https://example.test/img/${s.pageId}.png`,
                    },
                    description,
                });
            }
            return {
                objectId: `slide-${i}`,
                pageElements: els,
            };
        }),
    };
}

/**
 * Duplicate the marker shape on a specific slide by injecting a second
 * shape with the same header on the following slide (so `scanSlidePages`
 * emits a DUPLICATE error for it).
 */
function buildPresentationWithDup(pageIds)
{
    const base = buildPresentation(pageIds.map((p) => ({ pageId: p, imgBytes: new Uint8Array([1, 2, 3]) })));
    // Rewrite the last slide's marker to the first slide's pageId.
    const lastIdx = base.slides.length - 1;
    const firstMarker = base.slides[0].pageElements[0];
    base.slides[lastIdx].pageElements[0] = {
        objectId: `shape-dup-${lastIdx}`,
        shape: {
            text: {
                textElements: [
                    { textRun: { content: firstMarker.shape.text.textElements[0].textRun.content } },
                ],
            },
        },
    };
    return base;
}

/**
 * Recent refresh timestamp.
 */
function freshTs() { return Date.now(); }

// ────────────────────────────────────────────────────────────────────────
// extractLocalPageIds
// ────────────────────────────────────────────────────────────────────────

describe("extractLocalPageIds", () =>
{
    test("returns [] for null / missing pages", () =>
    {
        expect(extractLocalPageIds(null)).toEqual([]);
        expect(extractLocalPageIds({})).toEqual([]);
        expect(extractLocalPageIds({ pages: null })).toEqual([]);
    });

    test("plain page numbers → String(n)", () =>
    {
        const script = { pages: [
            { baseNumber: 1 },
            { baseNumber: 2 },
            { baseNumber: 17 },
        ] };
        expect(extractLocalPageIds(script)).toEqual(["1", "2", "17"]);
    });

    test("suffix upper-cased and joined with dash", () =>
    {
        const script = { pages: [
            { baseNumber: 1, suffix: "COVER" },
            { baseNumber: 1, suffix: "II" },
            { baseNumber: 10, suffix: "2" },
            { baseNumber: 3, suffix: "cover" },  // lower → upper
        ] };
        expect(extractLocalPageIds(script)).toEqual(
            ["1-COVER", "1-II", "10-2", "3-COVER"],
        );
    });

    test("skips pages without a numeric baseNumber", () =>
    {
        const script = { pages: [
            { baseNumber: 1 },
            { baseNumber: "nope" },
            null,
            { baseNumber: 2 },
        ] };
        expect(extractLocalPageIds(script)).toEqual(["1", "2"]);
    });
});

// ────────────────────────────────────────────────────────────────────────
// matchScriptToSlides
// ────────────────────────────────────────────────────────────────────────

describe("matchScriptToSlides", () =>
{
    test("identical arrays → all paired", () =>
    {
        const slidePages = [
            { fullId: "1" }, { fullId: "2" }, { fullId: "3" },
        ];
        const local = ["1", "2", "3"];
        const r = matchScriptToSlides(local, slidePages);
        expect(r.paired).toHaveLength(3);
        expect(r.paired.map((x) => x.localPageId)).toEqual(["1", "2", "3"]);
        expect(r.pairedDifferent).toEqual([]);
        expect(r.localOnly).toEqual([]);
        expect(r.deckOutOfScope).toEqual([]);
    });

    test("localOnly + deckOutOfScope diverge", () =>
    {
        const slidePages = [
            { fullId: "1" }, { fullId: "2" }, { fullId: "3" }, { fullId: "8" },
        ];
        const local = ["1", "2", "3", "6", "7"];
        const r = matchScriptToSlides(local, slidePages);
        expect(r.paired.map((x) => x.localPageId)).toEqual(["1", "2", "3"]);
        expect(r.pairedDifferent).toEqual([]);
        expect(r.localOnly).toEqual(["6", "7"]);
        expect(r.deckOutOfScope).toEqual(["8"]);
    });

    test("empty local + non-empty deck", () =>
    {
        const r = matchScriptToSlides([], [{ fullId: "1" }]);
        expect(r.paired).toEqual([]);
        expect(r.pairedDifferent).toEqual([]);
        expect(r.localOnly).toEqual([]);
        expect(r.deckOutOfScope).toEqual(["1"]);
    });

    test("11 local vs 75 deck, all local paired → deckOutOfScope = 64", () =>
    {
        const local = [];
        for (let i = 53; i <= 63; i++) local.push(String(i));
        const slidePages = [];
        for (let i = 1; i <= 75; i++) slidePages.push({ fullId: String(i) });
        const r = matchScriptToSlides(local, slidePages);
        expect(r.paired.map((x) => x.localPageId)).toEqual(local);
        expect(r.pairedDifferent).toEqual([]);
        expect(r.localOnly).toEqual([]);
        expect(r.deckOutOfScope).toHaveLength(64);
    });

    test("text-diff: identical local + deck → paired, no pairedDifferent", () =>
    {
        const slidePages = [
            { fullId: "1", headerText: "# Page 1\nHero enters.\n", slideIndex: 1 },
            { fullId: "2", headerText: "# Page 2\nExplosion.\n", slideIndex: 2 },
        ];
        const local = ["1", "2"];
        const localContent = new Map([
            ["1", "# Page 1\nHero enters.\n"],
            ["2", "# Page 2\nExplosion.\n"],
        ]);
        const r = matchScriptToSlides(local, slidePages, localContent);
        expect(r.paired).toHaveLength(2);
        expect(r.pairedDifferent).toEqual([]);
        expect(r.warnings).toEqual([]);
    });

    test("text-diff: casing difference → pairedDifferent", () =>
    {
        const slidePages = [
            { fullId: "1", headerText: "# Page 1\nHero enters.\n", slideIndex: 1 },
        ];
        const localContent = new Map([
            ["1", "# Page 1\nHERO ENTERS.\n"],
        ]);
        const r = matchScriptToSlides(["1"], slidePages, localContent);
        expect(r.pairedDifferent).toEqual(["1"]);
        expect(r.warnings).toEqual([]);
    });

    test("text-diff: deck empty → pairedDifferent + NO_DECK_HEADER_TEXT warning", () =>
    {
        const slidePages = [
            { fullId: "1", headerText: "# PAGE 1\n", slideIndex: 3 },
        ];
        const localContent = new Map([
            ["1", "# Page 1\nHero enters.\n"],
        ]);
        const r = matchScriptToSlides(["1"], slidePages, localContent);
        expect(r.pairedDifferent).toEqual(["1"]);
        expect(r.warnings).toHaveLength(1);
        expect(r.warnings[0].kind).toBe("NO_DECK_HEADER_TEXT");
        expect(r.warnings[0].pageId).toBe("1");
        expect(r.warnings[0].slideIndex).toBe(3);
    });

    test("text-diff: CRLF vs LF equivalence (no diff on Windows line endings)", () =>
    {
        const slidePages = [
            { fullId: "1", headerText: "# Page 1\nHero enters.\n", slideIndex: 1 },
        ];
        const localContent = new Map([
            ["1", "# Page 1\r\nHero enters.\r\n"],
        ]);
        const r = matchScriptToSlides(["1"], slidePages, localContent);
        expect(r.pairedDifferent).toEqual([]);
    });
});

describe("computePageTextCrc", () =>
{
    test("empty / null → sentinel 00000000", () =>
    {
        expect(computePageTextCrc("")).toBe("00000000");
        expect(computePageTextCrc(null)).toBe("00000000");
        expect(computePageTextCrc(undefined)).toBe("00000000");
    });

    test("CRLF and LF hash the same", () =>
    {
        const a = computePageTextCrc("# Page 1\nAction.\n");
        const b = computePageTextCrc("# Page 1\r\nAction.\r\n");
        expect(a).toBe(b);
    });

    test("case is significant", () =>
    {
        const lower = computePageTextCrc("# Page 1\nhero.\n");
        const upper = computePageTextCrc("# Page 1\nHERO.\n");
        expect(lower).not.toBe(upper);
    });
});

describe("extractLocalPageContents", () =>
{
    test("maps fullId → rawText for each page", () =>
    {
        const script = {
            pages: [
                { baseNumber: 1, suffix: "", rawText: "# Page 1\nA.\n" },
                { baseNumber: 2, suffix: "COVER", rawText: "# Page 2 COVER\nB.\n" },
            ],
        };
        const m = extractLocalPageContents(script);
        expect(m.get("1")).toBe("# Page 1\nA.\n");
        expect(m.get("2-COVER")).toBe("# Page 2 COVER\nB.\n");
    });

    test("pages without rawText are skipped (no map entry)", () =>
    {
        const m = extractLocalPageContents({ pages: [{ baseNumber: 1 }] });
        expect(m.has("1")).toBe(false);
    });

    test("nullish script → empty map", () =>
    {
        expect(extractLocalPageContents(null).size).toBe(0);
        expect(extractLocalPageContents({}).size).toBe(0);
    });
});

// ────────────────────────────────────────────────────────────────────────
// prepareSlidesSync
// ────────────────────────────────────────────────────────────────────────

describe("prepareSlidesSync (phase A — read-only)", () =>
{
    /** @type {Array<{ cmd: string, args: any }>} */
    let invokeCalls;
    /** @type {number} */
    let fetchCalls;

    /**
     * @param {Record<string, (args: any) => any>} handlers
     */
    function installInvoke(handlers)
    {
        invokeCalls = [];
        _setInvokeForTest(async (cmd, args) =>
        {
            invokeCalls.push({ cmd, args });
            const fn = handlers[cmd];
            if (!fn) throw new Error(`unexpected invoke: ${cmd}`);
            return fn(args);
        });
    }

    beforeEach(() =>
    {
        invokeCalls = [];
        fetchCalls = 0;
        // Phase A must never fetch — trip the counter if anything tries.
        globalThis.fetch = async () =>
        {
            fetchCalls++;
            throw new Error("phase A must not fetch");
        };
    });

    afterEach(() =>
    {
        globalThis.fetch = ORIGINAL_FETCH;
        _setInvokeForTest(null);
    });

    test("empty deck → aborted EMPTY_DECK, no invoke calls", async () =>
    {
        installInvoke({});  // any invoke would blow up.

        const report = await prepareSlidesSync({
            presentation: { title: "Empty", slides: [] },
            refreshedAt: freshTs(),
            presentationId: "pres-empty",
            script: { pages: [{ baseNumber: 1 }] },
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
        });

        expect(report.aborted).toEqual({
            reason: "EMPTY_DECK",
            detail: "The presentation has no slides.",
        });
        expect(report.presentationTitle).toBe("Empty");
        expect(report.presentationId).toBe("pres-empty");
        expect(report.deckPages).toEqual([]);
        expect(report.localPages).toEqual([]);
        expect(report.imagesFound).toBe(0);
        expect(report.imagesCached).toBe(0);
        expect(report.imagesToDownload).toBe(0);
        expect(report.toDownload).toEqual([]);
        expect(report.imagesDownloaded).toBe(0);
        expect(report.imagesFailed).toBe(0);
        expect(report.warnings).toEqual([]);
        expect(report.mismatch).toBeNull();
        expect(invokeCalls).toEqual([]);
        expect(fetchCalls).toBe(0);
    });

    test("empty presentation.slides is missing → aborted EMPTY_DECK", async () =>
    {
        installInvoke({});
        const report = await prepareSlidesSync({
            presentation: { title: "NoSlides" },
            refreshedAt: freshTs(),
            presentationId: "pid",
            script: { pages: [] },
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
        });
        expect(report.aborted?.reason).toBe("EMPTY_DECK");
    });

    test("happy path: 3 pages, all cached (CRC match)", async () =>
    {
        const imgA = new Uint8Array([10, 11, 12]);
        const imgB = new Uint8Array([20, 21, 22]);
        const imgC = new Uint8Array([30, 31, 32]);
        const crcA = crc32Hex(imgA);
        const crcB = crc32Hex(imgB);
        const crcC = crc32Hex(imgC);
        const presentation = buildPresentation([
            { pageId: "1", imgBytes: imgA, storedCrc: crcA },
            { pageId: "2", imgBytes: imgB, storedCrc: crcB },
            { pageId: "3", imgBytes: imgC, storedCrc: crcC },
        ], "Happy");

        installInvoke({
            slides_deck_stat: () => ({
                manifest: {
                    "1": { crc: crcA, path: `1.png` },
                    "2": { crc: crcB, path: `2.png` },
                    "3": { crc: crcC, path: `3.png` },
                },
                orphanPaths: [],
                cacheDirExists: true,
            }),
        });

        const report = await prepareSlidesSync({
            presentation,
            refreshedAt: freshTs(),
            presentationId: "pid-happy",
            script: { pages: [{ baseNumber: 1 }, { baseNumber: 2 }, { baseNumber: 3 }] },
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
        });

        expect(report.aborted).toBeUndefined();
        expect(report.presentationTitle).toBe("Happy");
        expect(report.deckPages).toEqual(["1", "2", "3"]);
        expect(report.localPages).toEqual(["1", "2", "3"]);
        expect(report.imagesFound).toBe(3);
        expect(report.imagesCached).toBe(3);
        expect(report.imagesToDownload).toBe(0);
        expect(report.toDownload).toEqual([]);
        expect(report.imagesDownloaded).toBe(0);
        expect(report.imagesFailed).toBe(0);
        expect(report.warnings).toEqual([]);
        expect(report.mismatch).toBeNull();

        // Phase A only reads stat — no writes, no gc, no fetches.
        const cmds = invokeCalls.map((c) => c.cmd);
        expect(cmds).toEqual(["slides_deck_stat"]);
        expect(fetchCalls).toBe(0);
    });

    test("one slide missing an image → NO_IMAGE_ON_SLIDE warning", async () =>
    {
        const imgA = new Uint8Array([1, 2, 3]);
        const crcA = crc32Hex(imgA);
        const presentation = buildPresentation([
            { pageId: "1", imgBytes: imgA, storedCrc: crcA },
            { pageId: "2", imgBytes: null }, // no image on slide 2.
        ], "MissingImg");

        installInvoke({
            slides_deck_stat: () => ({
                manifest: { "1": { crc: crcA, path: `1.png` } },
                orphanPaths: [],
                cacheDirExists: true,
            }),
        });

        const report = await prepareSlidesSync({
            presentation,
            refreshedAt: freshTs(),
            presentationId: "pid-noimg",
            script: { pages: [{ baseNumber: 1 }, { baseNumber: 2 }] },
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
        });

        expect(report.imagesFound).toBe(1);
        expect(report.imagesCached).toBe(1);
        expect(report.imagesToDownload).toBe(0);
        expect(report.imagesDownloaded).toBe(0);
        expect(report.warnings.length).toBe(1);
        expect(report.warnings[0].kind).toBe("NO_IMAGE_ON_SLIDE");
        expect(report.warnings[0].pageId).toBe("2");
    });

    test("duplicate PAGE marker → DUPLICATE warning propagated", async () =>
    {
        const presentation = buildPresentationWithDup(["1", "2", "3"]);
        installInvoke({
            slides_deck_stat: () => ({ manifest: {}, orphanPaths: [], cacheDirExists: false }),
        });

        const report = await prepareSlidesSync({
            presentation,
            refreshedAt: freshTs(),
            presentationId: "pid-dup",
            script: { pages: [{ baseNumber: 1 }, { baseNumber: 2 }] },
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
        });

        const dupWarn = report.warnings.find((w) => w.kind === "DUPLICATE");
        expect(dupWarn).toBeTruthy();
        expect(dupWarn?.slideIndex).toBe(3);
        // No writes in Phase A.
        expect(invokeCalls.some((c) => c.cmd === "slides_deck_write")).toBe(false);
        expect(invokeCalls.some((c) => c.cmd === "slides_deck_gc")).toBe(false);
    });

    test("plan populated for uncached page — no writes in Phase A", async () =>
    {
        // Presentation has one page, no storedCrc stamp — needs download.
        const presentation = {
            title: "OnePage",
            pageSize: {
                width:  { magnitude: 9144000, unit: "EMU" },
                height: { magnitude: 5143500, unit: "EMU" },
            },
            slides: [
                {
                    objectId: "slide-0",
                    pageElements: [
                        {
                            objectId: "shape-0",
                            shape: {
                                text: {
                                    textElements: [
                                        { textRun: { content: "# PAGE 1\n" } },
                                    ],
                                },
                            },
                        },
                        {
                            objectId: "img-0",
                            transform: { translateX: 9144000 * 0.6, translateY: 5143500 * 0.1, scaleX: 1, scaleY: 1 },
                            size: {
                                width:  { magnitude: 3000000, unit: "EMU" },
                                height: { magnitude: 2000000, unit: "EMU" },
                            },
                            image: { contentUrl: "https://example.test/img-1.png" },
                            description: "",  // no CRC stamp → needs download.
                        },
                    ],
                },
            ],
        };

        installInvoke({
            slides_deck_stat: () => ({ manifest: {}, orphanPaths: [], cacheDirExists: false }),
        });

        const report = await prepareSlidesSync({
            presentation,
            refreshedAt: freshTs(),
            presentationId: "pid-dl",
            script: { pages: [{ baseNumber: 1 }] },
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
        });

        expect(report.aborted).toBeUndefined();
        expect(report.imagesFound).toBe(1);
        expect(report.imagesCached).toBe(0);
        expect(report.imagesToDownload).toBe(1);
        expect(report.toDownload).toEqual([
            { pageId: "1", slidePageFullId: "1" },
        ]);
        expect(report.imagesDownloaded).toBe(0);
        expect(report.imagesFailed).toBe(0);
        expect(report.warnings).toEqual([]);

        // NO writes, NO gc, NO fetches during Phase A.
        expect(invokeCalls.some((c) => c.cmd === "slides_deck_write")).toBe(false);
        expect(invokeCalls.some((c) => c.cmd === "slides_deck_gc")).toBe(false);
        expect(fetchCalls).toBe(0);
    });

    test("cached page with no deck-side storedCrc stamp is still skipped", async () =>
    {
        const imgA = new Uint8Array([1, 2, 3]);
        const crcA = crc32Hex(imgA);
        const presentation = buildPresentation([
            { pageId: "1", imgBytes: imgA, storedCrc: null },
        ], "NoStamp");

        installInvoke({
            slides_deck_stat: () => ({
                manifest: { "1": { crc: crcA, path: "1.png" } },
                orphanPaths: [],
                cacheDirExists: true,
            }),
        });

        const report = await prepareSlidesSync({
            presentation,
            refreshedAt: freshTs(),
            presentationId: "pid-nostamp",
            script: { pages: [{ baseNumber: 1 }] },
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
        });

        expect(report.imagesFound).toBe(1);
        expect(report.imagesCached).toBe(1);
        expect(report.imagesToDownload).toBe(0);
        expect(report.toDownload).toEqual([]);
        expect(fetchCalls).toBe(0);
    });

    test("mismatch: local has extras, deck has extras", async () =>
    {
        const imgA = new Uint8Array([1]);
        const crcA = crc32Hex(imgA);
        const presentation = buildPresentation([
            { pageId: "1", imgBytes: imgA, storedCrc: crcA },
            { pageId: "8", imgBytes: imgA, storedCrc: crcA },
        ]);
        installInvoke({
            slides_deck_stat: () => ({
                manifest: {
                    "1": { crc: crcA, path: `1.png` },
                },
                orphanPaths: [],
                cacheDirExists: true,
            }),
        });

        const report = await prepareSlidesSync({
            presentation,
            refreshedAt: freshTs(),
            presentationId: "pid-mismatch",
            script: { pages: [
                { baseNumber: 1 },
                { baseNumber: 6 },
                { baseNumber: 7 },
            ] },
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
        });

        expect(report.mismatch).not.toBeNull();
        expect(report.mismatch?.pairedDifferent).toEqual([]);
        expect(report.mismatch?.localOnly).toEqual(["6", "7"]);
        expect(report.mismatch?.deckOutOfScope).toEqual(["8"]);
        // Page 8 is deckOutOfScope (unpaired) so no plan entry for it.
        expect(report.toDownload).toEqual([]);
    });
});

// ────────────────────────────────────────────────────────────────────────
// commitSlidesSync (Phase B — downloads + GC)
// ────────────────────────────────────────────────────────────────────────

describe("commitSlidesSync (phase B)", () =>
{
    /** @type {Array<{ cmd: string, args: any }>} */
    let invokeCalls;

    /**
     * @param {Record<string, (args: any) => any>} handlers
     */
    function installInvoke(handlers)
    {
        invokeCalls = [];
        _setInvokeForTest(async (cmd, args) =>
        {
            invokeCalls.push({ cmd, args });
            const fn = handlers[cmd];
            if (!fn) throw new Error(`unexpected invoke: ${cmd}`);
            return fn(args);
        });
    }

    beforeEach(() =>
    {
        invokeCalls = [];
    });

    afterEach(() =>
    {
        globalThis.fetch = ORIGINAL_FETCH;
        _setInvokeForTest(null);
        _setFetchForTest(null);
    });

    test("runs Phase A then Phase B: downloads + writes + GC", async () =>
    {
        const bodyBytes = new Uint8Array([9, 8, 7, 6, 5]);
        const expectedCrc = crc32Hex(bodyBytes);

        const presentation = {
            title: "OnePage",
            pageSize: {
                width:  { magnitude: 9144000, unit: "EMU" },
                height: { magnitude: 5143500, unit: "EMU" },
            },
            slides: [
                {
                    objectId: "slide-0",
                    pageElements: [
                        {
                            objectId: "shape-0",
                            shape: {
                                text: { textElements: [{ textRun: { content: "# PAGE 1\n" } }] },
                            },
                        },
                        {
                            objectId: "img-0",
                            transform: { translateX: 9144000 * 0.6, translateY: 5143500 * 0.1, scaleX: 1, scaleY: 1 },
                            size: {
                                width:  { magnitude: 3000000, unit: "EMU" },
                                height: { magnitude: 2000000, unit: "EMU" },
                            },
                            image: { contentUrl: "https://example.test/img-1.png" },
                            description: "",
                        },
                    ],
                },
            ],
        };

        installInvoke({
            slides_deck_stat: () => ({ manifest: {}, orphanPaths: [], cacheDirExists: false }),
            slides_deck_write: () => ({ path: "/tmp/1.png" }),
            slides_deck_gc: () => ({ removedPaths: [], kept: 1 }),
        });

        // Phase A — no fetch.
        globalThis.fetch = async () => { throw new Error("phase A must not fetch"); };
        _setFetchForTest(async () => { throw new Error("phase A must not fetch"); });
        const report = await prepareSlidesSync({
            presentation,
            refreshedAt: freshTs(),
            presentationId: "pid-dl",
            script: { pages: [{ baseNumber: 1 }] },
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
        });
        expect(report.imagesToDownload).toBe(1);
        expect(report.imagesDownloaded).toBe(0);
        expect(invokeCalls.some((c) => c.cmd === "slides_deck_write")).toBe(false);
        expect(invokeCalls.some((c) => c.cmd === "slides_deck_gc")).toBe(false);

        // Phase B — image fetch fires (no Authorization header) + write + gc.
        // Image fetch runs through the injected tauri-plugin-http seam so
        // tests must swap `_setFetchForTest`, not `globalThis.fetch`.
        _setFetchForTest(async (url, init) =>
        {
            expect(url).toBe("https://example.test/img-1.png");
            // CORS fix: no auth header on image fetch.
            expect(init?.headers).toBeUndefined();
            return /** @type {any} */ ({
                status: 200,
                arrayBuffer: async () => bodyBytes.buffer.slice(
                    bodyBytes.byteOffset,
                    bodyBytes.byteOffset + bodyBytes.byteLength,
                ),
            });
        });

        const committed = await commitSlidesSync({
            report,
            presentation,
            presentationId: "pid-dl",
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
        });

        expect(committed).toBe(report);
        expect(committed.aborted).toBeUndefined();
        expect(committed.imagesDownloaded).toBe(1);
        expect(committed.imagesFailed).toBe(0);
        expect(committed.warnings).toEqual([]);

        const writeCall = invokeCalls.find((c) => c.cmd === "slides_deck_write");
        expect(writeCall).toBeTruthy();
        expect(writeCall?.args.pageId).toBe("1");
        expect(writeCall?.args.crc).toBe(expectedCrc);
        expect(writeCall?.args.presentationId).toBe("pid-dl");
        expect(writeCall?.args.projectPath).toBe("/tmp/proj");
        expect(Array.isArray(writeCall?.args.bytes)).toBe(true);
        expect(writeCall?.args.bytes.length).toBe(bodyBytes.length);

        const gcCall = invokeCalls.find((c) => c.cmd === "slides_deck_gc");
        expect(gcCall).toBeTruthy();
        expect(new Set(gcCall?.args.keepPageIds)).toEqual(new Set(["1"]));
    });

    test("all cached: Phase B still runs GC, preserves cached ids", async () =>
    {
        const imgA = new Uint8Array([10, 11, 12]);
        const crcA = crc32Hex(imgA);
        const presentation = buildPresentation([
            { pageId: "1", imgBytes: imgA, storedCrc: crcA },
        ], "AllCached");

        installInvoke({
            slides_deck_stat: () => ({
                manifest: { "1": { crc: crcA, path: `1.png` } },
                orphanPaths: [],
                cacheDirExists: true,
            }),
            slides_deck_gc: () => ({ removedPaths: [], kept: 1 }),
        });

        globalThis.fetch = async () => { throw new Error("must not fetch"); };
        _setFetchForTest(async () => { throw new Error("must not fetch"); });
        const report = await prepareSlidesSync({
            presentation,
            refreshedAt: freshTs(),
            presentationId: "pid-cached",
            script: { pages: [{ baseNumber: 1 }] },
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
        });
        expect(report.imagesToDownload).toBe(0);
        expect(report.imagesCached).toBe(1);

        await commitSlidesSync({
            report,
            presentation,
            presentationId: "pid-cached",
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
        });

        const gcCall = invokeCalls.find((c) => c.cmd === "slides_deck_gc");
        expect(gcCall).toBeTruthy();
        expect(new Set(gcCall?.args.keepPageIds)).toEqual(new Set(["1"]));
    });
});

// ────────────────────────────────────────────────────────────────────────
// commitLocalUpload (feature-flagged upload path)
// ────────────────────────────────────────────────────────────────────────

describe("commitLocalUpload", () =>
{
    /** @type {typeof globalThis.fetch} */
    let origFetch;
    beforeEach(() => { origFetch = globalThis.fetch; });
    afterEach(() =>
    {
        _setInvokeForTest(null);
        globalThis.fetch = origFetch;
    });

    test("feature flag defaults to true", () =>
    {
        expect(uploadEnabled).toBe(true);
    });

    test("no pairedDifferent and no localOnly → no work, no warnings", async () =>
    {
        /** @type {Array<{cmd: string, args: any}>} */
        const calls = [];
        _setInvokeForTest(async (cmd, args) => { calls.push({ cmd, args }); return {}; });

        const report = {
            presentationTitle: "T",
            presentationId: "P",
            deckPages: ["1", "2"],
            localPages: ["1", "2"],
            imagesFound: 0,
            imagesCached: 0,
            imagesToDownload: 0,
            imagesDownloaded: 0,
            imagesFailed: 0,
            toDownload: [],
            warnings: [],
            mismatch: {
                pairedDifferent: [],
                localOnly: [],
                deckOutOfScope: [],
            },
        };
        const r = await commitLocalUpload({
            report,
            presentationId: "P",
            authClient: stubAuth("tok"),
        });
        expect(r).toBe(report);
        expect(calls.length).toBe(0);
        expect(report.warnings.length).toBe(0);
    });
});

// ────────────────────────────────────────────────────────────────────────
// runCommit — 5-step progress orchestrator
// ────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal PrepareReport shell for orchestrator tests.
 * @param {Partial<any>} overrides
 */
function makeReport(overrides = {})
{
    return {
        presentationTitle: "T",
        presentationId: "P",
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
        ...overrides,
    };
}

describe("runCommit", () =>
{
    /** @type {typeof globalThis.fetch} */
    let origFetch;
    beforeEach(() => { origFetch = globalThis.fetch; });
    afterEach(() =>
    {
        _setInvokeForTest(null);
        _setFetchForTest(null);
        globalThis.fetch = origFetch;
    });

    test("no images + no text changes → steps 1,2,3 skipped; 4,5 done", async () =>
    {
        _setInvokeForTest(async () => ({}));
        const report = makeReport();

        /** @type {Array<{ i: number, ev: any }>} */
        const events = [];
        let savedLink = 0;
        let refreshedPill = 0;
        const result = await runCommit({
            report,
            script: { pages: [] },
            presentation: { title: "T", slides: [] },
            presentationId: "P",
            mismatchPolicy: null,
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
            onStep: (i, ev) => events.push({ i, ev }),
            onSaveLink: async () => { savedLink++; },
            onRefreshPill: () => { refreshedPill++; },
        });

        expect(result.ok).toBe(true);
        expect(result.steps[0].status).toBe("skipped");
        expect(result.steps[1].status).toBe("skipped");
        expect(result.steps[2].status).toBe("skipped");
        expect(result.steps[3].status).toBe("done");
        expect(result.steps[4].status).toBe("done");
        expect(savedLink).toBe(1);
        expect(refreshedPill).toBe(1);
        // Each step emits at least one event.
        expect(events.some((e) => e.i === 0)).toBe(true);
        expect(events.some((e) => e.i === 3)).toBe(true);
        expect(events.some((e) => e.i === 4)).toBe(true);
    });

    test("use-deck with imagesToDownload triggers step 1", async () =>
    {
        // Mock the download path — invoke intercepts slides_deck_* and
        // fetch handles the image byte fetch.
        _setInvokeForTest(async (cmd) =>
        {
            if (cmd === "slides_deck_stat") return { manifest: {}, orphanPaths: [], cacheDirExists: true };
            if (cmd === "slides_deck_write") return null;
            if (cmd === "slides_deck_gc") return null;
            return {};
        });

        const report = makeReport({
            imagesToDownload: 1,
            toDownload: [{ pageId: "1", slidePageFullId: "1" }],
            localPages: ["1"],
        });
        // Presentation with a page 1 image so scanSlidePages sees it.
        const presentation = buildPresentation([{ pageId: "1", imgBytes: new Uint8Array([1, 2, 3]) }]);

        // Fetch returns the image bytes. Runs through the tauri-plugin-http
        // seam — swap via `_setFetchForTest`.
        _setFetchForTest(async () =>
        {
            return /** @type {any} */ ({
                status: 200,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            });
        });

        let saved = 0;
        const result = await runCommit({
            report,
            script: { pages: [{ baseNumber: 1, suffix: "", rawText: "" }] },
            presentation,
            presentationId: "P",
            mismatchPolicy: "use-deck",
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
            onStep: () => {},
            onSaveLink: async () => { saved++; },
        });

        expect(result.steps[0].status === "done" || result.steps[0].status === "warn").toBe(true);
        expect(result.steps[1].status).toBe("skipped");
        expect(result.steps[2].status).toBe("skipped");
        expect(result.steps[3].status).toBe("done");
        expect(saved).toBe(1);
    });

    test("use-local with pairedDifferent triggers step 2 batchUpdate + step 3 verify", async () =>
    {
        _setInvokeForTest(async () => ({}));
        const report = makeReport({
            localPages: ["1"],
            deckPages: ["1"],
            mismatch: { pairedDifferent: ["1"], localOnly: [], deckOutOfScope: [] },
        });

        // Presentation with page 1 header shape whose text matches "# PAGE 1\nfoo".
        // Step 2 posts batchUpdate → step 3 re-fetches presentations.get → sees
        // the deck text hasn't changed (mocked), so CRC compares equal to local.
        const localRaw = "# PAGE 1\nhello";
        const script = { pages: [{ baseNumber: 1, suffix: "", rawText: localRaw }] };

        const deckHeader = localRaw;
        const presentation = {
            title: "T",
            pageSize: { width: { magnitude: 9144000, unit: "EMU" }, height: { magnitude: 5143500, unit: "EMU" } },
            slides: [{
                objectId: "slide-1",
                pageElements: [{
                    objectId: "shape-1",
                    shape: {
                        text: { textElements: [{ textRun: { content: deckHeader } }] },
                    },
                }],
            }],
        };

        // Mock fetch: batchUpdate + presentations.get (verify).
        /** @type {Array<{ url: string, init: any }>} */
        const fetchCalls = [];
        globalThis.fetch = async (url, init) =>
        {
            fetchCalls.push({ url: String(url), init });
            if (String(url).includes(":batchUpdate"))
            {
                return { status: 200, json: async () => ({ presentationId: "P", replies: [] }) };
            }
            return { status: 200, json: async () => presentation };
        };

        const result = await runCommit({
            report,
            script,
            presentation,
            presentationId: "P",
            mismatchPolicy: "use-local",
            projectPath: "/tmp/proj",
            authClient: stubAuth("tok"),
            onStep: () => {},
            onSaveLink: async () => {},
        });

        // Step 2 ran (batch update fired).
        expect(fetchCalls.some((c) => c.url.includes(":batchUpdate"))).toBe(true);
        // Step 3 ran (verify fetched presentation).
        expect(fetchCalls.some((c) => !c.url.includes(":batchUpdate"))).toBe(true);
        // Step 2 may end done OR warn — commitLocalUpload's image render
        // path still pushes render-failed for missing renderPageToPng.
        // What matters here is that batchUpdate fired successfully.
        expect(["done", "warn"]).toContain(result.steps[1].status);
        // Step 3 verified — no mismatch → done (verify appends nothing).
        expect(result.steps[2].status).toBe("done");
    });

    test("verifyDeckText pushes VERIFY_FAILED warning on CRC mismatch", async () =>
    {
        // Deck header differs from local rawText → CRC mismatch → warning.
        const script = { pages: [{ baseNumber: 1, suffix: "", rawText: "# PAGE 1\nlocal" }] };
        const presentation = {
            title: "T",
            pageSize: { width: { magnitude: 9144000, unit: "EMU" }, height: { magnitude: 5143500, unit: "EMU" } },
            slides: [{
                objectId: "slide-1",
                pageElements: [{
                    objectId: "shape-1",
                    shape: {
                        text: { textElements: [{ textRun: { content: "# PAGE 1\ndifferent" } }] },
                    },
                }],
            }],
        };
        globalThis.fetch = async () =>
        {
            return { status: 200, json: async () => presentation };
        };

        const report = makeReport({ localPages: ["1"], deckPages: ["1"] });
        const out = await verifyDeckText({
            report,
            script,
            presentationId: "P",
            token: "tok",
            pageIds: ["1"],
        });
        expect(out.mismatched).toEqual(["1"]);
        expect(out.verified).toEqual([]);
        expect(report.warnings.some((w) => w.kind === "VERIFY_FAILED")).toBe(true);
    });
});

