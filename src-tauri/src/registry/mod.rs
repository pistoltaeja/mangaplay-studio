//! UUID file registry — Rust-owned per-project identity map.
//!
//! Schema types and atomic on-disk store.
//!
//! Modules:
//! - [`native_id`] — [`NativeId`] union covering NTFS / APFS / POSIX / iOS
//!   bookmark / Android SAF / Unknown variants. Serde-tagged with `kind`.
//! - [`store`] — [`RegistryFile`] / [`RegistryEntry`] schema types plus
//!   pure `load_from_disk` / `save_atomic` helpers with `.bak` recovery
//!   and a retry-with-backoff on the final rename (mirrors
//!   [`crate::fs_helpers::atomic_write_impl`]).

pub mod fs_err;
pub mod migrate;
pub mod native_id;
pub mod native_id_read;
pub mod resolve;
pub mod scan;
pub mod state;
pub mod store;
pub mod tree_entry;

pub use fs_err::{FsErr, to_command_result};
pub use migrate::fold_artmap_into_registry;
pub use native_id::NativeId;
pub use native_id_read::{ActiveBackend, NativeIdBackend, read_native_id};
pub use resolve::{locate_by_native_id, resolve_and_open};
pub use scan::scan_and_reconcile;
pub use state::{LoadedRegistry, ProjectRegistryState, RegistryStateErr};
pub use store::{LoadErr, RegistryEntry, RegistryFile, SaveErr, load_from_disk, save_atomic};
pub use tree_entry::TreeEntryDto;
