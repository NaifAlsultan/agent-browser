//! A minimal MCP client for the examples: starts agent-browser (AGENT_BROWSER_BIN, else the one cargo built) and
//! calls its tools one at a time.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

pub struct Client {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next: u64,
}

pub struct Output {
    pub error: bool,
    pub text: String,
    /// (mime type, base64 data)
    pub images: Vec<(String, String)>,
}

impl Client {
    pub fn start(client_name: &str) -> Client {
        let bin = std::env::var("AGENT_BROWSER_BIN").unwrap_or_else(|_| {
            let examples = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
            examples.parent().unwrap().join("agent-browser").to_string_lossy().to_string()
        });
        let mut child =
            Command::new(&bin).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap_or_else(|e| panic!("{bin}: {e}"));
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut client = Client { child, stdin, stdout, next: 1 };
        client.request("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": client_name, "version": "0" } }));
        client
    }

    pub fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{}", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).unwrap();
        stdin.flush().unwrap();
        let mut line = String::new();
        loop {
            line.clear();
            assert!(self.stdout.read_line(&mut line).unwrap() > 0, "agent-browser exited");
            let message: Value = serde_json::from_str(&line).unwrap();
            if message["id"] == id {
                return message;
            }
        }
    }

    pub fn call(&mut self, name: &str, args: Value, session: &str) -> Output {
        let message = self.request("tools/call", json!({ "name": name, "arguments": args, "_meta": { "ai.opencode/sessionID": session } }));
        let result = &message["result"];
        let mut text = Vec::new();
        let mut images = Vec::new();
        for part in result["content"].as_array().into_iter().flatten() {
            match part["type"].as_str() {
                Some("text") => text.push(part["text"].as_str().unwrap_or_default().to_string()),
                Some("image") => {
                    images.push((part["mimeType"].as_str().unwrap_or_default().to_string(), part["data"].as_str().unwrap_or_default().to_string()))
                }
                _ => {}
            }
        }
        Output { error: result["isError"] == true, text: text.join("\n"), images }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.wait();
    }
}
