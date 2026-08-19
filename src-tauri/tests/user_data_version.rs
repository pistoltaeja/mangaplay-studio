//! Integration tests for the user-data schema-version gate. Covers:
//!
//!   - `user_settings_load_impl` transient `_isFresh` flag
//!     (set when the on-disk file did not exist; dropped after first save).
//!   - `user_data_ensure_version_impl` — fresh-stamp vs needs-decision,
//!     and the back-compat fallback that reads `appVersionCreated` when
//!     `currentVersion` is missing.
//!   - `user_data_apply_rung_impl` — happy path (patch + version bump in
//!     one write) and stale-check (refuse to write if on-disk moved past
//!     the rung's `from`).
//!   - `user_data_record_failure_impl` — writes the lastMigrationAttempt
//!     record without touching currentVersion.
//!   - `user_data_skip_rung_impl` — bumps version, clears attempt, same
//!     stale-check guard as apply_rung.
//!   - `atomic_write_impl` — survives a pre-existing stray `.tmp` file
//!     (proves the rename overwrites cleanly) and does not leave a `.tmp`
//!     behind on success.
//!
//! Tauri-handle-dependent commands acquire `SETTINGS_WRITE_LOCK` and
//! resolve a `tauri::AppHandle` to the user-data dir. The `_impl` helpers
//! tested here skip both — each test uses its own `TempDir`, so concurrent
//! cargo-test runs stay hermetic without serializing on the global mutex.

use app_lib::{
    atomic_write_impl,
    user_data_apply_rung_impl,
    user_data_ensure_version_impl,
    user_data_record_failure_impl,
    user_data_skip_rung_impl,
    user_settings_load_impl,
    user_settings_save_impl,
};
use std::fs;
use tempfile::TempDir;

// Helper: pull the packaged userDataVersion from the same compile-time
// constant that user_data_ensure_version_impl uses, so the tests don't
// hardcode a version that drifts when the resource bumps.
fn packaged_user_data_version() -> String
{
    // app-version-info.json lives alongside the binary's resources/ dir.
    // It's read at compile time via include_str! in lib.rs, but for tests
    // we re-parse the same file from disk. CARGO_MANIFEST_DIR points at
    // src-tauri/, so resources/app-version-info.json resolves identically.
    let body = fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("app-version-info.json"),
    ).expect("app-version-info.json must exist for tests");
    let v: serde_json::Value = serde_json::from_str(&body).expect("valid json");
    v.get("userDataVersion")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .expect("userDataVersion field present")
}

// ── user_settings_load_impl _isFresh transient flag ──────────────────────

#[test]
fn user_settings_load_impl_returns_is_fresh_true_for_missing_file()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    // Precondition: no file on disk.
    assert!(!dir.join("user-settings.json").exists());

    let v = user_settings_load_impl(&dir).expect("load ok");

    // Fresh-detect contract: transient flag set when the load path saw no
    // file before merge. Boot reads this via isFreshUserBoot() in JS.
    assert_eq!(
        v["_isFresh"], serde_json::Value::Bool(true),
        "_isFresh must be true when user-settings.json did not exist"
    );

    // Load must still not scaffold the file (defaults stay in-memory).
    assert!(!dir.join("user-settings.json").exists());
}

#[test]
fn user_settings_load_impl_omits_is_fresh_after_write()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    // First save creates the file. Use a known key so the patch round-trips
    // through USER_SETTINGS_KNOWN.
    user_settings_save_impl(
        &dir,
        serde_json::json!({ "lastSettingsTab": "general" }),
    ).expect("save ok");

    let v = user_settings_load_impl(&dir).expect("load ok");

    // Path existed pre-load → _isFresh must NOT appear (loader only sets
    // it when path.exists() returned false).
    assert!(
        v.get("_isFresh").is_none() || v["_isFresh"].is_null(),
        "_isFresh must be absent after a real write; got {:?}", v.get("_isFresh")
    );
}

// ── user_data_ensure_version_impl ────────────────────────────────────────

#[test]
fn user_data_ensure_version_impl_fresh_user_stamps_version()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    // No user-settings.json yet — fresh user.
    assert!(!dir.join("user-settings.json").exists());

    let res = user_data_ensure_version_impl(&dir).expect("ensure ok");
    let packaged = packaged_user_data_version();

    assert_eq!(res["result"], "fresh");
    assert_eq!(res["currentVersion"], packaged);

    // File must now exist, with createdVersion + currentVersion both set
    // to the packaged userDataVersion.
    let on_disk = user_settings_load_impl(&dir).expect("load after stamp");
    assert_eq!(on_disk["createdVersion"], packaged,
        "createdVersion stamped on fresh user");
    assert_eq!(on_disk["currentVersion"], packaged,
        "currentVersion stamped on fresh user");
    assert!(dir.join("user-settings.json").exists(),
        "fresh stamp must create the file");
}

