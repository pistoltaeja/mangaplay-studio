// @ts-check
/**
 * import-modal.js — three-slot Import Screenplay modal.
 *
 * Slots: picker → progress → end. Slide-track pattern mirrors
 * publish-modal.js but the CSS lives under `.import-*` selectors (no
 * class reuse — plan §"Non-shared bits").
 *
 * openImportModal() is idempotent: a second call while a modal is already
 * open early-returns null (the modal-shell singleton would otherwise
 * cancel the current one, which mid-run would leave the FSM racing to
 * touch a detached DOM).
 */

import { icon } from "../panes/icons.js";
import { openModal } from "../modals/modal-shell.js";
import { t } from "../adapters/tauri-i18n.js";
import { ImportStateMachine } from "./import-state-machine.js";
import {
    pickFile,
    readBinaryFile,
    readTextFile,
    preflightPdf,
    preflightFountain,
    parsePdfToFountain,
    fountainPassthrough,
    applyToEditor,
    errorStringFor,
} from "./import-workers.js";

/** Singleton guard — matches publish-modal's early-return pattern. */
let _open = false;

/**
 * @param {{ basename?: string, localPath?: string }} ctx
 * @returns {Promise<null>}
 */
export async function openImportModal(ctx)
{
    if (_open) return null;
    _open = true;

    try
    {
        return await openModal({
            variantClass: "import-modal-backdrop",
            cancelValue: null,
            build: ({ backdrop, resolveWith: rawResolveWith, cancel: rawCancel }) =>
            {
                /** @type {ImportStateMachine|null} */
                let activeSm = null;
                /** @type {(v: any) => void} */
                const resolveWith = (v) =>
                {
                    if (activeSm) activeSm.cancel();
                    rawResolveWith(v);
                };
                const cancel = () =>
                {
                    if (activeSm) activeSm.cancel();
                    rawCancel();
                };

                const dialog = document.createElement("div");
                dialog.className = "settings-dialog import-modal";
                dialog.setAttribute("role", "dialog");
                dialog.setAttribute("aria-modal", "true");
                dialog.setAttribute("aria-label",
                    t("mangaplay-studio.importScreenplay.modal.title",
                        "Import Screenplay"));

                // ── Titlebar ───────────────────────────────────────────────
                const titlebar = document.createElement("div");
                titlebar.className = "settings-titlebar import-titlebar";
                const titleText = document.createElement("div");
                titleText.className = "import-title";
                titleText.textContent = t(
                    "mangaplay-studio.importScreenplay.modal.title",
                    "Import Screenplay");
                const closeBtn = document.createElement("button");
                closeBtn.type = "button";
                closeBtn.className = "settings-close";
                closeBtn.setAttribute("aria-label", "Close");
                closeBtn.insertAdjacentHTML("afterbegin", icon("x", { size: 16 }));
                closeBtn.addEventListener("click", () => cancel());
                titlebar.appendChild(titleText);
                titlebar.appendChild(closeBtn);

                // ── Track + three panels ───────────────────────────────────
                const track = document.createElement("div");
                track.className = "import-track";
                track.dataset.panel = "picker";

                /** @param {"picker"|"progress"|"end"} name */
                const setPanel = (name) =>
                {
                    track.dataset.panel = name;
                };

                const panelPicker = _buildPickerPanel({
                    isDirty: _isDocDirty(),
                    onPickPdf:      () => startImport("pdf"),
                    onPickFountain: () => startImport("fountain")
                });
                const panelProgress = _buildProgressPanel();
                const panelEnd = _buildEndPanel({
                    onDone:     () => resolveWith(null),
                    onTryAgain: () =>
                    {
                        panelProgress.reset();
                        panelEnd.reset();
                        panelPicker.reset();
                        setPanel("picker");
                    }
                });

                track.appendChild(panelPicker.root);
                track.appendChild(panelProgress.root);
                track.appendChild(panelEnd.root);

                dialog.appendChild(titlebar);
                dialog.appendChild(track);
                backdrop.appendChild(dialog);

                /**
                 * Kick off the file picker → preflight → FSM run.
                 * @param {"pdf"|"fountain"} kind
                 */
                async function startImport(kind)
                {
                    panelPicker.setCardLoading(kind, true);
                    /** @type {string|null} */
                    let path = null;
                    try
                    {
                        const filters = kind === "pdf"
                            ? [["PDF", ["pdf"]]]
                            : [["Fountain", ["fountain", "md"]]];
                        path = await pickFile(/** @type {any} */ (filters));
                    }
                    catch (e)
                    {
                        console.warn("[import-screenplay] pickFile failed:", e);
                    }
                    panelPicker.setCardLoading(kind, false);
                    if (!path) return;  // User cancelled OS dialog.

                    setPanel("progress");
                    panelProgress.reset();

                    const sm = new ImportStateMachine({
                        kind,
                        path,
                        workers: {
                            readBinaryFile,
                            readTextFile,
                            preflightPdf,
                            preflightFountain,
                            parsePdfToFountain,
                            fountainPassthrough,
                            applyToEditor,
                        },
                        onTransition: ({ state, pct, payload }) =>
                        {
                            if (state === "SUCCESS")
                            {
                                panelEnd.showSuccess();
                                setPanel("end");
                                return;
                            }
                            if (state === "ERROR")
                            {
                                const reason = (payload && payload.reason) || "";
                                const detail = (payload && payload.detail) || "";
                                panelEnd.showError({ reason, detail });
                                setPanel("end");
                                return;
                            }
                            panelProgress.update({ state, pct, kind });
                        }
                    });
                    activeSm = sm;
                    void sm.run();
                }
            }
        });
    }
    finally
    {
        _open = false;
    }
}

