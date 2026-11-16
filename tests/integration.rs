//! agent-browser over MCP with a real Chrome on Xvfb, against local pages. Skipped when Chrome or Xvfb isn't found
//! (AGENT_BROWSER_CHROME, AGENT_BROWSER_XVFB, else on PATH); the dev shell has both.

use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

fn found(variable: &str, fallback: &str) -> bool {
    let command = std::env::var(variable).unwrap_or_else(|_| fallback.to_string());
    if command.contains('/') {
        return Path::new(&command).exists();
    }
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(&command).exists()))
}

/// Each test starts its own server, Xvfb and Chromes: one at a time.
async fn serial() -> Option<tokio::sync::MutexGuard<'static, ()>> {
    if !found("AGENT_BROWSER_CHROME", "google-chrome-stable") || !found("AGENT_BROWSER_XVFB", "Xvfb") {
        eprintln!("skipped: Chrome or Xvfb not found (run in the dev shell)");
        return None;
    }
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    Some(LOCK.lock().await)
}

struct Fixtures {
    url: String,
}

/// Serves test/fixtures on 127.0.0.1; /file.bin is a download; other paths echo their query.
async fn fixtures() -> Fixtures {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test/fixtures");
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let dir = dir.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 16 * 1024];
                let n = stream.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..n]).to_string();
                let target = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (path, query) = target.split_once('?').unwrap_or((&target, ""));
                let name = if path == "/" { "form.html" } else { path.trim_start_matches('/') };
                let (headers, body) = if name == "file.bin" {
                    ("Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"file.bin\"\r\n".to_string(), vec![7u8; 4096])
                } else if let Ok(body) = std::fs::read(dir.join(name)).map_err(|_| ()).and_then(|b| if name.contains('/') { Err(()) } else { Ok(b) }) {
                    ("Content-Type: text/html; charset=utf-8\r\n".to_string(), body)
                } else {
                    let items: String = query.split('&').filter(|p| !p.is_empty()).map(|p| format!("<li>{}</li>", p.replace('<', "&lt;"))).collect();
                    (
                        "Content-Type: text/html; charset=utf-8\r\n".to_string(),
                        format!("<!doctype html><title>Echo {path}</title><h1>{path}</h1><ul>{items}</ul>").into_bytes(),
                    )
                };
                let head = format!("HTTP/1.1 200 OK\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(&body).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    Fixtures { url: format!("http://127.0.0.1:{port}") }
}

struct Server {
    child: tokio::process::Child,
    stdin: tokio::sync::Mutex<Option<tokio::process::ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next: AtomicU64,
    tmp: PathBuf,
    log: Arc<Mutex<String>>,
}

struct Output {
    error: bool,
    text: String,
    images: Vec<String>,
}