#[test]
fn user_data_ensure_version_impl_existing_user_returns_needs_decision()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    // Existing user with the LEGACY shape: appVersionCreated present,
    // createdVersion / currentVersion absent. This is the back-compat
    // fallback path — the gate must surface "needs-decision" with onDisk
    // pulled from appVersionCreated so the JS migration ladder fires.
    user_settings_save_impl(
        &dir,
        serde_json::json!({ "appVersionCreated": "0.9.0" }),
    ).expect("seed legacy");

    let res = user_data_ensure_version_impl(&dir).expect("ensure ok");
    let packaged = packaged_user_data_version();

    assert_eq!(res["result"], "needs-decision");
    assert_eq!(res["onDisk"], "0.9.0",
        "onDisk must fall back to appVersionCreated when currentVersion missing");
    assert_eq!(res["packaged"], packaged);
}

#[test]
fn user_data_ensure_version_impl_existing_user_with_both_fields()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    // Both fields present — currentVersion MUST win over appVersionCreated.
    // Otherwise an already-migrated user would re-run the ladder on every
    // boot because the legacy field reflects the install date, not the
    // current schema version.
    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "appVersionCreated": "0.9.0",
            "createdVersion": "0.9.0",
            "currentVersion": "1.0.0",
        }),
    ).expect("seed both");

    let res = user_data_ensure_version_impl(&dir).expect("ensure ok");

    assert_eq!(res["result"], "needs-decision");
    assert_eq!(res["onDisk"], "1.0.0",
        "currentVersion must take precedence over appVersionCreated");
}

// ── user_data_apply_rung_impl ────────────────────────────────────────────

#[test]
fn user_data_apply_rung_impl_applies_patch_and_bumps_version()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    // Seed an existing user at 1.0.0.
    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "createdVersion": "1.0.0",
            "currentVersion": "1.0.0",
        }),
    ).expect("seed");

    // Apply a rung 1.0.0 → 1.1.0 that flips a known field (lastSettingsTab
    // is in USER_SETTINGS_KNOWN, so the patch survives merge).
    let res = user_data_apply_rung_impl(
        &dir,
        "1.0.0".to_string(),
        "1.1.0".to_string(),
        serde_json::json!({ "lastSettingsTab": "shortcuts" }),
    ).expect("apply ok");

    assert_eq!(res["result"], "applied");
    assert_eq!(res["currentVersion"], "1.1.0");

    let on_disk = user_settings_load_impl(&dir).expect("reload");
    assert_eq!(on_disk["currentVersion"], "1.1.0", "version bumped");
    assert_eq!(on_disk["lastSettingsTab"], "shortcuts", "patch applied");
    assert!(on_disk["lastMigrationAttempt"].is_null(),
        "lastMigrationAttempt cleared on successful apply");
}

#[test]
fn user_data_apply_rung_impl_stale_check_blocks_double_apply()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    // Seed at 1.1.0 — i.e. another window already applied this rung.
    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "createdVersion": "1.0.0",
            "currentVersion": "1.1.0",
            "lastSettingsTab": "general",
        }),
    ).expect("seed");

    // Try to apply 1.0.0 → 1.1.0 again. Stale: refuse to write.
    let res = user_data_apply_rung_impl(
        &dir,
        "1.0.0".to_string(),
        "1.1.0".to_string(),
        serde_json::json!({ "lastSettingsTab": "shortcuts" }),
    ).expect("apply returns Ok with stale payload");

    assert_eq!(res["result"], "stale");
    assert_eq!(res["onDisk"], "1.1.0");

    // The file MUST be untouched — lastSettingsTab still "general", not
    // "shortcuts". This is the load-bearing guarantee: stale rungs do not
    // mutate state.
    let on_disk = user_settings_load_impl(&dir).expect("reload");
    assert_eq!(on_disk["lastSettingsTab"], "general",
        "stale apply must not mutate the patched field");
    assert_eq!(on_disk["currentVersion"], "1.1.0",
        "stale apply must not touch currentVersion");
}

// ── user_data_record_failure_impl ────────────────────────────────────────

