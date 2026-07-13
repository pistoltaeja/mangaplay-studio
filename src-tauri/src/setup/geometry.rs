//! Single source of truth for the main window's initial rect.
//!
//! Job: compute the target window geometry ONCE, and hand identical values
//! to (a) the native Win32 splash (`setup::native_splash`) and (b) the Tauri
//! `WebviewWindowBuilder` (`setup::window`). The two consumers used to each
//! read `settings.json` independently and produced subtly different rects —
//! the resulting size/position "pop" at the splash → shell handoff was
//! visible on every cold boot. Centralising the resolution here kills the
//! drift by construction.
//!
//! Two entry paths:
//! - **Splash path** — called from `run_splash_thread` BEFORE Tauri init.
//!   `app_handle` is `None`; the resolver falls back to raw Win32
//!   (`GetDpiForMonitor` for scale + `SPI_GETWORKAREA` for work area).
//! - **Window path** — called from `setup::window::build_main_window`
//!   AFTER Tauri init. `app_handle` is `Some`; the resolver uses
//!   `handle.primary_monitor()` for size/scale + `SPI_GETWORKAREA` for
//!   the taskbar-subtracted work area.
//!
//! All returned dimensions are LOGICAL pixels (Tauri's native unit). The
//! `physical_origin` / `physical_size` helpers exist for the splash which
//! talks physical pixels to `CreateWindowExW`.

use std::path::PathBuf;

/// Fully-resolved target rect for the main window.
#[derive(Debug, Clone, Copy)]
pub struct WindowGeometry
{
    /// Logical-pixel top-left, work-area relative to the primary monitor.
    pub logical_x: f64,
    pub logical_y: f64,
    pub logical_width: f64,
    pub logical_height: f64,
    /// Primary monitor DPI scale factor (physical / logical). Used to
    /// convert logical → physical for the Win32 splash.
    pub scale_factor: f64,
    /// Standalone only — honoured saved windowMaximized. Mobile/tablet
    /// always false (fixed-size windows).
    pub maximized: bool,
    /// Minimum inner size for the OS window (logical px). Mobile/tablet
    /// pin this to the fixed init size; standalone floors at 1080×640.
    pub min_logical_width: f64,
    pub min_logical_height: f64,
    /// True for standalone, false for the fixed-size mobile/tablet modes.
    pub resizable: bool,
}

impl WindowGeometry
{
    /// Resolve the target rect for the given UX mode.
    ///
    /// - `app_handle = Some(&handle)` — window path. Uses
    ///   `handle.primary_monitor()` for DPI + monitor size.
    /// - `app_handle = None` — splash path. Uses raw Win32 on Windows;
    ///   falls back to a 1.0 scale + 1920×1080 pretend screen on other
    ///   platforms (the splash is a no-op off Windows anyway).
    pub fn resolve(app_handle: Option<&tauri::AppHandle>, ux_mode: &str) -> Self
    {
        let (work_area_physical, scale_factor) = resolve_monitor(app_handle);

        match ux_mode
        {
            "mobile" => resolve_mobile(work_area_physical, scale_factor),
            "tablet" => resolve_tablet(work_area_physical, scale_factor),
            _ =>
            {
                let saved = read_saved_geometry();
                resolve_standalone_from_parts(
                    saved.width,
                    saved.height,
                    saved.maximized,
                    work_area_physical,
                    scale_factor,
                )
            }
        }
    }

    /// Physical-pixel top-left (splash consumes this for `CreateWindowExW`).
    pub fn physical_origin(&self) -> (i32, i32)
    {
        (
            (self.logical_x * self.scale_factor).round() as i32,
            (self.logical_y * self.scale_factor).round() as i32,
        )
    }

    /// Physical-pixel dimensions (splash consumes this for `CreateWindowExW`).
    pub fn physical_size(&self) -> (i32, i32)
    {
        (
            (self.logical_width * self.scale_factor).round() as i32,
            (self.logical_height * self.scale_factor).round() as i32,
        )
    }
}

