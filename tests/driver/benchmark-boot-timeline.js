// @ts-check
// Split vs benchmark-cold-start.js: this file runs a single UX mode and prints
// a deep per-milestone ASCII timeline (for human boot analysis + gap ⚠ flags).
// cold-start instead iterates ALL THREE UX modes and gates perf BUDGETS.
/**
 * tests/driver/benchmark-boot-timeline.js — Boot-timeline benchmarker.
 *
 * Launches the MangaplayStudio desktop app and measures every section of
 * startup timing in detail. Captures window.__mpsBenchmark ledger values,
 * computes a milestone timeline, prints a rich ASCII table to stdout, and
 * writes a JSON report to build/benchmarks/.
 *
 * Wired into package.json as:
 *   "bench:boot-timeline": "MPS_USE_DEV_EXE=1 bun tests/driver/benchmark-boot-timeline.js"
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import {
    CDP_PORT_DEFAULT,
    EXE_PATH,
    killExe,
    forceKillExe,
    isAlive,
    launchExeWithCdp,
    connectToPage,
    sleep,
    screenshot,
} from "./cdp-harness.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MPS_ROOT = join(import.meta.dirname, "..", "..");
const BENCH_DIR = join(MPS_ROOT, "build", "benchmarks");
const SCREENSHOTS_DIR = join(MPS_ROOT, "build", "smoke-screenshots", "boot-timeline");
const CDP_PORT = CDP_PORT_DEFAULT; // 9222

/** Gaps wider than this (ms) are flagged ⚠ in the table. */
const SLOW_GAP_MS = 500;

/**
 * After state:project the splash dismissal is:
 *   MIN_DISPLAY_MS (400ms) + fade transition (250ms) = 650ms estimated.
 */
const SPLASH_DISMISS_EXTRA_MS = 650;

/** Tight poll interval while waiting for benchmark ledger keys (ms). */
const LEDGER_POLL_INTERVAL_MS = 100;

/** Hard timeout waiting for a terminal boot state (ms). */
const BOOT_TIMEOUT_MS = 20000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Pad a string to width, right-aligned.
 * @param {string} s
 * @param {number} w
 * @returns {string}
 */
