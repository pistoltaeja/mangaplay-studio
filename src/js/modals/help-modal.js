// @ts-check
/**
 * help-modal.js — Compact help dialog opened from the [?] footer button.
 *
 * Shows the Mangaplay mascot + version, then a list of help links. Each link
 * row has a label, a one-line description, and an action button that opens
 * the URL in the user's default browser via @tauri-apps/plugin-opener.
 *
 * URLs come from src/app-settings.json, copied at build time to
 * frontend/app-settings.json and fetched once at module load. To change a
 * URL, edit the source JSON and rebuild — no Rust changes.
 *
 * Reuses styling primitives from the existing confirm-modal-* family
 * (see app.css "Confirm modal" section) and adapts the dark mascot/version
 * treatment from the picker shell (`.pkr-mascot` etc.).
 */

import { openModal } from "./modal-shell.js";
import { t } from "../adapters/tauri-i18n.js";
import { icon } from "../panes/icons.js";
import { escapeHtml } from "../util/index.js";
import { getSkin, getCurrentSkinId, registerSkinnedImage } from "../boot/skins.js";

const DEFAULTS = Object.freeze({
    discordUrl: "https://discord.gg/mangaplay",
    officialHelpUrl: "https://mangaplay.studio/guide"
});

/** @type {Record<string, any> | null} */
let cache = null;

/**
 * Fetch app-settings.json from the bundled asset and cache it. Falls back
 * to DEFAULTS on any failure so the modal is always functional.
 * @returns {Promise<Record<string, any>>}
 */
async function loadAppSettings()
{
    if (cache) return cache;
    try
    {
        const res = await fetch("./app-settings.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        cache = { ...DEFAULTS, ...json };
    }
    catch (e)
    {
        console.warn("[help-modal] app-settings.json load failed; using defaults:", e?.message || e);
        cache = { ...DEFAULTS };
    }
    return cache;
}

/**
 * Open a URL in the user's default browser. Wraps plugin-opener so callers
 * don't have to import the plugin themselves.
 * @param {string} url
 */
async function openExternal(url)
{
    try
    {
        const openerMod = await import("@tauri-apps/plugin-opener");
        await openerMod.openUrl(url);
    }
    catch (e)
    {
        console.error("[help-modal] open failed:", url, e);
    }
}

/**
 * Show the Help modal. Resolves when the user closes it.
 * @returns {Promise<void>}
 */
export async function openHelpModal()
{
    const settings = await loadAppSettings();
    const appVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

    return openModal({
        variantClass: "help-modal",
        cancelValue: undefined,
        build({ backdrop, resolveWith })
        {
            const dialog = document.createElement("div");
            dialog.className = "confirm-modal-dialog help-modal-dialog";
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");

            // Titlebar with close button — reuses .confirm-modal-titlebar
            // chrome (border-bottom, height) so the surface matches existing
            // modals.
            const titlebar = document.createElement("div");
            titlebar.className = "confirm-modal-titlebar";
            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className = "settings-close confirm-modal-close";
            closeBtn.setAttribute("aria-label", t("mangaplay-studio.picker.close", "Close"));
            closeBtn.insertAdjacentHTML("afterbegin", icon("x", { size: 16 }));
            closeBtn.addEventListener("click", () => resolveWith(undefined));
            titlebar.appendChild(closeBtn);

            // Brand block: mascot + title + version. Mirrors picker shell's
            // brand cluster (img + h-title + version line) so the help dialog
            // visually reads as part of the same family.
            const brand = document.createElement("div");
            brand.className = "help-modal-brand";
            const skinEntry = getSkin(getCurrentSkinId());
            // The single-image mascot asset was removed in favour of the
            // two-part head + body pair used by <mps-mascot>. The help modal
            // uses the head only — it's the recognisable half at this
            // thumbnail size.
            const mascotUrl = skinEntry.baseUrl + skinEntry.manifest.mascotHeadFile;
            brand.innerHTML = `
                <img class="help-modal-mascot" src="${escapeHtml(mascotUrl)}" alt="">
                <div class="help-modal-title">${escapeHtml(t("mangaplay-studio.help.title", "Mangaplay Studio"))}</div>
                <div class="help-modal-version">${escapeHtml(t("mangaplay-studio.picker.versionLabel", { version: appVersion }))}</div>
            `;
            const helpMascot = brand.querySelector(".help-modal-mascot");
            if (helpMascot instanceof HTMLImageElement)
            {
                registerSkinnedImage(helpMascot, "mascotHead");
            }

            // Help rows. Each row: label + description + action button.
            const list = document.createElement("div");
            list.className = "help-modal-list";
            list.appendChild(buildRow({
                label: t("mangaplay-studio.help.officialHelpLabel", "Official help site"),
                desc:  t("mangaplay-studio.help.officialHelpDesc",  "Read the official help documentation of Mangaplay Studio."),
                action: t("mangaplay-studio.help.visit", "Visit"),
                url: String(settings.officialHelpUrl || DEFAULTS.officialHelpUrl),
                actionClass: "is-primary"
            }));
            list.appendChild(buildRow({
                label: t("mangaplay-studio.help.discordLabel", "Discord chat"),
                desc:  t("mangaplay-studio.help.discordDesc",  "Chat with other Mangaplay Studio users on Discord."),
                action: t("mangaplay-studio.help.join", "Join"),
                url: String(settings.discordUrl || DEFAULTS.discordUrl),
                actionClass: ""
            }));

            dialog.appendChild(titlebar);
            dialog.appendChild(brand);
            dialog.appendChild(list);
            backdrop.appendChild(dialog);
        }
    });
}

/**
 * Build one help-list row.
 * @param {{ label: string, desc: string, action: string, url: string, actionClass: string }} opts
 * @returns {HTMLElement}
 */
function buildRow({ label, desc, action, url, actionClass })
{
    const row = document.createElement("div");
    row.className = "help-modal-row";

    const text = document.createElement("div");
    text.className = "help-modal-row-text";
    text.innerHTML = `
        <div class="help-modal-row-label">${escapeHtml(label)}</div>
        <div class="help-modal-row-desc">${escapeHtml(desc)}</div>
    `;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `help-modal-row-action ${actionClass}`.trim();
    btn.textContent = action;
    btn.addEventListener("click", () => { openExternal(url); });

    row.appendChild(text);
    row.appendChild(btn);
    return row;
}

