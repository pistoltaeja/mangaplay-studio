// @ts-check
/**
 * sync-state-machine.test.js — Bun tests for the gear-icon state machine.
 *
 * Coverage:
 *   - bootFromCache: missing entry → unsynced, present entry → idle.
 *   - triggerL1Check: idle → idle on rev match; idle → remote-ahead on
 *     mismatch; transient `checking` while in flight; error routing.
 *   - notifyLocalEdit: idle → local-ahead; no-op when already error/unsynced.
 *   - notifyPushSucceeded: writes cache + returns to idle.
 *   - notifyPullSucceeded: writes cache + returns to idle.
 *   - unlink: clears cache, transitions to unsynced.
 *   - inflight gate: triggerL1Check skips while a Push/Pull is in flight.
 *
 * No DOM, no Drive, no Tauri — everything is injected.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { SyncStateMachine } from "./sync-state-machine.js";

/**
 * Build a fake project store that records reads/writes in plain JS.
 */
function makeStore(initial = null)
{
    let entry = initial;
    const log = { gets: 0, sets: 0, removes: 0 };
    return {
        log,
        async getSyncEntry(_proj, _rel) { log.gets++; return entry; },
        async setSyncEntry(_proj, _rel, val) { log.sets++; entry = entry ? Object.assign({}, entry, val) : val; },
        async removeSyncEntry(_proj, _rel) { log.removes++; entry = null; }
    };
}

/**
 * Build a fake driveClient with a configurable filesGet response.
 */
function makeDrive(rev = "rev-1")
{
    const calls = [];
    return {
        calls,
        async filesGet(args)
        {
            calls.push(args);
            return { headRevisionId: rev };
        }
    };
}

function makeMachine(overrides = {})
{
    const store = overrides.projectStore || makeStore();
    const drive = overrides.driveClient || makeDrive();
    const transitions = [];
    const sm = new SyncStateMachine(Object.assign({
        scriptRelPath: "chapter-01.mangaplay",
        projectPath: "/proj",
        projectStore: store,
        driveClient: drive,
        getAuthToken: async () => "tok-test",
        onTransition: (t) => transitions.push(t)
    }, overrides));
    return { sm, store, drive, transitions };
}

describe("SyncStateMachine — bootFromCache", () =>
{
    test("no cache entry → unsynced", async () =>
    {
        const { sm, transitions } = makeMachine();
        await sm.bootFromCache();
        expect(sm.state).toBe("unsynced");
        expect(transitions[transitions.length - 1].state).toBe("unsynced");
    });

    test("cached entry → idle with hydrated fields", async () =>
    {
        const store = makeStore({
            docId: "doc-xyz",
            lastKnownRevisionId: "rev-cached",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "mangaplay",
            lastKnownLockToken: null
        });
        const { sm, transitions } = makeMachine({ projectStore: store });
        await sm.bootFromCache();
        expect(sm.state).toBe("idle");
        expect(sm.docId).toBe("doc-xyz");
        expect(sm.lastKnownRevisionId).toBe("rev-cached");
        expect(sm.format).toBe("mangaplay");
        expect(transitions[transitions.length - 1].state).toBe("idle");
    });
});