/** Read the shell-level save state via the documentElement attribute set by setSaveState(). */
function _isDocDirty()
{
    try
    {
        const el = /** @type {HTMLElement|null} */ (document.documentElement);
        return el?.getAttribute("data-save-state") === "dirty";
    }
    catch { return false; }
}

/**
 * Picker panel — heading + two cards (PDF, Fountain).
 * @param {{
 *   isDirty: boolean,
 *   onPickPdf: () => void,
 *   onPickFountain: () => void
 * }} handlers
 */
function _buildPickerPanel(handlers)
{
    const root = document.createElement("section");
    root.className = "import-panel import-panel-picker";

    // Non-blocking dirty-doc banner — shown when the buffer is dirty at
    // open time. `:empty { display: none }` hides it in the clean case.
    const dirtyBanner = document.createElement("p");
    dirtyBanner.className = "import-picker-dirty-banner";
    if (handlers.isDirty)
    {
        dirtyBanner.textContent = t(
            "mangaplay-studio.importScreenplay.picker.unsavedBanner",
            "This will replace your unsaved changes. Undo (Ctrl+Z) will restore them.");
    }
    root.appendChild(dirtyBanner);

    const cards = document.createElement("div");
    cards.className = "import-picker-cards";
    root.appendChild(cards);

    /**
     * @param {"pdf"|"fountain"} kind
     * @param {string} labelKey
     * @param {string} bodyKey
     * @param {string|null} noteKey    — null when the card has no footer note
     * @param {string} defaultLabel
     * @param {string} defaultBody
     * @param {string} defaultNote     — "" when noteKey is null
     * @param {string} imgSrc
     */
    function makeCard(kind, labelKey, bodyKey, noteKey, defaultLabel, defaultBody, defaultNote, imgSrc)
    {
        const card = document.createElement("button");
        card.type = "button";
        card.className = `import-picker-card import-picker-card--${kind}`;

        const image = document.createElement("div");
        image.className = "import-picker-card-image";
        const img = document.createElement("img");
        img.src = imgSrc;
        img.width = 48;
        img.height = 48;
        img.alt = "";
        image.appendChild(img);

        const title = document.createElement("div");
        title.className = "import-picker-card-title";
        title.textContent = t(labelKey, defaultLabel);

        const body = document.createElement("p");
        body.className = "import-picker-card-body";
        body.textContent = t(bodyKey, defaultBody);

        card.appendChild(image);
        card.appendChild(title);
        card.appendChild(body);

        if (noteKey)
        {
            const note = document.createElement("p");
            note.className = "import-picker-card-note";
            note.textContent = t(noteKey, defaultNote);
            card.appendChild(note);
        }
        return card;
    }

    const pdfCard = makeCard(
        "pdf",
        "mangaplay-studio.importScreenplay.picker.pdfTitle",
        "mangaplay-studio.importScreenplay.picker.pdfBody",
        "mangaplay-studio.importScreenplay.picker.pdfNote",
        "PDF",
        "Create a Fountain Screenplay from an existing PDF into the current document.",
        "Note: The accuracy of the screenplay created will be greatly affected by the quality of the original PDF",
        "./img/format/format-pdf.png"
    );
    pdfCard.addEventListener("click", () =>
    {
        if (pdfCard.classList.contains("is-loading")) return;
        handlers.onPickPdf();
    });
    cards.appendChild(pdfCard);

    const fountainCard = makeCard(
        "fountain",
        "mangaplay-studio.importScreenplay.picker.fountainTitle",
        "mangaplay-studio.importScreenplay.picker.fountainBody",
        null,
        "Fountain",
        "Import an existing Fountain formatted Screenplay into the current Document.",
        "",
        "./img/format/format-fountain.png"
    );
    fountainCard.addEventListener("click", () =>
    {
        if (fountainCard.classList.contains("is-loading")) return;
        handlers.onPickFountain();
    });
    // Fountain card hidden for now — not appended to the DOM. To restore,
    // add `cards.appendChild(fountainCard);` here.

    return {
        root,
        /**
         * @param {"pdf"|"fountain"} kind
         * @param {boolean} loading
         */
        setCardLoading(kind, loading)
        {
            const card = kind === "pdf" ? pdfCard : fountainCard;
            card.classList.toggle("is-loading", loading);
        },
        reset()
        {
            pdfCard.classList.remove("is-loading");
            fountainCard.classList.remove("is-loading");
        }
    };
}

