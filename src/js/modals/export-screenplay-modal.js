// @ts-check
/**
 * export-screenplay-modal.js — Export the active screenplay to TXT / FDX 8 /
 * FDX 10-11 / Fade In / Fountain.
 *
 * UI: small modal built on the settings-modal styling primitives — uses
 * .settings-backdrop and a narrowed .settings-dialog so it looks at home
 * next to the existing Settings popup. Layout mirrors the fountain.plus
 * converter (6-card format grid + "Create Screenplay" CTA + progress spinner).
 *
 * Conversion routes (mirror websites/fountain.plus/src/converter-entry.js):
 *
 *   "pdf"      → await generateScreenplayPdf(screenplay, { ... })  // returns Blob
 *   "txt"      → generateTxt(screenplay)
 *   "fdx8"     → generateFdx(screenplay, { version: 1 })
 *   "fdx10"    → generateFdx(screenplay, { version: 4 })
 *   "fadein"   → await generateFadein(screenplay)        // returns Blob
 *   "fountain" → mangaplay: generateFountain(sourceText)
 *                fountain:  screenplayToFountain(screenplay)
 *
 * The resulting bytes go through saveFileDialog (native Save-As, bypassed in
 * tests via MPS_TEST_SAVE_DIR) then writeBytes.
 */

import { icon } from "../panes/icons.js";
import { openModal } from "./modal-shell.js";
import { t } from "../adapters/tauri-i18n.js";
import {
    saveFileDialog, writeBytes,
    PersistentStorage, STORAGE_KEYS
} from "../adapters/tauri-storage.js";
import { showBanner } from "../boot/toast.js";
import { astToScreenplay } from "@mangaplay-studio/core";
import {
    generateTxt,
    generateFdx,
    generateFadein,
    generateFountain,
    screenplayToFountain,
    generateScreenplayPdf,
} from "@mangaplay-studio/core/export";

/**
 * @typedef {Object} ExportFormat
 * @property {string} id
 * @property {string} label
 * @property {string} ext       Filename extension WITHOUT a leading dot.
 * @property {string} dotExt    Filename extension WITH a leading dot.
 * @property {string} filterLabel  Save-dialog filter display name.
 * @property {boolean} [disabled]  Hide / grey out a format card.
 */

/** @type {ExportFormat[]} */
const FORMATS = [
    { id: "pdf",      label: "Screenplay PDF",   ext: "pdf",     dotExt: ".pdf",     filterLabel: "PDF" },
    { id: "fdx8",     label: "Final Draft 8",    ext: "fdx",     dotExt: ".fdx",     filterLabel: "Final Draft" },
    { id: "fdx10",    label: "Final Draft 10-11",ext: "fdx",     dotExt: ".fdx",     filterLabel: "Final Draft" },
    { id: "fadein",   label: "Fade In",          ext: "fadein",  dotExt: ".fadein",  filterLabel: "Fade In" },
    { id: "fountain", label: "Fountain",         ext: "fountain",dotExt: ".fountain",filterLabel: "Fountain" },
    { id: "txt",      label: "Plain Text",       ext: "txt",     dotExt: ".txt",     filterLabel: "Plain Text" },
];

/**
 * Strip known suffixes from the basename to get the stem.
 * @param {string} name
 */
