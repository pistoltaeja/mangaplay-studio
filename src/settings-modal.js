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
import { t, subscribe as subscribeI18n } from "./adapters/tauri-i18n.js";

/** Tauri invoke helper — falls back to a rejected promise outside Tauri. */
async function invoke(cmd, args)
{
    const t = /** @type {any} */ (window).__TAURI__;
    if (!t || !t.core || typeof t.core.invoke !== "function")
    {
        throw new Error("Tauri unavailable");
    }
    return t.core.invoke(cmd, args);
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
 * Small inline debouncer scoped to the modal's lifetime.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} ms
 * @returns {(...args: Parameters<F>) => void}
 */
function debounce(fn, ms)
{
    let h = 0;
    return (...args) =>
    {
        if (h) clearTimeout(h);
        h = /** @type {any} */ (setTimeout(() => fn(...args), ms));
    };
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
        { id: "appearance", labelKey: "mangaplay-studio.settings.tabAppearance", iconName: "palette" },
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
        row1.className = "settings-row";
        const row1Label = document.createElement("div");
        row1Label.className = "settings-row-label";
        const versionTitle = document.createElement("div");
        versionTitle.className = "settings-row-title";
        versionTitle.textContent = t("mangaplay-studio.settings.version", { version: appVersion || "0.0.0" });
        const installerLine = document.createElement("div");
        installerLine.className = "settings-row-help";
        installerLine.textContent = t("mangaplay-studio.settings.installerVersion", { version: appVersion || "0.0.0" });
        row1Label.appendChild(versionTitle);
        row1Label.appendChild(installerLine);

        const checkBtn = document.createElement("button");
        checkBtn.type = "button";
        checkBtn.className = "settings-btn-primary";
        checkBtn.textContent = t("mangaplay-studio.settings.checkForUpdates");

        const updateStatus = document.createElement("div");
        updateStatus.className = "settings-row-help";
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
        row2.className = "settings-row";
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
        row3.className = "settings-row";
        const row3Label = document.createElement("div");
        row3Label.className = "settings-row-label";
        const t3 = document.createElement("div");
        t3.className = "settings-row-title";
        t3.textContent = t("mangaplay-studio.settings.language");
        const h3 = document.createElement("div");
        h3.className = "settings-row-help";
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

    function renderAppearance()
    {
        content.replaceChildren();

        // Card 1 — base colour scheme.
        const card1 = document.createElement("div");
        card1.className = "settings-card";

        const row1 = document.createElement("div");
        row1.className = "settings-row";
        const row1Label = document.createElement("div");
        row1Label.className = "settings-row-label";
        const t1 = document.createElement("div");
        t1.className = "settings-row-title";
        t1.textContent = t("mangaplay-studio.settings.baseColourScheme");
        const h1 = document.createElement("div");
        h1.className = "settings-row-help";
        h1.textContent = t("mangaplay-studio.settings.baseColourSchemeHelp");
        row1Label.appendChild(t1);
        row1Label.appendChild(h1);

        const select = document.createElement("select");
        select.className = "settings-select";
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
            fontRow.className = "settings-row";
            const fontLabel = document.createElement("div");
            fontLabel.className = "settings-row-label";
            const fontTitle = document.createElement("div");
            fontTitle.className = "settings-row-title";
            fontTitle.textContent = cfg.title;
            const fontHelp = document.createElement("div");
            fontHelp.className = "settings-row-help";
            fontHelp.textContent = cfg.help;
            fontLabel.appendChild(fontTitle);
            fontLabel.appendChild(fontHelp);

            const fontSelect = document.createElement("select");
            fontSelect.className = "settings-select";
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
        row2.className = "settings-row";
        const row2Label = document.createElement("div");
        row2Label.className = "settings-row-label";
        const t2 = document.createElement("div");
        t2.className = "settings-row-title";
        t2.textContent = t("mangaplay-studio.settings.hardwareAcceleration");
        const h2 = document.createElement("div");
        h2.className = "settings-row-help";
        h2.textContent = t("mangaplay-studio.settings.hardwareAccelerationHelp");
        row2Label.appendChild(t2);
        row2Label.appendChild(h2);

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "settings-toggle";
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

    function renderActiveTab()
    {
        if (activeTab === "appearance") renderAppearance();
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

    document.body.appendChild(backdrop);
    modalRoot = backdrop;
    selectTab(activeTab);
    requestAnimationFrame(() => backdrop.classList.add("visible"));
}
