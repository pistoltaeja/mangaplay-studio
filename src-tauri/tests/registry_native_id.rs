//! Unit tests for the `NativeIdBackend` trait boundary (Part 6).
//!
//! Verifies that `ActiveBackend::default().read()` on the host platform
//! returns a well-formed `NativeId` variant. On the WSL Linux host used by
//! this repo's CI, the active backend is `PosixBackend` and we assert a
//! `NativeId::Posix { dev, ino }` with non-zero `ino`.

use std::fs::File;
use std::io::Write;

use app_lib::registry::{ActiveBackend, NativeId, NativeIdBackend};

#[test]
fn active_backend_reads_native_id_from_real_file()
{
    let tmp = std::env::temp_dir().join(format!(
        "mps-native-id-test-{}.bin",
        std::process::id()
    ));

    {
        let mut f = File::create(&tmp).expect("create temp file");
        f.write_all(b"hello").expect("write");
    }

    let f = File::open(&tmp).expect("open temp file");
    let id = ActiveBackend::default().read(&f).expect("read native id");

    #[cfg(all(unix, not(any(target_os = "macos", target_os = "ios", target_os = "android"))))]
    {
        match id
        {
            NativeId::Posix { ino, .. } =>
            {
                assert!(ino != 0, "expected non-zero inode on POSIX host");
            }
            other => panic!("expected NativeId::Posix on POSIX host, got {:?}", other),
        }
    }

    #[cfg(target_os = "macos")]
    {
        match id
        {
            NativeId::Apfs { ino, .. } =>
            {
                assert!(ino != 0, "expected non-zero inode on macOS host");
            }
            other => panic!("expected NativeId::Apfs on macOS host, got {:?}", other),
        }
    }

    #[cfg(target_os = "windows")]
    {
        match id
        {
            NativeId::Unknown =>
            {}
            other => panic!("expected NativeId::Unknown on Windows host (stub), got {:?}", other),
        }
    }

    let _ = std::fs::remove_file(&tmp);
}
