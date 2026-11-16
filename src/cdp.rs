//! Chrome's DevTools pipe: NUL-delimited JSON on fds 3 (commands) and 4 (replies and events). Events of a tab's
//! session, and of the child sessions (out-of-process iframes, workers) auto-attached under it, go to that tab's
//! stream; browser-level events go to `browser_events`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use browse_core::{CdpError, CdpEvent};
use serde_json::{Value, json};
use tokio::sync::{broadcast, oneshot};

#[derive(Debug, Clone)]
pub struct BrowserEvent {
    pub method: String,
    pub params: Value,
}

struct Route {
    root: String,
    events: broadcast::Sender<CdpEvent>,
}

#[derive(Default)]
struct Routes {
    sessions: HashMap<String, Route>,
    /// Targets being attached, whose session isn't known yet.
    targets: HashMap<String, broadcast::Sender<CdpEvent>>,
}

type Reply = oneshot::Sender<Result<Value, CdpError>>;

pub struct Connection {
    out: std::sync::mpsc::Sender<Vec<u8>>,
    pending: Mutex<HashMap<i64, Reply>>,
    next: AtomicI64,
    closed: AtomicBool,
    routes: Mutex<Routes>,
    browser_events: Mutex<Option<broadcast::Sender<BrowserEvent>>>,
}

pub fn frame(message: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(message).unwrap_or_default();
    bytes.push(0);
    bytes
}

pub fn error_of(error: &Value) -> CdpError {
    let message = error["message"].as_str().unwrap_or("CDP error").to_string();
    if message.contains("Session with given id not found") || message.contains("No target with given id") || message.contains("Target closed") {
        CdpError::TargetClosed
    } else {
        CdpError::Protocol(match error.get("data").and_then(Value::as_str) {
            Some(data) => format!("{message}: {data}"),
            None => message,
        })
    }
}

