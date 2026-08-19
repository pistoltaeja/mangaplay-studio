//! Platform-native stable-ID union used by the UUID file registry.
//!
//! This file carries the TYPES only — actual `read_native_id_from_handle`
//! implementations live behind `#[cfg]` gates in `native_id_read.rs`.
//!
//! Serde format is tag-based (`{"kind": "ntfs", ...}`) so JSON stays
//! stable + human-inspectable in `_mangaplaystudio/registry.json`.

use serde::{Deserialize, Serialize};

/// Platform-native stable file identifier.
///
/// Each variant maps to one of the target platforms' OS-provided identity
/// tokens. The registry stores exactly one variant per file entry — the
/// one that the platform on which the entry was minted was able to read.
///
/// A file's `NativeId` is compared at every open to detect external
/// rename/move/delete: mismatch triggers the healing path
/// (`locate_by_native_id`).
///
/// Variant tag matches the on-disk JSON schema. Do not rename
/// serde `kind` values without a matching migration.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Hash)]
#[serde(tag = "kind")]
pub enum NativeId
{
    /// Windows NTFS / ReFS.
    ///
    /// - `volume_serial`: `BY_HANDLE_FILE_INFORMATION::dwVolumeSerialNumber`
    ///   (32-bit) or the low 32 bits of `FILE_ID_INFO::VolumeSerialNumber`.
    /// - `file_id`: 128-bit `FILE_ID_128` rendered as a lowercase `0x…`
    ///   hex string. String (not `u128`) because JSON has no 128-bit
    ///   integer type and serde would silently truncate.
    #[serde(rename = "ntfs")]
    Ntfs
    {
        volume_serial: u32,
        file_id: String,
    },

    /// macOS APFS.
    ///
    /// - `volume_uuid`: `statfs.f_fsid` rendered as a UUID string; APFS
    ///   containers expose this directly via `getattrlist`.
    /// - `ino`: `stat.st_ino`.
    /// - `gen`: APFS generation counter — bumps on atomic-save replace
    ///   even if the path is reused, so mismatches signal "same slot,
    ///   different file".
    #[serde(rename = "apfs")]
    Apfs
    {
        volume_uuid: String,
        ino: u64,
        gen: u32,
    },

    /// Linux ext4 / xfs / btrfs fallback.
    ///
    /// Warn on tmpfs / overlayfs / NFS — inodes are unstable there. The
    /// `f_type` check + fallback to content-hash matching lives in the
    /// resolver, not here.
    #[serde(rename = "posix")]
    Posix
    {
        dev: u64,
        ino: u64,
    },

    /// iOS security-scoped bookmark.
    ///
    /// Path field on the registry entry is a display hint only when this
    /// variant is present — the blob is authoritative. Refreshed on
    /// `bookmarkDataIsStale == true` during resolve.
    #[serde(rename = "ios-bookmark")]
    IosBookmark
    {
        blob_base64: String,
    },

    /// Android SAF (Storage Access Framework).
    ///
    /// - `tree_uri`: content-URI granted via `ACTION_OPEN_DOCUMENT_TREE`.
    /// - `document_id`: stable per-file id inside that tree.
    /// - `persisted`: whether `takePersistableUriPermission` succeeded —
    ///   `false` means the grant will die at process exit and the entry
    ///   must be reconnected on next launch.
    #[serde(rename = "android-saf")]
    AndroidSaf
    {
        tree_uri: String,
        document_id: String,
        persisted: bool,
    },

    /// Cold-start fallback when no platform reader could produce a stable
    /// ID (e.g. tmpfs, NFS, unknown filesystem). Forces the resolver
    /// down the content-hash matching path.
    #[serde(rename = "unknown")]
    Unknown,
}
