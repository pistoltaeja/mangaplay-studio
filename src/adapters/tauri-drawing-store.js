// @ts-check
/**
 * tauri-drawing-store.js — desktop adapter for core/storage/drawing-store.js.
 *
 * The website canvas persists strokes to IndexedDB (per-WebView, per-domain).
 * Desktop wants strokes in the project's .mangaart so they follow the folder.
 * This adapter funnels save/load calls to globalThis.__MPS_DESKTOP__, which is
 * wired up by app.js once the project is open. If the bridge isn't ready yet
 * (e.g. boot order), calls are silently no-op'd so the engine still functions.
 *
 * The strokes payload is stored verbatim — could be compact:v1, drawengine:v1,
 * etc. Format is preserved on round-trip.
 */

function bridge()
{
    return globalThis.__MPS_DESKTOP__ || null;
}

/**
 * @param {string} slotId
 * @param {number} pageIndex
 * @param {any[]} strokes — already encoded (compact or drawengine)
 * @param {string} [format="drawengine:v1"]
 * @returns {Promise<{ ok: boolean, bytesWritten?: number, error?: string }>}
 */
export async function savePageVectors(slotId, pageIndex, strokes, format = "drawengine:v1")
{
    const b = bridge();
    if (!b) return { ok: false, error: "bridge-not-ready" };
    try
    {
        const drawing = { strokes, version: format };
        b.updatePage(pageIndex, drawing);
        b.queueSave();
        const bytesWritten = JSON.stringify(strokes).length;
        return { ok: true, bytesWritten };
    }
    catch (e)
    {
        return { ok: false, error: e?.message || "unknown" };
    }
}

/**
 * @param {string} slotId
 * @param {number} pageIndex
 * @returns {Promise<null | { format: string, strokes: any[] }>}
 */
export async function loadPageVectors(slotId, pageIndex)
{
    const b = bridge();
    if (!b) return null;
    const m = b.getMangaart();
    if (!m || !Array.isArray(m.pages)) return null;
    const entry = m.pages.find(p => p && p.index === pageIndex);
    if (!entry || !entry.drawing) return null;
    return {
        format: entry.drawing.version || "drawengine:v1",
        strokes: entry.drawing.strokes || [],
    };
}

/**
 * @param {string} slotId
 * @param {number} pageIndex
 * @returns {Promise<number>} byte size estimate
 */
export async function getPageSize(slotId, pageIndex)
{
    const b = bridge();
    if (!b) return 0;
    const m = b.getMangaart();
    if (!m || !Array.isArray(m.pages)) return 0;
    const entry = m.pages.find(p => p && p.index === pageIndex);
    if (!entry || !entry.drawing) return 0;
    try { return JSON.stringify(entry.drawing).length; } catch { return 0; }
}

/** localStorage is always durable in WebView2 — pretend we requested it. */
export async function requestPersistence() { return true; }

/** Stub DB handle — the engine sometimes calls this defensively. */
export async function openDrawingDB()
{
    return { _kind: "tauri-drawing-store-stub" };
}

// ── Safe stubs for less-used exports (the engine may import some of these). ──

export function setDecompressWorker() {}
export async function deleteDrawingDB() { return true; }
export function migrateFormat(payload) { return payload; }

export async function savePageMeta(slotId, pageIndex, meta)
{
    const b = bridge();
    if (!b) return { ok: false, error: "bridge-not-ready" };
    const m = b.getMangaart();
    if (!m || !Array.isArray(m.pages)) return { ok: false, error: "no-cache" };
    const entry = m.pages.find(p => p && p.index === pageIndex);
    if (entry) entry.meta = meta; // tuck meta alongside drawing
    return { ok: true };
}

export async function loadPageMeta(slotId, pageIndex)
{
    const b = bridge();
    if (!b) return null;
    const m = b.getMangaart();
    if (!m || !Array.isArray(m.pages)) return null;
    const entry = m.pages.find(p => p && p.index === pageIndex);
    return entry?.meta || null;
}

export async function migrateIdbToDocKeys() { return { ok: true, migrated: 0 }; }

export async function deletePageVectors(slotId, pageIndex)
{
    const b = bridge();
    if (!b) return true;
    const m = b.getMangaart();
    if (!m || !Array.isArray(m.pages)) return true;
    m.pages = m.pages.filter(p => p && p.index !== pageIndex);
    b.queueSave();
    return true;
}

export async function deleteSlotVectors() { return true; }
export async function getTotalStorageUsed() { return 0; }
export async function savePagePreview() { return { ok: true }; }
export async function loadPagePreview() { return null; }
export async function checkStorageQuota() { return { ok: true, usage: 0, quota: Number.MAX_SAFE_INTEGER }; }
