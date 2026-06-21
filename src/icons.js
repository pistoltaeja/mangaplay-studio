import { Files, Palette, Settings,
         Columns2, PanelLeftClose, PanelLeftOpen,
         Folder, Bookmark, TableOfContents, X,
         ArrowLeftRight, CircleUser,
         Copy, Trash2, Pencil, Plus, FilePlus, FolderPlus, Scissors,
         MoveUpRight, ChevronRight, ChevronLeft, ChevronDown,
         Code, BookOpen, WandSparkles,
         ChevronsDownUp, MonitorCog, Check } from "lucide";

const REGISTRY = {
    "files":             Files,
    "palette":           Palette,
    "settings":          Settings,
    "arrow-left-right":  ArrowLeftRight,
    "columns-2":         Columns2,
    "panel-left-close":  PanelLeftClose,
    "panel-left-open":   PanelLeftOpen,
    "folder":            Folder,
    "bookmark":          Bookmark,
    "table-of-contents": TableOfContents,
    "x":                 X,
    "circle-user":       CircleUser,
    "copy":              Copy,
    "trash-2":           Trash2,
    "pencil":            Pencil,
    "plus":              Plus,
    "file-plus":         FilePlus,
    "folder-plus":       FolderPlus,
    "scissors":          Scissors,
    "move-up-right":     MoveUpRight,
    "chevron-right":     ChevronRight,
    "chevron-left":      ChevronLeft,
    "chevron-down":      ChevronDown,
    "code":              Code,
    "book-open":         BookOpen,
    "wand-sparkles":     WandSparkles,
    "chevrons-down-up":  ChevronsDownUp,
    "monitor-cog":       MonitorCog,
    "check":             Check
};

/**
 * Render a lucide icon as an inline-SVG string.
 *
 * Lucide v1 exports each icon as a children-array of [tag, attrs] tuples.
 * (Older lucide bundles exported the outer [tag, attrs, children] svg tuple;
 * the safe-defaults destructure below tolerates either shape — if `node` is
 * already a children array, the entries simply iterate as children.)
 *
 * @param {string} name
 * @param {{size?:number, class?:string, strokeWidth?:number}} [opts]
 * @returns {string}
 */
export function icon(name, opts = {})
{
    const node = REGISTRY[name];
    if (!node) throw new Error(`Unknown icon: ${name}`);
    // Detect tuple form ["svg", attrs, children[]] vs raw children[].
    let attrs = {};
    let children = node;
    if (typeof node[0] === "string" && node[0] === "svg")
    {
        [, attrs = {}, children = []] = node;
    }
    const size = opts.size ?? 16;
    const sw = opts.strokeWidth ?? attrs["stroke-width"] ?? 2;
    const cls = opts.class ? ` class="${opts.class}"` : "";
    const inner = children
        .map(([tag, a = {}]) =>
            `<${tag} ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`)
        .join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
         + `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" `
         + `stroke-linecap="round" stroke-linejoin="round"${cls}>${inner}</svg>`;
}
