// @ts-check
/**
 * publish-scope.js — resolve the publish scope for a Google Slides publish
 * request.
 *
 * A publish request originates against an active file. If that file's
 * parent folder has `folderType === "storyboard"`, the publish is against
 * the WHOLE FOLDER (all sibling .mangaplay files stitched into a single
 * aggregate script). Otherwise it's a single-file publish.
 *
 * Aggregate stitching happens on demand — we don't require the
 * aggregate-view to be mounted (the desktop feature flag
 * `renderGroupsAsOne` may be off). We read the sibling files from disk
 * directly using `readFile`, stitch them with the same title-page
 * stripping rule as `aggregate-view.collectSourceForExport`, and parse
 * the result with `parseScript`.
 */

import {
    listProjectTree,
    getFolderType,
    readFile,
} from "../project/project.js";
import { formatForFilename } from "../editor/lang-registry.js";

/**
 * @typedef {{
 *   kind: "file",
 *   activeFileUuid: string,
 *   basename: string,
 *   pageCount: number,
 * } | {
 *   kind: "folder",
 *   folderUuid: string,
 *   folderName: string,
 *   fileUuids: string[],
 *   activeFileUuid: string,
 *   fileCount: number,
 *   pageCount: number,
 * }} PublishScope
 */

/**
 * @typedef {{
 *   scope: PublishScope,
 *   sourceText: string,
 *   script: any,
 * }} ResolvedPublish
 */

/**
 * Best-effort title-page strip — mirrors `stripTitlePage` in
 * `aggregate-view.js`. Removes the top block from the first line up to
 * (and including) the first blank line when the first line looks like a
 * title-page key (letters + spaces + colon).
 *
 * @param {string} text
 * @returns {string}
 */
function stripTitlePage(text)
{
    if (!text) return text;
    const keyLine = /^[A-Za-z][A-Za-z ]*:/;
    const lines = text.split(/\r?\n/);
    if (lines.length === 0 || !keyLine.test(lines[0])) return text;
    let i = 0;
    while (i < lines.length && lines[i].trim() !== "") i++;
    while (i < lines.length && lines[i].trim() === "") i++;
    return lines.slice(i).join("\n");
}

/**
 * Count `# Page N` markers in stitched source — proxy for page count when
 * the caller only needs a rough number for the scope header.
 *
 * @param {any} script
 * @returns {number}
 */
function pageCountOf(script)
{
    if (!script || !Array.isArray(script.pages)) return 0;
    return script.pages.length;
}

/**
 * Resolve the publish scope for a click against the active file. When the
 * active file lives in a Storyboard Folder, returns a `folder` scope with
 * the stitched aggregate source. Otherwise returns a `file` scope with
 * the single-file source.
 *
 * `parseScript` is loaded lazily so callers on the cold-boot bundle path
 * don't drag the parser in.
 *
 * @param {{
 *   projectPath: string,
 *   activeFileUuid: string | null,
 *   activeBasename: string,
 *   fallbackSourceText: string,
 *   fallbackScript: any,
 * }} opts
 * @returns {Promise<ResolvedPublish>}
 */
