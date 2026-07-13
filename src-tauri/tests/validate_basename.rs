//! Cross-language parity test: drive the Rust validator from the shared
//! `core/validate-basename-fixtures.json` file. JS-side sister test lives
//! at `mangaplay-studio/tests/validate-basename.test.js`.

use app_lib::validate_basename::validate_basename;
use std::path::PathBuf;

fn fixtures_path() -> PathBuf
{
    // CARGO_MANIFEST_DIR = <repo>/mangaplay-studio/src-tauri
    let manifest = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest)
        .join("..")
        .join("..")
        .join("core")
        .join("validate-basename-fixtures.json")
}

#[derive(serde::Deserialize)]
struct Fixtures
{
    valid: Vec<String>,
    invalid: Vec<InvalidEntry>,
}

#[derive(serde::Deserialize)]
struct InvalidEntry
{
    name: String,
    reason: String,
}

fn load_fixtures() -> Fixtures
{
    let raw = std::fs::read_to_string(fixtures_path()).expect("fixtures readable");
    serde_json::from_str::<Fixtures>(&raw).expect("fixtures parse")
}

#[test]
fn all_valid_pass()
{
    let f = load_fixtures();
    for name in &f.valid
    {
        let res = validate_basename(name);
        assert!(
            res.is_ok(),
            "valid fixture rejected: {:?} → {:?}",
            name,
            res
        );
    }
}

#[test]
fn all_invalid_rejected_with_matching_reason()
{
    let f = load_fixtures();
    for entry in &f.invalid
    {
        let res = validate_basename(&entry.name);
        match res
        {
            Ok(()) =>
            {
                panic!(
                    "invalid fixture accepted: {:?} (expected reason {:?})",
                    entry.name, entry.reason
                );
            }
            Err(reason) =>
            {
                assert_eq!(
                    reason, entry.reason,
                    "wrong reason for fixture {:?}: got {:?}, expected {:?}",
                    entry.name, reason, entry.reason
                );
            }
        }
    }
}
