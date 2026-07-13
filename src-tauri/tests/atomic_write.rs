//! Integration test for atomic_write_impl — exercises the real Rust I/O
//! that backs the `atomic_write_project_file` Tauri command.

use app_lib::atomic_write_impl;
use std::fs;
use std::path::PathBuf;

fn temp_path(name: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "mps-atomic-write-test-{}-{}",
        std::process::id(),
        name
    ));
    p
}

#[test]
fn writes_contents_correctly() {
    let p = temp_path("basic.md");
    let _ = fs::remove_file(&p);

    atomic_write_impl(p.to_str().unwrap(), "hello world").expect("write ok");
    let read_back = fs::read_to_string(&p).expect("read ok");
    assert_eq!(read_back, "hello world");

    // No .tmp file left behind
    let tmp = format!("{}.tmp", p.to_str().unwrap());
    assert!(
        !std::path::Path::new(&tmp).exists(),
        ".tmp file should have been renamed away"
    );

    let _ = fs::remove_file(&p);
}

#[test]
fn overwrites_existing_file_atomically() {
    let p = temp_path("overwrite.md");
    fs::write(&p, "old contents").expect("seed ok");

    atomic_write_impl(p.to_str().unwrap(), "new contents").expect("write ok");

    let read_back = fs::read_to_string(&p).expect("read ok");
    assert_eq!(read_back, "new contents");

    let _ = fs::remove_file(&p);
}

#[test]
fn errors_cleanly_on_unwritable_target() {
    let p = temp_path("nope/cannot/exist.md");
    let res = atomic_write_impl(p.to_str().unwrap(), "anything");
    assert!(res.is_err(), "writing into a non-existent parent should fail");
}