impl Server {
    async fn start(env: &[(&str, &str)]) -> Server {
        let tmp = std::env::temp_dir().join(format!("agent-browser-test-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_agent-browser"))
            .env("AGENT_BROWSER_TMPDIR", &tmp)
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Arc::default();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let routes = pending.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let message: Value = serde_json::from_str(&line).unwrap();
                if let Some(reply) = message["id"].as_u64().and_then(|id| routes.lock().unwrap().remove(&id)) {
                    let _ = reply.send(message);
                }
            }
        });
        let log = Arc::new(Mutex::new(String::new()));
        let mut errors = BufReader::new(child.stderr.take().unwrap()).lines();
        let sink = log.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = errors.next_line().await {
                if std::env::var_os("TEST_VERBOSE").is_some() {
                    eprintln!("{line}");
                }
                sink.lock().unwrap().push_str(&format!("{line}\n"));
            }
        });
        let server = Server { stdin: tokio::sync::Mutex::new(child.stdin.take()), child, pending, next: AtomicU64::new(1), tmp, log };
        let init = server
            .request("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "opencode", "version": "1" } }))
            .await;
        assert_eq!(init["result"]["serverInfo"]["name"], "agent-browser");
        server
    }

    async fn request(&self, method: &str, params: Value) -> Value {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, reply);
        let line = format!("{}\n", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        self.stdin.lock().await.as_mut().unwrap().write_all(line.as_bytes()).await.unwrap();
        match tokio::time::timeout(Duration::from_secs(120), answer).await {
            Ok(Ok(message)) => message,
            _ => panic!("no answer to {method} {params}\n{}", self.log.lock().unwrap()),
        }
    }

    async fn call(&self, name: &str, args: Value, session: &str) -> Output {
        let message = self.request("tools/call", json!({ "name": name, "arguments": args, "_meta": { "ai.opencode/sessionID": session } })).await;
        let result = &message["result"];
        let mut text = Vec::new();
        let mut images = Vec::new();
        for part in result["content"].as_array().unwrap() {
            match part["type"].as_str() {
                Some("text") => text.push(part["text"].as_str().unwrap().to_string()),
                Some("image") => images.push(part["mimeType"].as_str().unwrap().to_string()),
                _ => {}
            }
        }
        Output { error: result["isError"] == true, text: text.join("\n"), images }
    }

    async fn ok(&self, name: &str, args: Value, session: &str) -> String {
        let output = self.call(name, args.clone(), session).await;
        assert!(!output.error, "{name} {args} failed: {}", output.text);
        output.text
    }

    async fn json(&self, name: &str, args: Value, session: &str) -> Value {
        let text = self.ok(name, args, session).await;
        serde_json::from_str(&text).unwrap_or_else(|_| panic!("not JSON: {text}"))
    }

    /// The session directories (profile + home) in the server's directory.
    fn profiles(&self) -> Vec<String> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(&self.tmp).unwrap().flatten() {
            if entry.file_name().to_string_lossy().starts_with("agent-browser-") && entry.path().is_dir() {
                for inner in std::fs::read_dir(entry.path()).unwrap().flatten() {
                    if inner.path().is_dir() {
                        found.push(inner.file_name().to_string_lossy().to_string());
                    }
                }
            }
        }
        found.sort();
        found
    }

    async fn stop(mut self) -> PathBuf {
        self.stdin.lock().await.take();
        let status = tokio::time::timeout(Duration::from_secs(20), self.child.wait()).await.expect("the server didn't exit").unwrap();
        assert!(status.success(), "{status}\n{}", self.log.lock().unwrap());
        self.tmp.clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

fn rand_suffix() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64 % 1_000_000_007
}

fn ref_of(snapshot: &str, pattern: &str) -> String {
    let line = snapshot.lines().find(|line| line.contains(pattern)).unwrap_or_else(|| panic!("no {pattern} in:\n{snapshot}"));
    let start = line.find("[ref=").unwrap_or_else(|| panic!("no ref on {line}")) + 5;
    line[start..].split([' ', ']']).next().unwrap().to_string()
}

const A: &str = "ses_test_a";
const B: &str = "ses_test_b";

#[tokio::test]
async fn lists_the_tools_and_instructions() {
    let Some(_serial) = serial().await else { return };
    let server = Server::start(&[]).await;
    let init = server.request("initialize", json!({ "protocolVersion": "2025-06-18", "clientInfo": { "name": "claude-code" } })).await;
    assert!(init["result"]["instructions"].as_str().unwrap().contains("compose these tools in one script"));
    let list = server.request("tools/list", json!({})).await;
    let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        [
            "navigate",
            "snapshot",
            "click",
            "fill",
            "type",
            "press",
            "select",
            "hover",
            "drag",
            "scroll",
            "eval",
            "wait_for",
            "dialog",
            "screenshot",
            "tabs",
            "close"
        ]
    );
    let removed = server.call("execute", json!({ "code": "1" }), A).await;
    assert!(removed.error && removed.text.contains("isn't available"), "{}", removed.text);
    assert!(server.profiles().is_empty(), "nothing starts a browser before a browser tool is called");
    server.stop().await;
}

