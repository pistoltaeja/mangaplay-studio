// Lint posture: every `unsafe` block warns by default. The two intentional
// `env::set_var` sites in `detect_other_instance_and_set_flag` carry
// `#[allow(unsafe_code)]` with a SAFETY justification. The `platform::win32::shift_is_held`
// Windows FFI also carries `#[allow(unsafe_code)]` (single low-risk call,
// not worth pulling `windows-sys` for). Any NEW unsafe introduced without an
// explicit allow + comment will trigger a build warning.
#![warn(unsafe_code)]
// Force any unsafe op inside an unsafe fn to be wrapped in its own `unsafe`
// block. Catches drift where a contributor adds a second unsafe op next to
// an existing one without realising it's also unsafe.
#![deny(unsafe_op_in_unsafe_fn)]

pub mod art_map;
pub mod boot;
pub mod commands;
pub mod fs_helpers;
pub mod fs_watch;
pub mod locks;
pub mod pending_pick;
pub mod platform;
pub mod project_root;
pub mod registry;
pub mod script_map;
pub mod setup;
pub mod slides_links;
#[cfg(desktop)]
pub mod storyboard_uri;

pub mod user_data;
pub mod util;
pub mod validate_basename;

// Re-exports so integration tests (which link `app_lib` as a sibling crate)
// keep their pre-extraction import paths working.
pub use art_map::{
    art_map_drop,
    art_map_drop_prefix,
    art_map_find_script_by_uuid,
    art_map_get,
    art_map_rewrite_prefix,
    art_map_set,
    mint_script_uuid,
    read_all_scripts,
    resolve_art_path,
};
pub use boot::{UxModeState, resolve_ux_mode_with_source};
pub use commands::app_info::{app_delete_project_impl, app_remove_recent_impl, app_update_recent_impl};
pub use commands::auth::{auth_callback_page_html, auth_success_page_html};
pub use commands::auto_flatten::flatten_project_layout_impl;
pub use commands::registry_cmds::{
    DeleteMode as RegistryDeleteMode,
    ReadResult as RegistryReadResult,
    RevResult as RegistryRevResult,
    registry_atomic_write_impl_fn,
    registry_copy_impl,
    registry_create_file_impl,
    registry_delete_impl,
    registry_list_art_impl,
    registry_list_scripts_impl,
    registry_move_impl,
    registry_read_file_impl,
    registry_rename_impl,
    registry_write_bytes_impl,
};
pub use commands::file_ops::crud::{
    create_file_impl,
    rename_file_impl,
};
pub use commands::file_ops::fs_events::{
    FsChange, FsChangedPayload, RegistryFsChange, RegistryFsChangedPayload,
    path_eq_caseless, resolve_path_to_registry_change,
};
pub use commands::file_ops::trash::{
    copy_file_impl,
    delete_file_force_impl,
    delete_file_impl,
    force_delete_impl,
};
pub use commands::mangaart::{
    mangaart_erase_impl, mangaart_load_by_uuid_impl, mangaart_load_impl,
    mangaart_resolve_by_folder_uuid_impl, mangaart_resolve_by_uuid_impl,
    mangaart_resolve_path_impl, mangaart_scaffold_by_uuid_impl,
    mangaart_scaffold_impl, mangaart_sweep_empty_impl,
};
pub use commands::script_map::{scriptmap_get_or_mint_impl, ScriptMapMintResult};
pub use commands::project::{
    is_script_filename,
    list_project_scripts_impl,
    list_project_tree_impl,
    project_create_new_impl,
};
pub use commands::project_mutations::{
    move_path_impl,
    move_path_with_art,
    read_project_json,
    write_project_json,
};
pub use commands::publish_log::{next_free_publish_log_number, publish_log_append_impl, publish_log_load_impl};
pub use fs_helpers::{atomic_write_impl, chrono_iso_now};
pub use commands::recent::{update_recent_field_impl, update_recent_path_impl};
pub use commands::settings::{app_settings_get_impl, app_settings_set_impl};
pub use fs_watch::FsWatcher;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use fs_watch::{fs_watcher_is_watched_ext, fs_watcher_should_ignore, map_notify_event};
pub use locks::ProjectJsonLocks;
pub use project_root::{ProjectRoot, assert_within_project_root};
pub use registry::{
    FsErr,
    LoadErr as RegistryLoadErr,
    LoadedRegistry,
    NativeId,
    ProjectRegistryState,
    RegistryEntry,
    RegistryStateErr,
    RegistryFile,
    SaveErr as RegistrySaveErr,
    TreeEntryDto,
    fold_artmap_into_registry,
    load_from_disk as registry_load_from_disk,
    locate_by_native_id,
    read_native_id,
    resolve_and_open,
    save_atomic as registry_save_atomic,
    scan_and_reconcile,
};
pub use script_map::{
    script_map_drop,
    script_map_drop_prefix,
    script_map_get,
    script_map_get_or_mint,
    script_map_get_with_legacy_pullforward,
    script_map_rewrite_key,
    script_map_rewrite_prefix,
    script_map_set,
};
pub(crate) use user_data::PACKAGED_APP_VERSION_INFO_JSON;
pub(crate) use user_data::SETTINGS_WRITE_LOCK;
pub use user_data::paths::{resolve_user_data_dir, resolve_user_data_dir_for_exe};
pub use user_data::settings::{
    apply_last_project_path_guard,
    drop_project_session_impl,
    user_settings_load_impl,
    user_settings_save_impl,
};
pub use user_data::version::{
    user_data_apply_rung_impl,
    user_data_ensure_version_impl,
    user_data_record_failure_impl,
    user_data_skip_rung_impl,
};

