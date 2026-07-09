// @ts-check
/**
 * state-machine.js — explicit numbered FSM for the OAuth flow.
 *
 * Numbered transitions matter for log readability and crash analytics:
 * every transition writes `[mps:auth] step N → step M, { class }` so a
 * failed sign-in can be traced from the JS console without ambiguity.
 *
 * 0 IDLE
 * 1 BUILDING_URL       (generate verifier, challenge, state nonce)
 * 2 AWAITING_BROWSER   (auth_open_browser fired; user is in the consent UI)
 * 3 AWAITING_REDIRECT  (60s deadline; cancelled → IDLE)
 * 4 PARSING_REDIRECT   (state nonce CSRF check)
 * 5 EXCHANGING         (POST to BFF /v1/oauth/token w/ PKCE)
 * 6 FETCHING_PROFILE   (GET userinfo)
 * 7 PERSISTING         (keyring + user-settings write)
 * 8 AUTHENTICATED      (steady state; TTL countdown active)
 * 9 REFRESHING         (silent prompt=none; on 401)
 * 10 REVOKING          (logout: revoke token + clear store)
 */

export const STATES = Object.freeze({
    IDLE: 0,
    BUILDING_URL: 1,
    AWAITING_BROWSER: 2,
    AWAITING_REDIRECT: 3,
    PARSING_REDIRECT: 4,
    EXCHANGING: 5,
    FETCHING_PROFILE: 6,
    PERSISTING: 7,
    AUTHENTICATED: 8,
    REFRESHING: 9,
    REVOKING: 10,
});

const STATE_NAMES = Object.freeze({
    0: "IDLE",
    1: "BUILDING_URL",
    2: "AWAITING_BROWSER",
    3: "AWAITING_REDIRECT",
    4: "PARSING_REDIRECT",
    5: "EXCHANGING",
    6: "FETCHING_PROFILE",
    7: "PERSISTING",
    8: "AUTHENTICATED",
    9: "REFRESHING",
    10: "REVOKING",
});

/**
 * @typedef {Object} StateMachine
 * @property {() => number} getState
 * @property {(next: number, payload?: { class?: string }) => void} transition
 * @property {(handler: (state: number, payload: { class?: string }) => void) => () => void} onChange
 */

/** @returns {StateMachine} */
export function createStateMachine()
{
    let state = STATES.IDLE;
    /** @type {Set<(state: number, payload: { class?: string }) => void>} */
    const subs = new Set();

    return {
        getState()
        {
            return state;
        },
        transition(next, payload = {})
        {
            const prev = state;
            state = next;
            const cls = payload.class || null;
            console.log(`[mps:auth] step ${prev} → ${next}`, {
                from: STATE_NAMES[prev],
                to: STATE_NAMES[next],
                class: cls,
            });
            for (const s of subs)
            {
                try { s(state, payload); } catch (_) { /* best-effort */ }
            }
        },
        onChange(handler)
        {
            subs.add(handler);
            return () => subs.delete(handler);
        },
    };
}
