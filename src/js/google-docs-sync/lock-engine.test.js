// @ts-check
/**
 * lock-engine.test.js — Bun tests for the lock + heartbeat helpers.
 *
 * Coverage:
 *   - evaluateLockState truth table (unlocked / locked-by-me /
 *     locked-by-other / stale).
 *   - lock() round-trip success.
 *   - lock() race detection — re-read returns different token → throws
 *     FileNotGrantedError (classifier → permissions.doc_picker_denied).
 *   - unlock() clears the four mps fields + drops contentRestriction.
 *   - HeartbeatController.start writes mpsLockedAt on tick.
 *   - HeartbeatController skips writes when idle > 60s.
 */

import { describe, test, expect } from "bun:test";
import {
    evaluateLockState,
    lock,
    unlock,
    HeartbeatController,
    STALE_LOCK_MS,
    HEARTBEAT_MS,
    IDLE_THRESHOLD_MS
} from "./lock-engine.js";
import { classifyError } from "../../../../core/google-docs/index.js";

describe("evaluateLockState — truth table", () =>
{
    const now = Date.parse("2026-06-29T12:00:00Z");

    test("missing mpsLockToken → unlocked", () =>
    {
        expect(evaluateLockState({
            appProperties: {},
            ourLockToken: "tok-x",
            nowMs: now
        })).toBe("unlocked");
    });

    test("matching token within TTL → locked-by-me", () =>
    {
        expect(evaluateLockState({
            appProperties: {
                mpsLockToken: "tok-x",
                mpsLockedAt: new Date(now - 60_000).toISOString()
            },
            ourLockToken: "tok-x",
            nowMs: now
        })).toBe("locked-by-me");
    });

    test("differing token within TTL → locked-by-other", () =>
    {
        expect(evaluateLockState({
            appProperties: {
                mpsLockToken: "tok-other",
                mpsLockedAt: new Date(now - 30_000).toISOString()
            },
            ourLockToken: "tok-mine",
            nowMs: now
        })).toBe("locked-by-other");
    });

    test("mpsLockedAt older than 10 min → stale (even if token matches)", () =>
    {
        expect(evaluateLockState({
            appProperties: {
                mpsLockToken: "tok-x",
                mpsLockedAt: new Date(now - STALE_LOCK_MS - 1).toISOString()
            },
            ourLockToken: "tok-x",
            nowMs: now
        })).toBe("stale");
    });

    test("missing mpsLockedAt with present token → stale", () =>
    {
        expect(evaluateLockState({
            appProperties: { mpsLockToken: "tok-x" },
            ourLockToken: "tok-x",
            nowMs: now
        })).toBe("stale");
    });

    test("null appProperties → unlocked", () =>
    {
        expect(evaluateLockState({
            appProperties: null,
            ourLockToken: "tok",
            nowMs: now
        })).toBe("unlocked");
    });
});

