// @ts-check
/**
 * settings-modal.js — Desktop Settings dialog.
 *
 * Exposes `openSettingsModal(initialTab)`. Builds an 840×560 dialog with a
 * 200 px "Options" sidebar (General, Appearance) and a right pane that
 * renders the selected tab's cards.
 *
 * Persistence: reads settings once via `app_settings_get`, writes per-field
 * via `app_settings_set`. Each write is optimistic; on failure the previous
 * value is restored and a toast surfaces the error.
 *
 * Skin dropdown writes are debounced 150 ms (keyboard arrow churn) and call
 * `applySkin(value)` on each successful write so the swap is visible
 * immediately.
 */

import { icon } from "../panes/icons.js";
import { getPlatformKey } from "../adapters/platform-key.js";
import { applySkin, listSkins } from "../boot/skins.js";
import { applyScreenplayFont, applyEditorFont } from "../font/font-prefs.js";
import { applySmoothMotion, applySmoothScrolling } from "../adapters/motion-prefs.js";
import { t, subscribe as subscribeI18n, LANGUAGES } from "../adapters/tauri-i18n.js";
import { saveUserSettings, getUserSetting } from "../project/user-settings.js";
import { setSpellcheckState } from "../spellcheck/spellcheck-state.js";
import { applySpellcheckToAllViews } from "../editor/mps-editor.js";
import {
    signIn as authSignIn,
    signOut as authSignOut,
    switchAccount as authSwitchAccount,
    getCurrentProfile as authGetCurrentProfile,
    isAuthenticated as authIsAuthenticated,
    ensureRehydrated as authEnsureRehydrated,
    isInteractiveSignInPending as authIsInteractiveSignInPending,
    abortInteractiveSignIn as authAbortInteractiveSignIn,
} from "../auth/google-oauth.js";
import { classifyAuthError } from "../auth/error-classifier.js";
import { isTauri } from "../util/index.js";
import { debounce } from "../util/index.js";
import { loadPublishLog } from "../google-docs-sync/publish-log.js";

/** Tauri invoke helper — falls back to a rejected promise outside Tauri. */
async function invoke(cmd, args)
{
    if (!isTauri()) throw new Error("Tauri unavailable");
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke(cmd, args);
}

/** Tracks the singleton modal root so a second open() is a no-op. */
let modalRoot = null;
/** Removes the document-level keydown listener at close time. */
let detachKeydown = null;
/** Releases the i18n subscription so the modal re-renders on language change. */
let detachI18n = null;

/**
 * Minimal toast — fixed bottom-right, auto-dismisses after 4 s.
 * @param {string} msg
 */
function showToast(msg)
{
    const el = document.createElement("div");
    el.className = "settings-toast";
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("visible"));
    setTimeout(() =>
    {
        el.classList.remove("visible");
        setTimeout(() => el.remove(), 220);
    }, 4000);
}


/**
 * Open the Settings modal. Idempotent — re-opening when already mounted is a
 * no-op aside from switching the active tab.
 * @param {string} [initialTab]
 */