#[tokio::test]
async fn fills_a_form_hides_secrets_and_submits() {
    let Some(_serial) = serial().await else { return };
    let fixtures = fixtures().await;
    let server = Server::start(&[]).await;
    let opened = server.json("navigate", json!({ "url": format!("{}/form.html", fixtures.url) }), A).await;
    assert_eq!((opened["tab"].as_i64(), opened["title"].as_str()), (Some(1), Some("Test form")));
    let snapshot = server.ok("snapshot", json!({ "tab": 1 }), A).await;
    assert!(snapshot.contains("heading \"Sign up\""), "{snapshot}");
    server.ok("type", json!({ "tab": 1, "ref": ref_of(&snapshot, "textbox \"Name\""), "text": "Naif" }), A).await;
    server.ok("type", json!({ "tab": 1, "ref": ref_of(&snapshot, "textbox \"Email\""), "text": "naif@example.com" }), A).await;
    let filled = server
        .ok(
            "fill",
            json!({ "tab": 1, "fields": [
                { "ref": ref_of(&snapshot, "textbox \"Password\""), "value": "hunter2-secret" },
                { "ref": ref_of(&snapshot, "textbox \"Code\""), "value": "123456" },
                { "ref": ref_of(&snapshot, "textbox \"Card number\""), "value": "4111111111111111" },
                { "ref": ref_of(&snapshot, "combobox \"Country\""), "value": "United States" },
                { "ref": ref_of(&snapshot, "checkbox \"I agree\""), "checked": true },
            ] }),
            A,
        )
        .await;
    assert!(!filled.contains("hunter2") && !filled.contains("123456"), "{filled}");
    // The compact snapshot shows the values of read-only fields only, and never of secret ones.
    server.ok("eval", json!({ "tab": 1, "expression": "for (const input of document.querySelectorAll('input')) input.readOnly = true" }), A).await;
    let after = server.ok("snapshot", json!({ "tab": 1 }), A).await;
    for secret in ["hunter2", "123456", "4111111111111111"] {
        assert!(!after.contains(secret), "{secret} shows in:\n{after}");
    }
    assert!(after.contains("value=\"Naif\"") && after.contains("value=\"naif@example.com\""), "{after}");
    assert!(after.contains("selected=\"United States\"") && after.contains("checkbox \"I agree\"") && after.contains(" checked]"), "{after}");
    server.ok("eval", json!({ "tab": 1, "expression": "for (const input of document.querySelectorAll('input')) input.readOnly = false" }), A).await;
    let aria = server.ok("snapshot", json!({ "tab": 1, "mode": "aria" }), A).await;
    for secret in ["hunter2", "123456", "4111111111111111"] {
        assert!(!aria.contains(secret), "{secret} shows in the aria snapshot:\n{aria}");
    }
    let submitted = server.json("click", json!({ "tab": 1, "ref": ref_of(&after, "button \"Create account\"") }), A).await;
    let url = submitted["url"].as_str().unwrap();
    assert!(url.contains("/submitted?name=Naif&email=naif%40example.com"), "{submitted}");
    assert!(url.contains("country=us") && url.contains("terms=on"), "{submitted}");
    server.stop().await;
}

#[tokio::test]
async fn opens_popups_as_tabs_and_keeps_chrome_when_the_last_tab_closes() {
    let Some(_serial) = serial().await else { return };
    let fixtures = fixtures().await;
    let server = Server::start(&[]).await;
    server.ok("navigate", json!({ "url": format!("{}/form.html", fixtures.url) }), A).await;
    let clicked = server.json("click", json!({ "tab": 1, "selector": "text=Open in new tab" }), A).await;
    assert_eq!(clicked["newTabs"][0]["tab"], 2, "{clicked}");
    let tabs = server.json("tabs", json!({}), A).await;
    assert_eq!(tabs["tabs"][1]["opener"], 1, "{tabs}");
    assert_eq!(tabs["tabs"][1]["title"], "Test form", "{tabs}");
    let shot = server.call("screenshot", json!({ "tab": 1, "fullPage": true }), A).await;
    assert!(!shot.error && shot.images == ["image/png"], "{}", shot.text);
    let closed = server.json("tabs", json!({ "action": "close", "tabs": [1, 2] }), A).await;
    assert_eq!(closed["closed"], json!([1, 2]));
    assert_eq!(server.json("tabs", json!({}), A).await["tabs"], json!([]));
    let gone = server.call("snapshot", json!({ "tab": 1 }), A).await;
    assert!(gone.error && gone.text.contains("Tab 1 was closed"), "{}", gone.text);
    let again = server.json("navigate", json!({ "url": format!("{}/frame.html", fixtures.url) }), A).await;
    assert_eq!((again["tab"].as_i64(), again["title"].as_str()), (Some(3), Some("Frame")), "the same browser goes on");
    assert_eq!(server.profiles().len(), 1);
    server.stop().await;
}