impl Connection {
    pub fn open(input: OwnedFd, output: OwnedFd) -> (Arc<Connection>, broadcast::Receiver<BrowserEvent>) {
        let (out, outgoing) = std::sync::mpsc::channel::<Vec<u8>>();
        let (browser_events, browser_rx) = broadcast::channel(1024);
        let connection = Arc::new(Connection {
            out,
            pending: Mutex::new(HashMap::new()),
            next: AtomicI64::new(1),
            closed: AtomicBool::new(false),
            routes: Mutex::new(Routes::default()),
            browser_events: Mutex::new(Some(browser_events)),
        });
        std::thread::Builder::new()
            .name("cdp-write".into())
            .spawn(move || {
                let mut pipe = std::fs::File::from(input);
                for bytes in outgoing {
                    if pipe.write_all(&bytes).is_err() {
                        break;
                    }
                }
            })
            .expect("cdp writer thread");
        let reader = connection.clone();
        std::thread::Builder::new()
            .name("cdp-read".into())
            .spawn(move || {
                let mut pipe = BufReader::with_capacity(1 << 20, std::fs::File::from(output));
                let mut message = Vec::new();
                loop {
                    message.clear();
                    match pipe.read_until(0, &mut message) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if message.last() == Some(&0) {
                                message.pop();
                            }
                            if let Ok(value) = serde_json::from_slice::<Value>(&message) {
                                reader.dispatch(value);
                            }
                        }
                    }
                }
                reader.close();
            })
            .expect("cdp reader thread");
        (connection, browser_rx)
    }

    pub fn closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        for (_, reply) in self.pending.lock().unwrap().drain() {
            let _ = reply.send(Err(CdpError::Disconnected));
        }
        let mut routes = self.routes.lock().unwrap();
        routes.sessions.clear();
        routes.targets.clear();
        self.browser_events.lock().unwrap().take();
    }

    fn dispatch(&self, message: Value) {
        if let Some(id) = message.get("id").and_then(Value::as_i64) {
            if let Some(reply) = self.pending.lock().unwrap().remove(&id) {
                let _ = reply.send(match message.get("error") {
                    Some(error) => Err(error_of(error)),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                });
            }
            return;
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else { return };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let child = params.get("sessionId").and_then(Value::as_str).map(str::to_string);
        match message.get("sessionId").and_then(Value::as_str) {
            Some(session) => {
                let mut routes = self.routes.lock().unwrap();
                let Some(route) = routes.sessions.get(session) else { return };
                let events = route.events.clone();
                let root = route.root.clone();
                match (method, &child) {
                    ("Target.attachedToTarget", Some(child)) => {
                        routes.sessions.insert(child.clone(), Route { root: root.clone(), events: events.clone() });
                    }
                    ("Target.detachedFromTarget", Some(child)) => {
                        routes.sessions.remove(child);
                    }
                    _ => {}
                }
                drop(routes);
                let session_id = (session != root).then(|| session.to_string());
                let _ = events.send(CdpEvent { method: method.to_string(), params, session_id });
            }
            None => {
                {
                    let mut routes = self.routes.lock().unwrap();
                    match (method, &child) {
                        ("Target.attachedToTarget", Some(child)) => {
                            let target = params["targetInfo"]["targetId"].as_str().unwrap_or_default();
                            if let Some(events) = routes.targets.remove(target) {
                                routes.sessions.insert(child.clone(), Route { root: child.clone(), events });
                            }
                        }
                        ("Target.detachedFromTarget", Some(child)) => {
                            routes.sessions.retain(|session, route| session != child && route.root != *child);
                        }
                        _ => {}
                    }
                }
                if let Some(events) = self.browser_events.lock().unwrap().as_ref() {
                    let _ = events.send(BrowserEvent { method: method.to_string(), params });
                }
            }
        }
    }

    /// Routes the events of the session `target` is about to be attached on (and its children) to `events`.
    pub fn expect_target(&self, target: &str, events: broadcast::Sender<CdpEvent>) {
        self.routes.lock().unwrap().targets.insert(target.to_string(), events);
    }

    /// Stops routing a tab's sessions, which closes its event stream once nothing else holds it.
    pub fn forget_session(&self, root: &str) {
        let mut routes = self.routes.lock().unwrap();
        routes.sessions.retain(|_, route| route.root != root);
    }

    pub fn forget_target(&self, target: &str) {
        self.routes.lock().unwrap().targets.remove(target);
    }

    pub async fn send(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, CdpError> {
        if self.closed() {
            return Err(CdpError::Disconnected);
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, reply);
        let params = if params.is_null() { json!({}) } else { params };
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        if self.out.send(frame(&message)).is_err() || self.closed() {
            self.pending.lock().unwrap().remove(&id);
            return Err(CdpError::Disconnected);
        }
        answer.await.unwrap_or(Err(CdpError::Disconnected))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn frames_with_a_nul() {
        assert_eq!(frame(&json!({ "id": 1 })), b"{\"id\":1}\0");
    }

    #[test]
    fn maps_errors() {
        assert!(matches!(error_of(&json!({ "code": -32001, "message": "Session with given id not found." })), CdpError::TargetClosed));
        match error_of(&json!({ "code": -32000, "message": "Cannot navigate", "data": "bad url" })) {
            CdpError::Protocol(message) => assert_eq!(message, "Cannot navigate: bad url"),
            other => panic!("{other:?}"),
        }
    }

    /// A fake Chrome on the other end of two pipes.
    struct Peer {
        commands: std::fs::File,
        events: std::fs::File,
    }

    impl Peer {
        fn start() -> (Arc<Connection>, broadcast::Receiver<BrowserEvent>, Peer) {
            let (commands_read, commands_write) = crate::process::pipe().unwrap();
            let (events_read, events_write) = crate::process::pipe().unwrap();
            let (connection, browser) = Connection::open(commands_write, events_read);
            (connection, browser, Peer { commands: std::fs::File::from(commands_read), events: std::fs::File::from(events_write) })
        }

        fn read(&mut self) -> Value {
            let mut bytes = Vec::new();
            let mut byte = [0u8];
            loop {
                self.commands.read_exact(&mut byte).unwrap();
                if byte[0] == 0 {
                    return serde_json::from_slice(&bytes).unwrap();
                }
                bytes.push(byte[0]);
            }
        }

        fn write(&mut self, message: Value) {
            self.events.write_all(&frame(&message)).unwrap();
        }
    }

    #[tokio::test]
    async fn replies_routes_and_fails_pending_calls_when_chrome_exits() {
        let (connection, mut browser, mut peer) = Peer::start();
        let (tab_events, mut tab) = broadcast::channel(16);
        connection.expect_target("T1", tab_events);
        let sending = tokio::spawn({
            let connection = connection.clone();
            async move { connection.send("Page.enable", Value::Null, Some("S1")).await }
        });
        let command = tokio::task::spawn_blocking(move || {
            let command = peer.read();
            (peer, command)
        });
        let (mut peer, command) = command.await.unwrap();
        assert_eq!(command["method"], "Page.enable");
        assert_eq!(command["sessionId"], "S1");
        assert_eq!(command["params"], json!({}));
        peer.write(json!({ "method": "Target.attachedToTarget", "params": { "sessionId": "S1", "targetInfo": { "targetId": "T1", "type": "page" } } }));
        peer.write(json!({ "method": "Page.loadEventFired", "params": {}, "sessionId": "S1" }));
        peer.write(json!({ "method": "Target.attachedToTarget", "params": { "sessionId": "C1", "targetInfo": { "targetId": "F1", "type": "iframe" } }, "sessionId": "S1" }));
        peer.write(json!({ "method": "Page.frameNavigated", "params": {}, "sessionId": "C1" }));
        peer.write(json!({ "method": "Page.loadEventFired", "params": {}, "sessionId": "OTHER" }));
        peer.write(json!({ "id": command["id"], "result": { "ok": true } }));
        assert_eq!(sending.await.unwrap().unwrap(), json!({ "ok": true }));
        assert_eq!(browser.recv().await.unwrap().method, "Target.attachedToTarget");
        let first = tab.recv().await.unwrap();
        assert_eq!((first.method.as_str(), first.session_id), ("Page.loadEventFired", None));
        let attached = tab.recv().await.unwrap();
        assert_eq!((attached.method.as_str(), attached.session_id), ("Target.attachedToTarget", None));
        let child = tab.recv().await.unwrap();
        assert_eq!((child.method.as_str(), child.session_id.as_deref()), ("Page.frameNavigated", Some("C1")));

        let hanging = tokio::spawn({
            let connection = connection.clone();
            async move { connection.send("Runtime.evaluate", Value::Null, Some("S1")).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        drop(peer);
        assert!(matches!(hanging.await.unwrap(), Err(CdpError::Disconnected)));
        assert!(matches!(tab.recv().await, Err(broadcast::error::RecvError::Closed)));
        assert!(matches!(connection.send("Page.enable", Value::Null, None).await, Err(CdpError::Disconnected)));
    }
}