use tauri::Emitter;
use tauri::Listener;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First action: spawn the native splash. This runs before ANY Tauri
    // work so the user sees the branded splash within ~50ms — Tauri init
    // + WebView2 warmup take 500-2000ms on Windows cold-boot, and we
    // don't want a taskbar-highlighted-but-invisible window during that
    // window.
    //
    // Non-Windows targets get a no-op handle. The splash is closed by
    // either (a) the shell_ready IPC command when the loading shell paints
    // its first frame, or (b) a 5s hard timeout inside the splash thread
    // itself. Watchdog in setup/window.rs also flips the flag if
    // shell_ready never arrives.
    let splash_handle = crate::setup::native_splash::show();

    // Multi-instance support. Each launch checks a runtime lockfile in the
    // app data dir: if another instance is alive, this launch sets a flag
    // that the JS bootstrap reads via app_should_auto_resume() to FORCE the
    // picker (so the new window opens with the project chooser instead of
    // racing the existing window on the same recent project). Both windows
    // coexist freely; no plugin gate, no focus hijack.
    crate::commands::auto_resume::detect_other_instance_and_set_flag();

    // Resolve UX mode once at the very top so the entire builder chain +
    // setup() see the same value. This runs BEFORE tauri-plugin-log is
    // registered inside .setup(), so we can't `log::info!` here — capture
    // the mode + source now, log both once the plugin is online.
    let (ux_mode, ux_mode_source) = resolve_ux_mode_with_source();

    // Plugin registration is now target-agnostic — opener + deep-link ship
    // on Android + iOS as of v2.5 / v2.4 respectively (see Cargo.toml notes).
    // Keeping the two plugins registered on every target means the Rust
    // command layer (picker_open + on_open_url) does not need `#[cfg]`
    // gates around them.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_mps_firebase::init())
        .plugin(tauri_plugin_mps_admob::init())
        .plugin(tauri_plugin_mps_ios_webview::init())
        .plugin(tauri_plugin_iap::init());
    // tauri-plugin-http — desktop-only. Bypasses WebView CORS/CSP for the
    // Slides CDN image fetch (see slides-prepare.js::commitSlidesSync).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_http::init());
    log::debug!("[app_lib] Boot: plugins registered");

    // Windows window chrome (min / max / close) is now drawn by the frontend
    // — see src/window-controls.js. That replaces tauri-plugin-frame so the
    // CSP can drop 'unsafe-eval' (the plugin injected its buttons via
    // webview.eval() at page-load, which CSP gated). Every desktop platform
    // already runs decorations(false) below, so the hand-rolled buttons are
    // the only chrome the user sees.

    // Dev-only: register the `mpsdev://` URI scheme that streams frontend
    // files from disk. Lets the .exe pick up JS/CSS changes WITHOUT relinking
    // (huge win for CDP smoke iteration). NEVER compiled into release builds.
    //
    // Default frontend root is `build/mangaplay-studio/frontend/` resolved
    // relative to the .exe's parent. Override via env MPS_FRONTEND_DIR for
    // tests that want a controlled root.
    #[cfg(feature = "disk-frontend")]
    let builder = builder.register_uri_scheme_protocol("mpsdev", crate::boot::dev_uri::disk_frontend_handler);

    // `mps-storyboard://` — custom scheme owned by Rust. Streams cached
    // Slides PNGs from `<projectRoot>/_mangaplaystudio/storyboard/...`
    // after resolving projectId → projectRoot via the in-process registry.
    // Desktop-only — uses tokio::fs which is not available on mobile.
    // See src/storyboard_uri/ for the parser, security model, and handler.
    #[cfg(desktop)]
    let builder = builder.register_asynchronous_uri_scheme_protocol(
        "mps-storyboard",
        crate::storyboard_uri::scheme::handle,
    );

    // Updater plugin is gated behind the `updater` Cargo feature.
    // Loading it with the current "PLACEHOLDER" pubkey would panic at first
    // check. Re-enable by building with `--features updater` once
    // Signing-Procurement-Plan.md is complete.
    #[cfg(feature = "updater")]
    let builder = {
        use tauri_plugin_updater::Builder as UpdaterBuilder;
        builder.plugin(UpdaterBuilder::new().build())
    };

    let ux_mode_for_state = ux_mode.clone();
    // Splash handle wrapped in `SplashState` (Mutex<Option<>> plus the
    // shell_ready / shell_composited timestamps needed to gate the
    // fade-out on `max(shell_ready + 500ms, shell_composited)`). The
    // handle is kept alive here; the thread self-cleans and exits.
    let splash_state = crate::commands::lifecycle::SplashState::new(splash_handle);
    builder
        .manage(FsWatcher::new())
        .manage(ProjectJsonLocks::new())
        .manage(ProjectRoot::new())
        .manage(ProjectRegistryState::new())
        .manage(UxModeState(ux_mode_for_state))
        .manage(splash_state)
        .setup(move |app| {
            crate::setup::window::build_main_window(app, &ux_mode)?;
            log::debug!("[app_lib] Boot: main window built successfully");

            // Window chrome (min / max / close) is drawn by the frontend in
            // standalone mode — see src/window-controls.js. Mobile + tablet
            // remain frameless. Nothing to do here.

            // Test server: when MPS_TEST_PORT is set, spin up a lightweight HTTP
            // server that proxies eval/screenshot/input requests into the webview.
            // This is the macOS equivalent of the MPS_CDP_PORT → WebView2 CDP path
            // on Windows. Production builds never set this env var.
            if let Ok(test_port_str) = std::env::var("MPS_TEST_PORT") {
                if let Ok(test_port) = test_port_str.parse::<u16>() {
                    crate::commands::test_driver::start_test_server(test_port, app.handle().clone());
                }
            }

            // Logs live in app_log_dir — Windows: %LOCALAPPDATA%\<identifier>\logs.
            // Local (not Roaming) is the Windows convention for logs: they don't
            // sync between machines, can grow large without bloating the user's
            // roaming profile, and match what tauri-plugin-log's default
            // TargetKind::LogDir resolves to. The crash-log panic hook and the
            // plugin both write here so triagers have one folder to look in.
            let log_dir = app.path().app_log_dir().unwrap_or_else(|_| {
                app.path().app_data_dir().unwrap_or_default().join("logs")
            });
            std::fs::create_dir_all(&log_dir).ok();

            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .targets([
                        tauri_plugin_log::Target::new(
                            tauri_plugin_log::TargetKind::LogDir {
                                file_name: Some("app".into()),
                            },
                        ),
                        tauri_plugin_log::Target::new(
                            tauri_plugin_log::TargetKind::Stdout,
                        ),
                    ])
                    .build(),
            )?;

            // Self-documenting first-line: any future user wondering where
            // logs live can boot once and read this line. Path goes to
            // stdout AND app.log (same line, both targets).
            log::info!("Mangaplay Studio booting — logs at {}", log_dir.display());
            log::info!("Boot: log plugin initialized, level={:?}", log_level);
            log::info!(
                "Boot: UX mode = {} (source: {})",
                ux_mode,
                ux_mode_source.as_str()
            );

            // Durable pending-pick resurrection (`android-prereq-durable-pending`).
            // MUST run BEFORE the deep-link listener is installed so that
            // a queued `mangaplay://picker-callback` intent from a
            // pre-kill session lands on the resurrected sender rather
            // than being emitted as a plain `app:deep-link` event that
            // no JS listener is ready for yet. Desktop is a no-op when
            // no file exists.
            match crate::pending_pick::load_if_fresh(app.handle())
            {
                Ok(Some(entry)) =>
                {
                    log::info!(
                        "Pending pick found — event={} age={}s",
                        entry.event_name,
                        entry.age_secs()
                    );
                    crate::commands::picker::register_resurrected_pending(
                        app.handle(),
                        entry,
                    );
                }
                Ok(None) => {}
                Err(e) =>
                {
                    log::warn!("pending-pick load failed: {}", e);
                }
            }

            // Handle deep links (mangaplay://...). Ungated per
            // `android-prereq-deeplink-ungate` — the deep-link plugin's
            // emit path works identically on Android/iOS/desktop.
            //
            // Picker callbacks (`mangaplay://picker-callback?...`) are
            // dispatched to the picker's pending-sender registry so a
            // live `picker_open` awaiter completes. All other
            // `mangaplay://` URLs are forwarded as `app:deep-link` for
            // the JS-side auth / router.
            {
                let handle = app.handle().clone();
                app.listen("deep-link://new-url", move |event| {
                    let url = event.payload();
                    log::info!("Deep link received: {}", url);
                    // Payload arrives JSON-encoded (a quoted string) —
                    // strip the outer quotes so `contains` matches the
                    // raw URL. Belt-and-braces: try both shapes.
                    let trimmed = url.trim_matches('"');
                    if trimmed.starts_with("mangaplay://picker-callback")
                    {
                        crate::commands::picker::handle_deep_link_callback(
                            trimmed,
                        );
                        return;
                    }
                    let _ = handle.emit("app:deep-link", url);
                });
            }

            // Crash logging
            let crash_log_dir = log_dir.clone();
            std::panic::set_hook(Box::new(move |info| {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let crash_msg = format!("CRASH {} - {}\n", ts, info);
                let crash_path = crash_log_dir.join(format!("crash-{}.log", ts));
                std::fs::write(&crash_path, &crash_msg).ok();
                eprintln!("{}", crash_msg);
            }));

            Ok(())
        })
        // Grouped by subsystem for readability. `generate_handler!` order
        // is irrelevant to dispatch — regrouping is cosmetic only.
        .invoke_handler(tauri::generate_handler![
            // ── Lifecycle / boot ─────────────────────────────────────────
            crate::commands::lifecycle::shell_ready,
            crate::commands::lifecycle::shell_composited,
            crate::commands::console_capture::app_log_message,
            crate::commands::auto_resume::app_should_auto_resume,
            crate::commands::onboarding::app_should_force_onboarding,
            crate::commands::window_theme::set_window_theme,
            crate::commands::reveal::app_reveal_in_explorer,
            crate::commands::test_driver::test_eval_result,
            // ── App info / recent ────────────────────────────────────────
            crate::commands::app_info::app_platform,
            crate::commands::app_info::app_version_info,
            crate::commands::app_info::app_recent,
            crate::commands::app_info::app_update_recent,
            crate::commands::app_info::app_remove_recent,
            crate::commands::app_info::app_delete_project,
            // ── Settings ─────────────────────────────────────────────────
            crate::commands::settings::app_settings_get,
            crate::commands::settings::app_settings_set,
            // ── Auth ─────────────────────────────────────────────────────
            crate::commands::auth::auth_abort_loopback,
            crate::commands::auth::auth_listen_loopback,
            crate::commands::auth::auth_open_browser,
            crate::commands::auth::auth_raise_window,
            crate::commands::auth::auth_token_store_clear,
            crate::commands::auth::auth_token_store_get,
            crate::commands::auth::auth_token_store_set,
            // ── Picker ───────────────────────────────────────────────────
            crate::commands::picker::picker_open,
            // ── User data ────────────────────────────────────────────────
            crate::user_data::settings::path_exists,
            crate::user_data::settings::user_data_dir,
            crate::user_data::settings::user_settings_load,
            crate::user_data::settings::user_settings_save,
            crate::user_data::version::user_data_apply_rung,
            crate::user_data::version::user_data_ensure_version,
            crate::user_data::version::user_data_record_failure,
            crate::user_data::version::user_data_skip_rung,
            // ── Slides (R1) ──────────────────────────────────────────────
            crate::commands::slides_cache::slides_deck_stat,
            crate::commands::slides_cache::slides_deck_write,
            crate::commands::slides_cache::slides_deck_gc,
            crate::commands::slides_cache::slides_deck_delete,
            crate::commands::slides_image_fetch::slides_image_fetch,
            crate::commands::slides_link::slides_link_get,
            crate::commands::slides_link::slides_link_save,
            crate::commands::slides_link::slides_link_drop,
            crate::commands::slides_link::slides_link_drop_scoped,
            crate::commands::slides_lock::slides_publish_lock_acquire,
            crate::commands::slides_lock::slides_publish_lock_release,
            crate::commands::slides_lock::slides_publish_lock_heartbeat,
            crate::commands::slides_upload::slides_upload_images,
            crate::commands::storyboard_import::storyboard_import_local,
            crate::commands::storyboard_import::storyboard_list_png_files,
            crate::commands::publish_log::publish_log_append,
            crate::commands::publish_log::publish_log_load,
            // ── Registry / file ops (R2) ─────────────────────────────────
            crate::commands::file_ops::crud::app_save_file_dialog,
            crate::commands::file_ops::crud::app_open_file_dialog,
            crate::commands::file_ops::crud::app_open_files_dialog,
            crate::commands::file_ops::crud::app_read_file_bytes,
            crate::commands::file_ops::crud::app_write_bytes,
            crate::fs_watch::fs_watch_add_subdir,
            crate::fs_watch::fs_watch_remove_subdir,
            crate::fs_watch::fs_watch_start,
            crate::fs_watch::fs_watch_stop,
            crate::commands::registry_cmds::registry_list_tree,
            crate::commands::registry_cmds::registry_read_file,
            crate::commands::registry_cmds::registry_list_scripts,
            crate::commands::registry_cmds::registry_list_art,
            crate::commands::registry_cmds::registry_write_bytes,
            crate::commands::registry_cmds::registry_atomic_write,
            crate::commands::registry_cmds::registry_create_file,
            crate::commands::registry_cmds::registry_rename,
            crate::commands::registry_cmds::registry_move,
            crate::commands::registry_cmds::registry_delete,
            crate::commands::registry_cmds::registry_delete_force,
            crate::commands::registry_cmds::registry_copy,
            // ── Project / mangaart (R3) ──────────────────────────────────
            crate::commands::project::project_create_new,
            crate::commands::project::project_open,
            crate::commands::project::project_pick_folder,
            crate::commands::project::read_project_file,
            crate::commands::project::atomic_write_project_file,
            crate::commands::project::app_internal_remove_project_file,
            crate::commands::project::app_internal_remove_empty_project_dir,
            crate::commands::project::list_project_art,
            crate::commands::project::list_project_scripts,
            crate::commands::project_mutations::app_move_folder,
            crate::commands::project_mutations::app_rename_folder,
            crate::commands::project_mutations::app_rename_project,
            crate::commands::script_map::scriptmap_get_or_mint,
            crate::commands::mangaart::mangaart_resolve_path,
            crate::commands::mangaart::mangaart_resolve_by_uuid,
            crate::commands::mangaart::mangaart_resolve_by_folder_uuid,
            crate::commands::mangaart::mangaart_scaffold,
            crate::commands::mangaart::mangaart_scaffold_by_uuid,
            crate::commands::mangaart::mangaart_load,
            crate::commands::mangaart::mangaart_load_by_uuid,
            crate::commands::mangaart::mangaart_sweep_empty,
            crate::commands::mangaart::mangaart_erase,
            // ── System fonts ──────────────────────────────────────────────────
            // Mobile stubs return an error string; fontdb links on desktop only.
            crate::commands::fonts::fonts_list_families,
            crate::commands::fonts::fonts_resolve_family,
        ])
        // No on_window_event close handler — the JS side handles the
        // CloseRequested cycle via getCurrentWindow().onCloseRequested(),
        // calls evt.preventDefault() to hold the close, flushes pending
        // saves, then calls window.destroy() to exit. That avoids the
        // global-listen-vs-per-window-event problem in Tauri 2 release
        // builds (tauri-apps/tauri Discussion #5334).
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

