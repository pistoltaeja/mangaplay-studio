// @ts-check
/**
 * folder-tree.js — pure tree model for the file-explorer.
 *
 * Turns the UUID-keyed entry list emitted by `registry_list_tree`
 * (see TODO/uuid-file-registry.md, Part 4b) into a hierarchical
 * TreeNode structure. Hierarchy is derived from `parentUuid`
 * linkage — no path-splitting.
 *
 * `uuid` is the authoritative identity key everywhere. `relPath`
 * survives on TreeNode as a display hint only (breadcrumbs,
 * tooltips, watcher-registration). Never round-trip relPath
 * back to Rust for identity purposes.
 *
 * No DOM, no state. Used by the renderer in folder-explorer.js and tested
 * directly in tests/folder-tree.test.js.
 *
 * Forward slashes only for `relPath` (Rust's `walk_tree` /
 * `registry_list_tree` already produce forward-slash relPaths).
 */

/**
 * @typedef {Object} TreeEntry
 * @property {string} uuid
 * @property {string|null} parentUuid
 * @property {string} name        basename only (last segment of relPath)
 * @property {string} relPath     forward-slash relative path from project root
 * @property {"file"|"folder"} kind
 * @property {number} [rev]
 * @property {string|number|null} [modifiedAt]
 * @property {string|number|null} [createdAt]
 * @property {string} [path]      absolute path (legacy — synthesised entries)
 */

/**
 * @typedef {Object} TreeNode
 * @property {string} uuid         authoritative identity key
 * @property {string|null} parentUuid
 * @property {string} name         basename (last segment of relPath)
 * @property {string} relPath      full forward-slash relative path (display hint)
 * @property {"file"|"folder"} kind
 * @property {TreeEntry|null} entry  the source entry; null for synthesised folders
 * @property {TreeNode[]} children
 * @property {number} depth        0 for project-root children
 */

const ROOT_UUID = "";

/**
 * @typedef {Object} BuildTreeResult
 * @property {TreeNode} root
 * @property {Map<string, TreeNode>} byUuid   uuid → node lookup (includes root)
 */

/**
 * Build a TreeNode root from a flat list of UUID-keyed entries.
 *
 * The returned root is a sentinel folder with uuid `""`, relPath `""`
 * and depth `-1`; its `children` are the top-level rows.
 *
 * Attachment rules:
 *   - `parentUuid == null || parentUuid === ""` → attach to root.
 *   - Otherwise, attach to the node with matching uuid. If that parent
 *     isn't in the entry list, attach to root defensively (mirrors the
 *     old synthesised-folder fallback).
 *
 * Two passes: pass 1 constructs nodes indexed by uuid; pass 2 attaches
 * them to parents. Two-pass avoids order dependence.
 *
 * @param {TreeEntry[]} entries
 * @returns {TreeNode}
 */
export function buildTree(entries)
{
    return buildTreeInternal(entries).root;
}

/**
 * Full build that also returns the uuid→node lookup map. Used
 * internally by `findNodeByUuid`.
 *
 * @param {TreeEntry[]} entries
 * @returns {BuildTreeResult}
 */
