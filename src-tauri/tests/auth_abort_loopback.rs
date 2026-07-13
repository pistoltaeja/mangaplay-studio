//! Unit tests for the `auth_abort_loopback` HashMap behaviour.
//!
//! We do NOT exercise the end-to-end socket lifecycle here (a real
//! TcpListener + real thread + real accept-poll would be flaky and
//! platform-specific). The load-bearing invariant is the shared
//! abort-flag HashMap: insert → abort → verify flag, plus idempotency
//! and cleanup on Drop of the guard.

use app_lib::commands::auth::{
    abort_flags_clear_for_test,
    abort_flags_contains_for_test,
    abort_flags_insert_for_test,
    abort_flags_len_for_test,
    auth_abort_loopback,
};
use std::sync::atomic::Ordering;

/// Serialise the tests — they mutate the process-global HashMap.
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn abort_sets_flag_for_known_id()
{
    let _g = TEST_LOCK.lock().unwrap();
    abort_flags_clear_for_test();

    let id = "test-abort-known".to_string();
    let flag = abort_flags_insert_for_test(&id);
    assert!(!flag.load(Ordering::Relaxed), "flag starts unset");

    let result = auth_abort_loopback(id.clone()).expect("abort ok");
    assert!(result, "abort of known id returns true");
    assert!(flag.load(Ordering::Relaxed), "flag flips to true after abort");

    abort_flags_clear_for_test();
}

#[test]
fn abort_of_unknown_id_returns_false_not_error()
{
    let _g = TEST_LOCK.lock().unwrap();
    abort_flags_clear_for_test();

    let result = auth_abort_loopback("no-such-id".to_string()).expect("abort ok");
    assert!(!result, "abort of unknown id returns Ok(false), not an error");

    abort_flags_clear_for_test();
}

#[test]
fn abort_is_idempotent()
{
    let _g = TEST_LOCK.lock().unwrap();
    abort_flags_clear_for_test();

    let id = "test-abort-idempotent".to_string();
    let flag = abort_flags_insert_for_test(&id);

    let r1 = auth_abort_loopback(id.clone()).expect("first abort ok");
    let r2 = auth_abort_loopback(id.clone()).expect("second abort ok");
    assert!(r1 && r2, "both aborts return true while id is in the map");
    assert!(flag.load(Ordering::Relaxed), "flag stays set after idempotent abort");

    abort_flags_clear_for_test();
}

#[test]
fn insert_then_manual_remove_makes_abort_return_false()
{
    // Mirrors the AbortFlagGuard Drop behaviour: once the guard drops,
    // the id is gone from the HashMap and any late abort call returns
    // Ok(false) instead of racing to flip a flag that no listener is
    // reading.
    let _g = TEST_LOCK.lock().unwrap();
    abort_flags_clear_for_test();

    let id = "test-abort-after-cleanup".to_string();
    let _flag = abort_flags_insert_for_test(&id);
    assert!(abort_flags_contains_for_test(&id));

    abort_flags_clear_for_test(); // simulates guard Drop
    assert!(!abort_flags_contains_for_test(&id));

    let r = auth_abort_loopback(id).expect("abort ok");
    assert!(!r, "abort after cleanup returns false");
    assert_eq!(abort_flags_len_for_test(), 0);
}
