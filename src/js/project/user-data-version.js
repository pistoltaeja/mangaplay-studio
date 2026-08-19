// @ts-check
/**
 * user-data-version.js — JS half of the user-data schema-version gate.
 *
 * Companion to the Rust commands `app_version_info`,
 * `user_data_ensure_version`, `user_data_apply_rung`,
 * `user_data_record_failure`, `user_data_skip_rung` (defined in
 * src-tauri/src/lib.rs). The Rust side owns the mutex + on-disk write.
 * This module owns:
 *
 *   - packaged-version cache (`loadAppVersionInfo`)
 *   - semver comparison (`cmpVersion`)
 *   - migration registry (`MIGRATIONS`)
 *   - chain selection (`findMigrationChain`)
 *   - boot-time orchestration (`ensureUserDataVersion`)
 *   - skip-rung wrapper (`skipFailedRung`)
 *
 * Boot order: app.js calls `await ensureUserDataVersion()` AFTER
 * `loadUserSettings()` and BEFORE the SDK init block (initIap /
 * initAnalytics / initAccount).
 *
 * Outside Tauri (jsdom tests) `loadAppVersionInfo` returns a stub so
 * imports don't blow up. The other functions still exercise their pure
 * logic (cmpVersion, findMigrationChain) without a Tauri runtime.
 */

import semverCompare from "semver/functions/compare";
import semverCoerce from "semver/functions/coerce";
import { isTauri } from "../util/index.js";

/**
 * @typedef {{ appVersion: string, userDataVersion: string }} AppVersionInfo
 * @typedef {(settings: Record<string, any>) => (Promise<Record<string, any> | null> | Record<string, any> | null)} MigrationFn
 * @typedef {{ from: string, to: string, name: string, fn: MigrationFn }} MigrationRung
 */

/** Tauri invoke helper — mirrors the pattern used by user-settings.js. */
async function invoke(cmd, args)
{
    if (!isTauri())
    {
        if (cmd === "app_version_info")
        {
            return { appVersion: "0.0.0", userDataVersion: "0.0.0" };
        }
        if (cmd === "user_data_ensure_version")
        {
            // Headless stub — pretend fresh user. Tests that need the
            // needs-decision path should mock invoke directly.
            return { result: "fresh", currentVersion: "0.0.0" };
        }
        if (cmd === "user_data_apply_rung")
        {
            return { result: "applied", currentVersion: (args && args.to) || "0.0.0" };
        }
        if (cmd === "user_data_record_failure") return undefined;
        if (cmd === "user_data_skip_rung")
        {
            return { result: "skipped", currentVersion: (args && args.to) || "0.0.0" };
        }
        if (cmd === "user_settings_load")
        {
            return {
                format: "user-settings:v1",
                defaultLanguage: "en",
                appVersionCreated: "0.0.0",
                createdVersion: null,
                currentVersion: null,
                lastMigrationAttempt: null,
                lastProjectPath: null,
                lastSettingsTab: "general",
                spellcheckEnabled: true,
                spellcheckLanguage: null,
            };
        }
        throw new Error("Tauri unavailable");
    }
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke(cmd, args);
}

let appVersionInfoCache = /** @type {AppVersionInfo | null} */ (null);

/**
 * Returns the packaged `{ appVersion, userDataVersion }` baked into the
 * Rust binary at compile time. Cached after the first call — the values
 * never change for the lifetime of the process.
 * @returns {Promise<AppVersionInfo>}
 */
export async function loadAppVersionInfo()
{
    if (appVersionInfoCache) return appVersionInfoCache;
    const info = /** @type {AppVersionInfo} */ (await invoke("app_version_info"));
    appVersionInfoCache = info;
    return info;
}

/**
 * Semver compare. Returns -1 if `a < b`, 0 if equal, 1 if `a > b`.
 * Coerces loose inputs ("1.0" → "1.0.0") so the registry can use short
 * version tags during early development. Pre-release tags ("1.1.0-rc.1")
 * parse natively. Throws clearly on unparseable input.
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function cmpVersion(a, b)
{
    const av = normaliseVersion(a);
    const bv = normaliseVersion(b);
    const r = semverCompare(av, bv);
    if (r < 0) return -1;
    if (r > 0) return 1;
    return 0;
}

/**
 * @param {string} v
 * @returns {string}
 */
