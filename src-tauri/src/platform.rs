//! Platform-specific shims.
//!
//! Each submodule is gated by `#![cfg(target_os = "...")]` at the file
//! top. Add new platforms as sibling files (`macos.rs`, `linux.rs`) and
//! declare them here with the matching `#[cfg]` attribute.

#[cfg(target_os = "windows")]
pub mod win32;
