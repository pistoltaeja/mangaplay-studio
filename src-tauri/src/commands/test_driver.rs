//! Test HTTP server (macOS driver tests).
//!
//! On macOS, WKWebView has no CDP. When MPS_TEST_PORT is set, a tiny HTTP
//! server binds to 127.0.0.1:<port> and proxies test-runner requests into
//! the webview via Tauri's eval + IPC callback. On Windows, MPS_CDP_PORT
//! is used instead (Chrome DevTools Protocol over WebView2).
//!
//! Compiled on all platforms but only activated at runtime when the env
//! var is present — production builds never set it.

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use tauri::Manager;

/// Global map of pending eval requests. Key = request ID, value = oneshot sender.
static TEST_EVAL_PENDING: std::sync::OnceLock<StdMutex<HashMap<String, std::sync::mpsc::Sender<String>>>> =
    std::sync::OnceLock::new();

fn get_eval_pending() -> &'static StdMutex<HashMap<String, std::sync::mpsc::Sender<String>>> {
    TEST_EVAL_PENDING.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// IPC callback from JS: delivers the eval result back to the HTTP handler.
#[tauri::command]
pub fn test_eval_result(id: String, payload: String) -> Result<(), String> {
    let map = get_eval_pending().lock().map_err(|e| e.to_string())?;
    if let Some(tx) = map.get(&id) {
        let _ = tx.send(payload);
    }
    Ok(())
}

