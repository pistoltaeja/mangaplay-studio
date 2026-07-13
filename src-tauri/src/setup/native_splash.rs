//! Native Win32 splash window.
//!
//! Job: paint the branded splash PNG (`src/img/splash.png`, baked in via
//! `include_bytes!`) centred on the primary monitor as fast as possible —
//! target < 80ms from process start — so the user sees content while
//! WebView2 spends its ~500-2000ms warmup. Closes as soon as the loading
//! shell fires the `shell_ready` IPC, or after a 5s hard timeout.
//!
//! Design notes:
//! - Non-Windows targets get a no-op `show()` and a zero-cost `SplashHandle`.
//!   Wire code in `lib.rs` calls `show()` unconditionally; on macOS / Linux
//!   / Android it's a nop and the caller gets an inert handle.
//! - Runs on its OWN thread with a private message pump. Main thread
//!   proceeds with Tauri Builder normally.
//! - Communication: `Arc<AtomicBool>` sentinel that a `WM_TIMER` polls
//!   every 20ms. Cleaner than `PostThreadMessageW` (which needs the target
//!   thread ID and can race with the pump loop's `GetMessageW` blocking).
//! - Hard 5s self-destruct inside the pump so a lost / never-fired
//!   `shell_ready` can never leave a stale splash on screen.
//! - `UpdateLayeredWindow` — the splash is now a layered (WS_EX_LAYERED)
//!   window driven by per-window alpha so we can fade it out on close.
//!   The window-sized composite DIB (background filled + mascot BitBlt'd
//!   centred) is pushed once at show, then again on each `WM_TIMER` tick
//!   during the fade with a decreasing `SourceConstantAlpha`.
//!   AlphaFormat is 0 (NOT AC_SRC_ALPHA): FillRect leaves the DIB's alpha
//!   channel at its 0-initialised state, so honouring per-pixel alpha
//!   would render the background rect as transparent. With AlphaFormat=0
//!   the whole rect fades uniformly and the mascot's own translucent
//!   edges — already pre-composited against #1a1a1a in decode_png — look
//!   correct. The legacy `WM_PAINT` handler is left as a fallback but is
//!   not invoked in normal flow — `UpdateLayeredWindow` bypasses it.
//! - DPI: derived from `WindowGeometry.scale_factor` (per-monitor DPI via
//!   `GetDpiForMonitor(MDT_EFFECTIVE_DPI)` on the primary monitor, shared
//!   with the main-window resolver). `scale_factor >= 1.5` → use the @2x
//!   asset; else 1x. Same source as the coordinate rect so the picked PNG
//!   always matches the target geometry.
//! - PNG decode: `png` crate directly (not `image`) to keep dep size
//!   minimal. Decodes to RGBA8; we composite against #1a1a1a during the
//!   copy into the DIB section so any semi-transparent pixels blend
//!   cleanly.

#[cfg(target_os = "windows")]
use std::sync::Arc;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};

/// Public handle to a spawned splash. Non-Windows platforms get an inert
/// handle that costs nothing.
pub struct SplashHandle
{
    #[cfg(target_os = "windows")]
    close_flag: Arc<AtomicBool>,
    #[cfg(target_os = "windows")]
    fade_start_flag: Arc<AtomicBool>,
    #[cfg(target_os = "windows")]
    thread: Option<std::thread::JoinHandle<()>>,
    #[cfg(not(target_os = "windows"))]
    _marker: (),
}

impl SplashHandle
{
    /// Signal the splash thread to destroy the window. Best-effort join
    /// on a helper thread so callers never block on splash teardown.
    /// Idempotent — calling twice is safe.
    #[allow(dead_code)]
    #[cfg(target_os = "windows")]
    pub fn close(mut self)
    {
        self.close_flag.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take()
        {
            let _ = std::thread::spawn(move || {
                let _ = t.join();
            });
        }
    }

    /// Signal the splash to close without waiting for the thread. Use
    /// from IPC handlers where blocking is a bad idea. The atomic flip
    /// is enough — the splash thread's WM_TIMER polls it within ~20ms.
    ///
    /// This is the HARD-close path (no fade). Preferred callers should
    /// use `start_fade()` for the user-visible flow; `close_async()`
    /// remains for the watchdog + 5s timeout fallback.
    pub fn close_async(&self)
    {
        #[cfg(target_os = "windows")]
        {
            self.close_flag.store(true, Ordering::SeqCst);
        }
    }

