/// Dev-only handler for the `mpsdev://` URI scheme. Reads frontend files from
/// disk so JS/CSS/HTML edits ship without re-linking the .exe.
///
/// Resolution rules:
///   - `mpsdev://localhost/<path>` → `<FRONTEND_ROOT>/<path>`
///   - Empty/`/` path → `index.html`
///   - 404 falls back to `index.html` (SPA-style routing)
///   - 405 on non-GET
///
/// `FRONTEND_ROOT` resolution:
///   1. `MPS_FRONTEND_DIR` env var if set (used by CDP smoke tests).
///   2. `<exe parent>/../../frontend-<uxMode>/` (matches build:windows-dev layout).
///   3. `<exe parent>/frontend-<uxMode>/` (matches build:windows release layout copy).
///
/// The per-variant `frontend-<uxMode>/` directory name is baked into the
/// binary at build time from `MPS_BUILD_UX_MODE` (see build.rs). Prevents a
/// mobile-baked bundle on disk from being served to a standalone .exe when
/// both variants share the same target/exe location during iteration.
pub fn disk_frontend_handler<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
    use std::borrow::Cow;
    use tauri::http::{Response, StatusCode};

    let not_allowed = || -> Response<Cow<'static, [u8]>> {
        Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .body(Cow::Borrowed(&b"method not allowed"[..]))
            .unwrap()
    };
    if request.method() != "GET" {
        return not_allowed();
    }

    let uri = request.uri().clone();
    // Percent-decode so filenames containing reserved chars like `(` or `)`
    // (e.g. img/Google_Docs_logo_(2014-2020).svg) resolve to the real on-disk
    // file. WebView2 always sends the request with the reserved chars
    // percent-encoded, and `Uri::path()` returns them still encoded.
    let raw = uri.path().trim_start_matches('/');
    let mut path = percent_decode(raw);
    if path.is_empty() {
        path = "index.html".to_string();
    }

    // Per-UX-mode frontend dir name baked at compile time (see build.rs).
    // Falls back to "standalone" when the env wasn't set at build time
    // (matches parseUxMode() default in scripts/build-app.js).
    let ux_mode = option_env!("MPS_BUILD_UX_MODE").unwrap_or("");
    let frontend_dir_name: String = match ux_mode {
        "mobile" | "tablet" | "standalone" => format!("frontend-{}", ux_mode),
        _ => "frontend-standalone".to_string(),
    };

    let frontend_root: std::path::PathBuf = (|| {
        if let Ok(env_dir) = std::env::var("MPS_FRONTEND_DIR") {
            if !env_dir.is_empty() {
                return std::path::PathBuf::from(env_dir);
            }
        }
        let exe = std::env::current_exe().ok();
        if let Some(exe_dir) = exe.as_ref().and_then(|p| p.parent()) {
            // Candidate layouts, tried in order:
            //   A. build:windows-dev cargo output:
            //      build/mangaplay-studio/target-<mode>/x86_64-pc-windows-msvc/debug/exe
            //      → ../../../frontend-<mode>  (build/mangaplay-studio/frontend-<mode>/)
            //   B. final dev exe copy:
            //      build/mangaplay-studio/target-<mode>/MangaplayStudioDev.exe
            //      → ../frontend-<mode>  (build/mangaplay-studio/frontend-<mode>/)
            //   C. exe-sibling frontend (release-style copy):
            //      <exe-dir>/frontend-<mode>
            for candidate in &[
                exe_dir.join("..").join("..").join("..").join(&frontend_dir_name),
                exe_dir.join("..").join(&frontend_dir_name),
                exe_dir.join(&frontend_dir_name),
            ] {
                if candidate.is_dir() {
                    return candidate.clone();
                }
            }
        }
        std::path::PathBuf::from(&frontend_dir_name)
    })();

    // Canonical-path containment (defence in depth — no `..` traversal).
    let requested = frontend_root.join(&path);
    let requested_canon = requested.canonicalize();
    let root_canon = frontend_root.canonicalize();
    let in_root = match (&requested_canon, &root_canon) {
        (Ok(req), Ok(root)) => req.starts_with(root),
        _ => false,
    };

    let serve = |fs_path: &std::path::Path| -> Response<Cow<'static, [u8]>> {
        match std::fs::read(fs_path) {
            Ok(bytes) => {
                let ct = guess_content_type(fs_path);
                Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", ct)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Cow::Owned(bytes))
                    .unwrap()
            }
            Err(_) => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Cow::Borrowed(&b"not found"[..]))
                .unwrap(),
        }
    };

    if in_root && requested.is_file() {
        return serve(&requested);
    }

    // SPA-style fallback to index.html (skip if the request was already for
    // index.html — avoids infinite serving of a missing index).
    if path != "index.html" {
        let index = frontend_root.join("index.html");
        if index.is_file() {
            return serve(&index);
        }
    }

    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Cow::Owned(format!("not found: {}", path).into_bytes()))
        .unwrap()
}

use crate::util::percent::percent_decode;

fn guess_content_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js")   => "application/javascript; charset=utf-8",
        Some("mjs")  => "application/javascript; charset=utf-8",
        Some("css")  => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg")  => "image/svg+xml",
        Some("png")  => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif")  => "image/gif",
        Some("webp") => "image/webp",
        Some("ico")  => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf")  => "font/ttf",
        Some("otf")  => "font/otf",
        Some("wasm") => "application/wasm",
        Some("txt")  => "text/plain; charset=utf-8",
        Some("map")  => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}