#[tokio::test]
async fn reads_and_acts_in_frames_also_after_going_back_to_a_cached_page() {
    let Some(_serial) = serial().await else { return };
    let fixtures = fixtures().await;
    let server = Server::start(&[]).await;
    server.ok("navigate", json!({ "url": format!("{}/form.html", fixtures.url) }), A).await;
    let snapshot = server.ok("snapshot", json!({ "tab": 1 }), A).await;
    server.ok("click", json!({ "tab": 1, "ref": ref_of(&snapshot, "button \"Subscribe\"") }), A).await;
    let text = server.json("eval", json!({ "tab": 1, "frame": "iframe", "expression": "document.body.innerText" }), A).await;
    assert!(text.as_str().unwrap().contains("Subscribed!"), "{text}");

    server.ok("navigate", json!({ "tab": 1, "url": format!("{}/cross.html", fixtures.url) }), A).await;
    server.ok("wait_for", json!({ "tab": 1, "ms": 500 }), A).await;
    let cross = server.ok("snapshot", json!({ "tab": 1 }), A).await;
    assert!(cross.contains("iframe \"Other site\"") && cross.contains("button \"Subscribe\""), "{cross}");
    server.ok("eval", json!({ "tab": 1, "world": "main", "expression": "window.marker = 42" }), A).await;
    server.ok("navigate", json!({ "tab": 1, "url": format!("{}/popup.html", fixtures.url) }), A).await;
    server.ok("navigate", json!({ "tab": 1, "action": "back", "waitUntil": "commit" }), A).await;
    let marker = server.json("eval", json!({ "tab": 1, "world": "main", "expression": "window.marker" }), A).await;
    assert_eq!(marker, 42, "the page came back from the back/forward cache");
    let back = server.ok("snapshot", json!({ "tab": 1 }), A).await;
    server.ok("click", json!({ "tab": 1, "ref": ref_of(&back, "button \"Subscribe\"") }), A).await;
    let text = server.json("eval", json!({ "tab": 1, "frame": "iframe", "expression": "document.body.innerText" }), A).await;
    assert!(text.as_str().unwrap().contains("Subscribed!"), "{text}");
    server.stop().await;
}

#[tokio::test]
async fn answers_dialogs() {
    let Some(_serial) = serial().await else { return };
    let fixtures = fixtures().await;
    let server = Server::start(&[]).await;
    server.ok("navigate", json!({ "url": format!("{}/popup.html", fixtures.url) }), A).await;
    let clicked = server.json("click", json!({ "tab": 1, "selector": "role=button[name=\"Delete\"]" }), A).await;
    assert!(clicked["dialog"].to_string().contains("Delete everything?"), "{clicked}");
    server.ok("dialog", json!({ "tab": 1, "action": "dismiss" }), A).await;
    assert_eq!(server.json("eval", json!({ "tab": 1, "expression": "document.querySelector('#answer').textContent" }), A).await, "cancelled");
    server.ok("click", json!({ "tab": 1, "selector": "role=button[name=\"Delete\"]" }), A).await;
    server.ok("dialog", json!({ "tab": 1, "action": "accept" }), A).await;
    assert_eq!(server.json("eval", json!({ "tab": 1, "expression": "document.querySelector('#answer').textContent" }), A).await, "confirmed");
    server.stop().await;
}

#[tokio::test]
async fn waits_out_self_clearing_checks_and_reports_blocks_and_captchas() {
    let Some(_serial) = serial().await else { return };
    let fixtures = fixtures().await;
    let server = Server::start(&[]).await;
    let cleared = server.json("navigate", json!({ "url": format!("{}/challenge.html", fixtures.url) }), A).await;
    assert_eq!(cleared["challenge"]["status"], "cleared", "{cleared}");
    assert_eq!(cleared["title"], "Test form", "{cleared}");
    let blocked = server.json("navigate", json!({ "tab": 1, "url": format!("{}/blocked.html", fixtures.url) }), A).await;
    assert_eq!((blocked["challenge"]["kind"].as_str(), blocked["challenge"]["recommendation"].as_str()), (Some("block"), Some("stop")), "{blocked}");
    assert!(blocked["warning"].as_str().unwrap().contains("refused the visit"), "{blocked}");
    let captcha = server.json("navigate", json!({ "tab": 1, "url": format!("{}/captcha.html", fixtures.url) }), A).await;
    assert_eq!((captcha["challenge"]["kind"].as_str(), captcha["challenge"]["recommendation"].as_str()), (Some("interactive"), Some("report")), "{captcha}");
    let warning = captcha["warning"].as_str().unwrap();
    assert!(warning.contains("tell the user") && !warning.contains("handoff"), "{warning}");
    server.stop().await;
}

#[tokio::test]
async fn a_stale_ref_fails_quickly() {
    let Some(_serial) = serial().await else { return };
    let fixtures = fixtures().await;
    let server = Server::start(&[]).await;
    server.ok("navigate", json!({ "url": format!("{}/form.html", fixtures.url) }), A).await;
    let button = ref_of(&server.ok("snapshot", json!({ "tab": 1 }), A).await, "button \"Create account\"");
    server.ok("eval", json!({ "tab": 1, "expression": "document.querySelector('button[type=submit]').remove()" }), A).await;
    let started = Instant::now();
    let stale = server.call("click", json!({ "tab": 1, "ref": button }), A).await;
    assert!(stale.error && stale.text.contains(&button), "{}", stale.text);
    assert!(started.elapsed() < Duration::from_secs(8), "took {:?}", started.elapsed());
    server.stop().await;
}

