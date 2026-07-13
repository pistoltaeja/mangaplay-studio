//! Shared filesystem basename validator (Rust side).
//!
//! Mirrors `core/validate-basename.js`. The same fixtures
//! (`core/validate-basename-fixtures.json`) drive tests on both sides — keep
//! the reason codes and rule order in sync if either is edited.
//!
//! Reason codes:
//!   empty | separator | reserved | trailing-space | trailing-dot |
//!   leading-dot | control | forbidden-char | too-long

const WIN_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Reserved app-managed basenames (case-insensitive). Keeps users from
/// creating a folder or file that would shadow the per-project app dir.
const APP_RESERVED: &[&str] = &["_MANGAPLAYSTUDIO"];

const FORBIDDEN_CHARS: &[char] = &['<', '>', ':', '"', '|', '?', '*'];

/// Validate a filesystem basename. Returns `Ok(())` if accepted,
/// otherwise `Err(reason)` with the matching reason code.
pub fn validate_basename(name: &str) -> Result<(), &'static str>
{
    if name.trim().is_empty()
    {
        return Err("empty");
    }

    // Byte length cap (UTF-8 bytes — matches the JS TextEncoder count).
    if name.len() > 200
    {
        return Err("too-long");
    }

    if name.contains('/') || name.contains('\\')
    {
        return Err("separator");
    }

    // Control character anywhere (0x00-0x1F or 0x7F).
    for c in name.chars()
    {
        let cu = c as u32;
        if cu <= 0x1F || cu == 0x7F
        {
            return Err("control");
        }
    }

    if name.starts_with('.')
    {
        return Err("leading-dot");
    }

    // Trailing checks before forbidden-char so the more specific reason wins.
    let last = name.chars().last().unwrap();
    if last == ' '
    {
        return Err("trailing-space");
    }
    if last == '.'
    {
        return Err("trailing-dot");
    }

    for c in name.chars()
    {
        if FORBIDDEN_CHARS.contains(&c)
        {
            return Err("forbidden-char");
        }
    }

    // Reserved-name check (case-insensitive, with or without an extension).
    let stem = match name.find('.')
    {
        Some(i) => &name[..i],
        None => name,
    };
    let stem_upper = stem.to_ascii_uppercase();
    if WIN_RESERVED.iter().any(|r| *r == stem_upper)
    {
        return Err("reserved");
    }
    if APP_RESERVED.iter().any(|r| *r == stem_upper)
    {
        return Err("reserved");
    }

    Ok(())
}

#[cfg(test)]
mod tests
{
    use super::validate_basename;

    #[test]
    fn rejects_app_dir_name_case_insensitive()
    {
        assert_eq!(validate_basename("_mangaplaystudio"), Err("reserved"));
        assert_eq!(validate_basename("_MangaplayStudio"), Err("reserved"));
        assert_eq!(validate_basename("_MANGAPLAYSTUDIO"), Err("reserved"));
    }

    #[test]
    fn allows_similar_names()
    {
        assert!(validate_basename("_mangaplaystudio2").is_ok());
        assert!(validate_basename("mangaplaystudio").is_ok());
        assert!(validate_basename("_mangaplay").is_ok());
    }
}