/**
 * Progress panel — heading + progress bar + step label.
 */
function _buildProgressPanel()
{
    const root = document.createElement("section");
    root.className = "import-panel import-panel-progress";

    const heading = document.createElement("h2");
    heading.className = "import-progress-heading";
    heading.textContent = t(
        "mangaplay-studio.importScreenplay.modal.title",
        "Import Screenplay");
    root.appendChild(heading);

    const bar = document.createElement("div");
    bar.className = "import-progress-bar";
    const fill = document.createElement("div");
    fill.className = "import-progress-bar-fill";
    bar.appendChild(fill);
    root.appendChild(bar);

    const label = document.createElement("div");
    label.className = "import-progress-label";
    root.appendChild(label);

    return {
        root,
        reset()
        {
            fill.style.width = "0%";
            label.textContent = "";
        },
        /**
         * @param {{ state: string, pct: number, kind: "pdf"|"fountain" }} args
         */
        update({ state, pct, kind })
        {
            fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
            label.textContent = _stepLabel(state, kind);
        }
    };
}

/**
 * @param {string} state
 * @param {"pdf"|"fountain"} kind
 */
function _stepLabel(state, kind)
{
    switch (state)
    {
        case "PREFLIGHT_READ":
            return t("mangaplay-studio.importScreenplay.progress.reading",
                "Reading file…");
        case "PREFLIGHT_PARSE":
        case "PARSING":
            return kind === "pdf"
                ? t("mangaplay-studio.importScreenplay.progress.parsingPdf",
                    "Reading PDF…")
                : t("mangaplay-studio.importScreenplay.progress.parsingFountain",
                    "Parsing Fountain…");
        case "APPLYING":
            return t("mangaplay-studio.importScreenplay.progress.applying",
                "Updating document…");
        default:
            return "";
    }
}

/**
 * End panel — success + error variants stacked, one visible at a time.
 * @param {{ onDone: () => void, onTryAgain: () => void }} handlers
 */