export async function resolvePublishScope(opts)
{
    const { projectPath, activeFileUuid, activeBasename, fallbackSourceText, fallbackScript } = opts;

    // Diagnostic: log the raw input so we can see which side is failing when
    // a Storyboard Folder child publishes as a single file. Grep the DevTools
    // console for "[publish-scope]" to see the decision trail.
    console.warn("[publish-scope] input", {
        projectPath,
        activeFileUuid,
        activeBasename,
        hasFallbackSourceText: typeof fallbackSourceText === "string" && fallbackSourceText.length > 0,
        hasFallbackScript: Boolean(fallbackScript),
    });

    // No project or no active file uuid → single-file with runtime data.
    if (!projectPath || !activeFileUuid)
    {
        console.warn("[publish-scope] bail:no-project-or-uuid → kind=file", {
            projectPath,
            activeFileUuid,
        });
        return {
            scope: {
                kind: "file",
                activeFileUuid: activeFileUuid || "",
                basename: activeBasename || "",
                pageCount: pageCountOf(fallbackScript),
            },
            sourceText: fallbackSourceText,
            script: fallbackScript,
        };
    }

    /** @type {any[]} */
    let entries;
    try
    {
        entries = await listProjectTree(projectPath);
    }
    catch (e)
    {
        console.warn("[publish-scope] listProjectTree threw", {
            projectPath,
            error: (e && e.message) ? e.message : String(e),
        });
        entries = [];
    }
    console.warn("[publish-scope] listProjectTree ok", {
        entryCount: Array.isArray(entries) ? entries.length : 0,
    });
    const target = entries.find((e) => e && e.uuid === activeFileUuid);
    console.warn("[publish-scope] lookup:target", {
        activeFileUuid,
        foundTarget: Boolean(target),
        targetName: target ? target.name : null,
        targetKind: target ? target.kind : null,
        targetParentUuid: target ? target.parentUuid : null,
    });
    const parentUuid = target && target.parentUuid ? target.parentUuid : null;
    if (!parentUuid)
    {
        console.warn("[publish-scope] bail:no-parent → kind=file", {
            activeFileUuid,
            foundTarget: Boolean(target),
        });
        return {
            scope: {
                kind: "file",
                activeFileUuid,
                basename: activeBasename || (target?.name || ""),
                pageCount: pageCountOf(fallbackScript),
            },
            sourceText: fallbackSourceText,
            script: fallbackScript,
        };
    }

    /** @type {string} */
    let folderType = "default";
    try
    {
        folderType = /** @type {any} */ (await getFolderType(projectPath, parentUuid));
    }
    catch (e)
    {
        console.warn("[publish-scope] getFolderType threw", {
            projectPath,
            parentUuid,
            error: (e && e.message) ? e.message : String(e),
        });
        folderType = "default";
    }
    console.warn("[publish-scope] getFolderType result", {
        projectPath,
        parentUuid,
        folderType,
    });

    if (folderType !== "storyboard")
    {
        console.warn("[publish-scope] bail:not-storyboard → kind=file", {
            folderType,
        });
        return {
            scope: {
                kind: "file",
                activeFileUuid,
                basename: activeBasename || (target?.name || ""),
                pageCount: pageCountOf(fallbackScript),
            },
            sourceText: fallbackSourceText,
            script: fallbackScript,
        };
    }

    // Storyboard folder — gather alphabetical mangaplay siblings.
    const parent = entries.find((e) => e && e.uuid === parentUuid);
    const folderName = parent?.name || "Untitled";
    /** @type {Array<{uuid: string, name: string, relPath: string}>} */
    const siblings = [];
    for (const e of entries)
    {
        if (!e || e.parentUuid !== parentUuid) continue;
        if (e.kind !== "file") continue;
        if (formatForFilename(e.name) !== "mangaplay") continue;
        siblings.push(e);
    }
    siblings.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    console.warn("[publish-scope] siblings", {
        folderName,
        parentUuid,
        siblingCount: siblings.length,
        siblingNames: siblings.map((s) => s.name),
    });

    if (siblings.length === 0)
    {
        console.warn("[publish-scope] bail:no-siblings → kind=file");
        // Shouldn't happen — the active file itself should be in the list.
        return {
            scope: {
                kind: "file",
                activeFileUuid,
                basename: activeBasename || (target?.name || ""),
                pageCount: pageCountOf(fallbackScript),
            },
            sourceText: fallbackSourceText,
            script: fallbackScript,
        };
    }

    const projRoot = projectPath.replace(/[\\/]+$/, "");
    /** @type {string[]} */
    const parts = [];
    for (const sib of siblings)
    {
        const absPath = `${projRoot}/${sib.relPath}`;
        let text = "";
        try
        {
            text = (await readFile(absPath)) || "";
        }
        catch (e)
        {
            console.warn("[publish-scope] readFile failed for", absPath, e);
        }
        parts.push(stripTitlePage(text));
    }
    const synthetic = `Title: ${folderName}\n\n`;
    const sourceText = synthetic + parts.join("\n\n");

    // Lazy parseScript import — avoids dragging the parser into any cold
    // boot path that transitively imports this module.
    let script = null;
    try
    {
        const { parseScript } = await import("@mangaplay-studio/core");
        script = parseScript(sourceText);
    }
    catch (e)
    {
        console.warn("[publish-scope] parseScript failed:", e);
        script = fallbackScript;
    }

    console.warn("[publish-scope] decide → kind=folder", {
        folderUuid: parentUuid,
        folderName,
        fileCount: siblings.length,
        pageCount: pageCountOf(script),
    });
    return {
        scope: {
            kind: "folder",
            folderUuid: parentUuid,
            folderName,
            fileUuids: siblings.map((s) => s.uuid),
            activeFileUuid,
            fileCount: siblings.length,
            pageCount: pageCountOf(script),
        },
        sourceText,
        script,
    };
}