function buildTreeInternal(entries)
{
    /** @type {TreeNode} */
    const root = {
        uuid: ROOT_UUID,
        parentUuid: null,
        name: "",
        relPath: "",
        kind: "folder",
        entry: null,
        children: [],
        depth: -1,
    };
    /** @type {Map<string, TreeNode>} */
    const byUuid = new Map();
    byUuid.set(ROOT_UUID, root);

    if (!Array.isArray(entries)) return { root, byUuid };

    // Pass 1: create nodes indexed by uuid. Depth is finalised in pass 2
    // (parent depth + 1) since a node's depth depends on where it attaches.
    for (const entry of entries)
    {
        if (!entry || typeof entry.uuid !== "string" || entry.uuid === "") continue;
        if (byUuid.has(entry.uuid)) continue; // dedupe defensively
        const kind = entry.kind === "folder" ? "folder" : "file";
        const relPath = typeof entry.relPath === "string" ? entry.relPath : "";
        const basename = typeof entry.name === "string" && entry.name !== ""
            ? entry.name
            : (relPath.includes("/") ? relPath.slice(relPath.lastIndexOf("/") + 1) : relPath);
        /** @type {TreeNode} */
        const node = {
            uuid: entry.uuid,
            parentUuid: (entry.parentUuid === undefined ? null : entry.parentUuid),
            name: basename,
            relPath,
            kind,
            entry,
            children: [],
            depth: 0,
        };
        byUuid.set(entry.uuid, node);
    }

    // Pass 2: attach each node to its parent, compute depth. Iterate in
    // ancestor-first order by using a fixpoint — nodes whose parent
    // hasn't been attached yet get deferred. Since orphans attach to
    // root, this terminates.
    /** @type {Set<string>} */
    const attached = new Set([ROOT_UUID]);
    /** @type {TreeNode[]} */
    const pending = [];
    for (const [uuid, node] of byUuid)
    {
        if (uuid === ROOT_UUID) continue;
        pending.push(node);
    }
    let progress = true;
    while (pending.length > 0 && progress)
    {
        progress = false;
        for (let i = pending.length - 1; i >= 0; i--)
        {
            const node = pending[i];
            const parentKey = (node.parentUuid == null || node.parentUuid === "")
                ? ROOT_UUID
                : node.parentUuid;
            const parent = byUuid.get(parentKey);
            if (parent && attached.has(parent.uuid))
            {
                node.depth = parent.depth + 1;
                parent.children.push(node);
                attached.add(node.uuid);
                pending.splice(i, 1);
                progress = true;
            }
            else if (!parent)
            {
                // Unknown parent uuid — attach to root defensively.
                node.depth = 0;
                root.children.push(node);
                attached.add(node.uuid);
                pending.splice(i, 1);
                progress = true;
            }
        }
    }
    // Anything still pending is a cycle (shouldn't happen with valid
    // registry data). Attach the remainder to root to guarantee render.
    for (const node of pending)
    {
        node.depth = 0;
        root.children.push(node);
        attached.add(node.uuid);
    }

    return { root, byUuid };
}

/**
 * Locate a node by its uuid. Returns the sentinel root when uuid is
 * `""` or null, and null when not found.
 *
 * Rebuilds the byUuid map by walking the tree. Callers that need
 * repeated lookups should cache their own map.
 *
 * @param {TreeNode} root
 * @param {string|null} uuid
 * @returns {TreeNode|null}
 */
export function findNodeByUuid(root, uuid)
{
    if (!root) return null;
    if (uuid === ROOT_UUID || uuid == null) return root;
    /** @type {TreeNode[]} */
    const stack = [root];
    while (stack.length > 0)
    {
        const node = /** @type {TreeNode} */ (stack.pop());
        if (node.uuid === uuid) return node;
        for (const child of node.children) stack.push(child);
    }
    return null;
}

/**
 * Locate a node by its rel-path. Returns null when not found.
 * Kept for the folder-explorer's transitional caller cascade and for
 * legacy test coverage — uuid is the authoritative key.
 *
 * @param {TreeNode} root
 * @param {string} relPath
 * @returns {TreeNode|null}
 */
export function findNodeByRelPath(root, relPath)
{
    if (!root) return null;
    if (relPath === "" || relPath == null) return root;
    const segments = String(relPath).split("/").filter(Boolean);
    let cur = root;
    for (const seg of segments)
    {
        const next = cur.children.find((c) => c.name === seg);
        if (!next) return null;
        cur = next;
    }
    return cur;
}

/**
 * Flatten the tree into the linear sequence of visible rows the renderer
 * should produce, honouring the `expanded` set. Folders come before files
 * within each level; within a kind group, case-insensitive alphabetical
 * by `name`.
 *
 * The root sentinel itself is never emitted.
 *
 * @param {TreeNode} root
 * @param {Set<string>} expanded   set of UUIDs whose children are visible
 * @returns {TreeNode[]}
 */
export function flattenForRender(root, expanded)
{
    /** @type {TreeNode[]} */
    const out = [];
    const exp = expanded instanceof Set ? expanded : new Set();
    visit(root, out, exp);
    return out;
}

/**
 * @param {TreeNode} node
 * @param {TreeNode[]} out
 * @param {Set<string>} expanded
 */
function visit(node, out, expanded)
{
    const children = sortChildren(node.children);
    for (const child of children)
    {
        out.push(child);
        if (child.kind === "folder" && expanded.has(child.uuid))
        {
            visit(child, out, expanded);
        }
    }
}

/**
 * Sort children: folders first, then files; within each group, case-
 * insensitive alphabetical by `name`. Returns a new array — does not
 * mutate the input.
 *
 * @param {TreeNode[]} list
 * @returns {TreeNode[]}
 */
function sortChildren(list)
{
    const copy = list.slice();
    copy.sort((a, b) =>
    {
        if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return copy;
}