describe("SyncStateMachine — triggerL1Check", () =>
{
    test("idle → idle when remote rev matches cached", async () =>
    {
        const store = makeStore({
            docId: "doc-1",
            lastKnownRevisionId: "rev-7",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "fountain",
            lastKnownLockToken: null
        });
        const drive = makeDrive("rev-7");
        const { sm, transitions } = makeMachine({ projectStore: store, driveClient: drive });
        await sm.bootFromCache();
        transitions.length = 0;

        const result = await sm.triggerL1Check();
        expect(result).toBe(false);
        // Should have transitioned: checking → idle.
        const states = transitions.map((t) => t.state);
        expect(states).toContain("checking");
        expect(states[states.length - 1]).toBe("idle");
        expect(sm.state).toBe("idle");
        expect(drive.calls.length).toBe(1);
    });

    test("idle → remote-ahead when remote rev differs", async () =>
    {
        const store = makeStore({
            docId: "doc-1",
            lastKnownRevisionId: "rev-7",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "mangaplay",
            lastKnownLockToken: null
        });
        const drive = makeDrive("rev-9");
        const { sm, transitions } = makeMachine({ projectStore: store, driveClient: drive });
        await sm.bootFromCache();
        transitions.length = 0;

        const result = await sm.triggerL1Check();
        expect(result).toBe(true);
        expect(sm.state).toBe("remote-ahead");
        const states = transitions.map((t) => t.state);
        expect(states).toContain("checking");
        expect(states[states.length - 1]).toBe("remote-ahead");
    });

    test("network error transitions to error with classified payload", async () =>
    {
        const store = makeStore({
            docId: "doc-1",
            lastKnownRevisionId: "rev-1",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "text",
            lastKnownLockToken: null
        });
        const drive = {
            async filesGet()
            {
                const e = new Error("offline");
                e.name = "NetworkError";
                throw e;
            }
        };
        const { sm, transitions } = makeMachine({ projectStore: store, driveClient: drive });
        await sm.bootFromCache();
        transitions.length = 0;

        await sm.triggerL1Check();
        expect(sm.state).toBe("error");
        const last = transitions[transitions.length - 1];
        expect(last.state).toBe("error");
        expect(last.errorPayload).toBeTruthy();
        expect(last.errorPayload.class).toBe("auth.network");
    });

    test("unsynced state skips L1 check (no docId)", async () =>
    {
        const drive = makeDrive("rev-9");
        const { sm } = makeMachine({ driveClient: drive });
        await sm.bootFromCache();
        await sm.triggerL1Check();
        expect(drive.calls.length).toBe(0);
        expect(sm.state).toBe("unsynced");
    });

    test("inflight flag pauses L1 check (Push/Pull racing)", async () =>
    {
        const store = makeStore({
            docId: "doc-1",
            lastKnownRevisionId: "rev-7",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "fountain",
            lastKnownLockToken: null
        });
        const drive = makeDrive("rev-9");
        const { sm } = makeMachine({ projectStore: store, driveClient: drive });
        await sm.bootFromCache();
        sm.inflight = true;

        await sm.triggerL1Check();
        expect(drive.calls.length).toBe(0);
        expect(sm.state).toBe("idle");
    });

    test("missing token surfaces auth.token_expired error", async () =>
    {
        const store = makeStore({
            docId: "doc-1",
            lastKnownRevisionId: "rev-7",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "fountain",
            lastKnownLockToken: null
        });
        const { sm, transitions } = makeMachine({
            projectStore: store,
            getAuthToken: async () => null
        });
        await sm.bootFromCache();
        transitions.length = 0;

        await sm.triggerL1Check();
        expect(sm.state).toBe("error");
        const last = transitions[transitions.length - 1];
        expect(last.errorPayload.class).toBe("auth.token_expired");
    });
});

describe("SyncStateMachine — notifyLocalEdit", () =>
{
    test("idle → local-ahead", async () =>
    {
        const store = makeStore({
            docId: "doc-1",
            lastKnownRevisionId: "rev-7",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "text",
            lastKnownLockToken: null
        });
        const { sm, transitions } = makeMachine({ projectStore: store });
        await sm.bootFromCache();
        transitions.length = 0;

        sm.notifyLocalEdit();
        expect(sm.state).toBe("local-ahead");
        expect(transitions[transitions.length - 1].state).toBe("local-ahead");
    });

    test("unsynced + notifyLocalEdit stays unsynced", async () =>
    {
        const { sm } = makeMachine();
        await sm.bootFromCache();
        sm.notifyLocalEdit();
        expect(sm.state).toBe("unsynced");
    });

    test("error + notifyLocalEdit stays error", async () =>
    {
        const store = makeStore({
            docId: "doc-1",
            lastKnownRevisionId: "rev-1",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "text",
            lastKnownLockToken: null
        });
        const drive = {
            async filesGet() { const e = new Error("x"); e.name = "NetworkError"; throw e; }
        };
        const { sm } = makeMachine({ projectStore: store, driveClient: drive });
        await sm.bootFromCache();
        await sm.triggerL1Check();
        expect(sm.state).toBe("error");
        sm.notifyLocalEdit();
        expect(sm.state).toBe("error");
    });
});

describe("SyncStateMachine — push/pull notifications", () =>
{
    test("notifyPushSucceeded writes cache + transitions to idle", async () =>
    {
        const store = makeStore({
            docId: "doc-1",
            lastKnownRevisionId: "rev-old",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "mangaplay",
            lastKnownLockToken: null
        });
        const { sm } = makeMachine({ projectStore: store });
        await sm.bootFromCache();
        sm.notifyLocalEdit();
        expect(sm.state).toBe("local-ahead");

        await sm.notifyPushSucceeded("rev-new");
        expect(sm.state).toBe("idle");
        expect(sm.lastKnownRevisionId).toBe("rev-new");
        expect(store.log.sets).toBe(1);
    });

    test("notifyPullSucceeded writes cache + transitions to idle", async () =>
    {
        const store = makeStore({
            docId: "doc-1",
            lastKnownRevisionId: "rev-old",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "fountain",
            lastKnownLockToken: null
        });
        const drive = makeDrive("rev-fresh");
        const { sm } = makeMachine({ projectStore: store, driveClient: drive });
        await sm.bootFromCache();
        await sm.triggerL1Check();
        expect(sm.state).toBe("remote-ahead");

        await sm.notifyPullSucceeded("rev-fresh");
        expect(sm.state).toBe("idle");
        expect(sm.lastKnownRevisionId).toBe("rev-fresh");
        expect(store.log.sets).toBeGreaterThanOrEqual(1);
    });
});

