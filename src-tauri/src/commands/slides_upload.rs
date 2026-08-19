//! `slides_upload_images` — reserved Rust command name; upload happens in JS.
//!
//! ### Status
//!
//! The publish upload flow runs from JS in
//! `slides-upload-transport.js` (Drive files.create → Slides batchUpdate →
//! Drive files.delete cleanup). This Rust command is no longer called; it
//! stays in the invoke_handler as a reserved name so a future desktop-only
//! Rust migration can reclaim it without churn.
//!
//! Calling it returns a `"not-implemented"` error to make the historical
//! contract explicit.

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
