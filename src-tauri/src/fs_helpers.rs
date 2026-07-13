//! Filesystem helpers shared by the Tauri commands.
//!
//! Kept pure (no AppHandle, no event emission) so integration tests can
//! exercise them in a tempdir without a Tauri runtime.

use std::path::Path;

/// Trash `path` on desktop, fall back to a hard remove on Android.
///
/// Android has no recycle-bin; the trash crate isn't even in the
/// Android dependency set (see Cargo.toml per-target sections). Same
/// stable error shape on both branches so call sites stay symmetric.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn trash_or_remove(path: &Path) -> Result<(), String> {
    _trash_impl(path).map_err(|e| format!("trash-error:{}", e))
}

/// macOS: use NsFileManager to avoid the "wants to control Finder" Automation
/// permission dialog. Trade-off: trashed files lose Finder's "Put Back"
/// (longstanding macOS bug). Other platforms: default Finder/shell method.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn _trash_impl(path: &Path) -> Result<(), trash::Error> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(path)
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn trash_or_remove(path: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        std::fs::remove_dir_all(path).map_err(|e| format!("delete-error:{}", e))
    } else {
        std::fs::remove_file(path).map_err(|e| format!("delete-error:{}", e))
    }
}

/// Returns the next free filename under `parent` for `base` + `ext_chain`.
///
/// `ext_chain` is the **entire** extension suffix string — so
/// `next_free_name(parent, "Untitled", ".mangaplay.md", 1)` correctly handles
/// the double-suffix case (`.mangaplay.md` is one chain, not two extensions).
///
/// When `start == 1` the bare name (without a number) is tried first. If
/// taken, numbering begins at 2 (we never produce "Foo 1.ext"). For any
/// `start > 1` the bare-name probe is skipped and numbering begins at
/// `start.max(2)`.
///
/// Pathological fallback: if every candidate up to 9999 is taken, a
/// unix-timestamp-suffixed name is returned so the caller never blocks.
pub fn next_free_name(
    parent: &Path,
    base: &str,
    ext_chain: &str,
    start: u32,
) -> String
{
    if start == 1
    {
        let candidate = format!("{}{}", base, ext_chain);
        if !parent.join(&candidate).exists()
        {
            return candidate;
        }
    }
    let first = start.max(2);
    for n in first..10_000
    {
        let candidate = format!("{} {}{}", base, n, ext_chain);
        if !parent.join(&candidate).exists()
        {
            return candidate;
        }
    }
    // Pathological fallback: timestamp.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{} {}{}", base, ts, ext_chain)
}

/// Atomic write: write to `<path>.tmp`, fsync, then rename to `<path>`.
/// Exposed as a pure helper so Rust integration tests can exercise it
/// without spinning up Tauri.
///
/// The rename step retries with backoff (0/50/150/450 ms) to survive
/// transient Windows AV-lock contention on the destination file; create +
/// write are not retried because the rename is the documented contention
/// point. Worst-case added latency: +650 ms on the calling Tauri command
/// thread.
pub fn atomic_write_impl(path: &str, contents: &str) -> Result<(), String> {
    use std::io::Write;

    let tmp_path = format!("{}.tmp", path);
    let mut file = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
    file.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;

    let mut last_err = String::new();
    for delay_ms in [0u64, 50, 150, 450] {
        if delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
        match std::fs::rename(&tmp_path, &path) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

pub fn chrono_iso_now() -> String {
    chrono::Utc::now().to_rfc3339()
}
