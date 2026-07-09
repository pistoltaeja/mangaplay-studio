// @ts-check
/**
 * folder-picker.js — native Drive folder tree, used inline by the Publish
 * to Google Docs modal.
 *
 * We don't use the Google Picker API because Tauri's custom protocol
 * (`mpsdev://` / `tauri://`) isn't allow-listable as a Picker origin —
 * see the §"Why native, not Google Picker" rationale in
 * TODO/mangaplay-studio-google-docs-sync.md.
 *
 * Behaviour:
 *   - Two roots: "My Drive" (folderId='root', auto-expanded) and
 *     "Shared with me" (lazy on first expand via `sharedWithMe=true`).
 *   - Click a row = select that folder (fires `onSelect`).
 *   - Click the caret only = expand/collapse without selecting.
 *   - Children fetched on first expand, then cached for the component
 *     lifetime.
 *   - Loading: inline spinner row.
 *   - Empty: italic "No subfolders".
 *   - Error: inline "Couldn't load folders. Retry." with a retry link.
 *
 * The component is DOM-only and framework-free — fits the rest of
 * mangaplay-studio/src/ which is vanilla custom-elements + helpers.
 */

const MIME_FOLDER = "application/vnd.google-apps.folder";
const PAGE_SIZE = 100;

/**
 * @typedef {Object} FolderNode
 * @property {string} id
 * @property {string} name
 * @property {string} fullPath       — slash-separated label path e.g. "My Drive > Comics"
 * @property {boolean} expanded
 * @property {boolean} loaded
 * @property {boolean} loading
 * @property {string|null} loadError
 * @property {Array<FolderNode>} children
 * @property {"root"|"sharedWithMe"|"folder"} kind
 * @property {boolean} canSelect     — Shared-with-me virtual root cannot be selected as a destination
 */

/**
 * @typedef {Object} FolderPickerOpts
 * @property {{ filesList: (args: { token: string, q: string, fields?: string, pageSize?: number }) => Promise<{ files: Array<{ id: string, name: string }> }> }} driveClient
 * @property {string} token
 * @property {(folderId: string, folderName: string, fullPath: string) => void} onSelect
 * @property {(key: string, vars?: Record<string, any>) => string} t
 */

export class FolderPicker
{
    /**
     * @param {HTMLElement} container
     * @param {FolderPickerOpts} opts
     */
    constructor(container, opts)
    {
        this.container = container;
        this.opts = opts;
        this.t = opts.t;

        /** @type {string|null} */
        this.selectedId = null;

        /** @type {Array<FolderNode>} */
        this.roots =
        [
            {
                id: "root",
                name: this.t("mangaplay-studio.googleDocsSync.folderPicker.myDrive"),
                fullPath: this.t("mangaplay-studio.googleDocsSync.folderPicker.myDrive"),
                expanded: true,
                loaded: false,
                loading: false,
                loadError: null,
                children: [],
                kind: "root",
                canSelect: true
            },
            {
                id: "sharedWithMe",
                name: this.t("mangaplay-studio.googleDocsSync.folderPicker.sharedWithMe"),
                fullPath: this.t("mangaplay-studio.googleDocsSync.folderPicker.sharedWithMe"),
                expanded: false,
                loaded: false,
                loading: false,
                loadError: null,
                children: [],
                kind: "sharedWithMe",
                canSelect: false
            }
        ];

        this.container.classList.add("gds-folder-picker");
        this._render();

        // Auto-load My Drive on construction since it's expanded by default.
        this._loadChildren(this.roots[0]).catch(() => { /* surfaced inline */ });
    }

    /**
     * Render the tree from scratch. Called on every state change. Cheap —
     * the tree is small (folders, not files).
     */
    _render()
    {
        // Wipe + rebuild — simplest correct implementation, and the tree
        // has <100 visible rows in realistic use.
        this.container.replaceChildren();
        for (const root of this.roots)
        {
            this.container.appendChild(this._renderNode(root, 0));
        }
    }

