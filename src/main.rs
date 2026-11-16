mod browser;
mod cdp;
mod chrome;
mod config;
mod log;
mod process;
mod temp;
mod xvfb;

use std::sync::Arc;

use anyhow::Result;
use browse_core::{Content, Tool, ToolContext};
use serde_json::{Value, json};

use crate::browser::{AgentBrowser, Launch};
use crate::config::Config;
use crate::temp::ProcessDir;
use crate::xvfb::Display;

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config::from_env()?;
    log::set_debug(config.debug);
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--smoke") => smoke(&config, &args[1..]).await,
        _ => anyhow::bail!("not yet"),
    }
}

// Temporary, until the MCP server: drives the tools in-process.
async fn smoke(config: &Config, args: &[String]) -> Result<()> {
    let parent = config.tmp_dir.clone().unwrap_or_else(std::env::temp_dir);
    let dir = ProcessDir::create(&parent)?;
    let headless = std::env::var("AGENT_BROWSER_HEADLESS").is_ok_and(|v| v == "1");
    let display = if headless { None } else { Some(Display::start(&config.xvfb, config.screen, &dir.path).await?) };
    if let Some(display) = &display {
        dir.record_display(display.number);
    }
    let window = display.as_ref().map(|d| d.work_area).unwrap_or(xvfb::WorkArea { x: 0, y: 0, width: config.screen.0, height: config.screen.1 });
    let browser = AgentBrowser::launch(Launch {
        executable: config.chrome.clone(),
        display: display.as_ref().map(|d| (d.display.clone(), d.xauthority.clone())),
        window,
        directory: dir.session_dir("smoke")?,
        extra_args: config.extra_chrome_args.clone(),
        gpu: config.gpu,
        human_input: config.human_input,
    })
    .await?;
    let ctx = ToolContext { browser: Arc::new(browser.clone()), file_roots: Vec::new() };
    let mut tools: Vec<Arc<dyn Tool>> = browse_page::tools();
    tools.extend(browse_capture::tools());
    let call = |name: &str, args: Value| {
        let tool = tools.iter().find(|t| t.spec().name == name).cloned().expect("tool");
        let ctx = ctx.clone();
        async move {
            let output = tool.call(ctx, args).await.unwrap_or_else(|e| browse_core::ToolOutput::error(format!("{e:#}")));
            let text: Vec<String> = output.content.iter().map(|c| match c {
                Content::Text { text } => text.clone(),
                Content::Image { data, mime_type } => format!("[{mime_type} {} KiB]", data.len() * 3 / 4 / 1024),
            }).collect();
            (output.is_error, text.join("\n"))
        }
    };
    let steps: Vec<(String, Value)> = serde_json::from_str(args.first().map(String::as_str).unwrap_or("[]"))?;
    for (name, mut step) in steps {
        if step.get("tab").is_none() && name != "navigate" {
            step["tab"] = json!(1);
        }
        let started = std::time::Instant::now();
        let (error, text) = call(&name, step.clone()).await;
        println!("=== {name} {step} ({} ms){}\n{text}", started.elapsed().as_millis(), if error { " ERROR" } else { "" });
    }
    browser.close().await;
    if let Some(display) = display {
        display.stop().await;
    }
    dir.remove();
    Ok(())
}