function stemFor(name)
{
    if (!name) return "Untitled";
    const lower = name.toLowerCase();
    const doubles = [".mangaplay.md", ".fountain.md", ".sup.md"];
    for (const d of doubles) if (lower.endsWith(d)) return name.slice(0, -d.length);
    const singles = [".mangaplay", ".fountain", ".sup", ".txt", ".md"];
    for (const s of singles) if (lower.endsWith(s)) return name.slice(0, -s.length);
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Coerce the active script + source into a Screenplay (.scenes[]).
 * For Fountain, the script IS already a Screenplay. For Mangaplay, run
 * astToScreenplay(). Returns null when the input is unusable.
 * @param {any} script
 * @param {string} scriptFormat
 * @param {string} _sourceText
 */
function toScreenplay(script, scriptFormat)
{
    if (!script) return null;
    if (scriptFormat === "fountain" || scriptFormat === "superscript")
    {
        return script;          // already a Screenplay-shape
    }
    if (scriptFormat === "mangaplay")
    {
        try { return astToScreenplay(script); }
        catch (e) { console.warn("[export] astToScreenplay failed:", e); return null; }
    }
    return null;
}

/**
 * Run the conversion for the chosen format. Returns { bytes, defaultName }
 * or throws.
 *
 * @param {object} args
 * @param {string} args.formatId
 * @param {any}    args.screenplay
 * @param {string} args.sourceText
 * @param {string} args.scriptFormat
 * @param {string} args.stem
 * @returns {Promise<{ bytes: Uint8Array, defaultName: string }>}
 */
async function runConversion(args)
{
    const { formatId, screenplay, sourceText, scriptFormat, stem } = args;
    const fmt = FORMATS.find(f => f.id === formatId);
    if (!fmt) throw new Error(`unknown format: ${formatId}`);
    const defaultName = `${stem}${fmt.dotExt}`;

    /** @type {Uint8Array} */
    let bytes;
    switch (formatId)
    {
        case "txt":
        {
            const out = generateTxt(screenplay);
            bytes = new TextEncoder().encode(out);
            break;
        }
        case "fdx8":
        {
            const out = generateFdx(screenplay, { version: 1 });
            bytes = new TextEncoder().encode(out);
            break;
        }
        case "fdx10":
        {
            const out = generateFdx(screenplay, { version: 4 });
            bytes = new TextEncoder().encode(out);
            break;
        }
        case "fadein":
        {
            const blob = await generateFadein(screenplay);
            const buf = await blob.arrayBuffer();
            bytes = new Uint8Array(buf);
            break;
        }
        case "fountain":
        {
            let text;
            if (scriptFormat === "mangaplay")
            {
                text = generateFountain(sourceText);
            }
            else
            {
                text = screenplayToFountain(screenplay);
            }
            bytes = new TextEncoder().encode(text);
            break;
        }
        case "pdf":
        {
            const mangaSettings = PersistentStorage.get(STORAGE_KEYS.MANGA_SETTINGS, {}) || {};
            const characterTitleCards = mangaSettings.characterTitleCards !== false;
            const boldHeadings = mangaSettings.boldHeadings === true;
            const pageNumbers = mangaSettings.pageNumbers !== false;
            const blob = await generateScreenplayPdf(screenplay, {
                fontCandidates: [
                    "/fonts/courier-prime/CourierPrime-Regular.ttf",
                ],
                fontBoldCandidates: [
                    "/fonts/courier-prime/CourierPrime-Bold.ttf",
                ],
                impactFontCandidates: [
                    "/fonts/impact/Impact.ttf",
                ],
                characterTitleCards,
                useCourierPrime: true,
                boldHeadings,
                pageNumbers,
                branding: {
                    creator: "Mangaplay Studio",
                    producer: "Pistol Taeja",
                    website: "https://mangaplay.studio",
                },
            });
            const buf = await blob.arrayBuffer();
            bytes = new Uint8Array(buf);
            break;
        }
        default:
            throw new Error(`unknown format: ${formatId}`);
    }

    return { bytes, defaultName };
}

/**
 * Public entry — open the modal and run the user through pick → progress →
 * save. Resolves when the modal is closed (no return value; side effects
 * are the file write + toast).
 *
 * @param {{ script: any, scriptFormat: string, sourceText: string, basename: string, localPath?: string }} ctx
 */
export async function openExportScreenplayModal(ctx)
{
    const screenplay = toScreenplay(ctx.script, ctx.scriptFormat, ctx.sourceText);
    if (!screenplay)
    {
        showBanner(t("mangaplay-studio.dialog.export.noScreenplay")
            || "This file has no screenplay surface to export.");
        return;
    }
    const stem = stemFor(ctx.basename || "Untitled");

    /** @type {string|null} */
    let selectedFormatId = null;

    await openModal({
        variantClass: "export-screenplay-modal",
        cancelValue: null,
        build: ({ backdrop, resolveWith, cancel }) =>
        {
            const dialog = document.createElement("div");
            dialog.className = "settings-dialog export-dialog";
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            dialog.setAttribute("aria-label",
                t("mangaplay-studio.dialog.export.title") || "Export Screenplay");

            // ── titlebar (reuses settings-titlebar) ──────────────────────
            const titlebar = document.createElement("div");
            titlebar.className = "settings-titlebar export-titlebar";
            const titleText = document.createElement("div");
            titleText.className = "export-title";
            titleText.textContent = t("mangaplay-studio.dialog.export.title")
                || "Export Screenplay";
            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className = "settings-close";
            closeBtn.setAttribute("aria-label",
                t("mangaplay-studio.dialog.export.cancel") || "Cancel");
            closeBtn.insertAdjacentHTML("afterbegin", icon("x", { size: 16 }));
            closeBtn.addEventListener("click", cancel);
            titlebar.appendChild(titleText);
            titlebar.appendChild(closeBtn);

            // ── body ────────────────────────────────────────────────────
            const body = document.createElement("div");
            body.className = "settings-body export-body";

            const subtitle = document.createElement("p");
            subtitle.className = "export-subtitle";
            const subtitleTpl = t("mangaplay-studio.dialog.export.subtitle")
                || 'Export "{stem}" to a screenplay format.';
            subtitle.textContent = subtitleTpl.replace("{stem}", stem);
            body.appendChild(subtitle);

            const heading = document.createElement("div");
            heading.className = "export-section-heading";
            heading.textContent = t("mangaplay-studio.dialog.export.outputFormat")
                || "Output format";
            body.appendChild(heading);

            const grid = document.createElement("div");
            grid.className = "export-format-grid";
            grid.setAttribute("role", "radiogroup");
            for (const f of FORMATS)
            {
                const card = document.createElement("div");
                card.className = "export-format-card";
                if (f.disabled) card.classList.add("is-disabled");
                card.setAttribute("role", "radio");
                card.setAttribute("aria-checked", "false");
                card.dataset.formatId = f.id;
                card.tabIndex = f.disabled ? -1 : 0;

                const img = document.createElement("img");
                img.className = "export-format-icon";
                img.src = `./img/format/format-${f.id === "fdx8" ? "fdx-8"
                    : f.id === "fdx10" ? "fdx-10"
                    : f.id}.png`;
                img.alt = "";
                img.width = 48; img.height = 48;
                card.appendChild(img);

                const name = document.createElement("div");
                name.className = "export-format-name";
                name.textContent = f.label;
                card.appendChild(name);

                const ext = document.createElement("div");
                ext.className = "export-format-ext";
                ext.textContent = f.dotExt;
                card.appendChild(ext);

                if (!f.disabled)
                {
                    card.addEventListener("click", () => selectCard(f.id));
                    card.addEventListener("keydown", (ev) =>
                    {
                        if (ev.key === "Enter" || ev.key === " ")
                        {
                            ev.preventDefault();
                            selectCard(f.id);
                        }
                    });
                }
                grid.appendChild(card);
            }
            body.appendChild(grid);

            const progress = document.createElement("div");
            progress.className = "export-progress";
            progress.hidden = true;
            const spinner = document.createElement("div");
            spinner.className = "export-spinner";
            const progressLabel = document.createElement("div");
            progressLabel.className = "export-progress-label";
            progress.appendChild(spinner);
            progress.appendChild(progressLabel);
            body.appendChild(progress);

            const actions = document.createElement("div");
            actions.className = "export-actions";
            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = "mps-btn-secondary export-cancel";
            cancelBtn.textContent = t("mangaplay-studio.dialog.export.cancel") || "Cancel";
            cancelBtn.addEventListener("click", cancel);
            const ctaBtn = document.createElement("button");
            ctaBtn.type = "button";
            ctaBtn.className = "mps-btn-primary export-cta";
            ctaBtn.textContent = t("mangaplay-studio.dialog.export.cta")
                || "Create Screenplay";
            ctaBtn.disabled = true;
            ctaBtn.addEventListener("click", async () =>
            {
                if (!selectedFormatId) return;

                // Step → progress
                grid.hidden = true;
                actions.hidden = true;
                progress.hidden = false;
                progressLabel.textContent = (
                    t("mangaplay-studio.dialog.export.progressLabel")
                    || "Generating {format}…"
                ).replace("{format}", FORMATS.find(f => f.id === selectedFormatId)?.label || "");

                try
                {
                    const { bytes, defaultName } = await runConversion({
                        formatId: selectedFormatId,
                        screenplay,
                        sourceText: ctx.sourceText || "",
                        scriptFormat: ctx.scriptFormat,
                        stem,
                    });
                    const fmt = FORMATS.find(f => f.id === selectedFormatId);
                    const filters = fmt ? [[fmt.filterLabel, [fmt.ext]]] : [];
                    const savedPath = await saveFileDialog(defaultName, filters);
                    if (!savedPath)
                    {
                        // Cancelled — go back to format pick.
                        progress.hidden = true;
                        grid.hidden = false;
                        actions.hidden = false;
                        return;
                    }
                    await writeBytes(savedPath, bytes);
                    showBanner((
                        t("mangaplay-studio.dialog.export.savedToast")
                        || "Exported to {basename}"
                    ).replace("{basename}", defaultName));
                    resolveWith(savedPath);
                }
                catch (e)
                {
                    console.error("[export] failed:", e);
                    showBanner((
                        t("mangaplay-studio.dialog.export.failed")
                        || "Export failed: {reason}"
                    ).replace("{reason}", String((e && e.message) || e)));
                    progress.hidden = true;
                    grid.hidden = false;
                    actions.hidden = false;
                }
            });
            actions.appendChild(cancelBtn);
            actions.appendChild(ctaBtn);
            body.appendChild(actions);

            dialog.appendChild(titlebar);
            dialog.appendChild(body);
            backdrop.appendChild(dialog);

            /** @param {string} id */
            function selectCard(id)
            {
                selectedFormatId = id;
                ctaBtn.disabled = false;
                for (const card of grid.querySelectorAll(".export-format-card"))
                {
                    const el = /** @type {HTMLElement} */ (card);
                    const isSelected = el.dataset.formatId === id;
                    el.classList.toggle("is-selected", isSelected);
                    el.setAttribute("aria-checked", isSelected ? "true" : "false");
                }
            }
        }
    });
}
