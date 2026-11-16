mod browser;
mod cdp;
mod chrome;
mod config;
mod log;
mod mcp;
mod process;
mod sessions;
mod temp;
mod tools;
mod xvfb;

use std::sync::Arc;

use async_trait::async_trait;
use browse_core::{Content, Tool, ToolContext, ToolOutput, ToolSpec};
use serde_json::Value;

use crate::config::Config;
use crate::sessions::Sessions;

struct App {
    sessions: Arc<Sessions>,
    tools: Vec<Arc<dyn Tool>>,
}

#[async_trait]
impl mcp::Handler for App {
    fn tools(&self) -> Vec<ToolSpec> {
        let mut specs: Vec<ToolSpec> = self.tools.iter().map(|tool| tool.spec()).collect();
        specs.push(tools::close_spec());
        specs
    }

    async fn call(&self, name: &str, arguments: Value, session: &str) -> ToolOutput {
        if name == tools::CLOSE {
            return ToolOutput::text(if self.sessions.close(session).await {
                "Closed this session's browser and deleted its profile. The next call starts a fresh browser."
            } else {
                "This session had no browser open."
            });
        }
        if let Some(message) = tools::not_offered(name) {
            return ToolOutput::error(message);
        }
        let Some(tool) = self.tools.iter().find(|tool| tool.spec().name == name).cloned() else {
            return ToolOutput::error(format!("Unknown tool {name:?}."));
        };
        let listing = name == tools::TABS && arguments.get("action").and_then(Value::as_str).unwrap_or("list") == "list";
        if listing && !self.sessions.has(session) {
            return ToolOutput::text(r#"{"tabs":[]}"#);
        }
        let lease = match self.sessions.acquire(session).await {
            Ok(lease) => lease,
            Err(error) => return ToolOutput::error(format!("{error:#}")),
        };
        let ctx = ToolContext { browser: Arc::new(lease.browser.clone()), file_roots: Vec::new() };
        let mut output = tool.call(ctx, arguments).await.unwrap_or_else(|error| ToolOutput::error(format!("{error:#}")));
        if let Some(notice) = &lease.notice {
            output.content.insert(0, Content::Text { text: notice.clone() });
        }
        output
    }
}

#[tokio::main]
async fn main() {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            crate::log!("server.config-error", error = format!("{error:#}"));
            std::process::exit(2);
        }
    };
    log::set_debug(config.debug);
    let meta_key = config.session_meta_key.clone();
    crate::log!("server.started", version = mcp::VERSION, pid = std::process::id(), chrome = config.chrome, xvfb = config.xvfb);
    let sessions = match Sessions::new(config) {
        Ok(sessions) => sessions,
        Err(error) => {
            crate::log!("server.start-failed", error = format!("{error:#}"));
            std::process::exit(1);
        }
    };
    let app = Arc::new(App { sessions: sessions.clone(), tools: tools::registry() });
    let serving = mcp::serve(tokio::io::BufReader::new(tokio::io::stdin()), tokio::io::stdout(), app, meta_key);
    let signal = |kind| async move {
        match tokio::signal::unix::signal(kind) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    use tokio::signal::unix::SignalKind;
    let reason = tokio::select! {
        _ = serving => "stdin closed",
        _ = signal(SignalKind::terminate()) => "SIGTERM",
        _ = signal(SignalKind::interrupt()) => "SIGINT",
        _ = signal(SignalKind::hangup()) => "SIGHUP",
    };
    crate::log!("server.stopping", reason = reason);
    sessions.shutdown().await;
    // Calls still running hold runtime threads; don't wait for them.
    std::process::exit(0);
}
