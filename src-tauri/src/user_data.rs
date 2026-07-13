// ── User data store: portable resolver + user-settings.json ──────────────
//
// Two-tier storage:
//   - Default: Tauri's `app_config_dir()` (~/.config on Linux, %APPDATA% on
//     Windows, ~/Library/Application Support on macOS).
//   - Portable: when a `portable` file sits next to the running executable
//     AND `<exe-dir>/userdata/` is writable, that wins. Windows + Linux
//     only — macOS short-circuits because Gatekeeper App Translocation +
//     bundle signature sealing make portable mode user-hostile there.
//
// Honours the test env var `MPS_USER_DATA_DIR` so integration tests can pin
// the resolver to a controlled tempdir without depending on the host OS.

use std::sync::Mutex;

pub mod paths;
pub mod settings;
pub mod version;

pub(crate) static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Packaged metadata baked into the binary at compile time. Read via
/// `include_str!` — NOT `BaseDirectory::Resource` — because Android returns
/// `asset://` URIs that `std::fs::read_to_string` cannot open.
pub(crate) const PACKAGED_APP_VERSION_INFO_JSON: &str =
    include_str!("../resources/app-version-info.json");
