// @ts-check
/**
 * harper-linter.js — module-singleton owner of the Harper WorkerLinter.
 *
 * Harper ships as a Web Worker + WASM bundle (Apache-2.0). One worker is
 * shared across every CM6 view; dialect changes destroy + rebuild the
 * worker (rare event, settings-driven). The CSP in tauri.conf.json grants
 * `'wasm-unsafe-eval'` and `worker-src 'self' blob:` so the WASM can
 * instantiate and the Blob-URL worker can spawn.
 *
 * Public surface: `warmupHarper(dialect)` warms the worker at boot,
 * `lintEnglish(text, dialect)` returns Harper's raw lint result. The
 * shared worker is lazy-built on first use and rebuilt on dialect change.
 */

import { WorkerLinter, Dialect } from "harper.js";

/**
 * Resolve a tier-shape dialect (now a plain string sentinel) to the real
 * Harper `Dialect` enum value. `spellcheck-tier.js` returns "American" /
 * "British" so it can stay free of any `harper.js` import — without this
 * sleeve the entire Harper bundle would land in the boot chunk.
 *
 * Accepts the actual enum value too, in case a caller pre-resolved it.
 * Defaults to `Dialect.American` for unknown / missing inputs.
 *
 * @param {any} d
 * @returns {any}
 */
function resolveDialect(d)
{
    if (d === "American") return Dialect.American;
    if (d === "British") return Dialect.British;
    if (d === Dialect.American || d === Dialect.British) return d;
    return Dialect.American;
}
// `binary` keeps the 18 MB WASM as a separate asset rather than baking it
// into the JS bundle as base64 (the `binaryInlined` variant would add ~24 MB
// to app.js and blow the 3 MB bundle ceiling). The .wasm is copied next to
// app.js by scripts/copy-assets.js so harper.js's
// `new URL("harper_wasm_bg.wasm", import.meta.url)` resolves against
// `<frontend>/js/app.js` and stays same-origin with the page.
import { binary } from "harper.js/binary";

// Asset copying (scripts/copy-assets.js) places both `harper_wasm_bg.wasm`
// and `harper_wasm_slim_bg.wasm` in the frontend so the WebView's MIME
// handler returns `application/wasm` for both. No streaming shim or
// worker patch is required — past attempts (1) main-thread WebAssembly
// streaming shim and (2) Worker constructor interception broke the
// editor linter pipeline in subtle ways. The shipped wasm assets + dev
// `mpsdev` handler with `application/wasm` MIME mapping are the
// minimum-risk fix.

/** @type {any} */
let instance = null;
/** @type {any} */
let currentDialect = null;

/**
 * Words already pushed to Harper's user dictionary on the current worker.
 * Cleared whenever the worker is rebuilt (dialect change). The Set is the
 * dedupe layer for `ensureDictionary()` — Harper's `importWords()` is a
 * round-trip to the worker, so we keep the call free of repeats.
 * @type {Set<string>}
 */
const importedWords = new Set();

/**
 * Lazy-instantiate the shared WorkerLinter. Rebuilds on dialect change.
 * @param {any} dialect - One of `Dialect.American` / `Dialect.British`.
 * @returns {any}
 */
function ensureHarper(dialect)
{
    const resolved = resolveDialect(dialect);
    if (instance && currentDialect === resolved) return instance;
    if (instance)
    {
        // Linter.dispose() is async but we fire-and-forget — by the time the
        // promise settles the old worker is unreferenced.
        try { instance.dispose(); }
        catch (_) { /* ignore */ }
        // Old worker's user dictionary dies with it.
        importedWords.clear();
    }
    instance = new WorkerLinter({ binary, dialect: resolved });
    currentDialect = resolved;
    return instance;
}

/**
 * Tear down the singleton WorkerLinter. Called from app teardown so the
 * Worker thread + WASM heap release deterministically — matters on mobile
 * where the OS process budget is tight; on desktop the OS reclaims on exit.
 */
export function disposeHarper()
{
    if (!instance) return;
    try { instance.dispose(); }
    catch (_) { /* ignore */ }
    instance = null;
    currentDialect = null;
    importedWords.clear();
}

/**
 * Add words to Harper's user dictionary. Idempotent — only NEW words are
 * forwarded to the worker. Cleared on dialect rebuild.
 *
 * Used by the spellcheck pipeline to register script-specific vocabulary
 * (character cues, title-page Characters/Vocabulary lists, author name) so
 * Harper's curated dictionary stops flagging legitimate proper nouns,
 * honorifics, and slang contractions as spelling errors.
 *
 * @param {string[]} words
 * @returns {Promise<void>}
 */
export async function ensureDictionary(words)
{
    if (!instance) return;
    /** @type {string[]} */
    const fresh = [];
    for (const w of words)
    {
        const trimmed = (w || "").trim();
        if (!trimmed) continue;
        if (importedWords.has(trimmed)) continue;
        importedWords.add(trimmed);
        fresh.push(trimmed);
    }
    if (fresh.length === 0) return;
    try { await instance.importWords(fresh); }
    catch (_) { /* harper may not expose importWords on older worker — fail silent */ }
}

/**
 * Warm the Harper worker (downloads/instantiates WASM) so the first real
 * lint call is fast. Called once at boot from app.js.
 * @param {any} dialect
 * @returns {Promise<void>}
 */
export async function warmupHarper(dialect)
{
    const h = ensureHarper(dialect);
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    try { await h.setup(); }
    catch (_) { /* ignore — lazy setup will retry on first lint */ }
    // Stamp the benchmark ledger if present so the perf test can read it.
    try
    {
        /** @type {any} */
        const bench = typeof window !== "undefined" && /** @type {any} */ (window).__mpsBenchmark;
        if (bench && typeof performance !== "undefined")
        {
            bench.harperWarmupMs = performance.now() - t0;
            bench.harperWarmupDoneAt = performance.now();
        }
    }
    catch (_) { /* ignore */ }
}

/**
 * Lint `text` with Harper against the requested dialect. Returns the raw
 * Harper lint result array — the caller is responsible for mapping spans
 * back to absolute document positions.
 *
 * Forces `language: "plaintext"` because our prose is extracted from
 * Lezer-classified script nodes, not markdown; without this Harper would
 * treat `*foo*` / `# foo` as emphasis / heading syntax and silently shift
 * span offsets.
 * @param {string} text
 * @param {any} dialect
 * @returns {Promise<any[]>}
 */
export async function lintEnglish(text, dialect)
{
    const h = ensureHarper(dialect);
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    const result = await h.lint(text, { language: "plaintext" });
    // First-lint stamp for the benchmark — only set on the FIRST successful
    // call. Subsequent lints are below the worker's RPC overhead and not
    // useful to report once Harper has warmed up.
    try
    {
        /** @type {any} */
        const bench = typeof window !== "undefined" && /** @type {any} */ (window).__mpsBenchmark;
        if (bench && bench.firstLintMs === undefined && typeof performance !== "undefined")
        {
            bench.firstLintMs = performance.now() - t0;
            bench.firstLintDoneAt = performance.now();
        }
    }
    catch (_) { /* ignore */ }
    return result;
}

