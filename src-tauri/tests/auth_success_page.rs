//! Snapshot guards for the OAuth loopback callback page.
//!
//! The page is rendered by Rust the instant Google redirects to the
//! loopback — BEFORE the JS side exchanges the code for tokens. Any
//! copy that claims "you're signed in" or auto-closes the tab is a UX
//! lie: a downstream failure (BFF 5xx, keyring write fail, sub
//! mismatch) leaves the user staring at a success page while the app
//! shows them as signed out.
//!
//! These tests lock in the neutral-copy contract so a future edit
//! can't quietly re-introduce the lying behaviour.

use app_lib::{auth_callback_page_html, auth_success_page_html};

/// Success-page strings we consider a UX lie at loopback-response time
/// — reused by both the neutral and error variants' guard tests. The
/// callback page is rendered BEFORE token exchange completes, so any
/// wording that asserts a completed sign-in is wrong regardless of
/// which variant is shown.
const FORBIDDEN_SUCCESS: &[&str] = &[
    "signed in",
    "sign-in successful",
    "sign in successful",
    "you're signed in",
    "you are signed in",
    "successfully signed in",
    "authentication successful",
];

#[test]
fn does_not_claim_sign_in_success()
{
    let html = auth_success_page_html();
    let lower = html.to_ascii_lowercase();

    // Anything that asserts the user IS signed in is a lie at this
    // point in the flow.
    for forbidden in FORBIDDEN_SUCCESS {
        assert!(
            !lower.contains(forbidden),
            "OAuth callback page must NOT claim success — found {:?}\n\nPage:\n{}",
            forbidden,
            html
        );
    }
}

#[test]
fn does_not_claim_success_on_cancelled_variant()
{
    // The cancelled variant is rendered when Google redirects with
    // `?error=access_denied` / `?error=invalid_scope`. It MUST NOT
    // slip a "signed in" phrasing in either — same neutral-copy
    // contract as the success path.
    let html = auth_callback_page_html(Some("access_denied"));
    let lower = html.to_ascii_lowercase();

    for forbidden in FORBIDDEN_SUCCESS {
        assert!(
            !lower.contains(forbidden),
            "cancelled callback page must NOT claim success — found {:?}\n\nPage:\n{}",
            forbidden,
            html
        );
    }
}

#[test]
fn renders_cancelled_copy_for_access_denied()
{
    // Both Google `access_denied` (consent-cancel) and `invalid_scope`
    // (per-scope decline) route to the cancelled variant. The H1 and
    // the "cancelled or a permission was declined" sentence are the
    // signal to the user that the flow ended without a token.
    for code in &["access_denied", "invalid_scope"] {
        let html = auth_callback_page_html(Some(code));
        assert!(
            html.contains("Sign-in cancelled"),
            "expected cancelled H1 for error={:?}, got:\n{}",
            code, html
        );
        assert!(
            html.contains("cancelled or a permission was declined"),
            "expected cancelled sentence for error={:?}, got:\n{}",
            code, html
        );
    }
}

#[test]
fn renders_generic_copy_with_escaped_error_for_unknown_code()
{
    // Any other `error=<code>` falls through to the generic variant.
    // The raw code appears verbatim inside a <code> tag so the user
    // (and support) can see what Google actually returned.
    let html = auth_callback_page_html(Some("weird_thing"));
    assert!(
        html.contains("Sign-in didn't finish"),
        "expected generic H1, got:\n{}", html
    );
    assert!(
        html.contains("weird_thing"),
        "expected raw error code to appear in generic variant, got:\n{}", html
    );
    assert!(
        html.contains("<code>weird_thing</code>"),
        "expected error code wrapped in <code>, got:\n{}", html
    );
}

#[test]
fn html_escapes_error_code()
{
    // The `error` query param is attacker-controllable — anyone who
    // can convince the user to click a crafted OAuth URL can inject
    // an arbitrary error code. It MUST be HTML-escaped before hitting
    // the response body.
    let html = auth_callback_page_html(Some("<script>alert(1)</script>"));
    assert!(
        !html.contains("<script>alert(1)</script>"),
        "raw <script> tag must NOT appear unescaped\n\nPage:\n{}", html
    );
    assert!(
        html.contains("&lt;script&gt;"),
        "expected escaped <script> in output\n\nPage:\n{}", html
    );
}

#[test]
fn does_not_attempt_self_close()
{
    let html = auth_success_page_html();
    let lower = html.to_ascii_lowercase();

    // `window.close()` is denied on Safari + Firefox for top-level
    // navigation tabs (which OAuth callback tabs always are), and is
    // inconsistent on Chrome/Edge. The timer was a near-no-op; removing
    // it eliminates a per-browser surprise.
    for forbidden in &["window.close", "self.close(", "top.close("] {
        assert!(
            !lower.contains(forbidden),
            "OAuth callback page must NOT attempt to self-close — found {:?}",
            forbidden
        );
    }
}

#[test]
fn renders_with_mascot_and_return_copy()
{
    // Sanity: the page is still a real HTML doc with the mascot and a
    // return-to-app affordance. Catches accidental wholesale deletion.
    let html = auth_success_page_html();
    assert!(html.starts_with("<!doctype html>"), "missing doctype");
    assert!(html.contains("data:image/png;base64,"), "missing mascot data URI");
    assert!(
        html.to_ascii_lowercase().contains("return to mangaplay studio")
            || html.to_ascii_lowercase().contains("close this tab"),
        "page lost its return-to-app copy"
    );
}
