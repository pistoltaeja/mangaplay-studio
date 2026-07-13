//! File-operations commands: copy / delete / trash / create / rename, plus
//! art-cleanup helpers, FS event types, and filename utilities. Extracted
//! from lib.rs verbatim — no behaviour changes.

pub mod crud;
pub mod fs_events;
pub mod trash;