function _buildEndPanel(handlers)
{
    const root = document.createElement("section");
    root.className = "import-panel import-panel-end";

    // ── Success variant ─────────────────────────────────────────────────
    const successWrap = document.createElement("div");
    successWrap.className = "import-end-success";
    successWrap.hidden = true;

    const checkmark = document.createElement("div");
    checkmark.className = "import-checkmark";
    checkmark.innerHTML = `
        <svg viewBox="0 0 52 52" width="64" height="64" aria-hidden="true">
            <circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="M14 27 L23 36 L40 18" fill="none" stroke="currentColor" stroke-width="3"
                  stroke-linecap="round" stroke-linejoin="round" />
        </svg>`;

    const successHeading = document.createElement("h2");
    successHeading.className = "import-heading";
    successHeading.textContent = t(
        "mangaplay-studio.importScreenplay.end.successTitle",
        "Screenplay imported");

    const successBody = document.createElement("p");
    successBody.className = "import-body";
    successBody.textContent = t(
        "mangaplay-studio.importScreenplay.end.successBody",
        "The document has been replaced with your imported screenplay.");

    const successActions = document.createElement("div");
    successActions.className = "import-footer";
    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "mps-btn-primary";
    doneBtn.textContent = t(
        "mangaplay-studio.importScreenplay.end.done", "Done");
    doneBtn.addEventListener("click", () => handlers.onDone());
    successActions.appendChild(doneBtn);

    successWrap.appendChild(checkmark);
    successWrap.appendChild(successHeading);
    successWrap.appendChild(successBody);
    successWrap.appendChild(successActions);

    // ── Error variant ───────────────────────────────────────────────────
    const errorWrap = document.createElement("div");
    errorWrap.className = "import-end-error";
    errorWrap.hidden = true;

    const errorIcon = document.createElement("div");
    errorIcon.className = "import-error-icon";
    errorIcon.innerHTML = `
        <svg viewBox="0 0 52 52" width="64" height="64" aria-hidden="true">
            <circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="M17 17 L35 35 M35 17 L17 35" fill="none" stroke="currentColor"
                  stroke-width="3" stroke-linecap="round" />
        </svg>`;

    const errorHeading = document.createElement("h2");
    errorHeading.className = "import-heading";

    const errorBody = document.createElement("p");
    errorBody.className = "import-body";

    const errorActions = document.createElement("div");
    errorActions.className = "import-footer";
    const tryAgainBtn = document.createElement("button");
    tryAgainBtn.type = "button";
    tryAgainBtn.className = "mps-btn-primary";
    tryAgainBtn.textContent = t(
        "mangaplay-studio.importScreenplay.end.tryAgain", "Try Again");
    tryAgainBtn.addEventListener("click", () => handlers.onTryAgain());
    errorActions.appendChild(tryAgainBtn);

    errorWrap.appendChild(errorIcon);
    errorWrap.appendChild(errorHeading);
    errorWrap.appendChild(errorBody);
    errorWrap.appendChild(errorActions);

    root.appendChild(successWrap);
    root.appendChild(errorWrap);

    return {
        root,
        reset()
        {
            successWrap.hidden = true;
            errorWrap.hidden   = true;
        },
        showSuccess()
        {
            successWrap.hidden = false;
            errorWrap.hidden   = true;
        },
        /**
         * @param {{ reason: string, detail: string }} args
         */
        showError({ reason, detail })
        {
            errorHeading.textContent = t(
                "mangaplay-studio.importScreenplay.end.errorTitle",
                "Couldn't import that file");
            // Prefer localised per-reason string; fall back to the shared
            // core error string; final fallback is the raw detail.
            const localised = t(
                `mangaplay-studio.importScreenplay.errors.${reason}`, "");
            errorBody.textContent = localised
                || errorStringFor(reason)
                || detail
                || "Something went wrong reading this file.";

            successWrap.hidden = true;
            errorWrap.hidden   = false;
        }
    };
}
