# Mangaplay Studio Auth Module

Cross-platform Google OAuth 2.0 + PKCE for the desktop and (future) mobile app.

## Auth entry points

There is **no standalone "Sign in with Google" flow** — auth is bundled
with the two features that need it.

| Entry point            | Transport        | Consent           | Identity source       |
|------------------------|------------------|-------------------|-----------------------|
| Publish Google Doc     | Loopback OAuth   | One-time, first-run | Drive `about.get`   |
| Publish Google Slides Sync | Picker OAuth (via bridge) | Per-pick (Google mandates) | Drive `about.get` |

The Publish Doc modal keeps its inline "Sign in" gate — that's the
loopback OAuth entry. The Publish Slides modal has NO gate: clicking
"Choose from Google Drive™" triggers the Picker OAuth which
auto-authenticates on the same round-trip. Google's `trigger_onepick`
beta requires `drive.file` to be the ONLY scope, which is why identity
now comes from Drive rather than `/oauth2/v3/userinfo`.

## Architecture

```
                ┌───────────────────────────────┐
                │     google-oauth.js (API)     │
                │  signIn / signOut / refresh   │
                │  switchAccount / token cache  │
                └──────────────┬────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
┌───────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ state-machine │    │   storage.js     │    │ error-classifier │
│  numbered FSM │    │  vault+settings  │    │   taxonomy       │
└───────────────┘    └──────────────────┘    └──────────────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
   ┌──────────────────────┐       ┌─────────────────────────┐
   │   pkce.js (RFC 7636) │       │ transports/ (per-OS)    │
   │  verifier+challenge  │       │  loopback-desktop.js    │
   │  + CSRF nonce        │       │  deeplink-mobile.js     │
   └──────────────────────┘       │  platform-detect.js     │
                                  └─────────────────────────┘
                                              │
                                              ▼
                                  ┌─────────────────────────┐
                                  │  Rust commands (lib.rs) │
                                  │  auth_listen_loopback   │
                                  │  auth_open_browser      │
                                  │  auth_token_store_*     │
                                  └─────────────────────────┘
```

## State machine (numbered for traceability)

| #  | State              | Notes                                                    |
|----|--------------------|----------------------------------------------------------|
| 0  | IDLE               | No flow in progress.                                     |
| 1  | BUILDING_URL       | Verifier + challenge + CSRF nonce generated.             |
| 2  | AWAITING_BROWSER   | `auth_open_browser` fired; user inside consent UI.       |
| 3  | AWAITING_REDIRECT  | 60s Rust deadline; 65s JS timeout buffer.                |
| 4  | PARSING_REDIRECT   | State nonce CSRF check.                                  |
| 5  | EXCHANGING         | POST to BFF `/v2/oauth/token` w/ PKCE.                   |
| 6  | FETCHING_PROFILE   | GET Drive `about.get` (displayName, emailAddress, photoLink, permissionId). |
| 7  | PERSISTING         | Keyring (access + refresh + id token) + user-settings.   |
| 8  | AUTHENTICATED      | Steady state; refresh fires ~60s before expiry.          |
| 9  | REFRESHING         | Refresh-token grant via BFF `/v2/oauth/refresh`.         |
| 10 | REVOKING           | Logout: revoke refresh_token via BFF `/v2/oauth/revoke`. |

Every transition logs `[mps:auth] step N → M, { class }`.

## Scope version contract

`SCOPE_VERSION = 2` in [storage.js](./storage.js) is **shared** with
[extension-fountain-studio/adapters/fps-auth.js](../../../extension-fountain-studio/adapters/fps-auth.js).

Bumping in EITHER project requires bumping in BOTH in the same commit
window. The two products share the same Google `client_id`
(`358910684774-…`), so Google's "remembered consent" carries between
them — diverging versions would force a double-prompt for any user who
uses both products.

If the products' scope lists ever diverge (e.g. Fountain+ Studio adds
`presentations` for Slides while Mangaplay stays Docs-only), split the
client at that point: separate `client_id`, independent version counters,
independent consent screens.

### Refresh-token rollout did NOT bump SCOPE_VERSION

Adding `access_type=offline` (per `TODO/AuthRefreshToken`) changes the
authorization-request parameter set but does NOT change the scope set.
The extension's `chrome.identity` flow has its own refresh machinery, so
no coordinated change with `fps-auth.js` is required for this rollout.