/// Start the HTTP test server on a background thread. Called from setup()
/// when MPS_TEST_PORT is set.
pub fn start_test_server(port: u16, app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        use std::io::{Read as IoRead, Write as IoWrite, BufRead, BufReader};
        use std::net::TcpListener;

        let addr = format!("127.0.0.1:{}", port);
        let listener = match TcpListener::bind(&addr) {
            Ok(l) => l,
            Err(e) => {
                log::error!("[test-server] bind failed on {}: {}", addr, e);
                return;
            }
        };
        log::info!("[test-server] listening on {}", addr);

        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(s) => s,
                Err(_) => continue,
            };
            let app = app_handle.clone();

            // Read the HTTP request (simple line-by-line parse).
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() { continue; }

            let parts: Vec<&str> = request_line.trim().splitn(3, ' ').collect();
            if parts.len() < 2 { continue; }
            let method = parts[0];
            let path = parts[1];

            // Read headers to find Content-Length.
            let mut content_length: usize = 0;
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).is_err() { break; }
                let trimmed = header.trim();
                if trimmed.is_empty() { break; }
                if let Some(val) = trimmed.strip_prefix("Content-Length:") {
                    content_length = val.trim().parse().unwrap_or(0);
                }
                if let Some(val) = trimmed.strip_prefix("content-length:") {
                    content_length = val.trim().parse().unwrap_or(0);
                }
            }

            // Read body if present.
            let body = if content_length > 0 {
                let mut buf = vec![0u8; content_length];
                let _ = reader.read_exact(&mut buf);
                String::from_utf8_lossy(&buf).to_string()
            } else {
                String::new()
            };

            // Route.
            let (status, response_body) = match (method, path) {
                ("GET", "/json/version") => {
                    ("200 OK".to_string(), r#"{"ok":true,"transport":"mps-eval"}"#.to_string())
                }
                ("GET", "/json/list") => {
                    let list = format!(
                        r#"[{{"type":"page","evalUrl":"http://127.0.0.1:{}/eval"}}]"#,
                        port
                    );
                    ("200 OK".to_string(), list)
                }
                ("POST", "/eval") => {
                    handle_eval(&app, &body)
                }
                ("POST", "/screenshot") => {
                    handle_screenshot(&app)
                }
                ("POST", "/input/mouse") => {
                    // Synthesise mouse events via JS injection.
                    handle_input_mouse(&app, &body)
                }
                ("POST", "/input/key") => {
                    // Synthesise keyboard events via JS injection.
                    handle_input_key(&app, &body)
                }
                ("POST", "/input/insertText") => {
                    handle_input_insert_text(&app, &body)
                }
                _ => {
                    ("404 Not Found".to_string(), r#"{"error":"not found"}"#.to_string())
                }
            };

            let response = format!(
                "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{}",
                status,
                response_body.len(),
                response_body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
}

/// Evaluate JS in the webview and wait for the result via IPC callback.
fn handle_eval(app: &tauri::AppHandle, body: &str) -> (String, String) {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request".into(), format!(r#"{{"error":"{}"}}"#, e)),
    };
    let expression = match parsed.get("expression").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return ("400 Bad Request".into(), r#"{"error":"missing expression"}"#.into()),
    };
    let await_promise = parsed.get("awaitPromise").and_then(|v| v.as_bool()).unwrap_or(false);

    let req_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = std::sync::mpsc::channel::<String>();

    // Register the pending request.
    {
        let mut map = get_eval_pending().lock().unwrap();
        map.insert(req_id.clone(), tx);
    }

    // Wrap the expression so the result is sent back via IPC.
    // Uses string concatenation instead of format!() because the nested
    // JS braces ({result:{type:...}}) make format!()'s {{ escaping unworkable.
    let cb = |result_expr: &str| -> String {
        let mut s = String::new();
        s.push_str(r#"window.__TAURI_INTERNALS__.invoke("test_eval_result",{id:""#);
        s.push_str(&req_id);
        s.push_str(r#"",payload:JSON.stringify({result:{type:typeof("#);
        s.push_str(result_expr);
        s.push_str(r#"),value:("#);
        s.push_str(result_expr);
        s.push_str(r#")}})})"#);
        s
    };
    let cb_err = {
        let mut s = String::new();
        s.push_str(r#"window.__TAURI_INTERNALS__.invoke("test_eval_result",{id:""#);
        s.push_str(&req_id);
        s.push_str(r#"",payload:JSON.stringify({result:{type:"error",value:__e.message}})})"#);
        s
    };
    let wrapped = if await_promise {
        let mut s = String::from("(async function(){try{const __r=await(async function(){return ");
        s.push_str(expression);
        s.push_str("})();");
        s.push_str(&cb("__r"));
        s.push_str("}catch(__e){");
        s.push_str(&cb_err);
        s.push_str("}})();");
        s
    } else {
        let mut s = String::from("(function(){try{const __r=(function(){return ");
        s.push_str(expression);
        s.push_str("})();");
        s.push_str(&cb("__r"));
        s.push_str("}catch(__e){");
        s.push_str(&cb_err);
        s.push_str("}})()");
        s
    };

    // Evaluate in the webview.
    if let Some(wv) = app.webview_windows().get("main") {
        if let Err(e) = wv.eval(&wrapped) {
            let mut map = get_eval_pending().lock().unwrap();
            map.remove(&req_id);
            return ("500 Internal Server Error".into(), format!(r#"{{"error":"eval failed: {}"}}"#, e));
        }
    } else {
        let mut map = get_eval_pending().lock().unwrap();
        map.remove(&req_id);
        return ("500 Internal Server Error".into(), r#"{"error":"no main window"}"#.into());
    }

    // Wait for the result (timeout 10s).
    match rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(payload) => {
            let mut map = get_eval_pending().lock().unwrap();
            map.remove(&req_id);
            ("200 OK".into(), payload)
        }
        Err(_) => {
            let mut map = get_eval_pending().lock().unwrap();
            map.remove(&req_id);
            ("504 Gateway Timeout".into(), r#"{"error":"eval timeout"}"#.into())
        }
    }
}

/// Screenshot endpoint. On macOS the HTTP transport skips screenshots to avoid
/// blocking the single-threaded test server on the screencapture permission
/// dialog. On Windows this endpoint is never hit (CDP handles screenshots).
fn handle_screenshot(_app: &tauri::AppHandle) -> (String, String) {
    ("501 Not Implemented".into(), r#"{"error":"screenshot skipped on this platform"}"#.into())
}

/// Synthesise mouse events via JS injection.
fn handle_input_mouse(app: &tauri::AppHandle, body: &str) -> (String, String) {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request".into(), format!(r#"{{"error":"{}"}}"#, e)),
    };
    let event_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("mousePressed");
    let x = parsed.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let y = parsed.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let button_str = parsed.get("button").and_then(|v| v.as_str()).unwrap_or("left");
    let click_count = parsed.get("clickCount").and_then(|v| v.as_u64()).unwrap_or(1);

    // Map CDP event type to DOM event type.
    let dom_type = match event_type {
        "mousePressed" => "mousedown",
        "mouseReleased" => "mouseup",
        "mouseMoved" => "mousemove",
        _ => "mousedown",
    };
    let dom_button = match button_str {
        "right" => 2,
        "middle" => 1,
        _ => 0,
    };

    let js = format!(
        r#"(function(){{const el=document.elementFromPoint({x},{y});if(!el)return false;el.dispatchEvent(new MouseEvent("{dom_type}",{{clientX:{x},clientY:{y},button:{btn},buttons:{btns},detail:{cc},bubbles:true,cancelable:true,view:window}}));if("{dom_type}"==="mouseup"){{el.dispatchEvent(new MouseEvent("click",{{clientX:{x},clientY:{y},button:{btn},bubbles:true,cancelable:true,view:window}}));}};return true;}})()"#,
        x = x, y = y, dom_type = dom_type, btn = dom_button,
        btns = if dom_type == "mousedown" { 1 << dom_button } else { 0 },
        cc = click_count,
    );

    if let Some(wv) = app.webview_windows().get("main") {
        let _ = wv.eval(&js);
    }
    ("200 OK".into(), r#"{"result":{"type":"boolean","value":true}}"#.into())
}

/// Synthesise keyboard events via JS injection.
fn handle_input_key(app: &tauri::AppHandle, body: &str) -> (String, String) {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request".into(), format!(r#"{{"error":"{}"}}"#, e)),
    };
    let event_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("keyDown");
    let key = parsed.get("key").and_then(|v| v.as_str()).unwrap_or("");
    let code = parsed.get("code").and_then(|v| v.as_str()).unwrap_or("");
    let text = parsed.get("text").and_then(|v| v.as_str()).unwrap_or("");

    let dom_type = match event_type {
        "keyDown" => "keydown",
        "keyUp" => "keyup",
        "char" => "keypress",
        _ => "keydown",
    };

    // For "char" type, also insert the text.
    let insert_part = if event_type == "char" && !text.is_empty() {
        format!(
            r#"document.execCommand("insertText",false,{});"#,
            serde_json::to_string(text).unwrap_or_else(|_| format!("\"{}\"", text))
        )
    } else {
        String::new()
    };

    let js = format!(
        r#"(function(){{const el=document.activeElement||document.body;el.dispatchEvent(new KeyboardEvent("{dom_type}",{{key:{key_json},code:{code_json},bubbles:true,cancelable:true}}));{insert}}})();"#,
        dom_type = dom_type,
        key_json = serde_json::to_string(key).unwrap_or_else(|_| format!("\"{}\"", key)),
        code_json = serde_json::to_string(code).unwrap_or_else(|_| format!("\"{}\"", code)),
        insert = insert_part,
    );

    if let Some(wv) = app.webview_windows().get("main") {
        let _ = wv.eval(&js);
    }
    ("200 OK".into(), r#"{"result":{"type":"undefined"}}"#.into())
}

/// Insert text via execCommand.
fn handle_input_insert_text(app: &tauri::AppHandle, body: &str) -> (String, String) {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request".into(), format!(r#"{{"error":"{}"}}"#, e)),
    };
    let text = parsed.get("text").and_then(|v| v.as_str()).unwrap_or("");

    let js = format!(
        r#"document.execCommand("insertText",false,{});"#,
        serde_json::to_string(text).unwrap_or_else(|_| format!("\"{}\"", text))
    );

    if let Some(wv) = app.webview_windows().get("main") {
        let _ = wv.eval(&js);
    }
    ("200 OK".into(), r#"{"result":{"type":"boolean","value":true}}"#.into())
}
