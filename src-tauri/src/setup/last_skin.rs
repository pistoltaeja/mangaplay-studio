//! Skin-injector — reads `skin` from `settings.json` at boot so the
//! WebView's `initialization_script` can stamp `window.__MPS_LAST_SKIN__`
//! before any JS parses. Mirrors the `resolve_boot_language` pattern in
//! [`boot_strings`](super::boot_strings) — plain file I/O, no AppHandle
//! juggling, never panics.
//!
//! Without this the inline stamper in `index.html` falls back to
//! "default" and Night users see a one-frame Default splash on every
//! cold boot.

/// Read the active skin id from `settings.json` at the resolved settings
/// directory. Returns `"default"` on any error — first-boot users,
/// corrupted settings, tests without a settings dir, unknown value.
pub fn resolve_last_skin(app: &tauri::AppHandle) -> String
{
    // The `app_settings` module already owns the "which directory holds
    // settings.json" resolution (honours MPS_SETTINGS_DIR override), so
    // reach into its impl helper instead of duplicating the logic.
    let dir = match crate::commands::settings::resolve_settings_dir(app)
    {
        Ok(d) => d,
        Err(_) => return "default".to_string(),
    };
    let path = dir.join("settings.json");
    let body = match std::fs::read_to_string(&path)
    {
        Ok(b) => b,
        Err(_) => return "default".to_string(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&body)
    {
        Ok(v) => v,
        Err(_) => return "default".to_string(),
    };
    // Prefer explicit `skin`. Fall through to a one-shot legacy migration
    // read of `colorScheme` — the JS shell-restore path also migrates and
    // persists on first read, but returning the correct value here means
    // that first Night boot doesn't flicker either.
    if let Some(skin) = parsed.get("skin").and_then(|v| v.as_str())
    {
        if !skin.is_empty()
        {
            return skin.to_string();
        }
    }
    if let Some(cs) = parsed.get("colorScheme").and_then(|v| v.as_str())
    {
        return if cs == "dark" { "night".to_string() } else { "default".to_string() };
    }
    "default".to_string()
}
