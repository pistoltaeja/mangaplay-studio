// @ts-check
/**
 * folder-tree.js — pure tree model for the file-explorer.
 *
 * Turns the flat entry list emitted by `app_list_project_tree` into a
 * hierarchical TreeNode structure. Folders missing from the Rust output
 * are synthesised from intermediate path segments (defensive — Rust does
 * emit folder rows, but the renderer must never depend on a parent row
 * being present before its children).
 *
 * No DOM, no state. Used by the renderer in folder-explorer.js and tested
 * directly in tests/folder-tree.test.js.
 *
 * Forward slashes only. `relPath` is the unique key (e.g. `chapter-1`,
 * `chapter-1/intro.mangaplay.md`).
 */

/**
 * @typedef {Object} TreeEntry
 * @property {string} name        relative path from project root, forward-slash
 * @property {"file"|"folder"} kind
 * @property {string} [path]      absolute path (when emitted by Rust)
 * @property {number} [modifiedAt]
 * @property {number} [createdAt]
 */

/**
 * @typedef {Object} TreeNode
 * @property {string} name         basename (last segment of relPath)
 * @property {string} relPath      full forward-slash relative path
 * @property {"file"|"folder"} kind
 * @property {TreeEntry|null} entry  the source entry; null for synthesised folders
 * @property {TreeNode[]} children
 * @property {number} depth        0 for project-root children
 */

/**
 * Build a TreeNode root from a flat list of entries.
 *
 * The returned root is a sentinel folder with relPath `""` and depth `-1`;
 * its `children` are the top-level rows.
 *
 * @param {TreeEntry[]} entries
 * @returns {TreeNode}
 */
export function buildTree(entries)
{
    /** @type {TreeNode} */
    const root = {
        name: "",
        relPath: "",
        kind: "folder",
        entry: null,
        children: [],
        depth: -1,
    };
    /** @type {Map<string, TreeNode>} */
    const byPath = new Map();
    byPath.set("", root);

    if (!Array.isArray(entries)) return root;

    // First pass: ensure a folder node exists for every intermediate segment.
    // This guarantees that out-of-order or missing folder rows still build
    // a correct tree.
    for (const entry of entries)
    {
        if (!entry || typeof entry.name !== "string") continue;
        // SEPARATOR CONTRACT: the tree model uses forward-slash relPaths as the
        // canonical key form, regardless of host. The Rust walker (lib.rs
        // walk_tree) already emits forward-slash relPaths via PathBuf.components
        // + join("/"), so the JS side just consumes them — no normalisation
        // needed at the boundary.
        const segments = entry.name.split("/").filter(Boolean);
        if (segments.length === 0) continue;

        // Walk every prefix as a folder, then the leaf according to kind.
        for (let i = 0; i < segments.length; i++)
        {
            const relPath = segments.slice(0, i + 1).join("/");
            const isLeaf = i === segments.length - 1;
            const kind = isLeaf ? entry.kind : "folder";

            if (byPath.has(relPath))
            {
                // If we previously synthesised a folder and the real entry
                // arrives now, upgrade the node's `entry` reference.
                const existing = /** @type {TreeNode} */ (byPath.get(relPath));
                if (isLeaf && existing.entry === null && existing.kind === kind)
                {
                    existing.entry = entry;
                }
                continue;
            }

            const parentRelPath = segments.slice(0, i).join("/");
            const parent = byPath.get(parentRelPath);
            if (!parent) continue; // unreachable in a well-formed walk

            /** @type {TreeNode} */
            const node = {
                name: segments[i],
                relPath,
                kind,
                entry: isLeaf ? entry : null,
                children: [],
                depth: i,
            };
            parent.children.push(node);
            byPath.set(relPath, node);
        }
    }

    return root;
}

/**
 * Locate a node by its rel-path. Returns null when not found.
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
 * @param {Set<string>} expanded   set of rel-paths whose children are visible
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
        if (child.kind === "folder" && expanded.has(child.relPath))
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
