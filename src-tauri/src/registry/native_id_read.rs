//! Platform-native ID readers.
//!
//! Each [`NativeIdBackend::read`] reads a stable OS-provided identity token
//! from an **already-open** `File` handle. Reading from the handle (rather
//! than the path) is TOCTOU-safe: the value corresponds to the actual inode
//! we opened, even if a rename happens between path resolution and open.
//!
//! # Trait boundary
//!
//! The desktop/mobile split was carved as [`NativeIdBackend`] with per-target
//! zero-sized structs implementing it. [`ActiveBackend`] is a `type` alias
//! resolved at compile time to the correct backend for the current target.
//! The free function [`read_native_id`] stays as a thin delegate so existing
//! callers (`resolve.rs`, `scan.rs`) don't churn.
//!
//! # Coverage
//!
//! - Linux / BSD → [`posix::PosixBackend`] → [`NativeId::Posix { dev, ino }`].
//! - macOS → [`apfs::ApfsBackend`] → [`NativeId::Apfs`] with a
//!   `dev:<st_dev>` placeholder `volume_uuid`. Proper APFS volume UUID needs
//!   `statfs` FFI which is deferred.
//! - Windows → [`ntfs::NtfsBackend`] → [`NativeId::Unknown`] placeholder. The
//!   real `GetFileInformationByHandleEx(FileIdInfo)` path is deferred.
//! - iOS → [`ios_bookmark::IosBookmarkBackend`] → [`NativeId::Unknown`]
//!   placeholder. Real security-scoped bookmark reader lands via a Tauri
//!   mobile plugin.
//! - Android → [`saf::SafBackend`] → [`NativeId::Unknown`] placeholder. Real
//!   SAF reader lands via a Tauri mobile plugin.

use std::fs::File;

use crate::registry::native_id::NativeId;

// ---------------------------------------------------------------------------
// Trait boundary
// ---------------------------------------------------------------------------

/// Platform-specific reader for a stable native file ID.
///
/// One implementor per target OS; the active one is aliased as
/// [`ActiveBackend`] and picked at compile time via `#[cfg]`.
///
/// `locate_by_native_id` in `resolve.rs` intentionally stays a free function
/// — it walks the FS tree and calls [`Self::read`] per entry, so it doesn't
/// need to be part of the trait.
pub trait NativeIdBackend
{
    /// Read the native ID from an already-open file handle.
    fn read(&self, handle: &File) -> Result<NativeId, String>;
}

// ---------------------------------------------------------------------------
// Linux / BSD (POSIX fallback)
// ---------------------------------------------------------------------------

#[cfg(all(unix, not(any(target_os = "macos", target_os = "ios", target_os = "android"))))]
mod posix
{
    use super::*;

    /// POSIX backend — reads `(st_dev, st_ino)` from the open handle.
    ///
    /// The resolver treats tmpfs / overlayfs / NFS as untrusted for identity —
    /// that decision is made at the resolver layer, not here.
    #[derive(Default)]
    pub struct PosixBackend;

