// @ts-check
/**
 * footer-bootstrap.test.js — Bun tests for the pure `runUnlinkFlow` helper.
 *
 * Covers BUG-005: unlink must release the user's own lock (or a stale lock
 * matching their token) BEFORE clearing the 5 link-tracking appProperties,
 * so the Doc doesn't end up stranded read-only for the 10-minute TTL.
 *
 * The flow is exercised end-to-end with stubs — no DOM, no module-scope
 * state, no real Drive calls.
 */

import { describe, test, expect } from "bun:test";
import { runUnlinkFlow } from "./footer-bootstrap.js";

/**
 * Build a call-recording stub set. Returned `calls` is appended to in order
 * so tests can assert ordering ("lockUnlock before filesUpdate").
 */
function makeDeps(overrides = {})
{
    const calls = [];
    const baseAppProps = overrides.appProps || {};
    const deps = {
        token: "tok-abc",
        docId: "doc-1",
        ourLockToken: "ours",
        filesGet: async (args) =>
        {
            calls.push({ kind: "filesGet", args });
            if (overrides.filesGetThrows) throw new Error("filesGet boom");
            return { appProperties: baseAppProps };
        },
        filesUpdate: async (args) =>
        {
            calls.push({ kind: "filesUpdate", args });
            if (overrides.filesUpdateThrows) throw new Error("filesUpdate boom");
            return {};
        },
        lockUnlock: async (args) =>
        {
            calls.push({ kind: "lockUnlock", args });
        },
        evaluateLockStateFn: overrides.evaluateLockStateFn ||
            (({ appProperties, ourLockToken, ourSub: _ourSub }) =>
            {
                // Trivial evaluator for the test — real lock-engine tests cover
                // the truth table. ourSub is accepted to match the production
                // signature but unused here (tests don't exercise sub match).
                const tok = appProperties && appProperties.mpsLockToken;
                if (!tok) return "unlocked";
                if (overrides.forceState) return overrides.forceState;
                if (tok === ourLockToken) return "locked-by-me";
                return "locked-by-other";
            }),
        confirmLockedByOther: overrides.confirmLockedByOther || (() => true),
        onDriveUpdateFailed: () => { calls.push({ kind: "toast" }); },
        localUnlink: async () => { calls.push({ kind: "localUnlink" }); },
        teardownHeartbeat: () => { calls.push({ kind: "teardownHeartbeat" }); }
    };
    return { deps, calls };
}

