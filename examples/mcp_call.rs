//! Calls agent-browser's tools by hand, in order. In the dev shell:
//!   cargo run --example mcp_call -- '[["navigate", {"url": "example.com"}], ["snapshot", {"tab": 1}, "optional-session-id"]]'
//! MCP_CLIENT names the client (default mcp-call); AGENT_BROWSER_BIN runs another build, such as ./result/bin/agent-browser.

mod support;

use serde_json::Value;

fn main() {
    let steps: Vec<Vec<Value>> =
        serde_json::from_str(&std::env::args().nth(1).unwrap_or_else(|| "[]".into())).expect("steps: a JSON array of [tool, args, session?]");
    let mut client = support::Client::start(&std::env::var("MCP_CLIENT").unwrap_or_else(|_| "mcp-call".into()));
    for step in steps {
        let name = step[0].as_str().expect("tool name");
        let args = step.get(1).cloned().unwrap_or_else(|| serde_json::json!({}));
        let session = step.get(2).and_then(Value::as_str).unwrap_or("ses_cli");
        let started = std::time::Instant::now();
        let output = client.call(name, args.clone(), session);
        println!("\n=== {name} {args} ({} ms){}", started.elapsed().as_millis(), if output.error { " ERROR" } else { "" });
        println!("{}", output.text);
        for (mime, data) in &output.images {
            println!("[{mime} {} KiB]", data.len() * 3 / 4 / 1024);
        }
    }
}