describe("lock — happy path", () =>
{
    test("writes appProperties + contentRestriction, re-read confirms token", async () =>
    {
        const writes = [];
        const lastTokenRef = { value: null };
        const driveClient = {
            async filesUpdate(args)
            {
                writes.push(args);
                lastTokenRef.value = args.body.appProperties.mpsLockToken;
                return {};
            },
            async filesGet(_args)
            {
                return { appProperties: { mpsLockToken: lastTokenRef.value } };
            }
        };

        const result = await lock({
            token: "auth-tok",
            docId: "doc-1",
            userName: "Pete",
            clientId: "client-x",
            driveClient
        });

        expect(result.lockToken).toBeTruthy();
        expect(result.lockedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        const body = writes[0].body;
        expect(body.contentRestrictions[0].readOnly).toBe(true);
        expect(body.contentRestrictions[0].reason).toMatch(/Pete/);
        expect(body.appProperties.mpsLockToken).toBe(result.lockToken);
        expect(body.appProperties.mpsLockedAt).toBe(result.lockedAt);
        expect(body.appProperties.mpsLockedBy).toBe("Pete");
        expect(body.appProperties.mpsClientId).toBe("client-x");
    });
});

describe("lock — race detection", () =>
{
    test("re-read returns different token → throws + classifies to picker_denied", async () =>
    {
        const driveClient = {
            async filesUpdate() { return {}; },
            async filesGet()
            {
                return { appProperties: { mpsLockToken: "someone-else-wrote-this" } };
            }
        };

        let thrown = null;
        try
        {
            await lock({
                token: "auth-tok",
                docId: "doc-1",
                userName: "Pete",
                clientId: "client-x",
                driveClient
            });
        }
        catch (e) { thrown = e; }

        expect(thrown).toBeTruthy();
        expect(thrown.name).toBe("FileNotGrantedError");
        const cls = classifyError(thrown);
        expect(cls).toBe("permissions.doc_picker_denied");
    });
});

describe("unlock", () =>
{
    test("clears the four mps lock fields and drops readOnly", async () =>
    {
        const writes = [];
        const driveClient = {
            async filesUpdate(args) { writes.push(args); return {}; }
        };

        await unlock({ token: "tok", docId: "doc-1", driveClient });

        expect(writes.length).toBe(1);
        const body = writes[0].body;
        expect(body.contentRestrictions[0].readOnly).toBe(false);
        expect(body.appProperties.mpsLockToken).toBe("");
        expect(body.appProperties.mpsLockedAt).toBe("");
        expect(body.appProperties.mpsLockedBy).toBe("");
        expect(body.appProperties.mpsClientId).toBe("");
    });
});

describe("HeartbeatController", () =>
{
    function fakeTimers()
    {
        const tasks = [];
        return {
            tasks,
            setIntervalImpl(fn, ms) { const h = { fn, ms }; tasks.push(h); return h; },
            clearIntervalImpl(h) { const i = tasks.indexOf(h); if (i !== -1) tasks.splice(i, 1); }
        };
    }

    test("ticks every HEARTBEAT_MS and updates mpsLockedAt when interactive", async () =>
    {
        const writes = [];
        const driveClient = {
            async filesUpdate(args) { writes.push(args); return {}; }
        };
        const timers = fakeTimers();
        let now = 1_700_000_000_000;
        const hb = new HeartbeatController({
            driveClient,
            nowImpl: () => now,
            setIntervalImpl: timers.setIntervalImpl,
            clearIntervalImpl: timers.clearIntervalImpl
        });

        hb.start({ token: "tok", docId: "doc-1", lockToken: "lt-1" });
        expect(timers.tasks.length).toBe(1);

        // Interact, advance clock past one heartbeat window, fire the tick.
        hb.noteInteraction();
        now += 5_000;
        await timers.tasks[0].fn();

        expect(writes.length).toBe(1);
        expect(writes[0].body.appProperties.mpsLockedAt).toBeTruthy();

        hb.stop();
        expect(timers.tasks.length).toBe(0);
    });

    test("skips write when idle > 60s", async () =>
    {
        const writes = [];
        const driveClient = {
            async filesUpdate(args) { writes.push(args); return {}; }
        };
        const timers = fakeTimers();
        let now = 1_700_000_000_000;
        const hb = new HeartbeatController({
            driveClient,
            nowImpl: () => now,
            setIntervalImpl: timers.setIntervalImpl,
            clearIntervalImpl: timers.clearIntervalImpl
        });
        hb.start({ token: "tok", docId: "doc-1", lockToken: "lt-1" });

        hb.noteInteraction();
        now += IDLE_THRESHOLD_MS + 5_000;
        await timers.tasks[0].fn();

        expect(writes.length).toBe(0);
        hb.stop();
    });

    test("filesUpdate failure swallowed (best-effort)", async () =>
    {
        const driveClient = {
            async filesUpdate() { throw new Error("transient"); }
        };
        const timers = fakeTimers();
        let now = 1_700_000_000_000;
        const hb = new HeartbeatController({
            driveClient,
            nowImpl: () => now,
            setIntervalImpl: timers.setIntervalImpl,
            clearIntervalImpl: timers.clearIntervalImpl
        });
        hb.start({ token: "tok", docId: "doc-1", lockToken: "lt-1" });
        hb.noteInteraction();
        now += 5_000;

        // Should not throw despite the underlying error.
        let thrown = null;
        try { await timers.tasks[0].fn(); }
        catch (e) { thrown = e; }
        expect(thrown).toBe(null);
        hb.stop();
    });
});

describe("HEARTBEAT_MS sanity", () =>
{
    test("constant matches spec (5 minutes)", () =>
    {
        expect(HEARTBEAT_MS).toBe(5 * 60_000);
    });
    test("STALE_LOCK_MS matches spec (10 minutes)", () =>
    {
        expect(STALE_LOCK_MS).toBe(10 * 60_000);
    });
});