describe("runUnlinkFlow — BUG-005", () =>
{
    test("locked-by-me → lockUnlock BEFORE filesUpdate, then localUnlink + teardown", async () =>
    {
        const { deps, calls } = makeDeps({
            appProps: { mpsLockToken: "ours", mpsLockedAt: "2026-06-29T12:00:00Z", mpsLockedBy: "Pete" }
        });

        const result = await runUnlinkFlow(deps);

        expect(result.branch).toBe("released-own-lock");

        // Ordering: filesGet → lockUnlock → filesUpdate → localUnlink → teardown.
        const kinds = calls.map(c => c.kind);
        expect(kinds).toEqual([
            "filesGet",
            "lockUnlock",
            "filesUpdate",
            "localUnlink",
            "teardownHeartbeat"
        ]);

        // The 5-key clear sets all five keys to "" (Drive deletes empty-string keys).
        const update = calls.find(c => c.kind === "filesUpdate");
        expect(update.args.body.appProperties).toEqual({
            mpsProjectId: "",
            mpsScriptRelPath: "",
            mpsFormat: "",
            mpsClientId: "",
            mpsSchemaVersion: ""
        });
    });

    test("stale lock matching our token → same as locked-by-me (lockUnlock first)", async () =>
    {
        const { deps, calls } = makeDeps({
            appProps: { mpsLockToken: "ours", mpsLockedAt: "ancient" },
            forceState: "stale"
        });

        const result = await runUnlinkFlow(deps);

        expect(result.branch).toBe("released-stale-lock");
        const kinds = calls.map(c => c.kind);
        const lockIdx = kinds.indexOf("lockUnlock");
        const updateIdx = kinds.indexOf("filesUpdate");
        expect(lockIdx).toBeGreaterThan(-1);
        expect(updateIdx).toBeGreaterThan(lockIdx);
        expect(kinds).toContain("localUnlink");
        expect(kinds).toContain("teardownHeartbeat");
    });

    test("locked-by-other + confirm accepted → NO lockUnlock, but 5-key clear runs", async () =>
    {
        let confirmArgs = null;
        const { deps, calls } = makeDeps({
            appProps: { mpsLockToken: "theirs", mpsLockedAt: "2026-06-29T12:00:00Z", mpsLockedBy: "Alice" },
            confirmLockedByOther: (args) => { confirmArgs = args; return true; }
        });

        const result = await runUnlinkFlow(deps);

        expect(result.branch).toBe("locked-by-other-accepted");
        expect(confirmArgs).toEqual({ lockedBy: "Alice", lockedAt: "2026-06-29T12:00:00Z" });

        const kinds = calls.map(c => c.kind);
        expect(kinds).not.toContain("lockUnlock");
        expect(kinds).toEqual([
            "filesGet",
            "filesUpdate",
            "localUnlink",
            "teardownHeartbeat"
        ]);
    });

    test("locked-by-other + confirm declined → no Drive writes, no localUnlink", async () =>
    {
        const { deps, calls } = makeDeps({
            appProps: { mpsLockToken: "theirs", mpsLockedBy: "Alice" },
            confirmLockedByOther: () => false
        });

        const result = await runUnlinkFlow(deps);

        expect(result.branch).toBe("locked-by-other-declined");
        const kinds = calls.map(c => c.kind);
        expect(kinds).toEqual(["filesGet"]);   // ONLY the read, nothing else
    });

    test("unlocked → no lockUnlock, 5-key clear happens", async () =>
    {
        const { deps, calls } = makeDeps({ appProps: {} });

        const result = await runUnlinkFlow(deps);

        expect(result.branch).toBe("unlocked");
        const kinds = calls.map(c => c.kind);
        expect(kinds).not.toContain("lockUnlock");
        expect(kinds).toEqual([
            "filesGet",
            "filesUpdate",
            "localUnlink",
            "teardownHeartbeat"
        ]);
    });

    test("filesGet throws → local-only unlink (no filesUpdate, no lockUnlock)", async () =>
    {
        const { deps, calls } = makeDeps({ filesGetThrows: true });

        const result = await runUnlinkFlow(deps);

        expect(result.branch).toBe("filesGet-failed");
        const kinds = calls.map(c => c.kind);
        expect(kinds).toEqual([
            "filesGet",
            "localUnlink",
            "teardownHeartbeat"
        ]);
    });

    test("no token → local-only unlink, no Drive calls at all", async () =>
    {
        const { deps, calls } = makeDeps();
        deps.token = null;

        const result = await runUnlinkFlow(deps);

        expect(result.branch).toBe("no-token");
        const kinds = calls.map(c => c.kind);
        expect(kinds).toEqual(["localUnlink", "teardownHeartbeat"]);
    });

    test("no docId → local-only unlink, no Drive calls at all", async () =>
    {
        const { deps, calls } = makeDeps();
        deps.docId = null;

        const result = await runUnlinkFlow(deps);

        expect(result.branch).toBe("no-token");
        const kinds = calls.map(c => c.kind);
        expect(kinds).toEqual(["localUnlink", "teardownHeartbeat"]);
    });

    test("filesUpdate failure during 5-key clear → onDriveUpdateFailed toast fires, machine still unlinks", async () =>
    {
        const { deps, calls } = makeDeps({
            appProps: { mpsLockToken: "ours", mpsLockedAt: "2026-06-29T12:00:00Z" },
            filesUpdateThrows: true
        });

        const result = await runUnlinkFlow(deps);

        // Lock was released before the failure happened.
        expect(result.branch).toBe("released-own-lock");
        const kinds = calls.map(c => c.kind);
        expect(kinds).toContain("toast");
        expect(kinds).toContain("localUnlink");
        expect(kinds).toContain("teardownHeartbeat");
    });

    test("lockUnlock throws → flow HALTS, no 5-key clear, no localUnlink, toast fires", async () =>
    {
        const calls = [];
        const result = await runUnlinkFlow({
            token: "tok-abc",
            docId: "doc-1",
            ourLockToken: "ours",
            filesGet: async () => ({ appProperties: { mpsLockToken: "ours", mpsLockedAt: "x" } }),
            filesUpdate: async (args) => { calls.push({ kind: "filesUpdate", args }); return {}; },
            lockUnlock: async () => { calls.push({ kind: "lockUnlock-threw" }); throw new Error("nope"); },
            evaluateLockStateFn: () => "locked-by-me",
            confirmLockedByOther: () => true,
            onDriveUpdateFailed: () => { calls.push({ kind: "toast" }); },
            localUnlink: async () => { calls.push({ kind: "localUnlink" }); },
            teardownHeartbeat: () => { calls.push({ kind: "teardownHeartbeat" }); }
        });

        expect(result.branch).toBe("lock-release-failed");
        const kinds = calls.map(c => c.kind);
        // lockUnlock threw → flow halted. No filesUpdate, no localUnlink, no teardown.
        // Toast fires so the user can retry.
        expect(kinds).toEqual([
            "lockUnlock-threw",
            "toast"
        ]);
        expect(kinds).not.toContain("filesUpdate");
        expect(kinds).not.toContain("localUnlink");
        expect(kinds).not.toContain("teardownHeartbeat");
    });
});