#[test]
fn user_data_record_failure_impl_writes_last_migration_attempt()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    // Seed at 1.0.0 — a rung tried to migrate to 1.1.0 and threw.
    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "createdVersion": "1.0.0",
            "currentVersion": "1.0.0",
        }),
    ).expect("seed");

    user_data_record_failure_impl(
        &dir,
        "1.0.0".to_string(),
        "1.1.0".to_string(),
        "boom".to_string(),
        "2026-06-30T12:00:00Z".to_string(),
        2,
    ).expect("record ok");

    let on_disk = user_settings_load_impl(&dir).expect("reload");

    // currentVersion MUST be untouched — recording a failure does not
    // advance the gate. This is what keeps the ladder retry-safe.
    assert_eq!(on_disk["currentVersion"], "1.0.0",
        "record_failure must NOT bump currentVersion");

    let attempt = &on_disk["lastMigrationAttempt"];
    assert_eq!(attempt["from"], "1.0.0");
    assert_eq!(attempt["to"], "1.1.0");
    assert_eq!(attempt["error"], "boom");
    assert_eq!(attempt["attemptedAt"], "2026-06-30T12:00:00Z");
    assert_eq!(attempt["consecutiveFailures"], 2);
}

// ── user_data_skip_rung_impl ─────────────────────────────────────────────

#[test]
fn user_data_skip_rung_impl_bumps_version_without_patch()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    // Seed at 1.0.0 with a prior failure record to prove skip clears it.
    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "createdVersion": "1.0.0",
            "currentVersion": "1.0.0",
            "lastMigrationAttempt": {
                "from": "1.0.0",
                "to": "1.1.0",
                "error": "boom",
                "attemptedAt": "2026-06-30T12:00:00Z",
                "consecutiveFailures": 2
            }
        }),
    ).expect("seed");

    let res = user_data_skip_rung_impl(
        &dir,
        "1.0.0".to_string(),
        "1.1.0".to_string(),
    ).expect("skip ok");

    assert_eq!(res["result"], "skipped");
    assert_eq!(res["currentVersion"], "1.1.0");

    let on_disk = user_settings_load_impl(&dir).expect("reload");
    assert_eq!(on_disk["currentVersion"], "1.1.0",
        "skip must bump currentVersion to the rung's `to`");
    assert!(on_disk["lastMigrationAttempt"].is_null(),
        "skip must clear lastMigrationAttempt");
}

#[test]
fn user_data_skip_rung_impl_stale_check_blocks_double_skip()
{
    let tmp = TempDir::new().expect("tempdir");
    let dir = tmp.path().to_path_buf();

    // Already at 1.1.0 — caller's stale `from` is 1.0.0.
    user_settings_save_impl(
        &dir,
        serde_json::json!({
            "createdVersion": "1.0.0",
            "currentVersion": "1.1.0",
        }),
    ).expect("seed");

    let res = user_data_skip_rung_impl(
        &dir,
        "1.0.0".to_string(),
        "1.1.0".to_string(),
    ).expect("skip returns Ok with stale payload");

    assert_eq!(res["result"], "stale");
    assert_eq!(res["onDisk"], "1.1.0");

    let on_disk = user_settings_load_impl(&dir).expect("reload");
    assert_eq!(on_disk["currentVersion"], "1.1.0",
        "stale skip must not re-bump currentVersion");
}

// ── atomic_write_impl ────────────────────────────────────────────────────

#[test]
fn atomic_write_impl_leaves_no_tmp_file_on_success()
{
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("data.json");
    let target_str = target.to_str().expect("utf8 path");

    atomic_write_impl(target_str, "first").expect("first write");
    assert_eq!(fs::read_to_string(&target).expect("read"), "first");

    // The temp sidecar MUST be gone after a successful rename — otherwise
    // a future crash mid-write could leave the OS unable to tell which
    // file is canonical.
    assert!(
        !tmp.path().join("data.json.tmp").exists(),
        "atomic_write must clean up its own .tmp sidecar on success"
    );

    // Second write hits the same path again — proves the helper is
    // idempotent and the rename overwrites cleanly.
    atomic_write_impl(target_str, "second").expect("second write");
    assert_eq!(fs::read_to_string(&target).expect("reread"), "second");
    assert!(!tmp.path().join("data.json.tmp").exists());
}

#[test]
fn atomic_write_impl_overwrites_stale_tmp_sidecar()
{
    let tmp = TempDir::new().expect("tempdir");
    let target = tmp.path().join("data.json");
    let target_str = target.to_str().expect("utf8 path");
    let tmp_path = tmp.path().join("data.json.tmp");

    // Seed a stale .tmp sidecar — simulating a crash mid-write from a
    // previous boot. The next atomic_write_impl call must succeed
    // (File::create truncates the existing .tmp) and the final file must
    // contain ONLY the new contents.
    fs::write(&tmp_path, b"stale-leftover").expect("seed stale tmp");

    atomic_write_impl(target_str, "fresh-write").expect("write must succeed despite stale tmp");

    assert_eq!(
        fs::read_to_string(&target).expect("read final"),
        "fresh-write",
        "post-rename file must reflect the fresh write, not the stale sidecar"
    );
    assert!(
        !tmp_path.exists(),
        "stale tmp sidecar must be gone after the successful rename"
    );
}