#[tokio::test]
async fn sessions_get_their_own_browsers_and_close_deletes_one() {
    let Some(_serial) = serial().await else { return };
    let fixtures = fixtures().await;
    let server = Server::start(&[]).await;
    let url = format!("{}/form.html", fixtures.url);
    server.ok("navigate", json!({ "url": url }), A).await;
    server.ok("eval", json!({ "tab": 1, "expression": "localStorage.setItem('who', 'a')" }), A).await;
    server.ok("navigate", json!({ "url": url }), B).await;
    assert_eq!(server.json("eval", json!({ "tab": 1, "expression": "localStorage.getItem('who')" }), B).await, Value::Null);
    assert_eq!(server.json("eval", json!({ "tab": 1, "expression": "localStorage.getItem('who')" }), A).await, "a");
    let profiles = server.profiles();
    assert!(profiles.len() == 2 && profiles[0].starts_with(A) && profiles[1].starts_with(B), "{profiles:?}");

    assert!(server.ok("close", json!({}), A).await.contains("deleted its profile"));
    assert!(server.profiles().iter().all(|p| !p.starts_with(A)));
    assert!(server.ok("close", json!({}), A).await.contains("had no browser"));
    let fresh = server.json("navigate", json!({ "url": url }), A).await;
    assert_eq!(fresh["tab"], 1);
    assert_eq!(server.json("eval", json!({ "tab": 1, "expression": "localStorage.getItem('who')" }), A).await, Value::Null);
    server.stop().await;
}

#[tokio::test]
async fn a_slow_call_in_one_session_doesnt_hold_up_another() {
    let Some(_serial) = serial().await else { return };
    let fixtures = fixtures().await;
    let server = Arc::new(Server::start(&[]).await);
    let url = format!("{}/form.html", fixtures.url);
    server.ok("navigate", json!({ "url": url }), A).await;
    server.ok("navigate", json!({ "url": url }), B).await;
    let slow = tokio::spawn({
        let server = server.clone();
        async move {
            server.ok("wait_for", json!({ "tab": 1, "text": "never there", "timeout": 6_000 }), A).await;
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = Instant::now();
    server.ok("snapshot", json!({ "tab": 1 }), B).await;
    server.ok("click", json!({ "tab": 1, "selector": "text=More" }), B).await;
    assert!(started.elapsed() < Duration::from_secs(4), "the other session waited {:?}", started.elapsed());
    assert!(!slow.is_finished());
    let _ = slow.await;
    Arc::try_unwrap(server).ok().unwrap().stop().await;
}

#[tokio::test]
async fn the_session_cap_closes_the_least_recently_used_browser() {
    let Some(_serial) = serial().await else { return };
    let fixtures = fixtures().await;
    let server = Server::start(&[("AGENT_BROWSER_MAX_SESSIONS", "2")]).await;
    let url = format!("{}/form.html", fixtures.url);
    server.ok("navigate", json!({ "url": url }), "ses_one").await;
    server.ok("navigate", json!({ "url": url }), "ses_two").await;
    server.ok("snapshot", json!({ "tab": 1 }), "ses_one").await;
    let third = server.call("navigate", json!({ "url": url }), "ses_three").await;
    assert!(!third.error && !third.text.contains("Note:"), "{}", third.text);
    let profiles = server.profiles();
    assert!(profiles.len() == 2 && profiles.iter().all(|p| !p.starts_with("ses_two")), "{profiles:?}");
    let evicted = server.call("snapshot", json!({ "tab": 1 }), "ses_two").await;
    assert!(evicted.text.starts_with("Note: this session's browser was closed to make room for another session (at most 2"), "{}", evicted.text);
    assert!(evicted.error && evicted.text.contains("no tab 1"), "{}", evicted.text);
    let next = server.call("tabs", json!({}), "ses_two").await;
    assert!(!next.text.contains("Note:"), "told only once: {}", next.text);
    server.stop().await;
}

#[tokio::test]
async fn closes_idle_browsers() {
    let Some(_serial) = serial().await else { return };
    let fixtures = fixtures().await;
    let server = Server::start(&[("AGENT_BROWSER_IDLE_TIMEOUT_MS", "2000")]).await;
    server.ok("navigate", json!({ "url": format!("{}/form.html", fixtures.url) }), A).await;
    assert_eq!(server.profiles().len(), 1);
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    server.ok("snapshot", json!({ "tab": 1 }), A).await;
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    assert_eq!(server.profiles().len(), 1, "a call resets the idle time");
    tokio::time::sleep(Duration::from_millis(2_500)).await;
    assert!(server.profiles().is_empty(), "{:?}", server.profiles());
    assert!(server.log.lock().unwrap().contains("session.idle"));
    assert_eq!(server.json("tabs", json!({}), A).await["tabs"], json!([]));
    server.stop().await;
}

#[tokio::test]
async fn refuses_downloads() {
    let Some(_serial) = serial().await else { return };
    let fixtures = fixtures().await;
    let server = Server::start(&[]).await;
    server.ok("navigate", json!({ "url": format!("{}/form.html", fixtures.url) }), A).await;
    server.ok("eval", json!({ "tab": 1, "world": "main", "expression": "const a = document.createElement('a'); a.href = '/file.bin'; a.textContent = 'Get file'; document.body.prepend(a)" }), A).await;
    server.ok("click", json!({ "tab": 1, "selector": "text=Get file" }), A).await;
    let _ = server.call("navigate", json!({ "tab": 1, "url": format!("{}/file.bin", fixtures.url) }), A).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mut written = Vec::new();
    let mut stack = vec![server.tmp.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() && !path.is_symlink() {
                stack.push(path);
            } else if name.contains("file.bin") || name.ends_with(".crdownload") {
                written.push(path);
            }
        }
    }
    assert!(written.is_empty(), "downloaded: {written:?}");
    server.stop().await;
}

fn x_sockets() -> HashMap<String, u64> {
    std::fs::read_dir("/tmp/.X11-unix")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| Some((e.file_name().to_string_lossy().to_string(), e.metadata().ok()?.ino())))
        .collect()
}

/// Processes whose command line mentions `needle`, with their DISPLAY.
fn processes_with(needle: &str) -> Vec<(u32, Option<String>)> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else { continue };
        let Ok(cmdline) = std::fs::read(entry.path().join("cmdline")) else { continue };
        if !String::from_utf8_lossy(&cmdline).contains(needle) {
            continue;
        }
        let display = std::fs::read(entry.path().join("environ"))
            .ok()
            .and_then(|env| env.split(|b| *b == 0).find_map(|var| String::from_utf8_lossy(var).strip_prefix("DISPLAY=").map(str::to_string)));
        found.push((pid, display));
    }
    found
}