/// Standalone geometry resolver — pure function of its inputs. Exposed for
/// unit tests in `src-tauri/tests/geometry.rs`. See `WindowGeometry::resolve`
/// for the wrapper that fills `work_area` + `scale_factor` from the OS.
#[doc(hidden)]
pub fn resolve_standalone_from_parts(
    saved_width: Option<f64>,
    saved_height: Option<f64>,
    saved_maximized: bool,
    work_area: (i32, i32, i32, i32),  // left, top, right, bottom (physical px)
    scale_factor: f64,
) -> WindowGeometry
{
    let (wa_left, wa_top, wa_right, wa_bottom) = work_area;
    let scale = if scale_factor > 0.0 { scale_factor } else { 1.0 };

    // Convert physical work-area rect to logical for centering + maximized fill.
    let wa_logical_left = wa_left as f64 / scale;
    let wa_logical_top = wa_top as f64 / scale;
    let wa_logical_w = (wa_right - wa_left) as f64 / scale;
    let wa_logical_h = (wa_bottom - wa_top) as f64 / scale;

    if saved_maximized
    {
        return WindowGeometry
        {
            logical_x: wa_logical_left,
            logical_y: wa_logical_top,
            logical_width: wa_logical_w,
            logical_height: wa_logical_h,
            scale_factor: scale,
            maximized: true,
            min_logical_width: 640.0,
            min_logical_height: 640.0,
            resizable: true,
        };
    }

    // 640/640 = reduced floor so the window can shrink for narrow layouts.
    // Mirrors setup::window's previous inline floors.
    let logical_w = saved_width.unwrap_or(1280.0).max(640.0);
    let logical_h = saved_height.unwrap_or(800.0).max(640.0);

    // Center inside the work area, not the full screen — respect the taskbar.
    let logical_x = wa_logical_left + ((wa_logical_w - logical_w) / 2.0).max(0.0);
    let logical_y = wa_logical_top + ((wa_logical_h - logical_h) / 2.0).max(0.0);

    WindowGeometry
    {
        logical_x,
        logical_y,
        logical_width: logical_w,
        logical_height: logical_h,
        scale_factor: scale,
        maximized: false,
        min_logical_width: 640.0,
        min_logical_height: 640.0,
        resizable: true,
    }
}

/// Mobile: 720×1280 logical, non-resizable, centered on the work area.
fn resolve_mobile(work_area: (i32, i32, i32, i32), scale_factor: f64) -> WindowGeometry
{
    let (wa_left, wa_top, wa_right, wa_bottom) = work_area;
    let scale = if scale_factor > 0.0 { scale_factor } else { 1.0 };
    let wa_logical_left = wa_left as f64 / scale;
    let wa_logical_top = wa_top as f64 / scale;
    let wa_logical_w = (wa_right - wa_left) as f64 / scale;
    let wa_logical_h = (wa_bottom - wa_top) as f64 / scale;

    let logical_w = 720.0_f64;
    let logical_h = 1280.0_f64;
    let logical_x = wa_logical_left + ((wa_logical_w - logical_w) / 2.0).max(0.0);
    let logical_y = wa_logical_top + ((wa_logical_h - logical_h) / 2.0).max(0.0);

    WindowGeometry
    {
        logical_x,
        logical_y,
        logical_width: logical_w,
        logical_height: logical_h,
        scale_factor: scale,
        maximized: false,
        min_logical_width: logical_w,
        min_logical_height: logical_h,
        resizable: false,
    }
}

/// Tablet: 2064×2752 clamped to monitor_logical_h − 100, aspect preserved.
fn resolve_tablet(work_area: (i32, i32, i32, i32), scale_factor: f64) -> WindowGeometry
{
    let (wa_left, wa_top, wa_right, wa_bottom) = work_area;
    let scale = if scale_factor > 0.0 { scale_factor } else { 1.0 };
    let wa_logical_left = wa_left as f64 / scale;
    let wa_logical_top = wa_top as f64 / scale;
    let wa_logical_w = (wa_right - wa_left) as f64 / scale;
    let wa_logical_h = (wa_bottom - wa_top) as f64 / scale;

    let mut logical_h = 2752.0_f64;
    let mut logical_w = 2064.0_f64;
    if logical_h > wa_logical_h - 100.0
    {
        logical_h = (wa_logical_h - 100.0).max(640.0);
        // Tablet aspect = 2064/2752 ≈ 0.75.
        logical_w = (logical_h * (2064.0 / 2752.0)).round();
    }

    let logical_x = wa_logical_left + ((wa_logical_w - logical_w) / 2.0).max(0.0);
    let logical_y = wa_logical_top + ((wa_logical_h - logical_h) / 2.0).max(0.0);

    WindowGeometry
    {
        logical_x,
        logical_y,
        logical_width: logical_w,
        logical_height: logical_h,
        scale_factor: scale,
        maximized: false,
        min_logical_width: logical_w,
        min_logical_height: logical_h,
        resizable: false,
    }
}

// ── Monitor / DPI resolution ─────────────────────────────────────────────

