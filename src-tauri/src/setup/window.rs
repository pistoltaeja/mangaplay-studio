use tauri::{WebviewUrl, webview::WebviewWindowBuilder};
use tauri::utils::config::Color;

use crate::app_settings_get_impl;

pub fn build_main_window(app: &tauri::App, ux_mode: &str) -> tauri::Result<()>
{
    // Create the main window from Rust so we can conditionally enable CDP.
    // tauri.conf.json's windows[] is intentionally empty — see notes in
    // tauri.conf.json.template.

    // disk-frontend feature flips the webview URL from the embedded
    // tauri:// scheme (custom-protocol) to our mpsdev:// scheme so the
    // frontend is read from disk at runtime. Release builds always
    // use WebviewUrl::App.
    #[cfg(feature = "disk-frontend")]
    let webview_url = WebviewUrl::External(
        url::Url::parse("mpsdev://localhost/index.html")
            .expect("static mpsdev URL parse")
    );
    #[cfg(not(feature = "disk-frontend"))]
    let webview_url = WebviewUrl::App("index.html".into());

    // Resolve target rect via the shared source-of-truth. Same resolver is
    // called from the native Win32 splash BEFORE Tauri init — both paths
    // land on identical logical/physical rects so the splash → shell
    // handoff has no size/position pop. See src/setup/geometry.rs.
    let g = crate::setup::geometry::WindowGeometry::resolve(Some(&app.handle()), ux_mode);

    // disable_drag_drop_handler: Tauri 2 on Windows registers an OS-level
    // IDropTarget on the WebView2 HWND by default. That IDropTarget
    // intercepts intra-window HTML5 drags initiated inside the page —
    // stripping custom MIME types and aborting the renderer-side drag
    // before `drop` fires. The app does not consume OS file-drops
    // anywhere, so disabling the Tauri handler restores native
    // in-page HTML5 DnD (used by the file explorer to move files).
    // Inject the resolved UX mode + loading-shell boot strings as window
    // globals before any JS module evaluates. First use of
    // initialization_script in this codebase; the JS-side fallback guards
    // in src/index.html cover the case where Tauri's injection ordering
    // doesn't fire it first on a future platform.
    //
    // Boot strings — read the user's `defaultLanguage` from
    // user-settings.json and pick the pre-extracted boot dict for that
    // locale (baked into the binary via include_str! — see
    // setup/boot_strings.rs). Falls back to English on any error. This
    // lets the loading shell paint localised captions BEFORE app.js
    // parses (previously stuck in English for the first ~30ms of boot).
    let boot_language = super::boot_strings::resolve_boot_language(&app.handle());
    let boot_strings_json = super::boot_strings::boot_strings_for(&boot_language);
    // Resolve the persisted skin from settings.json so the inline
    // stamper in index.html can rewrite the active-skin <link> +
    // boot-splash <img> before any JS parses — eliminates the
    // one-frame Default flicker on every Night-user boot. Falls
    // back to "default" on any error.
    let last_skin = super::last_skin::resolve_last_skin(&app.handle());
    // Debug-only: MPS_PAUSE_AFTER_LOADING=1 freezes the app at the LOADING→next
    // transition seam so the splash-flash frame can be visually inspected.
    // JS side (boot/state-machine.js) checks window.__MPS_PAUSE_AFTER_LOADING
    // and halts before dismissing the splash / unhiding chrome.
    let pause_after_loading = std::env::var("MPS_PAUSE_AFTER_LOADING")
        .map(|v| !v.is_empty() && v != "0" && v.to_lowercase() != "false")
        .unwrap_or(false);
    // Debug-only: MPS_HIDE_HTML_BOOT_SCREEN=1 tells the inline boot IIFE
    // to hide #boot-screen entirely so the raw WebView background_color
    // (see .background_color() below) is visible. Lets the user tell
    // apart a WebView-first-frame white flash from a boot-screen issue.
    let hide_html_boot_screen = std::env::var("MPS_HIDE_HTML_BOOT_SCREEN")
        .map(|v| !v.is_empty() && v != "0" && v.to_lowercase() != "false")
        .unwrap_or(false);
    let init_script = format!(
        "window.__MPS_UX_MODE__ = {};\nwindow.__MPS_BOOT_LANG__ = {};\nwindow.__MPS_BOOT_STRINGS__ = {};\nwindow.__MPS_LAST_SKIN__ = {};\nwindow.__MPS_PAUSE_AFTER_LOADING = {};\nwindow.__MPS_HIDE_HTML_BOOT_SCREEN = {};",
        serde_json::to_string(ux_mode).unwrap_or_else(|_| "\"standalone\"".into()),
        serde_json::to_string(&boot_language).unwrap_or_else(|_| "\"en\"".into()),
        boot_strings_json,
        serde_json::to_string(&last_skin).unwrap_or_else(|_| "\"default\"".into()),
        if pause_after_loading { "true" } else { "false" },
        if hide_html_boot_screen { "true" } else { "false" },
    );
    log::debug!("[app_lib] Boot: initialization_script prepared ({} bytes, lang={})", init_script.len(), boot_language);

    #[allow(unused_mut)]
    let mut win_builder = WebviewWindowBuilder::new(
        app,
        "main",
        webview_url,
    )
        .title("Mangaplay Studio")
        // Match the Rust native splash + inline #boot-screen bg exactly.
        // Without this Tauri defaults to white, so the Rust-splash → WebView
        // handoff flashes white for one frame before the HTML parses. Value
        // mirrors --mps-splash-bg (#1a1a1a) — see icons/brand-colors.json.
        .background_color(Color(0x1a, 0x1a, 0x1a, 0xff))
        .initialization_script(&init_script);

    // Desktop: set explicit window size from the geometry resolver.
    // iOS/Android: the WebView fills the full screen — calling inner_size()
    // forces WKWebView to render at that logical size (e.g. 720×1280)
    // instead of the device's native viewport (e.g. 393×852 on iPhone 14),
    // making everything appear scaled down and mis-positioned.
    #[cfg(desktop)]
    {
        win_builder = win_builder.inner_size(g.logical_width, g.logical_height);
    }

    // Desktop-only geometry knobs. min_inner_size + resizable +
    // decorations + fullscreen + maximized + disable_drag_drop_handler
    // are unavailable on Android — gate them behind #[cfg(desktop)].
    #[cfg(desktop)]
    {
        // macOS draws its own traffic-light chrome when decorations
        // are enabled; Windows/Linux still use the hand-rolled buttons
        // wired in window-controls.js.
        let use_native_decorations = cfg!(target_os = "macos");
        win_builder = win_builder
            // OS-level minimum. Below this the three workspace panes
            // (left explorer + editor + storyboard) cannot all hold
            // their own minimums, and the canvas page collapses. The
            // numbers mirror LEFT_PANE_MIN + STORYBOARD_MIN + EDITOR_MIN
            // in src/shell-restore.js plus ~80px of chrome. Mobile and
            // tablet override these with their fixed per-mode minima.
            .min_inner_size(g.min_logical_width, g.min_logical_height)
            .resizable(g.resizable)
            .decorations(use_native_decorations)
            .fullscreen(false)
            // Hide the main window until the loading shell paints its
            // first frame — the shell fires the `shell_ready` IPC
            // (see commands::lifecycle) which calls window.show().
            // Without this the user sees a white / blank window flash
            // for the ~500-1000ms of WebView2 warmup before the HTML
            // parses. The watchdog below force-shows after 2s in case
            // shell_ready never fires (JS crash mid-boot).
            .visible(false)
            .disable_drag_drop_handler();

        if ux_mode == "standalone"
        {
            if g.maximized
            {
                // tauri#14068: combining .position() with .maximized(true)
                // causes a visible flicker at first paint. When maximized,
                // let Tauri place the window and just flag it maximized.
                win_builder = win_builder.maximized(true);
            }
            else
            {
                // Explicit position — Wry otherwise passes CW_USEDEFAULT
                // and the OS cascades the window off-center.
                win_builder = win_builder.position(g.logical_x, g.logical_y);
            }
        }
        else
        {
            // Mobile / tablet — fixed size, explicitly positioned so the
            // splash rect (resolved via the same geometry module) matches
            // the shell rect at handoff.
            win_builder = win_builder.position(g.logical_x, g.logical_y);
        }
    }

    // HW-accel from settings: if disabled, append --disable-gpu.
    // Honour MPS_SETTINGS_DIR override so tests can pin the boot-time
    // hardwareAcceleration read to a controlled tempdir.
    #[allow(unused_variables)]
    let hw_accel_enabled = {
        let dir = crate::commands::settings::resolve_settings_dir(&app.handle()).ok();
        if let Some(d) = dir {
            match app_settings_get_impl(&d, ux_mode) {
                Ok(v) => v.get("hardwareAcceleration")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(true),
                Err(_) => true,
            }
        } else { true }
    };

    // CDP gate: when MPS_CDP_PORT env is set, inject --remote-debugging-port
    // into the WebView2 browser args at window-creation time. This is the
    // only Tauri 2 path that actually enables CDP on Windows. Production
    // builds with no env var set get no CDP exposure.
    //
    // Same args string also carries --disable-gpu when the user has
    // turned off Hardware Acceleration in Settings.
    #[cfg(target_os = "windows")]
    {
        // Setting `additional_browser_args` REPLACES Wry's defaults
        // (which include `--disable-features=msWebOOUI,msPdfOOUI,
        // msSmartScreenProtection`). Re-include them in every code
        // path that overrides, plus a handful of hardening flags
        // (Translate, AutofillServerCommunication, BackForwardCache
        // disabled; pinch + background networking off). Composed
        // here so the CDP path AND the HW-accel-off path both
        // inherit the full set.
        let base_args = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,AutofillServerCommunication,Translate,BackForwardCache --disable-pinch --disable-background-networking";
        let mut extras = String::new();
        let mut want_override = false;
        if let Ok(port) = std::env::var("MPS_CDP_PORT") {
            if !port.is_empty() {
                // Config matches Haprog/tauri-cdp's proven-working
                // setup: disabling Edge OOUI/SmartScreen features
                // (already in base_args) is what lets Playwright's
                // connectOverCDP() actually upgrade the WebSocket.
                // Without it the HTTP CDP endpoints respond but WS
                // upgrades silently hang.
                extras.push_str(&format!("--remote-debugging-port={}", port));
                want_override = true;
            }
        }
        if !hw_accel_enabled {
            if !extras.is_empty() { extras.push(' '); }
            extras.push_str("--disable-gpu");
            want_override = true;
        }
        if want_override {
            let composed = format!("{} {}", base_args, extras);
            log::info!("WebView2 args: {}", composed);
            win_builder = win_builder.additional_browser_args(&composed);
        }
    }

    let _main_window = win_builder.build()?;
    log::debug!("[app_lib] Boot: WebviewWindowBuilder.build() succeeded");

    // Watchdog — if the loading shell never fires `shell_ready` (JS crash
    // mid-boot before the inline boot script runs, or an uncaught error
    // during initialization_script injection), force-show the window after
    // 2s so the user isn't left staring at a taskbar entry that never
    // opens. Safe against double-show because show() is idempotent.
    // Desktop-only — Android manages window visibility via its own
    // Activity lifecycle.
    #[cfg(desktop)]
    {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(2000));
            use tauri::Manager;
            if let Some(win) = handle.get_webview_window("main") {
                if !win.is_visible().unwrap_or(true) {
                    let _ = win.show();
                    let _ = win.set_focus();
                    log::warn!("[boot] shell_ready watchdog fired — force-showing main window");
                    // Also close the native splash — if the main window
                    // is still hidden 2s in, shell_ready never fired and
                    // the splash would otherwise linger until its own 5s
                    // hard timeout. Close it now so splash + main-window
                    // reveal happen in the same second.
                    if let Some(state) = handle.try_state::<crate::commands::lifecycle::SplashState>() {
                        if let Ok(guard) = state.handle.lock() {
                            if let Some(h) = guard.as_ref() {
                                h.close_async();
                            }
                        }
                    }
                }
            }
        });
    }

    // Non-desktop boot marker — logs at the 5s mark so the developer can see
    // how far into the boot sequence the app is. Not a failure indicator;
    // shell_ready may have already fired by this point.
    #[cfg(not(desktop))]
    {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(5000));
            log::debug!("[boot] 5s boot marker. If the app is still on the splash screen, JS may not have loaded.");
        });
    }

    Ok(())
}
