// @ts-check
/**
 * mimetypes.js — Google Picker MIME-type maps.
 *
 * `pickFile({ kind })` accepts a small string enum. Each kind maps to the
 * exact Google Drive MIME types the picker should filter on. `any` maps
 * to an empty list which callers translate into an omitted `&mimetypes=`
 * query param (Google shows all supported types).
 *
 * Kept as data — no imports, no side effects. Safe to statically import
 * from anywhere without dragging the picker client into the bundle.
 */

/** @type {Record<"slide" | "doc" | "any", string[]>} */
export const KIND_MIMETYPES = {
    slide: ["application/vnd.google-apps.presentation"],
    doc:   ["application/vnd.google-apps.document"],
    any:   [],
};

/**
 * Resolve a picker kind to its MIME-type filter list.
 *
 * @param {"slide" | "doc" | "any" | string} kind
 * @returns {string[]}
 */
export function kindToMimetypes(kind)
{
    const list = KIND_MIMETYPES[/** @type {keyof typeof KIND_MIMETYPES} */ (kind)];
    return Array.isArray(list) ? list.slice() : [];
}
