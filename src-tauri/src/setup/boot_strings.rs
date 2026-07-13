//! Boot-strings injector — bakes the `mangaplay-studio.boot` block from
//! every localisation/<lang>.json into the binary at compile time and picks
//! the right one at runtime.
//!
//! The loading shell in `src/index.html` paints BEFORE app.js loads
//! translations. Without this injection the initial `#boot-caption`
//! ("Loading…") and the 15-second-watchdog fallback ("Took longer than
//! expected.") would only ever appear in English.
//!
//! `scripts/extract-boot-strings.js` writes `resources/boot-strings.json`
//! by extracting `mangaplay-studio.boot` from each locale. That file
//! ships inside the binary via `include_str!` — ~12 KB across 14 locales,
//! zero runtime file I/O.
//!
//! Runtime cost: one JSON parse on cold start + one HashMap lookup. Both
//! at boot only, before the WebView is created.

const BOOT_STRINGS_JSON: &str = include_str!("../../resources/boot-strings.json");

/// Return a JSON-encoded string representing the boot dict for `lang`,
/// suitable for injecting via `initialization_script` as
/// `window.__MPS_BOOT_STRINGS__ = {...};`.
///
/// Falls back to English if the requested locale is missing or invalid.
/// Never panics — a corrupted resource JSON at compile-time is a build
/// error; at runtime we return the empty-object stub `"{}"` so the JS
/// side's own guards (`window.__MPS_BOOT_STRINGS__ ?? {}`) hold.
pub fn boot_strings_for(lang: &str) -> String
{
    let parsed: serde_json::Value = match serde_json::from_str(BOOT_STRINGS_JSON)
    {
        Ok(v) => v,
        Err(e) => {
            log::warn!("boot-strings resource JSON parse failed: {}", e);
            return "{}".to_string();
        }
    };

    // Pick language, fall through to English if missing.
    let dict = parsed.get(lang)
        .or_else(|| parsed.get("en"))
        .cloned()
        .unwrap_or(serde_json::json!({}));

    serde_json::to_string(&dict).unwrap_or_else(|_| "{}".to_string())
}

/// Read `defaultLanguage` from `user-settings.json` at the resolved user-data
/// dir, without going through the full `user_settings_load` command surface
/// (which needs an AppHandle in more places than we want to touch here).
///
/// Returns `"en"` on any error — first-boot users, corrupted settings,
/// tests without a user-data dir, etc. The invariant: this function never
/// panics and always returns something the loading shell can render.
pub fn resolve_boot_language(app: &tauri::AppHandle) -> String
{
    let dir = match crate::user_data::paths::resolve_user_data_dir(app)
    {
        Ok(d) => d,
        Err(_) => return "en".to_string(),
    };
    let path = dir.join("user-settings.json");
    let body = match std::fs::read_to_string(&path)
    {
        Ok(b) => b,
        Err(_) => return "en".to_string(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&body)
    {
        Ok(v) => v,
        Err(_) => return "en".to_string(),
    };
    parsed.get("defaultLanguage")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("en")
        .to_string()
}