export async function openSettingsModal(initialTab = "general")
{
    if (modalRoot)
    {
        const entry = modalRoot.querySelector(`.settings-entry[data-tab="${initialTab}"]`);
        if (entry) /** @type {HTMLButtonElement} */ (entry).click();
        return;
    }

    // ── Load persisted settings + platform info up front ──
    let state = { skin: "default", hardwareAcceleration: true, smoothMotion: true, smoothScrolling: true, appFont: "default", editorFont: "default", screenplayFont: "default", diagnosticsEnabled: true, analyticsEnabled: true };
    try
    {
        const got = await invoke("app_settings_get");
        if (got && typeof got === "object") state = { ...state, ...got };
    }
    catch (e)
    {
        console.warn("[settings] app_settings_get failed:", e);
    }

    let appVersion = "";
    try
    {
        const p = await invoke("app_platform");
        if (p && typeof p === "object" && typeof p.version === "string") appVersion = p.version;
    }
    catch (e)
    {
        console.warn("[settings] app_platform failed:", e);
    }

    // ── Build DOM ──
    const backdrop = document.createElement("div");
    backdrop.className = "settings-backdrop";
    backdrop.setAttribute("role", "presentation");

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", t("mangaplay-studio.settings.title"));

    // Title bar (close button).
    const titlebar = document.createElement("div");
    titlebar.className = "settings-titlebar";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "settings-close";
    closeBtn.setAttribute("aria-label", t("mangaplay-studio.settings.close"));
    closeBtn.insertAdjacentHTML("afterbegin", icon("x", { size: 16 }));
    titlebar.appendChild(closeBtn);

    // Body — sidebar + content.
    const body = document.createElement("div");
    body.className = "settings-body";

    const sidebar = document.createElement("div");
    sidebar.className = "settings-sidebar";
    const sidebarHeading = document.createElement("div");
    sidebarHeading.className = "settings-sidebar-heading";
    sidebarHeading.textContent = t("mangaplay-studio.settings.options");
    sidebar.appendChild(sidebarHeading);

    const content = document.createElement("div");
    content.className = "settings-content mps-scrollbar";

    body.appendChild(sidebar);
    body.appendChild(content);

    dialog.appendChild(titlebar);
    dialog.appendChild(body);
    backdrop.appendChild(dialog);

    // ── Sidebar tab entries ──
    const TABS = [
        { id: "general", labelKey: "mangaplay-studio.settings.tabGeneral", iconName: "circle-user" },
        { id: "text-editor", labelKey: "mangaplay-studio.settings.tabTextEditor", iconName: "file-text" },
        { id: "appearance", labelKey: "mangaplay-studio.settings.tabAppearance", iconName: "palette" },
        { id: "account", labelKey: "mangaplay-studio.settings.tabAccount", iconName: "circle-user" },
        { id: "publish", labelKey: "mangaplay-studio.settings.tabPublish", iconName: "send" },
    ];

    let activeTab = TABS.some((t) => t.id === initialTab) ? initialTab : "general";

    const entryEls = new Map();
    const tabLabelEls = new Map();
    for (const tab of TABS)
    {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-entry";
        btn.dataset.tab = tab.id;
        btn.insertAdjacentHTML("afterbegin", icon(tab.iconName, { size: 16 }));
        const label = document.createElement("span");
        label.textContent = t(tab.labelKey);
        btn.appendChild(label);
        btn.addEventListener("click", () => selectTab(tab.id));
        sidebar.appendChild(btn);
        entryEls.set(tab.id, btn);
        tabLabelEls.set(tab.id, label);
    }

    /**
     * Persist a single setting field. On failure: revert state, re-render,
     * surface a toast. The DOM tree is rebuilt for the active tab so the
     * reverted value lands on screen without bespoke per-control wiring.
     * @param {string} key
     * @param {any} value
     */
    async function writeField(key, value)
    {
        const prev = state[key];
        state[key] = value;
        try
        {
            await invoke("app_settings_set", { value: { [key]: value } });
            if (key === "skin") applySkin(value);
        }
        catch (e)
        {
            state[key] = prev;
            renderActiveTab();
            showToast(t("mangaplay-studio.settings.couldNotSave", { error: String(e?.message || e) }));
        }
    }

    const debouncedWriteSkin = debounce(
        (v) => { writeField("skin", v); },
        150
    );

    function renderGeneral()
    {
        content.replaceChildren();

        // Card 1 — version + check-for-updates + changelog link.
        // Changelog moved under installerVersion (13 px, .settings-link).
        // Status label sits inline to the LEFT of the button so success /
        // failure text never pushes the card height.
        const card1 = document.createElement("div");
        card1.className = "settings-card";

        const row1 = document.createElement("div");
        row1.className = "mps-row";
        const row1Label = document.createElement("div");
        row1Label.className = "mps-row-label";
        const versionTitle = document.createElement("div");
        versionTitle.className = "mps-row-title";
        versionTitle.textContent = t("mangaplay-studio.settings.version", { version: appVersion || "0.0.0" });
        const installerLine = document.createElement("div");
        installerLine.className = "mps-row-help";
        installerLine.textContent = t("mangaplay-studio.settings.installerVersion", { version: appVersion || "0.0.0" });
        const changelog = document.createElement("a");
        changelog.className = "settings-link";
        changelog.href = "#";
        changelog.textContent = t("mangaplay-studio.settings.readChangelog");
        changelog.addEventListener("click", async (ev) =>
        {
            ev.preventDefault();
            try
            {
                const openerMod = await import("@tauri-apps/plugin-opener");
                await openerMod.openUrl("https://mangaplay.studio/changelog");
            }
            catch (e)
            {
                showToast(t("mangaplay-studio.settings.couldNotOpenBrowser", { error: String(e?.message || e) }));
            }
        });
        row1Label.appendChild(versionTitle);
        row1Label.appendChild(installerLine);
        row1Label.appendChild(changelog);

        const updateStatus = document.createElement("span");
        updateStatus.className = "settings-update-status";
        updateStatus.dataset.role = "update-status";

        const checkBtn = document.createElement("button");
        checkBtn.type = "button";
        checkBtn.className = "mps-btn-primary";
        checkBtn.textContent = t("mangaplay-studio.settings.checkForUpdates");

        checkBtn.addEventListener("click", async () =>
        {
            if (checkBtn.disabled) return;
            checkBtn.disabled = true;
            updateStatus.className = "settings-update-status";
            updateStatus.textContent = "";
            // Show spinner while request is in flight; enforce 1s minimum.
            // `is-loading` hides the button text via visibility:hidden so the
            // button keeps its intrinsic width/height. The spinner overlays
            // absolute-centered — see .mps-btn-primary.is-loading in app-modals.css.
            const spinner = document.createElement("span");
            spinner.className = "settings-update-spinner";
            checkBtn.classList.add("is-loading");
            checkBtn.appendChild(spinner);

            const minDelay = new Promise((r) => setTimeout(r, 1000));
            const doFetch = (async () =>
            {
                const res = await fetch("https://mangaplay.studio/v1/updates", {
                    signal: AbortSignal.timeout(10_000),
                });
                if (!res.ok)
                {
                    const err = new Error(`http-${res.status}`);
                    /** @type {any} */ (err).kind = "http";
                    throw err;
                }
                try
                {
                    return await res.json();
                }
                catch (e)
                {
                    const err = new Error("bad-json");
                    /** @type {any} */ (err).kind = "parse";
                    throw err;
                }
            })();

            let statusText = "";
            let isError = false;
            try
            {
                const [json] = await Promise.all([doFetch, minDelay]);
                const key = await getPlatformKey();
                const remote = json && json[key] && typeof json[key].version === "string"
                    ? json[key].version : null;
                const local = appVersion || "0.0.0";
                if (!remote)
                {
                    const err = new Error("no-version-in-payload");
                    /** @type {any} */ (err).kind = "parse";
                    throw err;
                }
                statusText = compareVersions(remote, local) > 0
                    ? t("mangaplay-studio.settings.updateAvailable")
                    : t("mangaplay-studio.settings.upToDate");
            }
            catch (e)
            {
                await minDelay;
                // "No internet" = the browser couldn't reach the host at all
                // (DNS, refused, offline). Anything else — HTTP 4xx/5xx,
                // malformed JSON, missing per-OS key — is a reachable server
                // returning garbage: fall back to "Could not fetch updates".
                const kind = /** @type {any} */ (e)?.kind;
                const name = /** @type {any} */ (e)?.name;
                const isNetwork = name === "TypeError"
                    || name === "AbortError"
                    || (kind !== "http" && kind !== "parse");
                statusText = isNetwork
                    ? t("mangaplay-studio.settings.noInternetConnection")
                    : t("mangaplay-studio.settings.couldNotFetchUpdates");
                isError = true;
            }

            // Restore button, set inline status.
            spinner.remove();
            checkBtn.classList.remove("is-loading");
            checkBtn.disabled = false;
            updateStatus.textContent = statusText;
            updateStatus.className = isError
                ? "settings-update-status is-error"
                : "settings-update-status";

            setTimeout(() =>
            {
                if (updateStatus.textContent === statusText)
                {
                    updateStatus.textContent = "";
                    updateStatus.className = "settings-update-status";
                }
            }, 4000);
        });

        row1.appendChild(row1Label);
        row1.appendChild(updateStatus);
        row1.appendChild(checkBtn);
        card1.appendChild(row1);

        // Card 3 — Language picker. Persists via app_settings.language and
        // mirrors to localStorage so the next-launch picker shell renders
        // the right strings before Rust hands settings back.
        const card3 = document.createElement("div");
        card3.className = "settings-card";

        const row3 = document.createElement("div");
        row3.className = "mps-row";
        const row3Label = document.createElement("div");
        row3Label.className = "mps-row-label";
        const t3 = document.createElement("div");
        t3.className = "mps-row-title";
        t3.textContent = t("mangaplay-studio.settings.language");
        const h3 = document.createElement("div");
        h3.className = "mps-row-help";
        h3.textContent = t("mangaplay-studio.settings.languageHelp");
        row3Label.appendChild(t3);
        row3Label.appendChild(h3);

        const langEl = document.createElement("mps-lang-select");
        langEl.style.setProperty("--mps-lang-select-width", "180px");

        row3.appendChild(row3Label);
        row3.appendChild(langEl);
        card3.appendChild(row3);

        // Card — Help Diagnostics & Analytics (single toggle drives two settings).
        const cardHDA = document.createElement("div");
        cardHDA.className = "settings-card";
        const rowHDA = document.createElement("div");
        rowHDA.className = "mps-row";
        const rowHDALabel = document.createElement("div");
        rowHDALabel.className = "mps-row-label";
        const tHDA = document.createElement("div");
        tHDA.className = "mps-row-title";
        tHDA.textContent = t("mangaplay-studio.settings.helpDiagnosticsAnalytics");
        const hHDA = document.createElement("div");
        hHDA.className = "mps-row-help";
        hHDA.textContent = t("mangaplay-studio.settings.helpDiagnosticsAnalyticsHelp");
        rowHDALabel.appendChild(tHDA);
        rowHDALabel.appendChild(hHDA);

        // Combined state: ON only when BOTH flags are true. Default ON — match
        // the `!== false` pattern the smoothMotion/smoothScrolling toggles use so
        // legacy missing values read as true.
        const hdaOn = state.diagnosticsEnabled !== false && state.analyticsEnabled !== false;

        const hdaToggle = document.createElement("button");
        hdaToggle.type = "button";
        hdaToggle.className = "mps-toggle";
        hdaToggle.setAttribute("role", "switch");
        hdaToggle.setAttribute("aria-checked", String(hdaOn));
        hdaToggle.setAttribute("aria-label", t("mangaplay-studio.settings.helpDiagnosticsAnalytics"));
        hdaToggle.addEventListener("click", async () =>
        {
            const prevD = state.diagnosticsEnabled;
            const prevA = state.analyticsEnabled;
            const currentlyOn = state.diagnosticsEnabled !== false && state.analyticsEnabled !== false;
            const next = !currentlyOn;
            state.diagnosticsEnabled = next;
            state.analyticsEnabled = next;
            hdaToggle.setAttribute("aria-checked", String(next));
            try
            {
                await invoke("app_settings_set", { value: { diagnosticsEnabled: next, analyticsEnabled: next } });
                // Live-apply the analytics gate so the change takes effect
                // without a restart.
                try
                {
                    const mod = await import("../analytics/google-auth.js");
                    if (typeof mod.setAnalyticsAllowed === "function") mod.setAnalyticsAllowed(next);
                }
                catch (_) { /* best-effort */ }
            }
            catch (e)
            {
                state.diagnosticsEnabled = prevD;
                state.analyticsEnabled = prevA;
                hdaToggle.setAttribute("aria-checked", String(prevD !== false && prevA !== false));
                showToast(t("mangaplay-studio.settings.couldNotSave", { error: String(e?.message || e) }));
            }
        });

        rowHDA.appendChild(rowHDALabel);
        rowHDA.appendChild(hdaToggle);
        cardHDA.appendChild(rowHDA);

        content.appendChild(card1);
        content.appendChild(card3);
        content.appendChild(cardHDA);
    }

    /**
     * Dot-split numeric compare. Returns -1 if a<b, 0 if equal, 1 if a>b.
     * Missing segments treated as 0. Non-numeric segments compared as 0.
     * @param {string} a
     * @param {string} b
     * @returns {number}
     */
    function compareVersions(a, b)
    {
        const pa = String(a).split(".");
        const pb = String(b).split(".");
        const n = Math.max(pa.length, pb.length);
        for (let i = 0; i < n; i++)
        {
            const na = parseInt(pa[i] || "0", 10) || 0;
            const nb = parseInt(pb[i] || "0", 10) || 0;
            if (na < nb) return -1;
            if (na > nb) return 1;
        }
        return 0;
    }

    function renderTextEditor()
    {
        content.replaceChildren();

        // ── Text Editor section: spellcheck toggle + language dropdown ──
        const teCard = document.createElement("div");
        teCard.className = "settings-card";

        // Row 1 — Check spelling toggle.
        const teRow1 = document.createElement("div");
        teRow1.className = "mps-row";
        const teRow1Label = document.createElement("div");
        teRow1Label.className = "mps-row-label";
        const teT1 = document.createElement("div");
        teT1.className = "mps-row-title";
        teT1.textContent = t("mangaplay-studio.settings.textEditor.spellTitle");
        const teH1 = document.createElement("div");
        teH1.className = "mps-row-help";
        teH1.textContent = t("mangaplay-studio.settings.textEditor.spellHelp");
        teRow1Label.appendChild(teT1);
        teRow1Label.appendChild(teH1);

        const spellEnabled = !!getUserSetting("spellcheckEnabled", true);
        const spellLangInit = String(getUserSetting("spellcheckLanguage", "en-US") || "en-US");

        const spellToggle = document.createElement("button");
        spellToggle.type = "button";
        spellToggle.className = "mps-toggle";
        spellToggle.setAttribute("role", "switch");
        spellToggle.setAttribute("aria-checked", String(spellEnabled));
        spellToggle.setAttribute("aria-label", t("mangaplay-studio.settings.textEditor.spellTitle"));

        teRow1.appendChild(teRow1Label);
        teRow1.appendChild(spellToggle);
        teCard.appendChild(teRow1);

        // Row 2 — Language to spellcheck dropdown.
        const teRow2 = document.createElement("div");
        teRow2.className = "mps-row";
        const teRow2Label = document.createElement("div");
        teRow2Label.className = "mps-row-label";
        const teT2 = document.createElement("div");
        teT2.className = "mps-row-title";
        teT2.textContent = t("mangaplay-studio.settings.textEditor.langTitle");
        const teH2 = document.createElement("div");
        teH2.className = "mps-row-help";
        teH2.textContent = t("mangaplay-studio.settings.textEditor.langHelp");
        teRow2Label.appendChild(teT2);
        teRow2Label.appendChild(teH2);

        const langSelect = document.createElement("select");
        langSelect.className = "mps-select";

        // Build the 15 options: en-US + en-GB pinned to top, then the 13
        // non-English locales (re-using the UI-language picker labels for
        // consistency) sorted alphabetically by display name.
        const enUsLabel = t("mangaplay-studio.settings.textEditor.langEnUs");
        const enGbLabel = t("mangaplay-studio.settings.textEditor.langEnGb");
        const NON_EN_CODES = ["ja", "es", "id", "ko", "fr", "it", "pt", "ru", "th", "zh-CN", "zh-TW", "de", "vi"];
        /** @type {Array<{ code: string, label: string }>} */
        const nonEn = [];
        for (const code of NON_EN_CODES)
        {
            const meta = LANGUAGES.find((l) => l.code === code);
            const label = meta && meta.name ? meta.name : code;
            nonEn.push({ code, label });
        }
        nonEn.sort((a, b) => a.label.localeCompare(b.label));

        const allOpts = [
            { code: "en-US", label: enUsLabel },
            { code: "en-GB", label: enGbLabel },
            ...nonEn
        ];
        for (const opt of allOpts)
        {
            const o = document.createElement("option");
            o.value = opt.code;
            o.textContent = opt.label;
            if (opt.code === spellLangInit) o.selected = true;
            langSelect.appendChild(o);
        }

        function syncLangDisabled(enabled)
        {
            langSelect.disabled = !enabled;
            if (enabled)
            {
                langSelect.removeAttribute("aria-disabled");
                langSelect.style.opacity = "";
                langSelect.style.pointerEvents = "";
            }
            else
            {
                langSelect.setAttribute("aria-disabled", "true");
                langSelect.style.opacity = "0.5";
                langSelect.style.pointerEvents = "none";
            }
        }
        syncLangDisabled(spellEnabled);

        spellToggle.addEventListener("click", async () =>
        {
            const next = spellToggle.getAttribute("aria-checked") !== "true";
            spellToggle.setAttribute("aria-checked", String(next));
            syncLangDisabled(next);
            try { await saveUserSettings({ spellcheckEnabled: next }); }
            catch (e) { console.warn("[settings] saveUserSettings(spellcheckEnabled) failed:", e); }
            setSpellcheckState({ enabled: next });
            try { applySpellcheckToAllViews(); }
            catch (_) { /* ignore */ }
        });

        langSelect.addEventListener("change", async () =>
        {
            const next = langSelect.value;
            try { await saveUserSettings({ spellcheckLanguage: next }); }
            catch (e) { console.warn("[settings] saveUserSettings(spellcheckLanguage) failed:", e); }
            setSpellcheckState({ language: next });
            try { applySpellcheckToAllViews(); }
            catch (_) { /* ignore */ }
        });

        teRow2.appendChild(teRow2Label);
        teRow2.appendChild(langSelect);
        teCard.appendChild(teRow2);

        content.appendChild(teCard);
    }

    function renderSkins()
    {
        content.replaceChildren();

        // Card 1 — skin selection.
        const card1 = document.createElement("div");
        card1.className = "settings-card";

        const row1 = document.createElement("div");
        row1.className = "mps-row";
        const row1Label = document.createElement("div");
        row1Label.className = "mps-row-label";
        const t1 = document.createElement("div");
        t1.className = "mps-row-title";
        t1.textContent = t("mangaplay-studio.settings.skin");
        const h1 = document.createElement("div");
        h1.className = "mps-row-help";
        h1.textContent = t("mangaplay-studio.settings.skinHelp");
        row1Label.appendChild(t1);
        row1Label.appendChild(h1);

        // Dropdown driven by listSkins() from the registry so future
        // marketplace-installed skins auto-appear without touching this
        // file. First-party ids resolve to a localised label; unknown ids
        // fall back to the manifest's displayName.
        const SKIN_LABEL_KEY = {
            "default": "mangaplay-studio.settings.skinDefault",
            "night":   "mangaplay-studio.settings.skinNight",
        };
        const select = document.createElement("select");
        select.className = "mps-select";
        for (const manifest of listSkins())
        {
            const o = document.createElement("option");
            o.value = manifest.id;
            const labelKey = SKIN_LABEL_KEY[manifest.id];
            o.textContent = labelKey ? t(labelKey) : manifest.displayName;
            if (state.skin === manifest.id) o.selected = true;
            select.appendChild(o);
        }
        select.addEventListener("change", () =>
        {
            debouncedWriteSkin(select.value);
        });

        row1.appendChild(row1Label);
        row1.appendChild(select);
        card1.appendChild(row1);

        // Font rows. screenplayFont offers Courier New as an alternative.
        // editorFont offers Courier Prime Sans. appFont is Default-only until an
        // alternate app-wide stack is wired.
        const DEFAULT_OPT = { value: "default", labelKey: "mangaplay-studio.settings.fontDefault" };
        const FONT_ROWS = [
            {
                key: "appFont",
                title: t("mangaplay-studio.settings.applicationFont"),
                help: t("mangaplay-studio.settings.applicationFontHelp"),
                options: [DEFAULT_OPT],
            },
            {
                key: "editorFont",
                title: t("mangaplay-studio.settings.textEditorFont"),
                help: t("mangaplay-studio.settings.textEditorFontHelp"),
                options: [DEFAULT_OPT, { value: "courier-prime-sans", labelKey: "mangaplay-studio.settings.fontCourierPrimeSans" }],
                onApply: applyEditorFont,
            },
            {
                key: "screenplayFont",
                title: t("mangaplay-studio.settings.screenplayFont"),
                help: t("mangaplay-studio.settings.screenplayFontHelp"),
                options: [DEFAULT_OPT, { value: "courier-new", labelKey: "mangaplay-studio.settings.fontCourierNew" }],
                onApply: applyScreenplayFont,
            },
        ];
        for (const cfg of FONT_ROWS)
        {
            const fontRow = document.createElement("div");
            fontRow.className = "mps-row";
            const fontLabel = document.createElement("div");
            fontLabel.className = "mps-row-label";
            const fontTitle = document.createElement("div");
            fontTitle.className = "mps-row-title";
            fontTitle.textContent = cfg.title;
            const fontHelp = document.createElement("div");
            fontHelp.className = "mps-row-help";
            fontHelp.textContent = cfg.help;
            fontLabel.appendChild(fontTitle);
            fontLabel.appendChild(fontHelp);

            const fontSelect = document.createElement("select");
            fontSelect.className = "mps-select";
            const current = state[cfg.key] || "default";
            for (const opt of cfg.options)
            {
                const o = document.createElement("option");
                o.value = opt.value;
                o.textContent = t(opt.labelKey);
                if (current === opt.value) o.selected = true;
                fontSelect.appendChild(o);
            }
            fontSelect.addEventListener("change", () =>
            {
                if (cfg.onApply) cfg.onApply(fontSelect.value);
                writeField(cfg.key, fontSelect.value);
            });

            fontRow.appendChild(fontLabel);
            fontRow.appendChild(fontSelect);
            card1.appendChild(fontRow);
        }

        // "Advanced" heading outside any card.
        const advHeading = document.createElement("div");
        advHeading.className = "settings-section-heading";
        advHeading.textContent = t("mangaplay-studio.settings.advanced");

        // Card 2 — hardware acceleration toggle.
        const card2 = document.createElement("div");
        card2.className = "settings-card";
        const row2 = document.createElement("div");
        row2.className = "mps-row";
        const row2Label = document.createElement("div");
        row2Label.className = "mps-row-label";
        const t2 = document.createElement("div");
        t2.className = "mps-row-title";
        t2.textContent = t("mangaplay-studio.settings.hardwareAcceleration");
        const h2 = document.createElement("div");
        h2.className = "mps-row-help";
        h2.textContent = t("mangaplay-studio.settings.hardwareAccelerationHelp");
        row2Label.appendChild(t2);
        row2Label.appendChild(h2);

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "mps-toggle";
        toggle.setAttribute("role", "switch");
        toggle.setAttribute("aria-checked", String(!!state.hardwareAcceleration));
        toggle.setAttribute("aria-label", t("mangaplay-studio.settings.hardwareAcceleration"));
        toggle.addEventListener("click", () =>
        {
            const next = !(state.hardwareAcceleration === true);
            toggle.setAttribute("aria-checked", String(next));
            writeField("hardwareAcceleration", next);
        });
        row2.appendChild(row2Label);
        row2.appendChild(toggle);
        card2.appendChild(row2);

        // Card 2 row — smooth motion (default ON; toggling OFF applies live
        // via applySmoothMotion, which adds `no-smooth-motion` to <html>).
        const smoothMotionRow = document.createElement("div");
        smoothMotionRow.className = "mps-row";
        const smoothMotionLabel = document.createElement("div");
        smoothMotionLabel.className = "mps-row-label";
        const smoothMotionTitle = document.createElement("div");
        smoothMotionTitle.className = "mps-row-title";
        smoothMotionTitle.textContent = t("mangaplay-studio.settings.smoothMotion");
        const smoothMotionHelp = document.createElement("div");
        smoothMotionHelp.className = "mps-row-help";
        smoothMotionHelp.textContent = t("mangaplay-studio.settings.smoothMotionHelp");
        smoothMotionLabel.appendChild(smoothMotionTitle);
        smoothMotionLabel.appendChild(smoothMotionHelp);

        const smoothMotionToggle = document.createElement("button");
        smoothMotionToggle.type = "button";
        smoothMotionToggle.className = "mps-toggle";
        smoothMotionToggle.setAttribute("role", "switch");
        smoothMotionToggle.setAttribute("aria-checked", String(state.smoothMotion !== false));
        smoothMotionToggle.setAttribute("aria-label", t("mangaplay-studio.settings.smoothMotion"));
        smoothMotionToggle.addEventListener("click", () =>
        {
            const next = !(state.smoothMotion !== false);
            smoothMotionToggle.setAttribute("aria-checked", String(next));
            applySmoothMotion(next);
            writeField("smoothMotion", next);
        });
        smoothMotionRow.appendChild(smoothMotionLabel);
        smoothMotionRow.appendChild(smoothMotionToggle);
        card2.appendChild(smoothMotionRow);

        // Card 2 row — smooth scrolling (default ON; live-applied via
        // applySmoothScrolling → adds `no-smooth-scrolling` to <html>).
        const smoothScrollRow = document.createElement("div");
        smoothScrollRow.className = "mps-row";
        const smoothScrollLabel = document.createElement("div");
        smoothScrollLabel.className = "mps-row-label";
        const smoothScrollTitle = document.createElement("div");
        smoothScrollTitle.className = "mps-row-title";
        smoothScrollTitle.textContent = t("mangaplay-studio.settings.smoothScrolling");
        const smoothScrollHelp = document.createElement("div");
        smoothScrollHelp.className = "mps-row-help";
        smoothScrollHelp.textContent = t("mangaplay-studio.settings.smoothScrollingHelp");
        smoothScrollLabel.appendChild(smoothScrollTitle);
        smoothScrollLabel.appendChild(smoothScrollHelp);

        const smoothScrollToggle = document.createElement("button");
        smoothScrollToggle.type = "button";
        smoothScrollToggle.className = "mps-toggle";
        smoothScrollToggle.setAttribute("role", "switch");
        smoothScrollToggle.setAttribute("aria-checked", String(state.smoothScrolling !== false));
        smoothScrollToggle.setAttribute("aria-label", t("mangaplay-studio.settings.smoothScrolling"));
        smoothScrollToggle.addEventListener("click", () =>
        {
            const next = !(state.smoothScrolling !== false);
            smoothScrollToggle.setAttribute("aria-checked", String(next));
            applySmoothScrolling(next);
            writeField("smoothScrolling", next);
        });
        smoothScrollRow.appendChild(smoothScrollLabel);
        smoothScrollRow.appendChild(smoothScrollToggle);
        card2.appendChild(smoothScrollRow);

        content.appendChild(card1);
        content.appendChild(advHeading);
        content.appendChild(card2);
    }

    /**
     * Map a classified auth error class to a shared
     * `mangaplay-studio.auth.errors.*` key. Covers all 8 classes
     * emitted by `classifyAuthError()`.
     * @param {string} cls
     * @returns {string}
     */
    function _authErrorLocaleKey(cls)
    {
        switch (cls)
        {
            case "auth.user_cancelled":            return "cancelled";
            case "auth.network":                   return "network";
            case "auth.scope_denied":              return "scopeDenied";
            case "auth.token_expired":             return "tokenExpired";
            case "auth.refresh_token_expired":     return "refreshExpired";
            case "permissions.doc_access_revoked": return "revoked";
            case "fatal.config":                   return "config";
            default:                               return "unknown";
        }
    }

    /**
     * Surface a classified auth error. All 8 classifier classes route to
     * a shared `mangaplay-studio.auth.errors.*` sentence. When `errorEl`
     * is supplied (signed-out sign-in flow) the sentence lands in the
     * inline slot; when omitted (signed-in sign-out / switch failures)
     * it falls back to a toast — the signed-in card has no reserved
     * space for an inline error and those failures are rare.
     * @param {unknown} err
     * @param {HTMLElement} [errorEl] — permanently-mounted slot; aria-live=polite.
     */
    function routeAuthError(err, errorEl)
    {
        const cls = classifyAuthError(err);
        const key = _authErrorLocaleKey(cls.class);
        const msg = t(`mangaplay-studio.auth.errors.${key}`);
        if (errorEl) errorEl.textContent = msg;
        else showToast(msg);
    }

    // One-shot slot: when the click handler sees `authSignIn` return null
    // (cancellation), it stashes the locale key here BEFORE the natural
    // `mps:authChanged` re-render. `renderAccount` reads + clears it on
    // the first render so the sentence lands in the freshly-mounted
    // errorEl. Writing to the closure-captured errorEl directly would
    // hit a detached node — the emit happens synchronously inside
    // signIn's finally and re-renders before the click handler resumes.
    let _pendingSignInErrorKey = null;

    function renderAccount()
    {
        content.replaceChildren();

        const card = document.createElement("div");
        card.className = "settings-card";

        const signedIn = authIsAuthenticated();
        const profile = authGetCurrentProfile();
        const hasIdentity = !!profile && (!!profile.sub || !!profile.name || !!profile.picture);

        if (!signedIn || !hasIdentity)
        {
            // ── SIGNED OUT ────────────────────────────────────────────
            const row = document.createElement("div");
            row.className = "mps-row";
            const rowLabel = document.createElement("div");
            rowLabel.className = "mps-row-label";

            const title = document.createElement("div");
            title.className = "mps-row-title";
            title.textContent = t("mangaplay-studio.settings.account.heading");

            const help = document.createElement("div");
            help.className = "mps-row-help";
            help.textContent = t("mangaplay-studio.settings.account.signedOutBody");

            rowLabel.appendChild(title);
            rowLabel.appendChild(help);

            // Permanently-mounted inline error slot. Empty by default
            // so `:empty { margin-top: 0 }` collapses it — no dead
            // zone under the sign-in button in the common (no-error)
            // case. `aria-live=polite` announces the sentence when a
            // failed sign-in populates it; deliberately NOT `role=alert`
            // (which implies aria-live=assertive) — combining them is
            // contradictory.
            const errorEl = document.createElement("div");
            errorEl.className = "settings-account-error";
            errorEl.setAttribute("aria-live", "polite");

            // Two-state action slot:
            //  - Idle → primary "Sign in with Google" button (default).
            //  - In-flight (isInteractiveSignInPending() truthy) → the
            //    button reads "Waiting for browser sign-in…" (disabled)
            //    with a secondary "Cancel" button beside it. The natural
            //    `mps:authChanged` fired when the flow ends re-renders
            //    the Account tab and flips this back to idle.
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "mps-btn-primary";

            const pending = authIsInteractiveSignInPending();

            // One-shot drain of `_pendingSignInErrorKey` — gated on the
            // IDLE render only. When the flow starts, `signIn()` emits
            // authChanged synchronously, which re-renders THIS card in
            // the WAITING state; draining the pending key there would
            // consume the message before the flow ended. Drain only on
            // the idle render (post-flow), which is what the user sees.
            if (!pending && _pendingSignInErrorKey)
            {
                errorEl.textContent = t(
                    `mangaplay-studio.auth.errors.${_pendingSignInErrorKey}`);
                _pendingSignInErrorKey = null;
            }

            if (pending)
            {
                btn.disabled = true;
                btn.textContent = t("mangaplay-studio.auth.errors.waiting");

                const cancelBtn = document.createElement("button");
                cancelBtn.type = "button";
                cancelBtn.className = "mps-btn-secondary";
                cancelBtn.textContent = t("mangaplay-studio.auth.errors.cancelButton");
                cancelBtn.addEventListener("click", async () =>
                {
                    // Immediate disable — the abort is idempotent
                    // server-side (Rust returns Ok(false) for repeat
                    // ids), but a rapid double-click shouldn't queue
                    // extra invokes.
                    cancelBtn.disabled = true;
                    let aborted = false;
                    try { aborted = await authAbortInteractiveSignIn(); }
                    catch (_) { /* best-effort */ }
                    // On a successful abort, signIn's finally emits
                    // mps:authChanged after clearing the guards, which
                    // re-renders and removes this button entirely — no
                    // manual reset needed. But if abort no-op'd (spawn
                    // race before `_pendingAbortId` was set, or a mobile
                    // transport where there's no loopback id) the flow
                    // is still running and no re-render is coming, so
                    // re-enable the button so the user can retry.
                    if (!aborted) cancelBtn.disabled = false;
                });

                row.appendChild(rowLabel);
                row.appendChild(btn);
                row.appendChild(cancelBtn);
                card.appendChild(row);
                card.appendChild(errorEl);
            }
            else
            {
                btn.textContent = t("mangaplay-studio.settings.account.signInButton");
                btn.addEventListener("click", async () =>
                {
                    console.warn("[mps:auth:TRACE] settings-modal Sign-In button CLICKED → will call authSignIn({interactive:true})");
                    btn.disabled = true;
                    errorEl.textContent = "";
                    try
                    {
                        // Stash the cancelled key BEFORE `await` so it's
                        // in place when signIn's finally fires the
                        // synchronous `mps:authChanged` that re-renders
                        // this tab. If the sign-in succeeds we clear the
                        // stash before re-render.
                        _pendingSignInErrorKey = "cancelled";
                        const profile = await authSignIn({ interactive: true });
                        console.log("[settings:account] signIn returned profile:", profile);
                        console.log("[settings:account] post-signin isAuthenticated:",
                            authIsAuthenticated(), "currentProfile:", authGetCurrentProfile());
                        if (profile)
                        {
                            // Success — cancel the stashed cancelled
                            // message before the (already-emitted, but
                            // possibly not-yet-re-rendered) authChanged
                            // subscriber runs on the next microtask.
                            // In practice the emit ran synchronously
                            // inside the finally, so renderAccount has
                            // already drained the stash on the SIGNED-IN
                            // branch (which doesn't build errorEl) — this
                            // null-out is belt-and-braces.
                            _pendingSignInErrorKey = null;
                            renderActiveTab();
                        }
                        // profile === null: the "cancelled" stash was
                        // consumed by the synchronous re-render inside
                        // signIn's finally; nothing more to do here.
                    }
                    catch (e)
                    {
                        _pendingSignInErrorKey = null;
                        console.warn("[settings:account] signIn threw:", e);
                        routeAuthError(e, errorEl);
                    }
                    finally
                    {
                        btn.disabled = false;
                    }
                });

                row.appendChild(rowLabel);
                row.appendChild(btn);
                card.appendChild(row);
                card.appendChild(errorEl);
            }

            const perms = document.createElement("div");
            perms.className = "mps-row-help";
            perms.textContent = t("mangaplay-studio.settings.account.permissionsLine");
            card.appendChild(perms);
        }
        else
        {
            // ── SIGNED IN ─────────────────────────────────────────────
            // Single row: avatar + spoiler-name + reveal/hide button +
            // sign-out + switch — all on one line.
            const row = document.createElement("div");
            row.className = "mps-row settings-account-row";

            if (profile.picture)
            {
                const avatar = document.createElement("img");
                avatar.className = "settings-account-avatar";
                avatar.src = profile.picture;
                avatar.alt = "";
                avatar.width = 32;
                avatar.height = 32;
                row.appendChild(avatar);
            }

            // Spoiler-box: grey block, name hidden by default, click reveal
            // button to toggle. Prevents an over-the-shoulder leak.
            const nameSpoiler = document.createElement("div");
            nameSpoiler.className = "settings-name-spoiler";
            nameSpoiler.dataset.revealed = "false";

            const nameText = document.createElement("span");
            nameText.className = "settings-name-spoiler-text";
            const displayName = profile.name || t("mangaplay-studio.settings.account.heading");
            nameText.textContent = displayName;
            nameSpoiler.appendChild(nameText);

            const revealBtn = document.createElement("button");
            revealBtn.type = "button";
            revealBtn.className = "settings-name-spoiler-toggle";
            revealBtn.setAttribute("aria-label", t("mangaplay-studio.settings.account.revealName"));
            revealBtn.setAttribute("aria-pressed", "false");
            revealBtn.title = t("mangaplay-studio.settings.account.revealName");
            revealBtn.textContent = "\u{1F441}";
            revealBtn.addEventListener("click", () =>
            {
                const revealed = nameSpoiler.dataset.revealed === "true";
                const next = !revealed;
                nameSpoiler.dataset.revealed = next ? "true" : "false";
                revealBtn.setAttribute("aria-pressed", next ? "true" : "false");
                const label = next
                    ? t("mangaplay-studio.settings.account.hideName")
                    : t("mangaplay-studio.settings.account.revealName");
                revealBtn.setAttribute("aria-label", label);
                revealBtn.title = label;
            });

            row.appendChild(nameSpoiler);
            row.appendChild(revealBtn);

            const signOutBtn = document.createElement("button");
            signOutBtn.type = "button";
            signOutBtn.className = "mps-btn-danger";
            signOutBtn.textContent = t("mangaplay-studio.settings.account.signOut");
            signOutBtn.addEventListener("click", async () =>
            {
                signOutBtn.disabled = true;
                try
                {
                    await authSignOut();
                    renderActiveTab();
                }
                catch (e)
                {
                    routeAuthError(e);
                }
                finally
                {
                    signOutBtn.disabled = false;
                }
            });

            const switchBtn = document.createElement("button");
            switchBtn.type = "button";
            switchBtn.className = "mps-btn-primary";
            switchBtn.textContent = t("mangaplay-studio.settings.account.switchAccount");
            switchBtn.addEventListener("click", async () =>
            {
                switchBtn.disabled = true;
                try
                {
                    await authSwitchAccount();
                    renderActiveTab();
                }
                catch (e)
                {
                    routeAuthError(e);
                }
                finally
                {
                    switchBtn.disabled = false;
                }
            });

            row.appendChild(signOutBtn);
            row.appendChild(switchBtn);
            card.appendChild(row);
        }

        content.appendChild(card);
    }

    async function renderPublish()
    {
        content.replaceChildren();

        const card = document.createElement("div");
        card.className = "settings-card";

        const listEl = document.createElement("div");
        listEl.className = "settings-publish-list mps-scrollbar";

        const loadingEl = document.createElement("div");
        loadingEl.className = "settings-publish-empty";
        loadingEl.textContent = t("mangaplay-studio.settings.publish.loading");
        listEl.appendChild(loadingEl);

        card.appendChild(listEl);
        content.appendChild(card);

        const entries = await loadPublishLog();
        // User may have switched tabs while loading — bail out if so.
        if (activeTab !== "publish") return;

        listEl.replaceChildren();
        if (entries.length === 0)
        {
            const empty = document.createElement("div");
            empty.className = "settings-publish-empty";
            empty.textContent = t("mangaplay-studio.settings.publish.empty");
            listEl.appendChild(empty);
            return;
        }

        for (const entry of entries)
        {
            const row = document.createElement("div");
            row.className = "settings-publish-row";

            const fname = document.createElement("div");
            fname.className = "settings-publish-filename";
            fname.textContent = entry.fileName || "(untitled)";
            fname.title = entry.fileName || "";

            const date = document.createElement("div");
            date.className = "settings-publish-date";
            try
            {
                date.textContent = new Date(entry.createdAtUtc).toLocaleString();
            }
            catch (e)
            {
                date.textContent = entry.createdAtUtc || "";
            }

            // Avatar — <img> with onerror fallback to circle-user icon.
            let avatar;
            if (entry.googlePicture)
            {
                avatar = document.createElement("img");
                avatar.className = "settings-publish-avatar";
                avatar.src = entry.googlePicture;
                avatar.alt = entry.googleName || entry.googleEmail || "";
                avatar.title = entry.googleEmail || entry.googleName || "";
                avatar.loading = "lazy";
                avatar.onerror = () =>
                {
                    const fb = document.createElement("span");
                    fb.className = "settings-publish-avatar";
                    fb.innerHTML = icon("circle-user", { size: 20 });
                    avatar.replaceWith(fb);
                };
            }
            else
            {
                avatar = document.createElement("span");
                avatar.className = "settings-publish-avatar";
                avatar.innerHTML = icon("circle-user", { size: 20 });
                avatar.title = entry.googleEmail || entry.googleName || "";
            }

            const isCollab = entry.intent === "collaborate";
            const intent = document.createElement("span");
            intent.className = "settings-publish-intent " + (isCollab
                ? "settings-publish-intent-collaborate"
                : "settings-publish-intent-publish");
            intent.textContent = isCollab
                ? t("mangaplay-studio.settings.publish.intentCollaborate")
                : t("mangaplay-studio.settings.publish.intentPublish");

            const copyBtn = document.createElement("button");
            copyBtn.type = "button";
            copyBtn.className = "settings-publish-copy";
            copyBtn.setAttribute("aria-label", t("mangaplay-studio.settings.publish.copyLink"));
            copyBtn.title = t("mangaplay-studio.settings.publish.copyLink");
            copyBtn.innerHTML = icon("copy", { size: 16 });
            copyBtn.addEventListener("click", async () =>
            {
                try
                {
                    await navigator.clipboard.writeText(entry.docUrl);
                    showToast(t("mangaplay-studio.settings.publish.linkCopied"));
                }
                catch (e)
                {
                    console.warn("[settings] copy link failed", e);
                }
            });

            row.appendChild(fname);
            row.appendChild(date);
            row.appendChild(avatar);
            row.appendChild(intent);
            row.appendChild(copyBtn);
            listEl.appendChild(row);
        }
    }

    function renderActiveTab()
    {
        if (activeTab === "appearance") renderSkins();
        else if (activeTab === "text-editor") renderTextEditor();
        else if (activeTab === "account") renderAccount();
        else if (activeTab === "publish") renderPublish();
        else renderGeneral();
    }

    /** Refresh strings that live outside the per-tab content pane. */
    function refreshChrome()
    {
        dialog.setAttribute("aria-label", t("mangaplay-studio.settings.title"));
        closeBtn.setAttribute("aria-label", t("mangaplay-studio.settings.close"));
        sidebarHeading.textContent = t("mangaplay-studio.settings.options");
        for (const tab of TABS)
        {
            const label = tabLabelEls.get(tab.id);
            if (label) label.textContent = t(tab.labelKey);
        }
    }

    function selectTab(id)
    {
        activeTab = id;
        for (const [tabId, btn] of entryEls)
        {
            btn.classList.toggle("selected", tabId === id);
        }
        renderActiveTab();
    }

    // Re-render the active tab when auth state changes externally (e.g.
    // silent refresh completes mid-modal). Attached at mount time below;
    // unsubscribed in close().
    const onAuthChangedListener = /** @type {EventListener} */ (() => { renderActiveTab(); });

    function close()
    {
        if (!modalRoot) return;
        modalRoot.classList.remove("visible");
        if (detachKeydown)
        {
            document.removeEventListener("keydown", detachKeydown);
            detachKeydown = null;
        }
        if (detachI18n)
        {
            detachI18n();
            detachI18n = null;
        }
        try { document.removeEventListener("mps:authChanged", onAuthChangedListener); }
        catch (_) { /* best-effort */ }
        const r = modalRoot;
        modalRoot = null;
        setTimeout(() =>
        {
            try { r.remove(); } catch {}
        }, 200);
    }

    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", (ev) =>
    {
        if (ev.target === backdrop) close();
    });

    detachKeydown = (ev) =>
    {
        if (ev.key === "Escape") close();
    };
    document.addEventListener("keydown", detachKeydown);

    detachI18n = subscribeI18n(() =>
    {
        refreshChrome();
        renderActiveTab();
    });

    // Subscribe to auth-state changes so the Account tab updates if a
    // silent refresh completes (or sign-out fires from somewhere else)
    // while the modal is open.
    document.addEventListener("mps:authChanged", onAuthChangedListener);

    // Best-effort rehydrate so the Account tab paints with the correct
    // profile on first reveal even if app.js's boot path didn't finish.
    try { authEnsureRehydrated(); } catch (_) { /* best-effort */ }

    document.body.appendChild(backdrop);
    modalRoot = backdrop;
    selectTab(activeTab);
    requestAnimationFrame(() => backdrop.classList.add("visible"));
}
