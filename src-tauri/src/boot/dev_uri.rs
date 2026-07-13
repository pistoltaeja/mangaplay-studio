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
///   2. `<exe parent>/../../frontend/` (matches build:windows-dev layout).
///   3. `<exe parent>/frontend/` (matches build:windows release layout copy).
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
            //      build/mangaplay-studio/target/x86_64-pc-windows-msvc/debug/exe
            //      → ../../../frontend  (build/mangaplay-studio/frontend/)
            //   B. final dev exe copy:
            //      build/mangaplay-studio/target/MangaplayStudioDev.exe
            //      → ../frontend  (build/mangaplay-studio/frontend/)
            //   C. exe-sibling frontend (release-style copy):
            //      <exe-dir>/frontend
            for candidate in &[
                exe_dir.join("..").join("..").join("..").join("frontend"),
                exe_dir.join("..").join("frontend"),
                exe_dir.join("frontend"),
            ] {
                if candidate.is_dir() {
                    return candidate.clone();
                }
            }
        }
        std::path::PathBuf::from("frontend")
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

/// Percent-decode a URL path. Only `%XX` hex escapes are consumed — malformed
/// escapes are passed through as-is so a bad request 404s on the disk lookup
/// instead of surfacing as an unrelated parse error.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

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