#[tokio::test]
async fn stays_off_the_real_display_and_cleans_up_when_stopped() {
    let Some(_serial) = serial().await else { return };
    let before = x_sockets();
    let fixtures = fixtures().await;
    let server = Server::start(&[]).await;
    server.ok("navigate", json!({ "url": format!("{}/form.html", fixtures.url) }), A).await;
    server.ok("navigate", json!({ "url": format!("{}/form.html", fixtures.url) }), B).await;
    let tmp = server.tmp.to_string_lossy().to_string();
    let chromes = processes_with(&format!("--user-data-dir={tmp}"));
    assert!(!chromes.is_empty());
    let ours: Vec<String> = x_sockets().into_keys().filter(|name| !before.contains_key(name)).collect();
    assert_eq!(ours.len(), 1, "one Xvfb for the server: {ours:?}");
    let display = format!("/tmp/.X11-unix/{}", ours[0]);
    for (pid, shown_on) in &chromes {
        if let Some(shown_on) = shown_on {
            assert_eq!(shown_on, &display, "Chrome {pid} is on another display");
        }
    }
    let real = std::env::var("DISPLAY").ok();
    assert!(real.as_deref() != Some(display.as_str()));
    let tmp_dir = server.stop().await;
    assert!(processes_with(&format!("--user-data-dir={tmp}")).is_empty(), "Chrome outlived the server");
    let left: Vec<_> = std::fs::read_dir(&tmp_dir).unwrap().flatten().map(|e| e.file_name()).collect();
    assert!(left.is_empty(), "left behind: {left:?}");
    let after = x_sockets();
    for (name, inode) in before {
        assert_eq!(after.get(&name), Some(&inode), "/tmp/.X11-unix/{name} was replaced or removed");
    }
    assert!(!after.contains_key(&ours[0]), "the Xvfb socket is gone");
    std::fs::remove_dir(&tmp_dir).unwrap();
}
