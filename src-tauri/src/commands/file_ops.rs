//! File-operations commands: copy / delete / trash / create / rename, plus
//! art-cleanup helpers, FS event types, and filename utilities. Extracted
//! from lib.rs verbatim — no behaviour changes.

pub mod crud;
pub mod fs_events;
pub mod trash;

/// Shared kind→(ext_chain, seed) table for create-file. Err core is the
/// unrecognised kind string; callers format their own error variant.
pub(crate) fn kind_to_ext_and_seed(kind: &str) -> Result<(&'static str, Option<&'static str>), String>
{
    match kind
    {
        "folder" => Ok(("", None)),
        "mangaplay" => Ok((".mangaplay.md", Some("# Page 1\nPanel 1\nAction line.\n"))),
        "fountain" => Ok((".fountain.md", Some(""))),
        "superscript" => Ok((".sup.md", Some(""))),
        "text" => Ok((".txt", Some(""))),
        other => Err(other.to_string()),
    }
}
