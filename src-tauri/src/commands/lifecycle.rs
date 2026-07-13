//! Boot lifecycle commands invoked from the frontend loading shell.
//!
//! Two-IPC design (splits window-show from splash-close so the composite
//! gate is a real signal, not a wall-clock guess):
//!
//! - `shell_ready` — the loading shell (see src/index.html inline boot script)
//!   fires this once the boot screen has painted its first frame. Rust
//!   responds by SHOWING the main WebView window. No sleep. No splash close.
//!   The native splash stays up covering the WebView until the shell also
//!   reports composited.
//! - `shell_composited` — fired from JS AFTER a double-`requestAnimationFrame`
//!   nested inside the `shell_ready` callback, i.e. after the WebView has
//!   guaranteed presented its first real frame. Rust records the timestamp
//!   and (together with the shell_ready + 500ms deadline) asks the splash
//!   to begin its fade-out. No white-flash race because the WebView is
//!   already painting its `#1a1a1a` background by the time the splash
//!   fades.
//!
//! Fade-out trigger: `max(shell_ready + 500ms, shell_composited)`. The
//! 500ms grace after `shell_ready` guarantees the WebView has had time
//! to actually paint its first frame — on slow cold boots
//! `shell_composited` can arrive before the DWM has flushed the first
//! WebView frame to screen, so gating on wall-clock too avoids a
//! black-frame reveal. The splash then fades over ~260ms and destroys
//! itself.
//!
//! Both commands are idempotent — safe to call more than once. If either
//! never fires (JS crash mid-boot), the watchdog in
//! `setup::window::build_main_window` force-shows the window after 2s
//! and hard-closes the splash. A 5s hard timeout inside the splash
//! thread is the final safety net.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::Manager;

/// Managed state that tracks the native splash handle plus the two
/// boot-lifecycle timestamps needed for the fade trigger.
pub struct SplashState
{
    pub handle: Mutex<Option<crate::setup::native_splash::SplashHandle>>,
    pub shell_ready_at: Mutex<Option<Instant>>,
    pub shell_composited_at: Mutex<Option<Instant>>,
    /// Flips true once we've told the splash to start fading. Guards
    /// `try_start_fade` against double-firing when both branches (500ms
    /// timer + shell_composited) race to satisfy the gate.
    pub fade_signalled: AtomicBool,
}

impl SplashState
{
    pub fn new(handle: crate::setup::native_splash::SplashHandle) -> Self
    {
        Self {
            handle: Mutex::new(Some(handle)),
            shell_ready_at: Mutex::new(None),
            shell_composited_at: Mutex::new(None),
            fade_signalled: AtomicBool::new(false),
        }
    }
}

/// Attempt to start the splash fade. Fires only when BOTH signals have
/// been recorded AND the fade hasn't already been kicked off. Idempotent
/// — safe to call from the shell_ready delayed task, from
/// shell_composited, or from a watchdog.
fn try_start_fade(app: &tauri::AppHandle)
{
    let Some(state) = app.try_state::<SplashState>() else { return };

    let ready = state.shell_ready_at.lock().ok().and_then(|g| *g);
    let composited = state.shell_composited_at.lock().ok().and_then(|g| *g);
    let (Some(_ready), Some(_composited)) = (ready, composited) else { return };

    // Compare-and-swap so only the first caller past the gate signals.
    if state
        .fade_signalled
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    // Match (not `if let Ok`) so the poison-error temporary drops at the
    // `;` before the outer state ref does. `if let Ok(...)` binds the
    // Result temporary to the whole block, dragging its lifetime out to
    // the end of the fn and clashing with `state` scope.
    match state.handle.lock()
    {
        Ok(guard) =>
        {
            if let Some(h) = guard.as_ref()
            {
                log::info!("[boot] splash fade trigger fired — starting fade-out");
                h.start_fade();
            }
        }
        Err(_) => {}
    };
}

#[tauri::command]
pub fn shell_ready(app: tauri::AppHandle) -> Result<(), String>
{
    log::info!("shell_ready IPC received from JS");

    // Debug-only: MPS_DELAY_SHELL_READY_MS=<n> keeps the Rust native splash up
    // for n additional milliseconds before showing the main window. Lets the
    // user visually isolate the splash → WebView handoff seam while
    // diagnosing white-flash frames.
    if let Ok(raw) = std::env::var("MPS_DELAY_SHELL_READY_MS")
    {
        if let Ok(ms) = raw.trim().parse::<u64>()
        {
            if ms > 0
            {
                log::info!("MPS_DELAY_SHELL_READY_MS={} — sleeping before window show", ms);
                std::thread::sleep(Duration::from_millis(ms));
            }
        }
    }

    // Record shell_ready timestamp. First call wins; subsequent calls no-op.
    if let Some(state) = app.try_state::<SplashState>()
    {
        if let Ok(mut guard) = state.shell_ready_at.lock()
        {
            if guard.is_none()
            {
                *guard = Some(Instant::now());
            }
        }
    }

    // Show the WebView window (created hidden). show() + set_focus() are
    // idempotent — calling twice is cheap and safe. The watchdog in
    // build_main_window can race us here on very slow boots; that's fine.
    // Splash fade is DEFERRED to `max(shell_ready+500ms, shell_composited)`.
    if let Some(win) = app.get_webview_window("main")
    {
        let _ = win.show();
        let _ = win.set_focus();
    }

    // Schedule the 500ms half of the fade gate. On the tick, if
    // shell_composited has also arrived, the fade starts. Plain std
    // thread (not the async runtime) — no dep on tokio being enabled
    // in Cargo.toml, and a 500ms sleep on a throwaway thread is cheap.
    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        try_start_fade(&app_handle);
    });

    Ok(())
}

#[tauri::command]
pub fn shell_composited(app: tauri::AppHandle) -> Result<(), String>
{
    log::info!("shell_composited IPC received from JS — arming splash fade gate");

    if let Some(state) = app.try_state::<SplashState>()
    {
        if let Ok(mut guard) = state.shell_composited_at.lock()
        {
            if guard.is_none()
            {
                *guard = Some(Instant::now());
            }
        }
    }

    // Attempt to start the fade. If shell_ready fired > 500ms ago the
    // delayed task has already run — this call satisfies the gate now.
    // If shell_ready is newer than 500ms, this call is a no-op and the
    // delayed task will trigger it.
    try_start_fade(&app);

    Ok(())
}