/// Returns `(work_area_physical, scale_factor)`.
/// `work_area_physical` = `(left, top, right, bottom)` in physical pixels.
fn resolve_monitor(app_handle: Option<&tauri::AppHandle>) -> ((i32, i32, i32, i32), f64)
{
    // Window path: read the primary monitor via Tauri when we can.
    #[cfg(desktop)]
    {
        if let Some(handle) = app_handle
        {
            if let Ok(Some(monitor)) = handle.primary_monitor()
            {
                let scale = monitor.scale_factor();
                let size = monitor.size();          // physical
                let pos = monitor.position();       // physical
                // Try to subtract the taskbar via SPI_GETWORKAREA on Windows.
                #[cfg(target_os = "windows")]
                {
                    if let Some(wa) = win32_work_area()
                    {
                        return (wa, scale);
                    }
                }
                let full = (
                    pos.x,
                    pos.y,
                    pos.x + size.width as i32,
                    pos.y + size.height as i32,
                );
                return (full, scale);
            }
        }
    }
    let _ = app_handle;

    // Splash path (or Tauri monitor lookup failed): raw Win32 on Windows.
    #[cfg(target_os = "windows")]
    {
        let scale = win32_primary_scale_factor();
        let wa = win32_work_area().unwrap_or_else(|| {
            let (w, h) = win32_screen_size();
            (0, 0, w, h)
        });
        return (wa, scale);
    }

    // Non-Windows fallback — splash is a no-op off Windows; return a
    // sane default so the resolver still has something to work with.
    #[cfg(not(target_os = "windows"))]
    {
        ((0, 0, 1920, 1080), 1.0)
    }
}

#[cfg(target_os = "windows")]
fn win32_work_area() -> Option<(i32, i32, i32, i32)>
{
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };
    const SPIF_NONE: SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS =
        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0);

    let mut rect = RECT::default();
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut rect as *mut _ as *mut _),
            SPIF_NONE,
        )
    };
    if ok.is_ok() && rect.right > rect.left && rect.bottom > rect.top
    {
        Some((rect.left, rect.top, rect.right, rect.bottom))
    }
    else
    {
        None
    }
}

#[cfg(target_os = "windows")]
fn win32_screen_size() -> (i32, i32)
{
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
}

#[cfg(target_os = "windows")]
fn win32_primary_scale_factor() -> f64
{
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

    let point = POINT { x: 0, y: 0 };
    let hmon = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTOPRIMARY) };
    if hmon.is_invalid()
    {
        return 1.0;
    }
    let mut dpi_x: u32 = 0;
    let mut dpi_y: u32 = 0;
    let hr = unsafe { GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
    if hr.is_ok() && dpi_x > 0
    {
        (dpi_x as f64) / 96.0
    }
    else
    {
        1.0
    }
}

// ── Saved-geometry read (settings.json) ──────────────────────────────────

struct SavedGeometry
{
    width: Option<f64>,
    height: Option<f64>,
    maximized: bool,
}

/// Read `settings.json` from either `MPS_SETTINGS_DIR` (test override) or
/// the standard `%APPDATA%\studio.mangaplay.app\` path. Returns defaults on
/// any error — resolver always has something to work with, even on a fresh
/// install.
///
/// This may run before Tauri is initialised (splash path); the identifier
/// is hardcoded to match `tauri.conf.json.identifier`.
fn read_saved_geometry() -> SavedGeometry
{
    const APP_ID: &str = "studio.mangaplay.app";
    let empty = SavedGeometry { width: None, height: None, maximized: false };

    let dir: Option<PathBuf> = if let Ok(env_dir) = std::env::var("MPS_SETTINGS_DIR")
    {
        if env_dir.is_empty() { None } else { Some(PathBuf::from(env_dir)) }
    }
    else if let Ok(appdata) = std::env::var("APPDATA")
    {
        Some(PathBuf::from(appdata).join(APP_ID))
    }
    else
    {
        None
    };

    let dir = match dir { Some(d) => d, None => return empty };
    let settings_path = dir.join("settings.json");
    let body = match std::fs::read_to_string(&settings_path)
    {
        Ok(s) => s,
        Err(_) => return empty,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&body)
    {
        Ok(v) => v,
        Err(_) => return empty,
    };
    SavedGeometry
    {
        width: parsed.get("windowWidth").and_then(|v| v.as_f64()),
        height: parsed.get("windowHeight").and_then(|v| v.as_f64()),
        maximized: parsed.get("windowMaximized").and_then(|v| v.as_bool()).unwrap_or(false),
    }
}
