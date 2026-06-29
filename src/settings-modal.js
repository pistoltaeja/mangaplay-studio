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
 * Theme dropdown writes are debounced 150 ms (keyboard arrow churn) and call
 * `applyColorScheme(value)` on each successful write so the swap is visible
 * immediately.
 */

import { icon } from "./icons.js";
import { applyColorScheme } from "./theme.js";
import { applyScreenplayFont, applyEditorFont } from "./font-prefs.js";
import { t, subscribe as subscribeI18n, LANGUAGES } from "./adapters/tauri-i18n.js";
import { saveUserSettings, getUserSetting } from "./user-settings.js";
import { setSpellcheckState } from "./spellcheck-state.js";
import { applySpellcheckToAllViews } from "./mps-editor.js";
import {
    signIn as authSignIn,
    signOut as authSignOut,
    switchAccount as authSwitchAccount,
    getCurrentProfile as authGetCurrentProfile,
    isAuthenticated as authIsAuthenticated,
    ensureRehydrated as authEnsureRehydrated,
} from "./auth/google-oauth.js";
import { classifyAuthError } from "./auth/error-classifier.js";
import { isTauri } from "./util/is-tauri.js";
import { debounce } from "./util/debounce.js";

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
    let state = { colorScheme: "light", hardwareAcceleration: true, appFont: "default", editorFont: "default", screenplayFont: "default" };
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
            if (key === "colorScheme") applyColorScheme(value);
        }
        catch (e)
        {
            state[key] = prev;
            renderActiveTab();
            showToast(t("mangaplay-studio.settings.couldNotSave", { error: String(e?.message || e) }));
        }
    }

    const debouncedWriteScheme = debounce(
        (v) => { writeField("colorScheme", v); },
        150
    );

    function renderGeneral()
    {
        content.replaceChildren();

        // Card 1 — version + check-for-updates.
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
        row1Label.appendChild(versionTitle);
        row1Label.appendChild(installerLine);

        const checkBtn = document.createElement("button");
        checkBtn.type = "button";
        checkBtn.className = "mps-btn-primary";
        checkBtn.textContent = t("mangaplay-studio.settings.checkForUpdates");

        const updateStatus = document.createElement("div");
        updateStatus.className = "mps-row-help";
        updateStatus.dataset.role = "update-status";

        checkBtn.addEventListener("click", async () =>
        {
            updateStatus.textContent = t("mangaplay-studio.settings.checking");
            try
            {
                const r = await invoke("app_check_for_updates");
                if (r && typeof r === "object" && r.available === false)
                {
                    updateStatus.textContent = t("mangaplay-studio.settings.upToDate");
                }
                else if (r && typeof r === "object" && r.available === true)
                {
                    updateStatus.textContent = t("mangaplay-studio.settings.updateAvailable");
                }
                else
                {
                    updateStatus.textContent = "";
                }
            }
            catch (e)
            {
                const msg = String(e?.message || e || "");
                if (msg.includes("updater-unavailable"))
                {
                    updateStatus.textContent = t("mangaplay-studio.settings.updatesUnavailable");
                }
                else
                {
                    updateStatus.textContent = t("mangaplay-studio.settings.couldNotCheck", { error: msg });
                }
            }
            setTimeout(() =>
            {
                if (updateStatus.textContent !== "") updateStatus.textContent = "";
            }, 4000);
        });

        row1.appendChild(row1Label);
        row1.appendChild(checkBtn);
        card1.appendChild(row1);
        card1.appendChild(updateStatus);

        // Card 2 — changelog link.
        const card2 = document.createElement("div");
        card2.className = "settings-card";
        const row2 = document.createElement("div");
        row2.className = "mps-row";
        const changelog = document.createElement("a");
        changelog.className = "settings-link";
        changelog.href = "#";
        changelog.textContent = t("mangaplay-studio.settings.readChangelog");
        changelog.addEventListener("click", async (ev) =>
        {
            ev.preventDefault();
            try
            {
                const shellMod = await import("@tauri-apps/plugin-shell");
                const url = appVersion
                    ? `https://mangaplay.studio/desktop/changelog/${appVersion}`
                    : "https://mangaplay.studio/desktop/changelog";
                await shellMod.open(url);
            }
            catch (e)
            {
                showToast(t("mangaplay-studio.settings.couldNotOpenBrowser", { error: String(e?.message || e) }));
            }
        });
        row2.appendChild(changelog);
        card2.appendChild(row2);

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

        content.appendChild(card1);
        content.appendChild(card2);
        content.appendChild(card3);
    }

    function renderTextEditor()
    {
        content.replaceChildren();

        // ── Text Editor section: spellcheck toggle + language dropdown ──
        const teHeading = document.createElement("div");
        teHeading.className = "settings-section-heading";
        teHeading.textContent = t("mangaplay-studio.settings.textEditor.heading");

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

        content.appendChild(teHeading);
        content.appendChild(teCard);
    }

    function renderAppearance()
    {
        content.replaceChildren();

        // Card 1 — base colour scheme.
        const card1 = document.createElement("div");
        card1.className = "settings-card";

        const row1 = document.createElement("div");
        row1.className = "mps-row";
        const row1Label = document.createElement("div");
        row1Label.className = "mps-row-label";
        const t1 = document.createElement("div");
        t1.className = "mps-row-title";
        t1.textContent = t("mangaplay-studio.settings.baseColourScheme");
        const h1 = document.createElement("div");
        h1.className = "mps-row-help";
        h1.textContent = t("mangaplay-studio.settings.baseColourSchemeHelp");
        row1Label.appendChild(t1);
        row1Label.appendChild(h1);

        const select = document.createElement("select");
        select.className = "mps-select";
        for (const opt of [{ v: "light", l: t("mangaplay-studio.settings.schemeLight") }, { v: "dark", l: t("mangaplay-studio.settings.schemeDark") }])
        {
            const o = document.createElement("option");
            o.value = opt.v;
            o.textContent = opt.l;
            if (state.colorScheme === opt.v) o.selected = true;
            select.appendChild(o);
        }
        select.addEventListener("change", () =>
        {
            debouncedWriteScheme(select.value);
        });

        row1.appendChild(row1Label);
        row1.appendChild(select);
        card1.appendChild(row1);

        // Font rows. screenplayFont offers Courier New as an alternative.
        // appFont and editorFont are Default-only until alternate stacks are wired.
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
                options: [DEFAULT_OPT],
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

        content.appendChild(card1);
        content.appendChild(advHeading);
        content.appendChild(card2);
    }

    /**
     * Surface a classified auth error. `auth.user_cancelled` is silent;
     * network errors toast; everything else toasts with the diagnostic
     * (no modal layer in the desktop settings card today).
     * @param {unknown} err
     */
    function routeAuthError(err)
    {
        const cls = classifyAuthError(err);
        if (cls.class === "auth.user_cancelled")
        {
            console.warn("[settings:account] sign-in cancelled");
            return;
        }
        if (cls.class === "auth.network")
        {
            showToast(t("mangaplay-studio.settings.account.errors.network"));
            return;
        }
        if (cls.class === "permissions.doc_access_revoked")
        {
            showToast(t("mangaplay-studio.settings.account.errors.revoked"));
            return;
        }
        if (cls.class === "fatal.config")
        {
            showToast(t("mangaplay-studio.settings.account.errors.config"));
            return;
        }
        showToast(t("mangaplay-studio.settings.account.errors.unknown"));
    }

    function renderAccount()
    {
        content.replaceChildren();

        const card = document.createElement("div");
        card.className = "settings-card";

        const heading = document.createElement("div");
        heading.className = "settings-section-heading";
        heading.textContent = t("mangaplay-studio.settings.account.heading");

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

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "mps-btn-primary";
            btn.textContent = t("mangaplay-studio.settings.account.signInButton");
            btn.addEventListener("click", async () =>
            {
                btn.disabled = true;
                try
                {
                    const profile = await authSignIn({ interactive: true });
                    console.log("[settings:account] signIn returned profile:", profile);
                    console.log("[settings:account] post-signin isAuthenticated:",
                        authIsAuthenticated(), "currentProfile:", authGetCurrentProfile());
                    renderActiveTab();
                }
                catch (e)
                {
                    console.warn("[settings:account] signIn threw:", e);
                    routeAuthError(e);
                }
                finally
                {
                    btn.disabled = false;
                }
            });

            row.appendChild(rowLabel);
            row.appendChild(btn);
            card.appendChild(row);

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

        content.appendChild(heading);
        content.appendChild(card);
    }

    function renderActiveTab()
    {
        if (activeTab === "appearance") renderAppearance();
        else if (activeTab === "text-editor") renderTextEditor();
        else if (activeTab === "account") renderAccount();
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