If a future change adds or removes a scope from `OAUTH_SCOPES` in
[google-oauth.js](./google-oauth.js), SCOPE_VERSION MUST be bumped
(both here and in `fps-auth.js`). This forces a one-time re-consent so
the stored token actually reflects the new scope set.

## Refresh-token architecture (desktop + mobile native apps)

Native apps establish long-lived sessions by storing a `refresh_token`
issued by Google at first sign-in. The token lives in the OS keyring
alongside the access token; the BFF holds the OAuth `client_secret` and
mediates every refresh + revoke so the secret never reaches the device.

```
                            ┌──────────────────────┐
                            │   Desktop / Mobile   │
                            │     (Tauri app)      │
                            └──────────┬───────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
   1. First sign-in            2. Hourly refresh         3. Sign-out
              │                        │                        │
              ▼                        ▼                        ▼
  POST /v2/oauth/token       POST /v2/oauth/refresh   POST /v2/oauth/revoke
  { code, verifier, ... }    { refresh_token, ... }   { token, ... }
              │                        │                        │
              └────────────────────────┼────────────────────────┘
                                       │
                                       ▼
                          api.absolutelyskint.com
                          (holds client_secret)
                                       │
                                       ▼
                          Google OAuth 2.0 endpoints
```

### v1 vs v2 endpoint split

| Endpoint | Caller | Behaviour |
|---|---|---|
| `/v1/oauth/token` | Chrome extensions | Strips `refresh_token` and `id_token` from response. `chrome.identity` handles its own refresh internally. |
| `/v2/oauth/token` | Native (desktop / mobile) | Returns full token set: `access_token`, `refresh_token`, `id_token`, `expires_in`, `token_type`, `scope`. |
| `/v2/oauth/refresh` | Native | Exchanges refresh_token for a fresh access_token + id_token. Returns Google's `invalid_grant` (400) when the grant is dead. |
| `/v2/oauth/revoke` | Native | RFC 7009 revoke. Prefer revoking refresh_token (invalidates the whole grant); access_token revoke leaves refresh_token alive (wrong direction). |

The Chrome extension surfaces stay on `/v1/oauth/token` to avoid
gifting them long-lived credentials they have no path to store securely.

### Indefinite session preconditions (verify before relying on)

1. **GCP consent screen MUST be `Published`**, not `Testing`. Testing
   forces a 7-day refresh-token expiry regardless of usage.
2. **OAuth client type MUST be `Desktop app` / `iOS` / `Android`**
   (installed-app), so refresh tokens issue on every sign-in. Web-app
   clients only issue refresh_token on the first consent unless
   `prompt=consent` re-forces consent every time.
3. **No Gmail scopes** in `OAUTH_SCOPES`. Mixing `mail.google.com` or
   `gmail.*` with other scopes causes Google to revoke the refresh
   token on any password change. Current scope (`drive.file`) is
   mail-free — and `drive.file` is the ONLY scope, which is what
   Google's Picker `trigger_onepick` beta requires.