function normaliseVersion(v)
{
    if (typeof v !== "string" || v.length === 0)
    {
        throw new Error(`cmpVersion: unparseable version ${JSON.stringify(v)}`);
    }
    // semver.compare accepts strict X.Y.Z (with optional pre-release/build).
    // For loose inputs like "1.0" or "1", fall back to coerce — which
    // preserves pre-release suffixes via the `includePrerelease` option.
    try
    {
        // Cheap path: if it already parses strictly, semverCompare will
        // accept it. We attempt a no-op compare against itself; on throw
        // we fall through to coerce.
        semverCompare(v, v);
        return v;
    }
    catch (_)
    {
        const coerced = semverCoerce(v, { includePrerelease: true });
        if (!coerced)
        {
            throw new Error(`cmpVersion: unparseable version ${JSON.stringify(v)}`);
        }
        return coerced.version;
    }
}

/**
 * Migration registry. Keys are `"<from>-><to>"` strings; values are
 * async transforms that receive the current settings and return a flat
 * patch object (or null for version-bump-only rungs).
 *
 * Starts EMPTY. First real migration ships in a later PR.
 *
 * @type {Record<string, MigrationFn>}
 */
export const MIGRATIONS = {};

/**
 * Walks the registry, building a strictly-chained path where each
 * rung's `to` equals the next rung's `from`. Throws if no chain exists
 * or if a cycle is detected. Also rejects overlapping rungs (two rungs
 * sharing the same `from`).
 *
 * Pure function — `registry` argument exists for tests.
 *
 * @param {string} from
 * @param {string} to
 * @param {Record<string, MigrationFn>} [registry]
 * @returns {MigrationRung[]}
 */
export function findMigrationChain(from, to, registry = MIGRATIONS)
{
    // Parse all rungs once. Detect overlapping `from` (ambiguous next-hop).
    /** @type {Map<string, MigrationRung>} */
    const byFrom = new Map();
    for (const name of Object.keys(registry))
    {
        const m = name.match(/^(.+?)->(.+)$/);
        if (!m) throw new Error(`migration registry: malformed key ${JSON.stringify(name)} (expected "<from>-><to>")`);
        const rungFrom = m[1];
        const rungTo = m[2];
        if (byFrom.has(rungFrom))
        {
            const prev = /** @type {MigrationRung} */ (byFrom.get(rungFrom));
            throw new Error(`migration registry: overlapping rungs from ${rungFrom} — ${prev.name} and ${name}`);
        }
        byFrom.set(rungFrom, { from: rungFrom, to: rungTo, name, fn: registry[name] });
    }

    if (cmpVersion(from, to) === 0) return [];

    /** @type {MigrationRung[]} */
    const chain = [];
    /** @type {Set<string>} */
    const visited = new Set();
    let cursor = from;
    while (cmpVersion(cursor, to) !== 0)
    {
        if (visited.has(cursor))
        {
            throw new Error(`migration registry: cycle detected at ${cursor}`);
        }
        visited.add(cursor);
        const next = byFrom.get(cursor);
        if (!next)
        {
            throw new Error(`no migration path from ${from} to ${to}`);
        }
        chain.push(next);
        cursor = next.to;
    }
    return chain;
}

/**
 * @typedef {{ status: "fresh", from: null, to: string }
 *   | { status: "up-to-date", from: string, to: string }
 *   | { status: "downgrade-noop", from: string, to: string }
 *   | { status: "migrated", from: string, to: string, rungs: number }
 *   | { status: "raced", from: string, to: string }
 * } EnsureResult
 */

/**
 * Boot-time entry point. Decides between fresh-stamp / no-op / migrate
 * based on the Rust gate, then walks the migration ladder if needed.
 *
 * Errors thrown by a rung are decorated with a `.migration` payload
 * (`{ from, to, name, consecutiveFailures }`) and re-thrown so the
 * error-router can surface a recoverable banner.
 *
 * @param {{}} [opts]
 * @returns {Promise<EnsureResult>}
 */