    /**
     * @param {FolderNode} node
     * @param {number} depth
     * @returns {HTMLElement}
     */
    _renderNode(node, depth)
    {
        const wrapper = document.createElement("div");
        wrapper.className = "gds-node";

        const row = document.createElement("div");
        row.className = "gds-row";
        row.style.paddingLeft = `${depth * 16 + 8}px`;
        if (this.selectedId === node.id && node.canSelect)
        {
            row.dataset.selected = "true";
        }

        const caret = document.createElement("span");
        caret.className = "gds-caret";
        caret.textContent = node.expanded ? "▾" : "▸";
        caret.addEventListener("click", (e) =>
        {
            e.stopPropagation();
            this._toggleExpand(node);
        });
        row.appendChild(caret);

        const icon = document.createElement("span");
        icon.className = "gds-icon";
        icon.textContent = "📁";
        row.appendChild(icon);

        const label = document.createElement("span");
        label.className = "gds-label";
        label.textContent = node.name;
        row.appendChild(label);

        if (this.selectedId === node.id && node.canSelect)
        {
            const sel = document.createElement("span");
            sel.className = "gds-selected-badge";
            sel.textContent = this.t("mangaplay-studio.googleDocsSync.folderPicker.selected");
            row.appendChild(sel);
        }

        if (node.canSelect)
        {
            row.addEventListener("click", () => this._select(node));
            row.style.cursor = "pointer";
        }
        else
        {
            // Shared-with-me virtual root only toggles when its label is clicked.
            row.addEventListener("click", () => this._toggleExpand(node));
            row.style.cursor = "default";
        }

        wrapper.appendChild(row);

        if (node.expanded)
        {
            const childContainer = document.createElement("div");
            childContainer.className = "gds-children";

            if (node.loading)
            {
                const loading = document.createElement("div");
                loading.className = "gds-loading";
                loading.style.paddingLeft = `${(depth + 1) * 16 + 8}px`;
                loading.textContent = this.t("mangaplay-studio.googleDocsSync.folderPicker.loading");
                childContainer.appendChild(loading);
            }
            else if (node.loadError)
            {
                const errRow = document.createElement("div");
                errRow.className = "gds-error";
                errRow.style.paddingLeft = `${(depth + 1) * 16 + 8}px`;

                const errMsg = document.createElement("span");
                errMsg.textContent = this.t("mangaplay-studio.googleDocsSync.folderPicker.errorLoading") + " ";
                errRow.appendChild(errMsg);

                const retry = document.createElement("a");
                retry.href = "#";
                retry.className = "gds-retry";
                retry.textContent = this.t("mangaplay-studio.googleDocsSync.folderPicker.retry");
                retry.addEventListener("click", (e) =>
                {
                    e.preventDefault();
                    node.loadError = null;
                    this._loadChildren(node).catch(() => { /* surfaced inline */ });
                });
                errRow.appendChild(retry);

                childContainer.appendChild(errRow);
            }
            else if (node.loaded && node.children.length === 0)
            {
                const empty = document.createElement("div");
                empty.className = "gds-empty";
                empty.style.paddingLeft = `${(depth + 1) * 16 + 8}px`;
                empty.textContent = this.t("mangaplay-studio.googleDocsSync.folderPicker.noSubfolders");
                childContainer.appendChild(empty);
            }
            else
            {
                for (const child of node.children)
                {
                    childContainer.appendChild(this._renderNode(child, depth + 1));
                }
            }

            wrapper.appendChild(childContainer);
        }

        return wrapper;
    }

    /**
     * @param {FolderNode} node
     */
    _select(node)
    {
        if (!node.canSelect) return;
        this.selectedId = node.id;
        this._render();
        try { this.opts.onSelect(node.id, node.name, node.fullPath); }
        catch (e) { console.warn("[mps:gdocs:folder-picker] onSelect threw", e); }
    }

    /**
     * @param {FolderNode} node
     */
    async _toggleExpand(node)
    {
        node.expanded = !node.expanded;
        this._render();
        if (node.expanded && !node.loaded && !node.loading)
        {
            await this._loadChildren(node);
        }
    }

    /**
     * @param {FolderNode} node
     */
    async _loadChildren(node)
    {
        node.loading = true;
        node.loadError = null;
        this._render();

        try
        {
            const q = (node.kind === "sharedWithMe")
                ? `sharedWithMe=true and mimeType='${MIME_FOLDER}' and trashed=false`
                : `'${node.id}' in parents and mimeType='${MIME_FOLDER}' and trashed=false`;

            const resp = await this.opts.driveClient.filesList({
                token: this.opts.token,
                q,
                fields: "files(id,name)",
                pageSize: PAGE_SIZE
            });

            const files = Array.isArray(resp && resp.files) ? resp.files : [];
            node.children = files.map((f) => /** @type {FolderNode} */ ({
                id: String(f.id),
                name: String(f.name),
                fullPath: `${node.fullPath} > ${f.name}`,
                expanded: false,
                loaded: false,
                loading: false,
                loadError: null,
                children: [],
                kind: "folder",
                canSelect: true
            }));
            node.loaded = true;
        }
        catch (err)
        {
            const e = /** @type {any} */ (err);
            node.loadError = (e && e.message) || "load-failed";
        }
        finally
        {
            node.loading = false;
            this._render();
        }
    }

    /** Drop selection (used by callers when the user switches off "Choose folder"). */
    clearSelection()
    {
        this.selectedId = null;
        this._render();
    }

    /** @returns {string|null} */
    getSelectedId()
    {
        return this.selectedId;
    }
}