function padR(s, w)
{
    return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

/**
 * Pad a string to width, left-aligned.
 * @param {string} s
 * @param {number} w
 * @returns {string}
 */
function padL(s, w)
{
    return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/**
 * Format a millisecond value for the table. Null/undefined → "—".
 * @param {number | null | undefined} ms
 * @returns {string}
 */
function fmtMs(ms)
{
    if (ms == null || !isFinite(ms)) return "—";
    return `${Math.round(ms)}ms`;
}

/**
 * Read the full window.__mpsBenchmark ledger from the page.
 * Returns a flat object of key → number (performance.now timestamps).
 *
 * @param {(method: string, params?: any) => Promise<any>} cdp
 * @returns {Promise<Record<string, number>>}
 */
async function readLedger(cdp)
{
    const r = await cdp("Runtime.evaluate", {
        expression: `(function(){ return window.__mpsBenchmark ? Object.assign({}, window.__mpsBenchmark) : null; })()`,
        returnByValue: true,
    });
    /** @type {Record<string, number>} */
    const empty = {};
    return (r && r.result && r.result.value) ? r.result.value : empty;
}

/**
 * Poll window.__mpsBenchmark until a terminal boot state appears (or timeout).
 * Returns the final ledger snapshot and the state string.
 *
 * Terminal states: start-screen, project, onboarding, error.
 *
 * @param {(method: string, params?: any) => Promise<any>} cdp
 * @param {number} timeoutMs
 * @returns {Promise<{ ledger: Record<string, number>, finalState: string }>}
 */
async function pollUntilBooted(cdp, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    const terminalStates = ["start-screen", "project", "onboarding", "empty", "ready", "error"];
    /** @type {Record<string, number>} */
    let ledger = {};
    /** @type {string | null} */
    let finalState = null;

    while (Date.now() < deadline)
    {
        try
        {
            const r = await cdp("Runtime.evaluate", {
                expression: `(function()
                {
                    const state = document.documentElement.getAttribute("data-app-state");
                    const bench = window.__mpsBenchmark ? Object.assign({}, window.__mpsBenchmark) : {};
                    return { state, bench };
                })()`,
                returnByValue: true,
            });

            if (r && r.result && r.result.value)
            {
                const val = /** @type {{ state: string, bench: Record<string, number> }} */ (r.result.value);
                if (val.bench) ledger = val.bench;
                if (val.state && terminalStates.includes(val.state))
                {
                    finalState = val.state;
                    // One final snapshot to capture any keys written in the same tick.
                    ledger = await readLedger(cdp);
                    break;
                }
            }
        }
        catch
        {
            // App may still be initialising — swallow and retry.
        }

        await sleep(LEDGER_POLL_INTERVAL_MS);
    }

    if (!finalState)
    {
        ledger = await readLedger(cdp);
        const r = await cdp("Runtime.evaluate", {
            expression: `document.documentElement.getAttribute("data-app-state")`,
            returnByValue: true,
        }).catch(() => null);
        finalState = (r && r.result && r.result.value) ? String(r.result.value) : "unknown";
    }

    return { ledger, finalState };
}

/**
 * Build the ordered milestone timeline from raw measurements.
 *
 * Ledger values are performance.now() timestamps in the *renderer* process.
 * Harness wallclock is performance.now() in *this* Bun process.
 *
 * Anchor: connectAt (harness wallclock) ≈ renderer's firstPaintAt epoch.
 * For any renderer timestamp R:
 *   t_rel_spawn = (connectAt - spawnAt) + (R - firstPaintAt)
 *
 * @param {{
 *   spawnAt: number,
 *   connectAt: number,
 *   ledger: Record<string, number>,
 * }} opts
 * @returns {Array<{
 *   label: string,
 *   t_abs: number,
 *   t_rel_spawn: number,
 *   t_rel_first_paint: number | null,
 *   t_rel_boot_start: number | null,
 *   duration_from_prev: number | null,
 * }>}
 */
function buildTimeline({ spawnAt, connectAt, ledger })
{
    const fp = ledger["firstPaintAt"];
    const bs = ledger["bootStartedAt"];

    /**
     * @param {number | null | undefined} rPnow
     * @returns {number | null}
     */
    function rendererToRelSpawn(rPnow)
    {
        if (rPnow == null || fp == null) return null;
        return (connectAt - spawnAt) + (rPnow - fp);
    }

    /**
     * @param {number | null | undefined} rPnow
     * @returns {number | null}
     */
    function relPaint(rPnow)
    {
        if (rPnow == null || fp == null) return null;
        return rPnow - fp;
    }

    /**
     * @param {number | null | undefined} rPnow
     * @returns {number | null}
     */
    function relBoot(rPnow)
    {
        if (rPnow == null || bs == null) return null;
        return rPnow - bs;
    }

    // Ordered milestone definitions.
    // Splash-stage keys (state:booting etc.) come from setAppState() in boot.js
    // and are distinct from the FSM STATES enum (state:loading, state:project, etc.)
    // used by markBench() in app.js. Both sets are captured in the ledger.
    const defs = [
        { label: "spawn",                  rPnow: /** @type {number|null|undefined} */ (null), isSpawn: true },
        { label: "http-server-ready",      rPnow: /** @type {number|null|undefined} */ (null), isConnect: true },
        { label: "first-paint",            rPnow: fp },
        { label: "app-js-parsed",          rPnow: ledger["scriptParsed"] },
        { label: "splash: booting",        rPnow: ledger["state:booting"] },
        { label: "splash: probing",        rPnow: ledger["state:probing"] },
        { label: "settings-loaded",        rPnow: ledger["userSettingsLoaded"] },
        { label: "splash: loading-recent", rPnow: ledger["state:loading-recent"] },
        { label: "splash: user-data",      rPnow: ledger["state:user-data"] },
        { label: "user-data-migrated",     rPnow: ledger["userDataMigrated"] },
        { label: "placeholders-scheduled", rPnow: ledger["placeholdersScheduled"] },
        { label: "fsm: loading",           rPnow: ledger["state:loading"] },
        { label: "fsm: onboarding",        rPnow: ledger["state:onboarding"] },
        { label: "fsm: start-screen",      rPnow: ledger["state:start-screen"] ?? ledger["state:recent-projects"] },
        { label: "fsm: empty",             rPnow: ledger["state:empty"] },
        { label: "fsm: ready",             rPnow: ledger["state:ready"] },
        { label: "fsm: opening-project",   rPnow: ledger["state:opening-project"] },
        { label: "fsm: project",           rPnow: ledger["state:project"] },
    ];

    /** @type {Array<{label:string, t_abs:number, t_rel_spawn:number, t_rel_first_paint:number|null, t_rel_boot_start:number|null, duration_from_prev:number|null}>} */
    const milestones = [];
    /** @type {number | null} */
    let prevRelSpawn = null;

    for (const def of defs)
    {
        /** @type {number | null} */
        let t_rel_spawn;

        if (def.isSpawn)
        {
            t_rel_spawn = 0;
        }
        else if (def.isConnect)
        {
            t_rel_spawn = connectAt - spawnAt;
        }
        else
        {
            t_rel_spawn = rendererToRelSpawn(def.rPnow);
        }

        if (t_rel_spawn == null) continue;

        const duration_from_prev = prevRelSpawn != null ? t_rel_spawn - prevRelSpawn : null;

        milestones.push(
        {
            label: def.label,
            t_abs: spawnAt + t_rel_spawn,
            t_rel_spawn,
            t_rel_first_paint: (def.isSpawn || def.isConnect) ? null : relPaint(def.rPnow),
            t_rel_boot_start:  (def.isSpawn || def.isConnect) ? null : relBoot(def.rPnow),
            duration_from_prev,
        });

        prevRelSpawn = t_rel_spawn;
    }

    // Splash-dismissed estimate: anchor on whichever terminal FSM state was reached.
    const TERMINAL_LABELS = ["fsm: project", "fsm: ready", "fsm: start-screen", "fsm: empty", "fsm: onboarding"];
    const anchor = TERMINAL_LABELS.reduce(/** @param {any} a @param {string} lbl */
        (a, lbl) => a || milestones.find((m) => m.label === lbl) || null, null);
    if (anchor)
    {
        const t_rel_spawn = anchor.t_rel_spawn + SPLASH_DISMISS_EXTRA_MS;
        milestones.push(
        {
            label: "splash-dismissed (est)",
            t_abs: spawnAt + t_rel_spawn,
            t_rel_spawn,
            t_rel_first_paint: anchor.t_rel_first_paint != null
                ? anchor.t_rel_first_paint + SPLASH_DISMISS_EXTRA_MS : null,
            t_rel_boot_start: anchor.t_rel_boot_start != null
                ? anchor.t_rel_boot_start + SPLASH_DISMISS_EXTRA_MS : null,
            duration_from_prev: SPLASH_DISMISS_EXTRA_MS,
        });
    }

    return milestones;
}

/**
 * Print a Unicode box-drawing table of the timeline to stdout.
 * @param {ReturnType<typeof buildTimeline>} milestones
 */
function printTable(milestones)
{
    const COL_LABEL = 30;
    const COL_VAL   = 10;

    const hdr1 = padL("Milestone", COL_LABEL);
    const hdr2 = padR("+spawn",   COL_VAL);
    const hdr3 = padR("+paint",   COL_VAL);
    const hdr4 = padR("+boot",    COL_VAL);
    const hdr5 = padR("gap",      COL_VAL);

    const TOP = `┌${"─".repeat(COL_LABEL + 2)}┬${"─".repeat(COL_VAL + 2)}┬${"─".repeat(COL_VAL + 2)}┬${"─".repeat(COL_VAL + 2)}┬${"─".repeat(COL_VAL + 2)}┐`;
    const SEP = `├${"─".repeat(COL_LABEL + 2)}┼${"─".repeat(COL_VAL + 2)}┼${"─".repeat(COL_VAL + 2)}┼${"─".repeat(COL_VAL + 2)}┼${"─".repeat(COL_VAL + 2)}┤`;
    const BOT = `└${"─".repeat(COL_LABEL + 2)}┴${"─".repeat(COL_VAL + 2)}┴${"─".repeat(COL_VAL + 2)}┴${"─".repeat(COL_VAL + 2)}┴${"─".repeat(COL_VAL + 2)}┘`;

    console.log("");
    console.log("  Boot Timeline");
    console.log("");
    console.log(TOP);
    console.log(`│ ${padL(hdr1, COL_LABEL)} │ ${hdr2} │ ${hdr3} │ ${hdr4} │ ${hdr5} │`);
    console.log(SEP);

    for (const m of milestones)
    {
        const label = padL(m.label, COL_LABEL);
        const spawn = padR(fmtMs(m.t_rel_spawn), COL_VAL);
        const paint = padR(fmtMs(m.t_rel_first_paint), COL_VAL);
        const boot  = padR(fmtMs(m.t_rel_boot_start), COL_VAL);

        const gapMs = m.duration_from_prev;
        const gapStr = gapMs == null
            ? padR("—", COL_VAL)
            : gapMs > SLOW_GAP_MS
                ? padR(`${Math.round(gapMs)}ms ⚠`, COL_VAL)
                : padR(fmtMs(gapMs), COL_VAL);

        console.log(`│ ${label} │ ${spawn} │ ${paint} │ ${boot} │ ${gapStr} │`);
    }

    console.log(BOT);
    console.log("");
}

/**
 * Print the 3 biggest gaps between consecutive milestones.
 * @param {ReturnType<typeof buildTimeline>} milestones
 */
function printSummary(milestones)
{
    /** @type {Array<{from: string, to: string, gapMs: number}>} */
    const gaps = [];
    for (let i = 1; i < milestones.length; i++)
    {
        const gap = milestones[i].duration_from_prev;
        if (gap != null && gap > 0)
        {
            gaps.push({ from: milestones[i - 1].label, to: milestones[i].label, gapMs: gap });
        }
    }

    gaps.sort((a, b) => b.gapMs - a.gapMs);

    console.log("  Top 3 slowest gaps:");
    console.log("");
    for (let i = 0; i < Math.min(3, gaps.length); i++)
    {
        const { from, to, gapMs } = gaps[i];
        console.log(`  ${i + 1}. ${from} >> ${to}  (${Math.round(gapMs)}ms)`);
    }
    console.log("");
}

/**
 * Compute a flat timing summary for the JSON report.
 *
 * @param {{
 *   spawnAt: number,
 *   connectAt: number,
 *   ledger: Record<string, number>,
 *   milestones: ReturnType<typeof buildTimeline>,
 * }} opts
 * @returns {Record<string, number | null>}
 */
function buildTimingSummary({ spawnAt, connectAt, ledger, milestones })
{
    const fp = ledger["firstPaintAt"];
    const bs = ledger["scriptParsed"];
    const sl = ledger["userSettingsLoaded"];
    const sp = ledger["state:project"];

    const httpReadyMs = connectAt - spawnAt;

    /** @param {string} label @returns {number | null} */
    function relSpawnOf(label)
    {
        const m = milestones.find((x) => x.label === label);
        return m ? m.t_rel_spawn : null;
    }

    const fpRelSpawn         = relSpawnOf("first-paint");
    const scriptRelSpawn     = relSpawnOf("app-js-parsed");
    const settingsRelSpawn   = relSpawnOf("settings-loaded");
    const projectRelSpawn    = relSpawnOf("fsm: project");
    const splashRelSpawn     = relSpawnOf("splash-dismissed (est)");

    return {
        spawnToHttpReadyMs: httpReadyMs,
        httpReadyToFirstPaintMs: fpRelSpawn != null ? fpRelSpawn - httpReadyMs : null,
        firstPaintToScriptParsedMs: (fpRelSpawn != null && scriptRelSpawn != null)
            ? scriptRelSpawn - fpRelSpawn
            : (fp != null && bs != null ? bs - fp : null),
        scriptParsedToSettingsLoadedMs: (scriptRelSpawn != null && settingsRelSpawn != null)
            ? settingsRelSpawn - scriptRelSpawn
            : (bs != null && sl != null ? sl - bs : null),
        settingsLoadedToStateProjectMs: (settingsRelSpawn != null && projectRelSpawn != null)
            ? projectRelSpawn - settingsRelSpawn
            : (sl != null && sp != null ? sp - sl : null),
        totalSpawnToProjectMs: projectRelSpawn ?? null,
        splashDismissedEstMs: splashRelSpawn ?? null,
    };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main()
{
    mkdirSync(BENCH_DIR, { recursive: true });
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    /** @type {string[]} */
    const screenshotPaths = [];

    console.log("");
    console.log("  bench:boot-timeline — MangaplayStudio");
    console.log(`  EXE: ${EXE_PATH(MPS_ROOT)}`);
    console.log("");

    // ── 1. Pre-flight ──────────────────────────────────────────────────────────
    console.log("  [1/7] Pre-flight: killing any running instance...");
    killExe();
    await sleep(300);
    if (isAlive())
    {
        console.log("  [1/7] Still alive — force-killing...");
        forceKillExe();
        await sleep(300);
    }

    // Seed a fresh user-data dir with onboardingCompleted:true so the app
    // goes straight to the start-screen picker instead of onboarding.
    const userDataDir = join(MPS_ROOT, "build", "test-tmp", "boot-timeline-userdata");
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    mkdirSync(userDataDir, { recursive: true });
    // Read the current app version so the migration check doesn't error.
    let appVersion = "1.0.1";
    try
    {
        const meta = JSON.parse(readFileSync(join(MPS_ROOT, "..", "mangaplay-studio-configs", "app-metadata.json"), "utf8"));
        if (typeof meta.common?.version === "string") appVersion = meta.common.version;
    }
    catch {}
    writeFileSync(join(userDataDir, "user-settings.json"), JSON.stringify({
        format: "user-settings:v1",
        defaultLanguage: "en",
        appVersionCreated: appVersion,
        lastProjectPath: null,
        lastSettingsTab: "general",
        onboardingCompleted: true,
    }));

    /** @type {import("child_process").ChildProcess | null} */
    let proc = null;

    try
    {
        // ── 2. Spawn ───────────────────────────────────────────────────────────
        const spawnAt = performance.now();
        console.log("  [2/7] Launching app...");

        const { proc: p } = await launchExeWithCdp(
        {
            root: MPS_ROOT,
            port: CDP_PORT,
            projectFiles: /** @type {any} */ ([]),
            env:
            {
                MPS_UX_MODE: "standalone",
                MPS_NO_AUTO_RESUME: "1",
                MPS_USER_DATA_DIR: userDataDir,
            },
        });
        proc = p;

        // ── 3. Connect ─────────────────────────────────────────────────────────
        console.log("  [3/7] Waiting for HTTP test server...");
        const { cdp } = await connectToPage(CDP_PORT, 20000);
        const connectAt = performance.now();
        console.log(`  [3/7] HTTP server ready at +${Math.round(connectAt - spawnAt)}ms from spawn.`);

        // ── 4. Poll until booted ───────────────────────────────────────────────
        console.log("  [4/7] Polling for boot completion...");
        const { ledger, finalState } = await pollUntilBooted(cdp, BOOT_TIMEOUT_MS);
        console.log(`  [4/7] Reached state: ${finalState}`);

        if (finalState === "error")
        {
            console.error("  ERROR: App reached error state during boot.");
        }

        // ── 5. Screenshot ──────────────────────────────────────────────────────
        if (finalState === "start-screen" || finalState === "project")
        {
            const label = finalState === "start-screen" ? "start-screen" : "project";
            const ssPath = join(SCREENSHOTS_DIR, `${label}-${timestamp}.png`);
            console.log(`  [5/7] Screenshot: ${ssPath}`);
            try
            {
                await screenshot(cdp, ssPath);
                screenshotPaths.push(ssPath);
            }
            catch (/** @type {unknown} */ e)
            {
                console.warn(`  [5/7] Screenshot failed (non-fatal): ${e instanceof Error ? e.message : e}`);
            }
        }
        else
        {
            console.log(`  [5/7] Skipping screenshot (state=${finalState}).`);
        }

        // ── 6. Snapshot ledger at terminal state ───────────────────────────────
        // We do not click the open-folder button: doing so spawns a native
        // macOS folder-picker dialog that blocks until user interaction.
        // Instead just take a final ledger snapshot to capture any keys written
        // after the FSM settled (e.g. harperWarmupDoneAt).
        console.log("  [6/7] Final ledger snapshot...");
        {
            const lateLedger = await readLedger(cdp);
            Object.assign(ledger, lateLedger);
        }

        // Final ledger snapshot picks up any keys written after project mount.
        const finalLedger = await readLedger(cdp);
        Object.assign(ledger, finalLedger);

        // ── 7. Compute, print, save ────────────────────────────────────────────
        console.log("  [7/7] Computing timeline...");

        const milestones = buildTimeline({ spawnAt, connectAt, ledger });
        printTable(milestones);
        printSummary(milestones);

        const timing = buildTimingSummary({ spawnAt, connectAt, ledger, milestones });

        console.log("  Timing summary:");
        console.log(`    spawn → http-ready:        ${fmtMs(timing.spawnToHttpReadyMs)}`);
        console.log(`    http-ready → first-paint:  ${fmtMs(timing.httpReadyToFirstPaintMs)}`);
        console.log(`    first-paint → js-parsed:   ${fmtMs(timing.firstPaintToScriptParsedMs)}`);
        console.log(`    js-parsed → settings:      ${fmtMs(timing.scriptParsedToSettingsLoadedMs)}`);
        console.log(`    settings → project:        ${fmtMs(timing.settingsLoadedToStateProjectMs)}`);
        console.log(`    spawn → project (total):   ${fmtMs(timing.totalSpawnToProjectMs)}`);
        console.log(`    splash dismissed (est):    ${fmtMs(timing.splashDismissedEstMs)}`);
        console.log("");

        const reportPath = join(BENCH_DIR, `boot-timeline-${timestamp}.json`);
        writeFileSync(reportPath, JSON.stringify(
        {
            timestamp: new Date().toISOString(),
            platform: process.platform,
            exePath: EXE_PATH(MPS_ROOT),
            mode: "standalone",
            ledger,
            timing,
            milestones,
            screenshots: screenshotPaths,
        }, null, 2));
        console.log(`  Report: ${reportPath}`);
        console.log("");
    }
    finally
    {
        console.log("  Killing app...");
        killExe();
        await sleep(300);
        if (isAlive()) forceKillExe();
        if (proc)
        {
            try { proc.kill(); } catch {}
        }
        console.log("  Done.");
        console.log("");
    }
}

main().catch((err) =>
{
    console.error("bench:boot-timeline failed:", err);
    killExe();
    process.exit(1);
});