If all three hold, refresh tokens are effectively indefinite (per
[Google's OAuth 2.0 expiration docs](https://developers.google.com/identity/protocols/oauth2#expiration)).

Conditions that DO end a session (by design):
- User revokes via [account.google.com/permissions](https://account.google.com/permissions).
- 6 months elapse without a successful refresh (clock resets on each).
- 100-refresh-tokens-per-account-per-client limit (oldest evicted on new sign-in).
- Google Workspace admin pulls access.

### Boot-time revocation probe

`ensureRehydrated()` fires one forced-refresh round-trip to the BFF
BEFORE the UI declares "signed in." Three outcomes:

| BFF response | Local action | FSM |
|---|---|---|
| 200 + new access_token | Cache token + emit signed-in | AUTHENTICATED |
| 400 invalid_grant | `_clearSessionState` + emit signed-out | IDLE |
| Network error | Keep storage; mark `_isBootOffline`; retry on `online` event | IDLE |

**Critical**: only Google's explicit `invalid_grant` clears storage.
Network errors keep the refresh_token intact so users offline at boot
(plane, captive portal) don't lose their session.

### id_token.sub verification (best-effort)

Since `openid` is no longer requested (only `drive.file` is), Google
returns `id_token: null` on every exchange and refresh. The
`_extractIdTokenSub` verification path is gated behind
`if (idToken != null)` and is a no-op in steady state; the code stays
in place so a future scope change that re-introduces `openid` picks up
the check automatically. Stable per-account identity is now
`permissionId` from Drive `about.get`.

### Single-flight coordination

The boot probe AND `getAccessToken()` both populate `_refreshInFlight`
with a `Promise<RefreshResult>`. Concurrent callers during boot or
mid-session token rotation share a single BFF round-trip rather than
firing N parallel refreshes against the same refresh_token (which
Google would 429-throttle).

## Transports

| Transport         | Platforms             | Status         |
|-------------------|-----------------------|----------------|
| loopback-desktop  | Windows / macOS / Linux | Working      |
| deeplink-mobile   | iOS / Android         | Skeleton only  |

The desktop transport binds `127.0.0.1:0` (per RFC 8252 §7.3) via the
Rust `auth_listen_loopback` command, opens the system browser via
`auth_open_browser`, and listens for `app:auth-redirect` events from
Rust.

The mobile transport requires `tauri-plugin-web-auth`
(`ASWebAuthenticationSession` on iOS / Chrome Custom Tabs on Android) —
the skeleton ships today with `// TODO mobile:` markers at the spots
that need filling in.

## Callback page contract

The HTML served by the Rust loopback listener
([`auth_success_page_html` in lib.rs](../../src-tauri/src/lib.rs)) is
rendered the instant Google redirects to `127.0.0.1:<port>` — BEFORE
the JS side exchanges the code with the BFF, BEFORE keyring writes,
and BEFORE id_token.sub verification.

**The page MUST NOT claim sign-in success.** Any copy along the lines
of "you're signed in" / "authentication successful" is a lie at this
point in the flow — a downstream failure (network drop mid-exchange,
BFF 5xx, Windows Credential Manager 2560-char limit, sub mismatch)
will leave the user staring at a success page while the app shows
them as signed out.

Neutral copy is enforced by [`tests/auth_success_page.rs`](../../src-tauri/tests/auth_success_page.rs):

- forbidden substrings: `signed in`, `sign-in successful`,
  `authentication successful`, `window.close`, `self.close(`,
  `top.close(`
- required: `<!doctype html>`, the embedded mascot data URI, and
  either "return to mangaplay studio" or "close this tab"

After Rust accepts the loopback connection and writes the response,
the main window is **raised + focused** (`unminimize()` + `set_focus()`
at lib.rs `auth_listen_loopback`) BEFORE `app:auth-redirect` fires.
The user's attention shifts back to the app while JS runs the exchange,
so failures land in the app banner with the window already in front.

If the exchange itself fails, the JS `_runFlow` catch invokes the
`auth_raise_window` command (lib.rs) as a second nudge:
`unminimize` + `set_focus` + `request_user_attention(Informational)`.
The attention flag is the last-resort fallback on focus-steal-strict
window managers (GNOME, macOS).

### Deferred — Linux sandboxed launchers

`auth_open_browser` on Linux honours `$BROWSER` first (POSIX
convention) and falls back to `tauri-plugin-opener::open_url` which wraps
`xdg-open` / xdg-desktop-portal. When both fail under a sandboxed
runtime, the error includes a `(Flatpak)` / `(Snap)` tag (detected via
`FLATPAK_ID` / `SNAP` env vars) so the surface error tells support
which path collapsed. Spawning a hard-coded browser binary directly
is intentionally NOT done — it cannot escape the sandbox and would
just shift the failure.

### Deferred — IPv6 `[::1]` listener

Skipped. Google's loopback flow uses a literal IPv4 redirect URI
(`http://127.0.0.1:<port>`), so the browser never performs DNS
resolution that could prefer `::1`. Re-evaluate if a real bug report
surfaces.

### Deferred — release-process signing

- **Windows SmartScreen**: requires OV or EV code-signing certificate.
  Tracked separately; not a code change.
- **macOS Gatekeeper**: requires Apple Developer ID + notarization.
  Tracked separately; not a code change.

## Privacy contract

Analytics events flow through
`https://api.absolutelyskint.com/v1/log` via
[../analytics/google-auth.js](../analytics/google-auth.js). The
`diagnostic` field returned by [error-classifier.js](./error-classifier.js)
is truncated to 200 chars.

- NO access tokens, NO refresh tokens.
- NO email addresses, NO doc IDs, NO doc content.
- `permissionId` (opaque Drive per-account ID, stable) IS allowed.