    /// Signal the splash thread to begin the fade-out animation. The
    /// splash thread will fade the layered-window alpha from 255 to 0
    /// over ~260ms via `UpdateLayeredWindow`, then destroy the window.
    /// Idempotent — subsequent calls after fade-in-progress are ignored.
    pub fn start_fade(&self)
    {
        #[cfg(target_os = "windows")]
        {
            self.fade_start_flag.store(true, Ordering::SeqCst);
        }
    }
}

/// Spawn the splash on a new thread and return immediately with a handle.
/// On non-Windows platforms this is a no-op returning an inert handle.
///
/// Best-effort. Any failure inside the thread (PNG decode, window
/// creation, GDI ops) logs `warn` and lets the thread exit — the app
/// still boots normally.
pub fn show() -> SplashHandle
{
    #[cfg(target_os = "windows")]
    {
        let close_flag = Arc::new(AtomicBool::new(false));
        let fade_start_flag = Arc::new(AtomicBool::new(false));
        let close_flag_thread = Arc::clone(&close_flag);
        let fade_flag_thread = Arc::clone(&fade_start_flag);
        let thread = std::thread::Builder::new()
            .name("mps-splash".into())
            .spawn(move || {
                if let Err(e) = win::run_splash_thread(close_flag_thread, fade_flag_thread)
                {
                    log::warn!("[splash] thread exited with error: {}", e);
                }
            })
            .ok();
        SplashHandle { close_flag, fade_start_flag, thread }
    }

    #[cfg(not(target_os = "windows"))]
    {
        SplashHandle { _marker: () }
    }
}

// ── Windows-specific implementation ──────────────────────────────────────

#[cfg(target_os = "windows")]
mod win
{
    use super::*;

    // Splash PNGs baked into the binary. Paths relative to this source file.
    // `../../../src/img/splash.png` = src-tauri/src/setup → src-tauri → mangaplay-studio → src/img.
    const SPLASH_1X: &[u8] = include_bytes!("../../../src/img/splash.png");
    const SPLASH_2X: &[u8] = include_bytes!("../../../src/img/splash@2x.png");

    // Internal dev toggle: flip to `false` to suppress the mascot BitBlt.
    // The layered window still spawns as a solid brand-background rect and
    // still fades on the same schedule — only the mascot artwork is
    // omitted. Useful for isolating window/geometry/fade issues from
    // asset-rendering issues. Off by default (mascot shown).
    const SHOW_MASCOT: bool = false;

    // Brand background — canonical source is icons/brand-colors.json; every
    // surface reads from there via scripts/emit-brand-colors.js which writes
    // the Rust const tuple used here + the CSS var + the iOS storyboard
    // <color> + the Android colors.xml splash_bg entry. Any drift is a bug
    // in emit-brand-colors.js, not this file.
    const BG_R: u8 = crate::setup::brand_colors_generated::SPLASH_BG_RGB.0;
    const BG_G: u8 = crate::setup::brand_colors_generated::SPLASH_BG_RGB.1;
    const BG_B: u8 = crate::setup::brand_colors_generated::SPLASH_BG_RGB.2;

    // Hard self-destruct so a lost close signal never leaves the splash
    // on screen. Tuned so it always outlives the WebView2 warmup on cold
    // boot but never runs long enough to be user-visible past the shell.
    const HARD_TIMEOUT_MS: u64 = 5000;

    // Poll cadence for the atomic close flag. 20ms → user-imperceptible
    // lag between shell_ready → splash gone.
    const POLL_INTERVAL_MS: u32 = 20;
    const POLL_TIMER_ID: usize = 1;

    // Fade-out duration. Matches the CSS fade the WebView shell uses so
    // the splash → WebView handoff feels like one continuous animation.
    const FADE_DURATION_MS: u64 = 260;