    impl NativeIdBackend for PosixBackend
    {
        fn read(&self, f: &File) -> Result<NativeId, String>
        {
            use std::os::unix::fs::MetadataExt;

            let meta = f.metadata().map_err(|e| format!("native-id-read:metadata:{}", e))?;
            Ok(NativeId::Posix
            {
                dev: meta.dev(),
                ino: meta.ino(),
            })
        }
    }
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod apfs
{
    use super::*;

    /// APFS backend — reads `(st_dev, st_ino)` from the open handle.
    ///
    /// The `volume_uuid` is a `dev:<st_dev>` placeholder — proper APFS volume
    /// UUIDs need a `statfs` FFI call which is deferred. The `dev:` prefix
    /// keeps the value distinguishable from a real UUID and stable across
    /// the same mounted volume, which is what the registry compares.
    ///
    /// `gen` is stored as 0 until we thread the APFS generation counter
    /// through `getattrlist` (deferred with the volume-UUID work).
    #[derive(Default)]
    pub struct ApfsBackend;

    impl NativeIdBackend for ApfsBackend
    {
        fn read(&self, f: &File) -> Result<NativeId, String>
        {
            use std::os::unix::fs::MetadataExt;

            let meta = f.metadata().map_err(|e| format!("native-id-read:metadata:{}", e))?;
            Ok(NativeId::Apfs
            {
                volume_uuid: format!("dev:{}", meta.dev()),
                ino: meta.ino(),
                gen: 0,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Windows (placeholder)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod ntfs
{
    use super::*;

    /// NTFS backend — placeholder that returns [`NativeId::Unknown`].
    ///
    /// The resolver treats `Unknown` as "cannot verify" and proceeds without
    /// healing — see [`crate::registry::resolve::resolve_and_open`].
    ///
    /// Consequence: until this returns a real
    /// `Ntfs { volume_serial, file_id }`, the registry cannot detect files
    /// that were renamed while the app was closed — any file at the cached
    /// path is trusted.
    #[derive(Default)]
    pub struct NtfsBackend;

    impl NativeIdBackend for NtfsBackend
    {
        fn read(&self, _f: &File) -> Result<NativeId, String>
        {
            // Deferred: implement via GetFileInformationByHandleEx(FileIdInfo)
            // — needs a `windows-sys` Cargo dep.
            Ok(NativeId::Unknown)
        }
    }
}

// ---------------------------------------------------------------------------
// iOS (deferred to uuid-registry-mobile follow-up)
// ---------------------------------------------------------------------------

#[cfg(target_os = "ios")]
mod ios_bookmark
{
    use super::*;

    /// iOS security-scoped bookmark backend — stub.
    ///
    /// Real impl: `NSURL bookmarkDataWithOptions:.withSecurityScope` via a
    /// Tauri mobile plugin. Compiles today so the mobile target link-checks;
    /// until the plugin lands, `.read()` returns [`NativeId::Unknown`] — the
    /// same "cannot verify" fallback used by the Windows placeholder, so the
    /// resolver takes its cached-path-trusted branch instead of panicking on
    /// first FS scan.
    #[derive(Default)]
    pub struct IosBookmarkBackend;

    impl NativeIdBackend for IosBookmarkBackend
    {
        fn read(&self, _f: &File) -> Result<NativeId, String>
        {
            // Deferred: real security-scoped bookmark reader via Tauri mobile plugin.
            Ok(NativeId::Unknown)
        }
    }
}

// ---------------------------------------------------------------------------
// Android (deferred to uuid-registry-mobile follow-up)
// ---------------------------------------------------------------------------

#[cfg(target_os = "android")]
mod saf
{
    use super::*;

    /// Android SAF backend — stub.
    ///
    /// Real impl: `DocumentsContract.getTreeDocumentId` +
    /// `takePersistableUriPermission` via a Tauri mobile plugin. Compiles
    /// today so the mobile target link-checks; until the plugin lands,
    /// `.read()` returns [`NativeId::Unknown`] — the same "cannot verify"
    /// fallback used by the Windows placeholder, so the resolver takes its
    /// cached-path-trusted branch instead of panicking on first FS scan.
    #[derive(Default)]
    pub struct SafBackend;

    impl NativeIdBackend for SafBackend
    {
        fn read(&self, _f: &File) -> Result<NativeId, String>
        {
            // Deferred: real SAF-backed reader via Tauri mobile plugin.
            Ok(NativeId::Unknown)
        }
    }
}

// ---------------------------------------------------------------------------
// Active backend — picked at compile time.
// ---------------------------------------------------------------------------

#[cfg(all(unix, not(any(target_os = "macos", target_os = "ios", target_os = "android"))))]
pub type ActiveBackend = posix::PosixBackend;

#[cfg(target_os = "macos")]
pub type ActiveBackend = apfs::ApfsBackend;

#[cfg(target_os = "windows")]
pub type ActiveBackend = ntfs::NtfsBackend;

#[cfg(target_os = "ios")]
pub type ActiveBackend = ios_bookmark::IosBookmarkBackend;

#[cfg(target_os = "android")]
pub type ActiveBackend = saf::SafBackend;

// ---------------------------------------------------------------------------
// Free-function wrapper — source-compat shim for existing call sites.
// ---------------------------------------------------------------------------

/// Read the native ID from an open handle using the active platform backend.
///
/// Thin delegate over [`ActiveBackend::default`] + [`NativeIdBackend::read`].
/// Kept as a free function so callers in `resolve.rs` / `scan.rs` don't need
/// to instantiate a backend. New code may use the trait directly.
pub fn read_native_id(f: &File) -> Result<NativeId, String>
{
    ActiveBackend::default().read(f)
}
