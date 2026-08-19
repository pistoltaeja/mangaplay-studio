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
import { getPlatformKey, getPlatformKeyCached } from "../adapters/platform-key.js";
import { applySkin, listSkins } from "../boot/skins.js";
import { applyScreenplayFont, applyEditorFont } from "../font/font-prefs.js";
import { applySmoothMotion, applySmoothScrolling } from "../adapters/motion-prefs.js";
import { t, subscribe as subscribeI18n, LANGUAGES } from "../adapters/tauri-i18n.js";
import { saveUserSettings, getUserSetting } from "../project/user-settings.js";
import { areAdsDisabled } from "../ads/ad-service.js";
import { setSpellcheckState } from "../spellcheck/spellcheck-state.js";
import { applySpellcheckToAllViews } from "../editor/mps-editor.js";
import {
    personalDictWords,
    isPersonalDictWord,
    addToPersonalDict,
    removeFromPersonalDict,
} from "../spellcheck/spellcheck-store.js";
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
import { isMobileLike } from "../boot/ux-mode.js";
import { isSkinUnlocked, hasPro, onEntitlementsChanged, setEntitlements } from "../iap/entitlements.js";
import { SKIN_CATALOG } from "../boot/skins-catalog.generated.js";

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
/** Releases the entitlements subscription at close time. */
let entitlementsOff = null;

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
    backdrop.classList.add("is-settings", "mps-sheet-backdrop");

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", t("mangaplay-studio.settings.title"));
    dialog.classList.add("is-settings", "mps-sheet");

    // Title bar (close button).
    const titlebar = document.createElement("div");
    titlebar.className = "settings-titlebar mps-sheet-titlebar";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "settings-close mps-sheet-close";
    closeBtn.setAttribute("aria-label", t("mangaplay-studio.settings.close"));
    closeBtn.insertAdjacentHTML("afterbegin", icon("x", { size: 16 }));
    titlebar.appendChild(closeBtn);

    // Body — sidebar + content.
    const body = document.createElement("div");
    body.className = "settings-body";

    const sidebar = document.createElement("div");
    sidebar.className = "settings-sidebar mps-sheet-tabs";
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
        { id: "general", labelKey: "mangaplay-studio.settings.tabGeneral", iconName: "settings" },
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
        btn.className = "settings-entry mps-sheet-tab";
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

    // ── Sub-page (iOS drill-down) infrastructure ──────────────────────────────
    // A per-open stack of overlay panels that slide in over `.settings-content`
    // while the left rail stays put. Only Personal Dictionary uses it today.

    /** @typedef {{ render: (panelEl: HTMLElement) => void }} Subpage */
    /** @type {Subpage[]} */
    const subpageStack = [];
    /** @type {HTMLElement|null} */
    let subpageTrack = null;
    const REDUCED_MOTION = window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;

    /** Lazily create the overlay track that hosts sliding sub-pages. */
    function ensureSubpageTrack()
    {
        if (subpageTrack && subpageTrack.isConnected) return subpageTrack;
        subpageTrack = document.createElement("div");
        subpageTrack.className = "settings-subpage-track";
        content.appendChild(subpageTrack);
        return subpageTrack;
    }

    /**
     * Swap the titlebar button glyph + affordance to reflect the current
     * drill depth: `‹` while a sub-page is open, `✕` at the root.
     */
    function updateCloseButtonGlyph()
    {
        const deep = subpageStack.length > 0;
        closeBtn.replaceChildren();
        closeBtn.insertAdjacentHTML("afterbegin", icon(deep ? "chevron-left" : "x", { size: 16 }));
        closeBtn.classList.toggle("is-back", deep);
        closeBtn.setAttribute(
            "aria-label",
            deep ? t("mangaplay-studio.settings.back") : t("mangaplay-studio.settings.close"),
        );
    }

    /**
     * Run the enter/leave slide, then invoke `done` after the transition ends
     * (or a 400 ms fallback). Reduced-motion collapses to an instant swap.
     * @param {HTMLElement} incoming — panel sliding into view
     * @param {HTMLElement|null} outgoing — panel sliding out (may be null)
     * @param {"forward"|"back"} dir
     * @param {() => void} done
     */
    function runSlide(incoming, outgoing, dir, done)
    {
        if (REDUCED_MOTION)
        {
            incoming.classList.remove("is-entering-right", "is-entering-left", "is-leaving-left", "is-leaving-right");
            incoming.classList.add("is-active");
            if (outgoing)
            {
                outgoing.classList.remove("is-active", "is-leaving-left", "is-leaving-right", "is-entering-left", "is-entering-right");
            }
            done();
            return;
        }

        // Start state: incoming enters from the right (forward) or left (back).
        incoming.classList.remove("is-active", "is-leaving-left", "is-leaving-right");
        incoming.classList.add(dir === "forward" ? "is-entering-right" : "is-entering-left");
        void incoming.offsetWidth; // flush start transform before transitioning

        let finished = false;
        const finish = () =>
        {
            if (finished) return;
            finished = true;
            incoming.removeEventListener("transitionend", onEnd);
            done();
        };

        /** @param {TransitionEvent} ev */
        const onEnd = (ev) =>
        {
            if (ev.propertyName !== "transform") return;
            finish();
        };

        requestAnimationFrame(() =>
        {
            incoming.classList.remove("is-entering-right", "is-entering-left");
            incoming.classList.add("is-active");
            if (outgoing)
            {
                outgoing.classList.remove("is-active");
                outgoing.classList.add(dir === "forward" ? "is-leaving-left" : "is-leaving-right");
            }
            incoming.addEventListener("transitionend", onEnd);
            setTimeout(finish, 400);
        });
    }

    /**
     * Push a new sub-page: build its panel, slide it in from the right over the
     * current layer, and morph the close button to a back arrow.
     * @param {Subpage} subpage
     */
    function pushSubpage(subpage)
    {
        const track = ensureSubpageTrack();
        const prevEl = /** @type {HTMLElement|null} */ (subpageStack.length
            ? track.lastElementChild
            : null);

        const panel = document.createElement("div");
        panel.className = "settings-subpage mps-scrollbar";
        subpage.render(panel);
        track.appendChild(panel);
        track.classList.add("is-active");

        subpageStack.push(subpage);
        updateCloseButtonGlyph();

        runSlide(panel, prevEl, "forward", () =>
        {
            if (prevEl) prevEl.classList.remove("is-leaving-left", "is-leaving-right");
        });
    }

    /** Pop the top sub-page, sliding it back out to the right. */
    function popSubpage()
    {
        if (!subpageTrack || subpageStack.length === 0) return;
        const track = subpageTrack;
        const topEl = /** @type {HTMLElement|null} */ (track.lastElementChild);
        subpageStack.pop();
        const belowEl = /** @type {HTMLElement|null} */ (
            subpageStack.length ? track.children[subpageStack.length - 1] : null
        );

        updateCloseButtonGlyph();

        if (belowEl)
        {
            runSlide(belowEl, topEl, "back", () =>
            {
                if (topEl) topEl.remove();
            });
        }
        else if (topEl)
        {
            // Last layer — slide it out to the right; the base content shows through.
            if (REDUCED_MOTION)
            {
                topEl.remove();
                track.classList.remove("is-active");
            }
            else
            {
                topEl.classList.remove("is-active");
                topEl.classList.add("is-leaving-right");
                let done = false;
                const cleanup = () =>
                {
                    if (done) return;
                    done = true;
                    topEl.removeEventListener("transitionend", onEnd);
                    topEl.remove();
                    if (subpageStack.length === 0) track.classList.remove("is-active");
                };
                /** @param {TransitionEvent} ev */
                const onEnd = (ev) =>
                {
                    if (ev.propertyName !== "transform") return;
                    cleanup();
                };
                topEl.addEventListener("transitionend", onEnd);
                setTimeout(cleanup, 400);
            }
        }
    }

    /** Pop every sub-page instantly (used when a left-rail tab is clicked). */
    function popAllSubpages()
    {
        if (!subpageTrack || subpageStack.length === 0) return;
        subpageStack.length = 0;
        subpageTrack.replaceChildren();
        subpageTrack.classList.remove("is-active");
        updateCloseButtonGlyph();
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

        // Row 3 — Personal Dictionary drill-in.
        const teRow3 = document.createElement("button");
        teRow3.type = "button";
        teRow3.className = "mps-row mps-row-drill";
        const teRow3Label = document.createElement("div");
        teRow3Label.className = "mps-row-label";
        const teT3 = document.createElement("div");
        teT3.className = "mps-row-title";
        teT3.textContent = t("mangaplay-studio.settings.textEditor.personalDictionaryTitle");
        const teH3 = document.createElement("div");
        teH3.className = "mps-row-help";
        teH3.textContent = t("mangaplay-studio.settings.textEditor.personalDictionaryHelp");
        teRow3Label.appendChild(teT3);
        teRow3Label.appendChild(teH3);
        const teChevron = document.createElement("span");
        teChevron.className = "mps-row-chevron";
        teChevron.insertAdjacentHTML("afterbegin", icon("chevron-right", { size: 16 }));
        teRow3.appendChild(teRow3Label);
        teRow3.appendChild(teChevron);
        teRow3.addEventListener("click", () => pushSubpage({ render: renderPersonalDictionary }));
        teCard.appendChild(teRow3);

        content.appendChild(teCard);
    }

    /**
     * Personal Dictionary sub-page — an add-row (input + button) above a
     * scrolling, case-insensitively-sorted list of words, each removable.
     * @param {HTMLElement} panelEl
     */
    function renderPersonalDictionary(panelEl)
    {
        panelEl.replaceChildren();

        const header = document.createElement("div");
        header.className = "settings-section-heading settings-subpage-heading";
        header.textContent = t("mangaplay-studio.settings.textEditor.personalDictionaryTitle");
        panelEl.appendChild(header);

        // ── Add-row: input + Add button ──
        const addRow = document.createElement("div");
        addRow.className = "pdict-add-row";

        const input = document.createElement("input");
        input.type = "text";
        input.className = "pdict-input";
        input.placeholder = t("mangaplay-studio.settings.textEditor.personalDictionaryAddPlaceholder");
        input.setAttribute("aria-label", t("mangaplay-studio.settings.textEditor.personalDictionaryAddPlaceholder"));
        input.autocomplete = "off";
        input.spellcheck = false;

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "mps-btn-primary pdict-add-btn";
        addBtn.textContent = t("mangaplay-studio.settings.textEditor.personalDictionaryAddButton");
        addBtn.disabled = true;

        input.addEventListener("input", () =>
        {
            addBtn.disabled = input.value.trim().length === 0;
        });

        const listWrap = document.createElement("div");
        listWrap.className = "pdict-list mps-scrollbar";

        /** Rebuild the word list (or empty note) in place. */
        function renderList()
        {
            listWrap.replaceChildren();
            const words = personalDictWords().slice().sort((a, b) =>
                a.localeCompare(b, undefined, { sensitivity: "base" }));

            if (words.length === 0)
            {
                const empty = document.createElement("div");
                empty.className = "pdict-empty";
                empty.textContent = t("mangaplay-studio.settings.textEditor.personalDictionaryEmpty");
                listWrap.appendChild(empty);
                return;
            }

            for (const word of words)
            {
                const row = document.createElement("div");
                row.className = "mps-row pdict-word-row";
                const label = document.createElement("div");
                label.className = "pdict-word";
                label.textContent = word;
                const del = document.createElement("button");
                del.type = "button";
                del.className = "pdict-remove";
                del.setAttribute("aria-label",
                    t("mangaplay-studio.settings.textEditor.personalDictionaryRemoveLabel", { word }));
                del.insertAdjacentHTML("afterbegin", icon("trash-2", { size: 15 }));
                del.addEventListener("click", async () =>
                {
                    del.disabled = true;
                    try { await removeFromPersonalDict(word); }
                    catch (e) { console.warn("[settings] removeFromPersonalDict failed:", e); }
                    renderList();
                });
                row.appendChild(label);
                row.appendChild(del);
                listWrap.appendChild(row);
            }
        }

        async function commitAdd()
        {
            const word = input.value.trim();
            if (word.length === 0) return;

            if (isPersonalDictWord(word))
            {
                showToast(t("mangaplay-studio.settings.textEditor.personalDictionaryDuplicate", { word }));
                input.select();
                return;
            }

            addBtn.disabled = true;
            try { await addToPersonalDict(word); }
            catch (e)
            {
                console.warn("[settings] addToPersonalDict failed:", e);
                addBtn.disabled = input.value.trim().length === 0;
                return;
            }
            input.value = "";
            addBtn.disabled = true;
            renderList();
            showToast(t("mangaplay-studio.settings.textEditor.personalDictionaryAdded", { word }));
            input.focus();
        }

        addBtn.addEventListener("click", commitAdd);
        input.addEventListener("keydown", (ev) =>
        {
            if (ev.key === "Enter")
            {
                ev.preventDefault();
                commitAdd();
            }
        });

        addRow.appendChild(input);
        addRow.appendChild(addBtn);
        panelEl.appendChild(addRow);
        panelEl.appendChild(listWrap);

        renderList();
        requestAnimationFrame(() => input.focus());
    }

    function renderSkins()
    {
        content.replaceChildren();

        if (entitlementsOff)
        {
            entitlementsOff();
            entitlementsOff = null;
        }
        entitlementsOff = onEntitlementsChanged(() => renderActiveTab());

        async function openPaywall()
        {
            const { openPaywallModal } = await import("../iap/paywall-modal.js");
            await openPaywallModal({ onEntitlementsChanged: (snap) => setEntitlements(snap) });
        }

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

        // Preview-swatch grid driven by listSkins() from the registry so
        // future marketplace-installed skins auto-appear without touching
        // this file. First-party ids resolve to a localised label; unknown
        // ids fall back to the manifest's displayName. Mini-mockup geometry
        // and palettes are ported from the native iOS swatch grid
        // (MPSSettingsView+Swatch.m miniaturePreviewForSkin: /
        // MPSSkinCatalog previewPaletteForSkin:).
        const SKIN_LABEL_KEY = {
            "default":   "mangaplay-studio.settings.skinDefault",
            "night":     "mangaplay-studio.settings.skinNight",
            "oragepad":  "mangaplay-studio.settings.skinOragepad",
            "cyberpunk": "mangaplay-studio.settings.skinCyberpunk",
            "academia":  "mangaplay-studio.settings.skinAcademia",
        };
        /** Hardcoded per-skin preview palette — intentionally NOT the live
         * CSS vars: each swatch previews its own skin's colors regardless
         * of the active skin. Mirrors iOS previewPaletteForSkin:. */
        const PREVIEW_PALETTE_FOR_SKIN = {
            "default":   { bg: "#f6f6f6", toolbar: "#ffffff", card: "#ffffff", line: "#007aff" },
            "night":     { bg: "#0e0e12", toolbar: "#17171d", card: "#1c1c24", line: "#5b8dff" },
            "oragepad":  { bg: "#2a1c0e", toolbar: "#3a2712", card: "#f3e2c2", line: "#d98a2b" },
            "cyberpunk": { bg: "#0d0a1f", toolbar: "#1a0f3a", card: "#160c2e", line: "#00e5ff" },
            "academia":  { bg: "#2b241a", toolbar: "#3a3020", card: "#e8dcc0", line: "#9c7a3c" },
        };
        const os = getPlatformKeyCached() || "windows";
        const grid = document.createElement("div");
        grid.className = "skin-swatch-grid";
        grid.setAttribute("role", "radiogroup");
        grid.setAttribute("aria-label", t("mangaplay-studio.settings.skin"));

        for (const manifest of listSkins())
        {
            const cat = SKIN_CATALOG[manifest.id];
            if (cat && !cat.platforms.includes(os)) continue;   // premium off its store → hidden
            if (!cat) console.debug("[settings] skin not in catalog, showing ungated:", manifest.id);

            const id = manifest.id;
            const p = PREVIEW_PALETTE_FOR_SKIN[id] || PREVIEW_PALETTE_FOR_SKIN["default"];
            const labelKey = SKIN_LABEL_KEY[id];
            const skinName = labelKey ? t(labelKey, manifest.displayName) : manifest.displayName;

            const cell = document.createElement("button");
            cell.type = "button";
            cell.className = "skin-swatch-cell";
            cell.dataset.skinId = id;
            cell.setAttribute("role", "radio");

            // Mini app mockup — bg fill, toolbar band, page card, 3 text bars.
            const art = document.createElement("div");
            art.className = "skin-swatch-art";
            art.style.background = p.bg;

            const toolbar = document.createElement("div");
            toolbar.className = "skin-swatch-toolbar";
            toolbar.style.background = p.toolbar;
            art.appendChild(toolbar);

            const pageCard = document.createElement("div");
            pageCard.className = "skin-swatch-page";
            pageCard.style.background = p.card;
            for (const width of ["70%", "90%", "50%"])
            {
                const bar = document.createElement("div");
                bar.className = "skin-swatch-bar";
                bar.style.background = p.line;
                bar.style.width = width;
                pageCard.appendChild(bar);
            }
            art.appendChild(pageCard);

            const badge = document.createElement("div");
            badge.className = "skin-swatch-check";
            badge.innerHTML = icon("check", { size: 12, strokeWidth: 3 });
            art.appendChild(badge);

            const name = document.createElement("div");
            name.className = "skin-swatch-name";
            name.textContent = skinName;

            cell.appendChild(art);
            cell.appendChild(name);
            cell.setAttribute("aria-label", skinName);

            const selected = state.skin === id;
            cell.classList.toggle("is-selected", selected);
            cell.setAttribute("aria-checked", selected ? "true" : "false");

            cell.addEventListener("click", () =>
            {
                if (id === state.skin) return;
                if (!isSkinUnlocked(id))   // unreachable on desktop; defensive
                {
                    openPaywall();
                    return;
                }
                for (const c of grid.children)
                {
                    const on = c.dataset.skinId === id;
                    c.classList.toggle("is-selected", on);
                    c.setAttribute("aria-checked", on ? "true" : "false");
                }
                debouncedWriteSkin(id);
            });

            grid.appendChild(cell);
        }

        row1.appendChild(row1Label);
        card1.appendChild(row1);
        card1.appendChild(grid);

        const isStore = (getPlatformKeyCached() === "android" || getPlatformKeyCached() === "ios");
        if (isStore)
        {
            const unlockBtn = document.createElement("button");
            unlockBtn.type = "button";
            unlockBtn.className = "mps-btn-secondary";
            unlockBtn.textContent = t("mangaplay-studio.settings.unlockSkins");
            unlockBtn.addEventListener("click", () => { openPaywall(); });
            card1.appendChild(unlockBtn);

            if (!hasPro())
            {
                const upgradeBtn = document.createElement("button");
                upgradeBtn.type = "button";
                upgradeBtn.className = "mps-btn-primary";
                upgradeBtn.textContent = t("mangaplay-studio.settings.upgradeTurbo");
                upgradeBtn.addEventListener("click", () => { openPaywall(); });
                card1.appendChild(upgradeBtn);
            }
        }

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

        // ── ADS OPT-IN (iOS only, non-entitled only) ─────────────
        if (getPlatformKeyCached() === "ios" && !areAdsDisabled())
        {
            const adsCard = document.createElement("div");
            adsCard.className = "settings-card";

            const adsRow = document.createElement("div");
            adsRow.className = "mps-row";

            const adsLabel = document.createElement("div");
            adsLabel.className = "mps-row-label";

            const adsTitle = document.createElement("div");
            adsTitle.className = "mps-row-title";
            adsTitle.textContent = t("mangaplay-studio.settings.account.adsOptIn");

            const adsHelp = document.createElement("div");
            adsHelp.className = "mps-row-help";

            const adsToggle = document.createElement("button");
            adsToggle.type = "button";
            adsToggle.className = "mps-toggle";
            adsToggle.setAttribute("role", "switch");
            adsToggle.setAttribute("aria-label", t("mangaplay-studio.settings.account.adsOptIn"));
            adsToggle.setAttribute("aria-checked", "false");
            adsHelp.textContent = t("mangaplay-studio.settings.account.adsOptInHelp");

            // Seed initial state from ATT status
            (async () =>
            {
                try
                {
                    const status = await invoke("plugin:mps-admob|admob_get_att_status");
                    const authorized = status === "authorized";
                    adsToggle.setAttribute("aria-checked", String(authorized));
                    if (status === "denied" || status === "restricted")
                    {
                        adsHelp.textContent = t("mangaplay-studio.settings.account.adsOptInDeniedHelp");
                    }
                }
                catch
                {
                    // Already seeded to false/help above
                }
            })();

            adsToggle.addEventListener("click", async () =>
            {
                const currentlyOn = adsToggle.getAttribute("aria-checked") === "true";
                if (currentlyOn)
                {
                    // Cannot revoke ATT programmatically — direct user to iOS Settings
                    adsHelp.textContent = t("mangaplay-studio.settings.account.adsOptInDeniedHelp");
                    return;
                }
                // Attempt to request ATT
                try
                {
                    const granted = await invoke("plugin:mps-admob|admob_request_att") === true;
                    adsToggle.setAttribute("aria-checked", String(granted));
                    if (!granted)
                    {
                        adsHelp.textContent = t("mangaplay-studio.settings.account.adsOptInDeniedHelp");
                    }
                    else
                    {
                        adsHelp.textContent = t("mangaplay-studio.settings.account.adsOptInHelp");
                    }
                }
                catch
                {
                    adsHelp.textContent = t("mangaplay-studio.settings.account.adsOptInDeniedHelp");
                }
            });

            adsLabel.appendChild(adsTitle);
            adsLabel.appendChild(adsHelp);
            adsRow.appendChild(adsLabel);
            adsRow.appendChild(adsToggle);
            adsCard.appendChild(adsRow);
            content.appendChild(adsCard);
        }
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
        updateCloseButtonGlyph();
        sidebarHeading.textContent = t("mangaplay-studio.settings.options");
        for (const tab of TABS)
        {
            const label = tabLabelEls.get(tab.id);
            if (label) label.textContent = t(tab.labelKey);
        }
    }

    function selectTab(id)
    {
        // Switching tabs while drilled-in returns to that tab's root but keeps
        // the modal open. The content pane is rebuilt below, so pop first.
        popAllSubpages();
        activeTab = id;
        for (const [tabId, btn] of entryEls)
        {
            btn.classList.toggle("selected", tabId === id);
        }
        if (isMobileLike())
        {
            const selected = entryEls.get(id);
            if (selected) selected.scrollIntoView({ inline: "nearest", block: "nearest" });
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
        if (entitlementsOff)
        {
            entitlementsOff();
            entitlementsOff = null;
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

    closeBtn.addEventListener("click", () =>
    {
        if (subpageStack.length > 0) popSubpage();
        else close();
    });
    backdrop.addEventListener("click", (ev) =>
    {
        if (ev.target === backdrop) close();
    });

    detachKeydown = (ev) =>
    {
        if (ev.key !== "Escape") return;
        if (subpageStack.length > 0) popSubpage();
        else close();
    };
    document.addEventListener("keydown", detachKeydown);

    detachI18n = subscribeI18n(() =>
    {
        // A language switch rebuilds the content pane, which would strand an
        // open sub-page; pop back to the tab root first so state stays sane.
        popAllSubpages();
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
