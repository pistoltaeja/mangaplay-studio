//! Windows-only platform shims.
//!
//! Other OS platforms should mirror this layout: add a sibling
//! `platform/macos.rs` or `platform/linux.rs` gated by the matching
//! `#[cfg(target_os = "...")]` and re-export from `platform/mod.rs` (or
//! `platform.rs`).

#![cfg(target_os = "windows")]

// SAFETY (unsafe_code allow): single Win32 call into `user32!GetAsyncKeyState`.
// No pointer arithmetic, no out-params, no resource ownership. The function
// is documented thread-safe (queries the calling thread's async key state).
// Kept as hand-rolled FFI because pulling `windows-sys` solely for one
// keyboard query inflates compile time more than the audit win is worth.
#[allow(unsafe_code)]
pub fn shift_is_held() -> bool {
    // GetAsyncKeyState(VK_SHIFT). High bit set ⇒ key currently down.
    // Avoid pulling the full winapi crate by linking the function manually.
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAsyncKeyState(vkey: i32) -> i16;
    }
    const VK_SHIFT: i32 = 0x10;
    unsafe { (GetAsyncKeyState(VK_SHIFT) as u16 & 0x8000) != 0 }
}
