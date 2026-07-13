//! Force-onboarding gate. Returns `true` iff the current launch should force
//! the onboarding flow regardless of the persisted `onboardingCompleted`
//! flag in user-settings.json.
//!
//! Precedence (first hit wins):
//!   1. MPS_FORCE_ONBOARDING=1 env var
//!   2. `--onboarding` CLI argument (passed after Tauri's `--` separator)
//!   3. false (respect the persisted flag)
//!
//! Called once at boot by the JS bootstrap. Cheap — no I/O, no state.

#[tauri::command]
pub fn app_should_force_onboarding() -> Result<bool, String>
{
    if std::env::var("MPS_FORCE_ONBOARDING").ok().as_deref() == Some("1")
    {
        return Ok(true);
    }
    if std::env::args().any(|a| a == "--onboarding")
    {
        return Ok(true);
    }
    Ok(false)
}
