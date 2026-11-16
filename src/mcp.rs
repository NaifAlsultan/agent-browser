//! The stdio MCP server: newline-delimited JSON-RPC 2.0, from browse's `browse mcp`. It speaks both protocol eras: a
//! pre-2026 client opens with `initialize`, and a 2026-07-28 client skips the handshake, probes with
//! `server/discover` and sends the per-request `_meta` envelope on every call. Each call belongs to the session named
//! by its `_meta` (AGENT_BROWSER_SESSION_META_KEY), or to the default session.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use browse_core::{ToolOutput, ToolSpec};
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::sessions::DEFAULT_KEY;

pub const NAME: &str = "agent-browser";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const INSTRUCTIONS: &str = include_str!("instructions.md");

/// The revision that needs no `initialize`: requests carry their own `_meta` envelope, and every result says
/// `resultType`.
const MODERN: &str = "2026-07-28";
/// What an `initialize` may negotiate, newest first.
const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const META_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_SERVER: &str = "io.modelcontextprotocol/serverInfo";

#[async_trait]
pub trait Handler: Send + Sync + 'static {
    fn tools(&self) -> Vec<ToolSpec>;
    async fn call(&self, name: &str, arguments: Value, session: &str) -> ToolOutput;
}

/// The session a request belongs to.
pub fn session_of(params: &Value, meta_key: &str) -> String {
    params
        .get("_meta")
        .and_then(|meta| meta.get(meta_key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(DEFAULT_KEY)
        .to_string()
}

/// A 2026-07-28 list result: the era's `resultType` plus the cache hints its schema requires.
fn listed(mut value: Value) -> Value {
    if let Value::Object(object) = &mut value {
        object.insert("resultType".into(), json!("complete"));
        object.insert("ttlMs".into(), json!(0));
        object.insert("cacheScope".into(), json!("private"));
    }
    value
}

/// Serves until `input` ends. Calls still running then are left to the caller's shutdown.
pub async fn serve(input: impl AsyncBufRead + Unpin, output: impl AsyncWrite + Unpin + Send + 'static, handler: Arc<dyn Handler>, meta_key: String) {
    let (out, mut outgoing) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut output = output;
        while let Some(message) = outgoing.recv().await {
            let mut text = message.to_string();
            text.push('\n');
            if output.write_all(text.as_bytes()).await.is_err() || output.flush().await.is_err() {
                break;
            }
        }
    });
    let reply = |out: &mpsc::UnboundedSender<Value>, id: Value, result: Value| {
        let _ = out.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    };
    let calls: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>> = Arc::default();
    let mut modern = false;
    let mut lines = input.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            let _ = out.send(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }));
            continue;
        };
        let method = message.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let Some(id) = message.get("id").cloned() else {
            // Notifications need no answer; a cancelled call is stopped and gets none.
            if method == "notifications/cancelled"
                && let Some(request) = params.get("requestId")
                && let Some(call) = calls.lock().unwrap().remove(&request.to_string())
            {
                call.abort();
            }
            continue;
        };
        if params.get("_meta").and_then(|meta| meta.get(META_VERSION)).and_then(Value::as_str) == Some(MODERN) {
            modern = true;
        }
        match method.as_str() {
            "initialize" => {
                modern = false;
                let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
                let version = PROTOCOLS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOLS[0]);
                reply(
                    &out,
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": { "name": NAME, "version": VERSION },
                        "instructions": INSTRUCTIONS,
                    }),
                );
            }
            "server/discover" => {
                modern = true;
                reply(
                    &out,
                    id,
                    json!({
                        "resultType": "complete",
                        "supportedVersions": [MODERN, PROTOCOLS[0], PROTOCOLS[1], PROTOCOLS[2], PROTOCOLS[3]],
                        "capabilities": { "tools": {} },
                        "instructions": INSTRUCTIONS,
                        "ttlMs": 0,
                        "cacheScope": "private",
                        "_meta": { META_SERVER: { "name": NAME, "version": VERSION } },
                    }),
                );
            }
            "ping" => reply(&out, id, if modern { json!({ "resultType": "complete" }) } else { json!({}) }),
            "tools/list" => {
                let tools = json!({ "tools": handler.tools() });
                reply(&out, id, if modern { listed(tools) } else { tools });
            }
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                let arguments = params.get("arguments").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
                let session = session_of(&params, &meta_key);
                let key = id.to_string();
                let (handler, out, calls_done) = (handler.clone(), out.clone(), calls.clone());
                let mut calls = calls.lock().unwrap();
                let task = tokio::spawn({
                    let key = key.clone();
                    async move {
                        let started = std::time::Instant::now();
                        let result = handler.call(&name, arguments, &session).await;
                        crate::debug!("tool.call", name = name, session = session, ms = started.elapsed().as_millis(), error = result.is_error);
                        if calls_done.lock().unwrap().remove(&key).is_none() {
                            return;
                        }
                        let mut value = serde_json::to_value(result).unwrap_or(Value::Null);
                        if modern && let Value::Object(object) = &mut value {
                            object.insert("resultType".into(), json!("complete"));
                        }
                        let _ = out.send(json!({ "jsonrpc": "2.0", "id": id, "result": value }));
                    }
                });
                calls.insert(key, task.abort_handle());
            }
            "resources/list" => reply(&out, id, if modern { listed(json!({ "resources": [] })) } else { json!({ "resources": [] }) }),
            "prompts/list" => reply(&out, id, if modern { listed(json!({ "prompts": [] })) } else { json!({ "prompts": [] }) }),
            _ => {
                let _ = out.send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {method}") } }));
            }
        }
    }
    drop(out);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), writer).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, BufReader, DuplexStream};

    struct Fake;

    #[async_trait]
    impl Handler for Fake {
        fn tools(&self) -> Vec<ToolSpec> {
            vec![ToolSpec { name: "echo".into(), description: "Echoes.".into(), input_schema: json!({ "type": "object" }) }]
        }

        async fn call(&self, name: &str, arguments: Value, session: &str) -> ToolOutput {
            if let Some(ms) = arguments.get("sleep").and_then(Value::as_u64) {
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
            ToolOutput::text(json!({ "name": name, "arguments": arguments, "session": session }).to_string())
        }
    }

    struct Client {
        input: DuplexStream,
        output: tokio::io::Lines<BufReader<DuplexStream>>,
    }

    impl Client {
        fn start() -> Client {
            let (input, server_input) = tokio::io::duplex(1 << 16);
            let (server_output, output) = tokio::io::duplex(1 << 16);
            tokio::spawn(serve(BufReader::new(server_input), server_output, Arc::new(Fake), "ai.opencode/sessionID".into()));
            Client { input, output: BufReader::new(output).lines() }
        }

        async fn send(&mut self, message: Value) {
            let mut text = message.to_string();
            text.push('\n');
            self.input.write_all(text.as_bytes()).await.unwrap();
        }

        async fn receive(&mut self) -> Value {
            let line = tokio::time::timeout(Duration::from_secs(5), self.output.next_line()).await.unwrap().unwrap().unwrap();
            serde_json::from_str(&line).unwrap()
        }
    }

    #[tokio::test]
    async fn initialize_lists_and_calls() {
        let mut client = Client::start();
        client.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "opencode", "version": "1" } } })).await;
        let init = client.receive().await;
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(init["result"]["serverInfo"]["name"], "agent-browser");
        assert_eq!(init["result"]["instructions"], INSTRUCTIONS);
        client.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        client.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
        let list = client.receive().await;
        assert_eq!(list["result"]["tools"][0]["name"], "echo");
        assert!(list["result"].get("resultType").is_none());
        client.send(json!({ "jsonrpc": "2.0", "id": "a", "method": "tools/call", "params": { "name": "echo", "arguments": { "x": 1 }, "_meta": { "ai.opencode/sessionID": "ses_1" } } })).await;
        let call = client.receive().await;
        assert_eq!(call["id"], "a");
        let text: Value = serde_json::from_str(call["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(text, json!({ "name": "echo", "arguments": { "x": 1 }, "session": "ses_1" }));
        assert!(call["result"].get("isError").is_none());
    }

    #[tokio::test]
    async fn an_unknown_version_gets_the_newest_and_unknown_methods_fail() {
        let mut client = Client::start();
        client.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } })).await;
        assert_eq!(client.receive().await["result"]["protocolVersion"], PROTOCOLS[0]);
        client.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "sampling/whatever" })).await;
        assert_eq!(client.receive().await["error"]["code"], -32601);
        client.input.write_all(b"not json\n").await.unwrap();
        assert_eq!(client.receive().await["error"]["code"], -32700);
    }

    #[tokio::test]
    async fn speaks_the_2026_revision_without_initialize() {
        let mut client = Client::start();
        let meta = json!({ "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { "name": "x", "version": "1" } });
        client.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": { "_meta": meta } })).await;
        let discovered = client.receive().await;
        assert_eq!(discovered["result"]["supportedVersions"][0], MODERN);
        assert_eq!(discovered["result"]["instructions"], INSTRUCTIONS);
        assert_eq!(discovered["result"]["_meta"][META_SERVER]["name"], "agent-browser");
        client.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": { "_meta": meta } })).await;
        let list = client.receive().await;
        assert_eq!((list["result"]["resultType"].as_str(), list["result"]["cacheScope"].as_str()), (Some("complete"), Some("private")));
        client.send(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "echo", "arguments": {}, "_meta": meta } })).await;
        let call = client.receive().await;
        assert_eq!(call["result"]["resultType"], "complete");
        assert!(call["result"]["content"][0]["text"].as_str().unwrap().contains("\"session\":\"default\""));
    }

    #[tokio::test]
    async fn a_cancelled_call_stops_and_gets_no_answer() {
        let mut client = Client::start();
        client.send(json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "echo", "arguments": { "sleep": 300 } } })).await;
        client.send(json!({ "jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": { "name": "echo", "arguments": { "sleep": 400 } } })).await;
        client.send(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 7, "reason": "user" } })).await;
        let answer = client.receive().await;
        assert_eq!(answer["id"], 8, "only the call that wasn't cancelled answers: {answer}");
        client.send(json!({ "jsonrpc": "2.0", "id": 9, "method": "ping" })).await;
        assert_eq!(client.receive().await["id"], 9);
    }

    #[tokio::test]
    async fn calls_run_concurrently() {
        let mut client = Client::start();
        client.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "echo", "arguments": { "sleep": 2_000 }, "_meta": { "ai.opencode/sessionID": "slow" } } })).await;
        client.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "echo", "arguments": {}, "_meta": { "ai.opencode/sessionID": "fast" } } })).await;
        let started = std::time::Instant::now();
        assert_eq!(client.receive().await["id"], 2);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(client.receive().await["id"], 1);
    }

    #[test]
    fn sessions_come_from_the_configured_meta_key() {
        let params = json!({ "_meta": { "ai.opencode/sessionID": "ses_a", "client/conversation": " c1 " } });
        assert_eq!(session_of(&params, "ai.opencode/sessionID"), "ses_a");
        assert_eq!(session_of(&params, "client/conversation"), "c1");
        assert_eq!(session_of(&params, "other"), DEFAULT_KEY);
        assert_eq!(session_of(&json!({ "_meta": { "ai.opencode/sessionID": "  " } }), "ai.opencode/sessionID"), DEFAULT_KEY);
        assert_eq!(session_of(&Value::Null, "ai.opencode/sessionID"), DEFAULT_KEY);
    }

    #[tokio::test]
    async fn ends_when_input_ends() {
        let (input, server_input) = tokio::io::duplex(1024);
        let (server_output, mut output) = tokio::io::duplex(1024);
        let serving = tokio::spawn(serve(BufReader::new(server_input), server_output, Arc::new(Fake), "k".into()));
        drop(input);
        tokio::time::timeout(Duration::from_secs(3), serving).await.unwrap().unwrap();
        let mut rest = Vec::new();
        output.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
    }
}