describe("SyncStateMachine — unlink", () =>
{
    test("clears cache + transitions to unsynced", async () =>
    {
        const store = makeStore({
            docId: "doc-1",
            lastKnownRevisionId: "rev-1",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "mangaplay",
            lastKnownLockToken: null
        });
        const { sm } = makeMachine({ projectStore: store });
        await sm.bootFromCache();
        expect(sm.state).toBe("idle");

        await sm.unlink();
        expect(sm.state).toBe("unsynced");
        expect(sm.docId).toBe(null);
        expect(sm.lastKnownRevisionId).toBe(null);
        expect(store.log.removes).toBe(1);
    });

    test("second call is a no-op — removeSyncEntry stays at one call, no extra transitions emitted", async () =>
    {
        const store = makeStore({
            docId: "doc-1",
            lastKnownRevisionId: "rev-1",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "mangaplay",
            lastKnownLockToken: null
        });
        const { sm, transitions } = makeMachine({ projectStore: store });
        await sm.bootFromCache();      // → idle
        await sm.unlink();             // → unsynced
        const transitionsAfterFirstUnlink = transitions.length;

        await sm.unlink();             // double-click — should no-op

        expect(sm.state).toBe("unsynced");
        expect(store.log.removes).toBe(1);
        expect(transitions.length).toBe(transitionsAfterFirstUnlink);
    });

    test("after unlink, bootFromCache reads null and stays unsynced", async () =>
    {
        const store = makeStore({
            docId: "doc-1",
            lastKnownRevisionId: "rev-1",
            lastCheckedAt: "2026-06-29T10:00:00Z",
            format: "mangaplay",
            lastKnownLockToken: null
        });
        const { sm } = makeMachine({ projectStore: store });
        await sm.bootFromCache();
        await sm.unlink();
        expect(sm.state).toBe("unsynced");

        // Re-boot — store has been cleared, so the next read returns null.
        await sm.bootFromCache();
        expect(sm.state).toBe("unsynced");
        expect(sm.docId).toBe(null);
        expect(sm.lastKnownRevisionId).toBe(null);
    });
});

describe("SyncStateMachine — start/stop lifecycle", () =>
{
    test("start wires window listeners; stop tears them down", () =>
    {
        const listeners = new Map();
        const windowImpl = {
            addEventListener(name, fn) { listeners.set(name, fn); },
            removeEventListener(name) { listeners.delete(name); }
        };
        const documentImpl = {
            addEventListener() {},
            removeEventListener() {}
        };
        const timers = { setIntervals: 0, clearIntervals: 0, setTimeouts: 0, clearTimeouts: 0 };
        const sm = new SyncStateMachine({
            scriptRelPath: "x.mangaplay",
            projectPath: "/p",
            projectStore: makeStore(),
            driveClient: makeDrive(),
            getAuthToken: async () => "tok",
            windowImpl,
            documentImpl,
            setIntervalImpl: (fn, ms) => { timers.setIntervals++; return { fn, ms }; },
            clearIntervalImpl: () => { timers.clearIntervals++; },
            setTimeoutImpl: (fn, ms) => { timers.setTimeouts++; return { fn, ms }; },
            clearTimeoutImpl: () => { timers.clearTimeouts++; }
        });

        sm.start();
        expect(listeners.has("focus")).toBe(true);
        expect(listeners.has("blur")).toBe(true);
        expect(listeners.has("online")).toBe(true);
        expect(timers.setIntervals).toBe(1);   // status text refresher
        expect(timers.setTimeouts).toBeGreaterThanOrEqual(1);   // L2 backstop

        sm.stop();
        expect(listeners.size).toBe(0);
        expect(timers.clearIntervals).toBe(1);
        expect(timers.clearTimeouts).toBeGreaterThanOrEqual(1);
    });

    test("stop is idempotent", () =>
    {
        const sm = new SyncStateMachine({
            scriptRelPath: "x.mangaplay",
            projectPath: "/p",
            projectStore: makeStore(),
            driveClient: makeDrive(),
            getAuthToken: async () => "tok",
            windowImpl: { addEventListener: () => {}, removeEventListener: () => {} },
            documentImpl: { addEventListener: () => {}, removeEventListener: () => {} }
        });
        sm.start();
        sm.stop();
        expect(() => sm.stop()).not.toThrow();
    });
});