    use windows::core::{PCWSTR, w};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM, HINSTANCE};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleDC, CreateDIBSection, CreateSolidBrush,
        DeleteDC, DeleteObject, FillRect,
        SelectObject, ReleaseDC, GetDC, PAINTSTRUCT, BeginPaint, EndPaint,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        SRCCOPY, HBITMAP, HDC, HBRUSH, HGDIOBJ,
        BLENDFUNCTION, AC_SRC_OVER,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
        GetMessageW, KillTimer, LoadCursorW, MSG,
        PostQuitMessage, RegisterClassExW, SetTimer, ShowWindow,
        TranslateMessage, UnregisterClassW, UpdateLayeredWindow,
        WM_DESTROY, WM_PAINT,
        WM_TIMER, WM_MOUSEACTIVATE,
        WNDCLASSEXW, CS_HREDRAW, CS_VREDRAW, IDC_ARROW, MA_NOACTIVATE,
        SW_SHOWNOACTIVATE, ULW_ALPHA, WS_EX_LAYERED, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, HMENU,
    };

    /// Decoded splash PNG in top-down BGRA format ready to blit into a DIB.
    struct DecodedSplash
    {
        width: i32,
        height: i32,
        /// BGRA rows, top-down. Length = width * height * 4.
        pixels: Vec<u8>,
    }

    /// Decode a PNG byte slice into top-down BGRA, compositing any
    /// semi-transparent pixels against the brand background so the
    /// non-alpha `BitBlt` renders identically to the design mock.
    fn decode_png(bytes: &[u8]) -> Result<DecodedSplash, String>
    {
        let decoder = png::Decoder::new(bytes);
        let mut reader = decoder.read_info().map_err(|e| format!("png read_info: {}", e))?;
        let info = reader.info();
        let width = info.width as i32;
        let height = info.height as i32;
        let color = info.color_type;
        let bit_depth = info.bit_depth;
        if bit_depth != png::BitDepth::Eight
        {
            return Err(format!("unsupported bit depth: {:?}", bit_depth));
        }
        let mut raw = vec![0u8; reader.output_buffer_size()];
        reader.next_frame(&mut raw).map_err(|e| format!("png next_frame: {}", e))?;

        // Normalise to BGRA top-down. Alpha-composite against the brand
        // background so BitBlt doesn't need per-pixel alpha.
        let bg_r = BG_R as u32;
        let bg_g = BG_G as u32;
        let bg_b = BG_B as u32;
        let px_count = (width * height) as usize;
        let mut bgra = Vec::with_capacity(px_count * 4);
        match color
        {
            png::ColorType::Rgb =>
            {
                for chunk in raw.chunks_exact(3)
                {
                    bgra.push(chunk[2]); // B
                    bgra.push(chunk[1]); // G
                    bgra.push(chunk[0]); // R
                    bgra.push(0xFF);
                }
            }
            png::ColorType::Rgba =>
            {
                for chunk in raw.chunks_exact(4)
                {
                    let a = chunk[3] as u32;
                    let inv = 255 - a;
                    let r = (chunk[0] as u32 * a + bg_r * inv) / 255;
                    let g = (chunk[1] as u32 * a + bg_g * inv) / 255;
                    let b = (chunk[2] as u32 * a + bg_b * inv) / 255;
                    bgra.push(b as u8);
                    bgra.push(g as u8);
                    bgra.push(r as u8);
                    bgra.push(0xFF);
                }
            }
            other =>
            {
                return Err(format!("unsupported colour type: {:?}", other));
            }
        }
        Ok(DecodedSplash { width, height, pixels: bgra })
    }

    thread_local! {
        static SPLASH_STATE: std::cell::RefCell<Option<SplashState>> = const { std::cell::RefCell::new(None) };
    }

    struct SplashState
    {
        dib_bitmap: HBITMAP,
        dib_dc: HDC,
        /// Compositing DC that holds the fully-rendered layered surface
        /// (brand background + centred mascot). Source for
        /// `UpdateLayeredWindow` — sized to the full window rect so a
        /// single blit pushes the entire window state.
        composite_dc: HDC,
        composite_bitmap: HBITMAP,
        /// Mascot artwork size (pixels of the decoded PNG). Blitted
        /// centred inside the larger window rect.
        mascot_w: i32,
        mascot_h: i32,
        /// Full splash window rect. The area outside the mascot is
        /// FillRect'd with the brand background so the surround matches
        /// the WebView shell's #boot-screen background exactly.
        window_w: i32,
        window_h: i32,
        /// Splash window position (physical pixels). Passed as pptDst to
        /// UpdateLayeredWindow so the position never drifts on repaint.
        window_x: i32,
        window_y: i32,
        /// Cached brand-background brush for FillRect. Owned by the
        /// SplashState; freed at teardown alongside the DIB.
        bg_brush: HBRUSH,
        close_flag: Arc<AtomicBool>,
        fade_start_flag: Arc<AtomicBool>,
        started_at: std::time::Instant,
        /// Timestamp at which the fade-out began. `None` until the
        /// fade_start_flag flips.
        fade_started_at: Option<std::time::Instant>,
        /// Current SourceConstantAlpha value. Starts at 255 (fully
        /// opaque). Decreases toward 0 over `FADE_DURATION_MS` once
        /// `fade_started_at` is set.
        alpha: u8,
    }

    pub(super) fn run_splash_thread(
        close_flag: Arc<AtomicBool>,
        fade_start_flag: Arc<AtomicBool>,
    ) -> Result<(), String>
    {
        // 1. Resolve target geometry via the shared source-of-truth. Splash
        // path — no Tauri app handle available yet (this runs pre-init). The
        // resolver falls back to raw Win32 for DPI + work area, and the same
        // resolver is called from setup::window::build_main_window with an
        // app handle so both paths land on identical rects. Resolved first so
        // its `scale_factor` (per-monitor DPI, same value the resolver uses
        // for the rect) drives the 1x/@2x PNG pick — a single source of
        // truth avoids the split GetDpiForSystem-vs-GetDpiForMonitor bug on
        // multi-monitor mixed-DPI setups.
        let ux_mode = std::env::var("MPS_UX_MODE").unwrap_or_else(|_| "standalone".into());
        let g = crate::setup::geometry::WindowGeometry::resolve(None, &ux_mode);
        let (x, y) = g.physical_origin();
        let (w, h) = g.physical_size();
        log::debug!(
            "[splash] target rect ({}, {}) {}x{} (physical px, ux_mode={})",
            x, y, w, h, ux_mode
        );

        // 2. Decode PNG (fail early before any Win32 allocation).
        let use_2x = g.scale_factor >= 1.5;
        let bytes = if use_2x { SPLASH_2X } else { SPLASH_1X };
        let decoded = decode_png(bytes)?;
        log::debug!(
            "[splash] decoded {}x{} @ scale {:.2} ({})",
            decoded.width, decoded.height, g.scale_factor, if use_2x { "@2x" } else { "1x" }
        );

        // 3. Register window class.
        let hinstance: HINSTANCE = unsafe {
            // SAFETY: null lpModuleName returns the current executable's
            // module handle. Documented Win32 behaviour, never fails.
            match GetModuleHandleW(PCWSTR::null())
            {
                Ok(h) => HINSTANCE(h.0),
                Err(e) => return Err(format!("GetModuleHandleW: {}", e)),
            }
        };
        let class_name = w!("MpsSplashWindow");
        let cursor = unsafe {
            // SAFETY: LoadCursorW with null hInstance + IDC_ARROW returns
            // the system arrow cursor. `.unwrap_or_default()` swallows the
            // theoretical error path — the splash doesn't need a cursor.
            LoadCursorW(None, IDC_ARROW).unwrap_or_default()
        };

        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(splash_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: Default::default(),
            hCursor: cursor,
            hbrBackground: HBRUSH::default(),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: class_name,
            hIconSm: Default::default(),
        };
        let atom = unsafe {
            // SAFETY: WNDCLASSEXW is fully initialised above.
            RegisterClassExW(&wc)
        };
        if atom == 0
        {
            return Err("RegisterClassExW returned 0".to_string());
        }

        // 4. Create window at the resolved rect, NOT at the decoded PNG size.
        // The window is the "outer container" the mascot centres inside;
        // BitBlt in WM_PAINT paints the mascot at ((window_w - mascot_w)/2,
        // (window_h - mascot_h)/2) with FillRect surrounding it in the
        // brand background.
        let hwnd = unsafe {
            // SAFETY: class registered above, hInstance valid, rect bounded.
            match CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class_name,
                w!(""),
                WS_POPUP,
                x, y, w, h,
                None,
                Some(HMENU::default()),
                Some(hinstance),
                None,
            )
            {
                Ok(h) => h,
                Err(e) => {
                    let _ = UnregisterClassW(class_name, Some(hinstance));
                    return Err(format!("CreateWindowExW: {}", e));
                }
            }
        };

        // 5. Build the DIB the WM_PAINT handler blits from.
        let (dib_dc, dib_bitmap) = match create_dib(hwnd, &decoded)
        {
            Ok(pair) => pair,
            Err(e) => {
                unsafe {
                    let _ = DestroyWindow(hwnd);
                    let _ = UnregisterClassW(class_name, Some(hinstance));
                }
                return Err(e);
            }
        };

        // 5b. Brand-background brush for FillRect in WM_PAINT. Owned by
        // the SplashState; DeleteObject'd at teardown. `CreateSolidBrush`
        // never fails except on GDI-object exhaustion, but we still map
        // the null return to a hard error for safety.
        // COLORREF is 0x00BBGGRR encoding.
        let bg_colorref = (BG_R as u32) | ((BG_G as u32) << 8) | ((BG_B as u32) << 16);
        let bg_brush = unsafe {
            // SAFETY: pure GDI call, no aliasing / lifetime constraints.
            CreateSolidBrush(windows::Win32::Foundation::COLORREF(bg_colorref))
        };
        if bg_brush.0.is_null()
        {
            unsafe {
                let _ = DeleteDC(dib_dc);
                let _ = DeleteObject(HGDIOBJ(dib_bitmap.0));
                let _ = DestroyWindow(hwnd);
                let _ = UnregisterClassW(class_name, Some(hinstance));
            }
            return Err("CreateSolidBrush returned null".to_string());
        }

        // 5c. Build the window-sized composite DIB the layered window
        // draws from. This is the full brand-background rectangle with
        // the mascot BitBlt'd centred inside; a single
        // `UpdateLayeredWindow` call pushes it in one shot. The alpha
        // channel is 0xFF for every pixel (fully opaque) — window-wide
        // opacity is controlled at blit time via
        // `BLENDFUNCTION::SourceConstantAlpha`.
        let (composite_dc, composite_bitmap) = match create_composite_dib(hwnd, w, h)
        {
            Ok(pair) => pair,
            Err(e) => {
                unsafe {
                    let _ = DeleteDC(dib_dc);
                    let _ = DeleteObject(HGDIOBJ(dib_bitmap.0));
                    let _ = DeleteObject(HGDIOBJ(bg_brush.0));
                    let _ = DestroyWindow(hwnd);
                    let _ = UnregisterClassW(class_name, Some(hinstance));
                }
                return Err(e);
            }
        };

        // Prime the composite DC: fill with brand background, then (unless
        // the dev toggle SHOW_MASCOT is off) BitBlt the mascot centred.
        // This becomes the "source of truth" bitmap that
        // UpdateLayeredWindow blits through the alpha-blend pipeline every
        // fade tick.
        let full_rect = RECT { left: 0, top: 0, right: w, bottom: h };
        let mascot_x = (w - decoded.width) / 2;
        let mascot_y = (h - decoded.height) / 2;
        unsafe {
            let _ = FillRect(composite_dc, &full_rect, bg_brush);
            if SHOW_MASCOT {
                let _ = BitBlt(
                    composite_dc, mascot_x, mascot_y,
                    decoded.width, decoded.height,
                    Some(dib_dc), 0, 0, SRCCOPY,
                );
            }
        }

        // 6. Store thread-local state, register poll timer, show.
        SPLASH_STATE.with(|slot| {
            *slot.borrow_mut() = Some(SplashState {
                dib_bitmap,
                dib_dc,
                composite_dc,
                composite_bitmap,
                mascot_w: decoded.width,
                mascot_h: decoded.height,
                window_w: w,
                window_h: h,
                window_x: x,
                window_y: y,
                bg_brush,
                close_flag: Arc::clone(&close_flag),
                fade_start_flag: Arc::clone(&fade_start_flag),
                started_at: std::time::Instant::now(),
                fade_started_at: None,
                alpha: 255,
            });
        });

        // Push the initial layered-window surface at full opacity BEFORE
        // ShowWindow so the very first frame the user sees is the fully
        // rendered splash — not a black flash from the uninitialised
        // layered surface.
        push_layered_frame(hwnd, composite_dc, x, y, w, h, 255);

        unsafe {
            // SAFETY: hwnd is valid until DestroyWindow below.
            let _ = SetTimer(Some(hwnd), POLL_TIMER_ID, POLL_INTERVAL_MS, None);
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        log::debug!(
            "[splash] window shown at ({}, {}) {}x{} — mascot {}x{} centred inside",
            x, y, w, h, decoded.width, decoded.height
        );

        // 7. Message pump.
        let mut msg = MSG::default();
        loop
        {
            let ret = unsafe { GetMessageW(&mut msg, None, 0, 0) };
            if ret.0 == 0 || ret.0 == -1
            {
                break;
            }
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        // 8. Cleanup.
        SPLASH_STATE.with(|slot| {
            if let Some(state) = slot.borrow_mut().take()
            {
                unsafe {
                    // SAFETY: DIB DC + bitmap + brush + composite DC/bitmap
                    // were created by create_dib / create_composite_dib /
                    // CreateSolidBrush above and are unused after this
                    // thread exits (the WndProc has already torn down at
                    // WM_DESTROY).
                    let _ = DeleteDC(state.dib_dc);
                    let _ = DeleteObject(HGDIOBJ(state.dib_bitmap.0));
                    let _ = DeleteDC(state.composite_dc);
                    let _ = DeleteObject(HGDIOBJ(state.composite_bitmap.0));
                    let _ = DeleteObject(HGDIOBJ(state.bg_brush.0));
                }
            }
        });
        unsafe {
            let _ = UnregisterClassW(class_name, Some(hinstance));
        }
        Ok(())
    }

    fn create_dib(hwnd: HWND, decoded: &DecodedSplash) -> Result<(HDC, HBITMAP), String>
    {
        let width = decoded.width;
        let height = decoded.height;
        let screen_dc = unsafe { GetDC(Some(hwnd)) };
        if screen_dc.0.is_null()
        {
            return Err("GetDC(hwnd) returned null".to_string());
        }
        let mem_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
        if mem_dc.0.is_null()
        {
            unsafe { let _ = ReleaseDC(Some(hwnd), screen_dc); }
            return Err("CreateCompatibleDC returned null".to_string());
        }

        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative biHeight = top-down DIB. Matches our top-down
                // decoded row order — no vertical flip needed.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let dib = unsafe {
            // SAFETY: bmi fully initialised above; `bits` receives the DIB's
            // backing store pointer; hSection null → CreateDIBSection allocates.
            match CreateDIBSection(Some(mem_dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            {
                Ok(h) if !h.0.is_null() => h,
                Ok(_) => {
                    let _ = DeleteDC(mem_dc);
                    let _ = ReleaseDC(Some(hwnd), screen_dc);
                    return Err("CreateDIBSection returned null bitmap".to_string());
                }
                Err(e) => {
                    let _ = DeleteDC(mem_dc);
                    let _ = ReleaseDC(Some(hwnd), screen_dc);
                    return Err(format!("CreateDIBSection: {}", e));
                }
            }
        };

        // SAFETY: `bits` points to width*height*4 bytes owned by the DIB
        // for the DIB's lifetime; decoded.pixels has exactly that length.
        unsafe {
            std::ptr::copy_nonoverlapping(
                decoded.pixels.as_ptr(),
                bits as *mut u8,
                decoded.pixels.len(),
            );
        }

        // Select the DIB into the compatible DC so WM_PAINT can BitBlt
        // directly from mem_dc.
        unsafe {
            let _ = SelectObject(mem_dc, HGDIOBJ(dib.0));
            let _ = ReleaseDC(Some(hwnd), screen_dc);
        }
        Ok((mem_dc, dib))
    }

    /// Build an empty window-sized 32-bit BGRA DIB + compatible DC. The
    /// caller pre-renders the splash surface into it (background fill +
    /// mascot BitBlt) and `UpdateLayeredWindow` blits from it every fade
    /// tick.
    fn create_composite_dib(hwnd: HWND, width: i32, height: i32)
        -> Result<(HDC, HBITMAP), String>
    {
        let screen_dc = unsafe { GetDC(Some(hwnd)) };
        if screen_dc.0.is_null()
        {
            return Err("GetDC(hwnd) returned null (composite)".to_string());
        }
        let mem_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
        if mem_dc.0.is_null()
        {
            unsafe { let _ = ReleaseDC(Some(hwnd), screen_dc); }
            return Err("CreateCompatibleDC returned null (composite)".to_string());
        }

        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let dib = unsafe {
            match CreateDIBSection(Some(mem_dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            {
                Ok(h) if !h.0.is_null() => h,
                Ok(_) => {
                    let _ = DeleteDC(mem_dc);
                    let _ = ReleaseDC(Some(hwnd), screen_dc);
                    return Err("CreateDIBSection returned null (composite)".to_string());
                }
                Err(e) => {
                    let _ = DeleteDC(mem_dc);
                    let _ = ReleaseDC(Some(hwnd), screen_dc);
                    return Err(format!("CreateDIBSection (composite): {}", e));
                }
            }
        };
        unsafe {
            let _ = SelectObject(mem_dc, HGDIOBJ(dib.0));
            let _ = ReleaseDC(Some(hwnd), screen_dc);
        }
        Ok((mem_dc, dib))
    }

    /// Push a single frame of the layered splash window at the given
    /// SourceConstantAlpha. Wraps `UpdateLayeredWindow` with the full
    /// window position + size so a repositioned splash isn't possible
    /// (the position never actually changes — the arg is present for
    /// UpdateLayeredWindow's API contract).
    ///
    /// `alpha` = 255 → fully opaque, 0 → fully transparent. AlphaFormat=0
    /// (NOT AC_SRC_ALPHA) so per-pixel alpha is ignored and the whole
    /// composite rect (background + mascot) fades uniformly under
    /// SourceConstantAlpha. See detailed rationale on the BLENDFUNCTION
    /// literal below.
    fn push_layered_frame(
        hwnd: HWND, src_dc: HDC,
        x: i32, y: i32, w: i32, h: i32,
        alpha: u8,
    )
    {
        let dst_pt = POINT { x, y };
        let src_pt = POINT { x: 0, y: 0 };
        let size = SIZE { cx: w, cy: h };
        // AlphaFormat = 0 (NOT AC_SRC_ALPHA) — the composite DIB is created
        // by CreateDIBSection which zero-initialises its bits, and FillRect
        // with a COLORREF-brush only writes RGB channels, leaving alpha=0.
        // With AC_SRC_ALPHA the compositor would treat the background rect
        // as transparent (revealing the desktop / WebView behind), which
        // is exactly what happens when the mascot PNG is small and mostly
        // transparent. Dropping AC_SRC_ALPHA means SourceConstantAlpha
        // alone drives fade; the whole rect (bg + mascot) fades uniformly.
        // The mascot's own translucent edges were already alpha-composited
        // against #1a1a1a in decode_png, so we lose no visual quality.
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: alpha,
            AlphaFormat: 0,
        };
        unsafe {
            // SAFETY: hwnd is the WS_EX_LAYERED splash window created
            // above; src_dc holds the composite DIB owned by SplashState
            // for the lifetime of the splash thread. All pointer args
            // are stack-locals valid for the call duration.
            let _ = UpdateLayeredWindow(
                hwnd,
                Some(HDC::default()),
                Some(&dst_pt),
                Some(&size),
                Some(src_dc),
                Some(&src_pt),
                windows::Win32::Foundation::COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            );
        }
    }

    unsafe extern "system" fn splash_wnd_proc(
        hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM,
    ) -> LRESULT
    {
        match msg
        {
            WM_PAINT =>
            {
                let mut ps = PAINTSTRUCT::default();
                let hdc = unsafe { BeginPaint(hwnd, &mut ps) };
                SPLASH_STATE.with(|slot| {
                    if let Some(state) = slot.borrow().as_ref()
                    {
                        // First fill the WHOLE window rect with the brand
                        // background so the surround around the mascot
                        // matches the WebView shell's #boot-screen bg
                        // exactly. Without this fill, the window is left
                        // in whatever colour the GDI class default gives
                        // us (black) and a #1a1a1a-vs-#000 seam appears
                        // around the mascot on cold-drawn windows.
                        let full_rect = RECT {
                            left: 0, top: 0,
                            right: state.window_w, bottom: state.window_h,
                        };
                        unsafe { let _ = FillRect(hdc, &full_rect, state.bg_brush); }

                        // Blit the mascot centred inside the window rect.
                        // Integer division rounds down; a 1-pixel offset
                        // is imperceptible.
                        let mascot_x = (state.window_w - state.mascot_w) / 2;
                        let mascot_y = (state.window_h - state.mascot_h) / 2;
                        unsafe {
                            let _ = BitBlt(
                                hdc, mascot_x, mascot_y,
                                state.mascot_w, state.mascot_h,
                                Some(state.dib_dc), 0, 0, SRCCOPY,
                            );
                        }
                    }
                });
                unsafe { let _ = EndPaint(hwnd, &ps); }
                LRESULT(0)
            }
            WM_TIMER =>
            {
                if wparam.0 == POLL_TIMER_ID
                {
                    // Tri-state resolve inside the RefCell borrow so we
                    // hold the mutable borrow only for the state
                    // transition. Anything that needs to hit Win32
                    // (UpdateLayeredWindow, DestroyWindow) happens
                    // outside the borrow to avoid re-entry via WndProc.
                    enum Tick { HardClose, Repaint { x: i32, y: i32, w: i32, h: i32, src_dc: HDC, alpha: u8 }, Nothing }
                    let action = SPLASH_STATE.with(|slot| {
                        let mut state_ref = slot.borrow_mut();
                        let Some(state) = state_ref.as_mut() else { return Tick::HardClose };

                        // Hard-close path takes priority — used by the
                        // watchdog + 5s timeout.
                        if state.close_flag.load(Ordering::SeqCst)
                            || state.started_at.elapsed().as_millis() as u64 >= HARD_TIMEOUT_MS
                        {
                            return Tick::HardClose;
                        }

                        // Kick the fade timer the first time we notice
                        // the flag flipped by shell_composited.
                        if state.fade_start_flag.load(Ordering::SeqCst)
                            && state.fade_started_at.is_none()
                        {
                            state.fade_started_at = Some(std::time::Instant::now());
                        }

                        // Advance the fade if it's running.
                        if let Some(fade_start) = state.fade_started_at
                        {
                            let elapsed_ms = fade_start.elapsed().as_millis() as u64;
                            if elapsed_ms >= FADE_DURATION_MS
                            {
                                // Ensure the compositor has committed the
                                // alpha=0 frame before we DestroyWindow.
                                // Otherwise the layered window can vanish
                                // mid-fade-frame, exposing a seam between
                                // its physical rect and the WebView beneath
                                // (rect drift + DWM invalidation timing).
                                // Push alpha=0 unconditionally on the last
                                // tick, then destroy on the NEXT tick.
                                if state.alpha != 0
                                {
                                    state.alpha = 0;
                                    return Tick::Repaint {
                                        x: state.window_x,
                                        y: state.window_y,
                                        w: state.window_w,
                                        h: state.window_h,
                                        src_dc: state.composite_dc,
                                        alpha: 0,
                                    };
                                }
                                return Tick::HardClose;
                            }
                            // Linear 255 → 0 over FADE_DURATION_MS. Fine
                            // for 260ms; ease curves cost more than the
                            // perceptual gain at this duration.
                            let new_alpha = (255_u64
                                * (FADE_DURATION_MS - elapsed_ms)
                                / FADE_DURATION_MS) as u8;
                            if new_alpha != state.alpha
                            {
                                state.alpha = new_alpha;
                                return Tick::Repaint {
                                    x: state.window_x,
                                    y: state.window_y,
                                    w: state.window_w,
                                    h: state.window_h,
                                    src_dc: state.composite_dc,
                                    alpha: new_alpha,
                                };
                            }
                        }
                        Tick::Nothing
                    });
                    match action
                    {
                        Tick::HardClose =>
                        {
                            unsafe {
                                let _ = KillTimer(Some(hwnd), POLL_TIMER_ID);
                                let _ = DestroyWindow(hwnd);
                            }
                        }
                        Tick::Repaint { x, y, w, h, src_dc, alpha } =>
                        {
                            push_layered_frame(hwnd, src_dc, x, y, w, h, alpha);
                        }
                        Tick::Nothing => {}
                    }
                }
                LRESULT(0)
            }
            WM_MOUSEACTIVATE =>
            {
                // Never activate on click. Belt-and-braces with
                // WS_EX_NOACTIVATE, since the ex-style alone doesn't
                // block activation via queued mouse events.
                LRESULT(MA_NOACTIVATE as isize)
            }
            WM_DESTROY =>
            {
                unsafe { PostQuitMessage(0); }
                LRESULT(0)
            }
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }
}