export async function ensureUserDataVersion(opts = {})
{
    // Touch the packaged-info cache up front so subsequent calls are cheap.
    const packagedInfo = await loadAppVersionInfo();
    const decision = await invoke("user_data_ensure_version");

    if (decision && decision.result === "fresh")
    {
        // Rust stamped a fresh user — nothing else to do.
        // eslint-disable-next-line no-console
        console.info("[user-data] fresh user stamped at", decision.currentVersion);
        return { status: "fresh", from: null, to: decision.currentVersion };
    }

    // result === "needs-decision"
    const onDisk = decision.onDisk;
    const packaged = decision.packaged;

    const cmp = cmpVersion(onDisk, packaged);
    if (cmp === 0)
    {
        return { status: "up-to-date", from: onDisk, to: onDisk };
    }
    if (cmp > 0)
    {
        // eslint-disable-next-line no-console
        console.warn("[user-data] on-disk version > packaged version — user downgraded? Skipping migration.");
        return { status: "downgrade-noop", from: onDisk, to: packaged };
    }

    // cmp < 0 — need to migrate.
    const chain = findMigrationChain(onDisk, packaged);
    const settings = await invoke("user_settings_load");

    for (const rung of chain)
    {
        let patch;
        try
        {
            patch = await rung.fn(settings);
        }
        catch (e)
        {
            await recordAndRethrow(rung, e);
        }

        let res;
        try
        {
            res = await invoke("user_data_apply_rung", {
                from: rung.from,
                to: rung.to,
                patch: patch || {},
            });
        }
        catch (e)
        {
            await recordAndRethrow(rung, e);
        }

        if (res && res.result === "stale")
        {
            // Another window beat us to it. Bail — they will continue
            // the ladder on their end; our next boot will recheck.
            // eslint-disable-next-line no-console
            console.info("[user-data] rung", rung.name, "was stale (another window) — bailing");
            return { status: "raced", from: onDisk, to: res.onDisk };
        }
    }

    // Silence unused-var lint without changing the public signature.
    void packagedInfo;
    void opts;

    return { status: "migrated", from: onDisk, to: packaged, rungs: chain.length };
}

/**
 * Record the failure (with consecutiveFailures incremented if the same
 * rung failed last time) and re-throw a decorated error.
 *
 * @param {MigrationRung} rung
 * @param {unknown} e
 * @returns {Promise<never>}
 */
async function recordAndRethrow(rung, e)
{
    const errMessage = (e && /** @type {any} */ (e).message) || String(e);

    // Read the latest settings to inspect lastMigrationAttempt — the
    // in-memory cache in user-settings.js may be stale across the await.
    let consec = 1;
    try
    {
        const settings2 = await invoke("user_settings_load");
        const prev = settings2 && settings2.lastMigrationAttempt;
        const sameRung = prev && prev.from === rung.from && prev.to === rung.to;
        consec = sameRung ? ((prev.consecutiveFailures || 0) + 1) : 1;
    }
    catch (_)
    {
        // If the load failed we still want to record SOMETHING — default
        // to 1 and let the next boot re-evaluate.
    }

    try
    {
        await invoke("user_data_record_failure", {
            from: rung.from,
            to: rung.to,
            error: errMessage,
            attemptedAt: new Date().toISOString(),
            consecutiveFailures: consec,
        });
    }
    catch (_)
    {
        // Recording the failure is best-effort. Don't mask the original.
    }

    const err = new Error(`migration failed: ${rung.name}: ${errMessage}`);
    /** @type {any} */ (err).migration = {
        from: rung.from,
        to: rung.to,
        name: rung.name,
        consecutiveFailures: consec,
    };
    throw err;
}

/**
 * Wraps the Rust `user_data_skip_rung` command. Used by the error-router's
 * "Skip and continue" action after the 2nd consecutive failure of the
 * same rung. The Rust side bumps `currentVersion` to the rung's `to`
 * WITHOUT applying the patch and clears `lastMigrationAttempt`.
 *
 * @param {{ from: string, to: string }} args
 * @returns {Promise<{ result: "skipped" | "stale", currentVersion?: string, onDisk?: string }>}
 */
export async function skipFailedRung({ from, to })
{
    return await invoke("user_data_skip_rung", { from, to });
}

/** Reset module-level cache — only used by tests. */
export function _resetForTests()
{
    appVersionInfoCache = null;
}
