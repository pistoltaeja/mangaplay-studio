//! `slides_upload_images` — server-side reference stub.
//!
//! ### Status
//!
//! The publish upload flow currently runs the Google Drive `files.create`
//! and Slides `presentations.batchUpdate` calls from the JS side using
//! `fetch`. This mirrors how `commitSlidesSync` does image downloads —
//! JS owns HTTP so Rust doesn't need to link an HTTP client (`reqwest` /
//! `hyper` etc. are NOT current deps of `src-tauri`, per the picker
//! transport rule in `.claude/rules/mangaplay-studio-app.md`).
//!
//! This module exists so `lib.rs`'s `invoke_handler!` can register the
//! `slides_upload_images` name today. Calling it currently returns a
//! `"not-implemented"` error; JS callers must use the direct fetch path
//! in `slides-prepare.js::commitLocalUpload`.
//!
//! ### Future work
//!
//! When a project-wide HTTP client is introduced (documented `reqwest`
//! addition + Android-target split), the actual upload — temp Drive file
//! create, `presentations.batchUpdate`, temp file cleanup — moves here.
//!
//! Desktop-only in intent: the `#[cfg(not(target_os = "android"))]` gate
//! matches the picker-transport rule. On Android the command returns the
//! same "not-implemented" error; there is currently no way to publish
//! from mobile anyway (see `capabilities/android.json` which omits
//! `shell:*`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct UploadItem
{
    #[serde(rename = "pageId")]
    pub page_id: String,
    #[serde(rename = "slidePageId")]
    pub slide_page_id: Option<String>,
    /// PNG bytes base64-encoded — matches the transport pattern used by
    /// `slides_deck_write` for its `Vec<u8>` payload.
    #[serde(rename = "pngBytesB64")]
    pub png_bytes_b64: String,
    /// `"replace"` (replace an existing image object) or `"create-append"`
    /// (append a new slide with the image).
    pub mode: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadFailure
{
    #[serde(rename = "pageId")]
    pub page_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadReport
{
    pub uploaded: Vec<String>,
    pub failed: Vec<UploadFailure>,
}

/// Reference stub. Returns a `not-implemented` error so JS callers know
/// to run the fetch-based fallback in `slides-prepare.js`. Present in
/// `invoke_handler!` so the command name is bookable even before the
/// upload path lands in Rust.
#[tauri::command]
pub async fn slides_upload_images(
    presentation_id: String,
    uploads: Vec<UploadItem>,
    token: String,
) -> Result<UploadReport, String>
{
    let _ = (presentation_id, uploads, token);
    Err("not-implemented".into())
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests
{
    use super::*;

    #[test]
    fn stub_report_shape_roundtrips()
    {
        // The command itself is `async` and we don't want to pull in a
        // runtime for a stub test. Exercise the serialisation contract
        // instead — this is what JS callers unmarshal.
        let r = UploadReport
        {
            uploaded: vec!["1".into(), "2".into()],
            failed: vec![UploadFailure { page_id: "3".into(), reason: "http-403".into() }],
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"uploaded\""));
        assert!(json.contains("\"failed\""));
        assert!(json.contains("\"pageId\":\"3\""));
    }
}
