//! The tools every client gets: browse's page tools and screenshot, and our own `tabs` and `close` (which the server
//! handles, since it ends the session's browser).

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, bail};
use async_trait::async_trait;
use browse_core::{TabOptions, Tool, ToolContext, ToolOutput, ToolSpec};
use serde_json::{Value, json};

pub const CLOSE: &str = "close";
pub const TABS: &str = "tabs";

/// browse tools agent-browser leaves out, so a call to one fails clearly.
const NOT_OFFERED: &[(&str, &str)] = &[
    ("upload", "files can't be uploaded"),
    ("emulate", "the browser presents itself as it is"),
    ("webmcp", "use the page through its own controls"),
    ("screenshot_diff", "take a screenshot and compare it yourself"),
    ("network", "requests can't be captured"),
    ("console", "the page's console can't be read"),
    ("recording", "the screen can't be recorded"),
    ("handoff", "no person watches this browser; tell the user what's needed instead"),
    ("demonstrate", "no person watches this browser"),
    ("status", "tabs lists this session's tabs"),
    ("settings", "configuration is set with AGENT_BROWSER_* variables when the server starts"),
    ("execute", "call the tools directly, or compose them in your client's code mode"),
];

pub fn not_offered(name: &str) -> Option<String> {
    NOT_OFFERED.iter().find(|(tool, _)| *tool == name).map(|(tool, instead)| format!("{tool} isn't available in agent-browser: {instead}."))
}

/// The browser tools, by name: everything but `close`.
pub fn registry() -> Vec<Arc<dyn Tool>> {
    let mut tools: Vec<Arc<dyn Tool>> = Vec::new();
    for tool in browse_page::tools().into_iter().chain(browse_capture::tools()) {
        let name = tool.spec().name;
        if not_offered(&name).is_some() {
            continue;
        }
        tools.push(match name.as_str() {
            "navigate" => Arc::new(Adjusted { inner: tool, description: Some(NAVIGATE), refused: TAB_OPTIONS }),
            "screenshot" => Arc::new(Adjusted { inner: tool, description: Some(SCREENSHOT), refused: &["path"] }),
            _ => tool,
        });
    }
    tools.push(Arc::new(TabsTool));
    tools
}

pub fn close_spec() -> ToolSpec {
    ToolSpec {
        name: CLOSE.into(),
        description: "Close this session's browser and delete its profile: its tabs, cookies and storage. Call it when you're done browsing; the next call starts a fresh browser.".into(),
        input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
    }
}

/// The tab options browse's navigate takes, which only mean something in browse's extension.
const TAB_OPTIONS: &[&str] = &["group", "allowedOrigins", "readOnly", "keepVisible", "browser"];

/// A browse tool with our description, and without arguments that don't apply here.
struct Adjusted {
    inner: Arc<dyn Tool>,
    description: Option<&'static str>,
    refused: &'static [&'static str],
}

#[async_trait]
impl Tool for Adjusted {
    fn spec(&self) -> ToolSpec {
        let mut spec = self.inner.spec();
        if let Some(description) = self.description {
            spec.description = description.into();
        }
        if let Some(properties) = spec.input_schema.get_mut("properties").and_then(Value::as_object_mut) {
            for key in self.refused {
                properties.remove(*key);
            }
        }
        spec
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> Result<ToolOutput> {
        let given: Vec<&str> = self.refused.iter().copied().filter(|key| args.get(*key).is_some_and(|v| !v.is_null())).collect();
        if !given.is_empty() {
            return Ok(ToolOutput::error(format!("{} isn't supported by agent-browser's {}", given.join(", "), self.inner.spec().name)));
        }
        self.inner.call(ctx, args).await
    }
}

const NAVIGATE: &str = "Open a page. Without `tab` it opens a new tab at `url` and returns its id as `tab`: keep it and pass it to every other tool. With `tab` it goes to `url` in that tab, or back/forward/reload, and waits for the page. Returns JSON: tab, url, title, status (the HTTP status, when known), navigated, from, and when relevant redirects, pending (a navigation still loading when the timeout hit; url is what the tab shows meanwhile), dialog, newTabs, challenge (a bot check or block page was detected; follow its warning) and warning. An HTTP error status is a result, not a failure. A bare host gets https:// (\":3000\" means http://localhost:3000); http(s), about:blank, data:, blob:, file: and view-source: URLs are used as given; javascript: (use eval) and app schemes such as mailto: or tel: are refused.";

const SCREENSHOT: &str = "Capture the tab as an image: the viewport (default), the full page, one element (a snapshot ref, including refs inside iframes, or a selector, resolved exactly like the page tools) or a rectangle (clip, viewport CSS pixels). By default image pixels are CSS pixels, so a point (x, y) in a viewport screenshot is the same (x, y) mouse tools use. Returns the image and {width, height} (actual image pixels); images are scaled down to at most 8000 px per side (a note says so). fullPage on a page taller or wider than the viewport, and clips reaching outside it, make Chrome briefly resize the page (pages see resize events); elements are scrolled into view instead when they fit. labels: true numbers the visible interactive elements on the image (drawn on the PNG, nothing is added to the page) and returns [{label, role, text, context, selector, rect:[x,y,w,h]}] so an element seen in the image can be targeted by selector or by its rect's center.";

struct TabsTool;

#[async_trait]
impl Tool for TabsTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: TABS.into(),
            description: "List, open or close this session's tabs. Tabs are the handle every other tool takes as `tab`. `list` (the default) returns each tab's id, url and title, and `opener` for popups a page opened. `new` opens a tab (at `url`, else about:blank), waits for it to load and returns it; navigate without `tab` does the same. `close` closes `tab` or `tabs`.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "new", "close"], "description": "What to do. Defaults to list." },
                    "url": { "type": "string", "description": "new: the URL to open (else about:blank)." },
                    "tab": { "type": "integer", "description": "close: the tab to close." },
                    "tabs": { "type": "array", "items": { "type": "integer" }, "description": "close: several tabs to close." },
                },
                "additionalProperties": false,
            }),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> Result<ToolOutput> {
        let text = |value: Value| ToolOutput::text(value.to_string());
        match args.get("action").and_then(Value::as_str).unwrap_or("list") {
            "list" => {
                let mut tabs = ctx.browser.tabs().await?;
                // Chrome doesn't always announce title changes.
                for tab in &mut tabs {
                    let Ok(cdp) = ctx.browser.cdp(tab.tab).await else { continue };
                    if let Ok(Ok(info)) = tokio::time::timeout(Duration::from_secs(2), cdp.send("Target.getTargetInfo", json!({}), None)).await {
                        tab.url = info["targetInfo"]["url"].as_str().unwrap_or(&tab.url).to_string();
                        tab.title = info["targetInfo"]["title"].as_str().unwrap_or(&tab.title).to_string();
                    }
                }
                Ok(text(json!({ "tabs": tabs })))
            }
            "new" => match args.get("url").and_then(Value::as_str).filter(|url| !url.trim().is_empty()) {
                // Through navigate, which checks the URL and reports bot challenges.
                Some(url) => {
                    let navigate = registry().into_iter().find(|tool| tool.spec().name == "navigate").expect("navigate");
                    navigate.call(ctx, json!({ "url": url })).await
                }
                None => Ok(text(serde_json::to_value(ctx.browser.open_tab(None, &TabOptions::default()).await?)?)),
            },
            "close" => {
                let mut picked = Vec::new();
                if let Some(tab) = args.get("tab").filter(|v| !v.is_null()) {
                    picked.push(tab.as_i64().ok_or_else(|| anyhow::anyhow!("tab must be an integer tab id, not {tab}"))?);
                }
                match args.get("tabs") {
                    None | Some(Value::Null) => {}
                    Some(Value::Array(list)) => {
                        for tab in list {
                            picked.push(tab.as_i64().ok_or_else(|| anyhow::anyhow!("tabs must be integer tab ids, not {tab}"))?);
                        }
                    }
                    Some(other) => bail!("tabs must be an array of tab ids, not {other}"),
                }
                if picked.is_empty() {
                    return Ok(ToolOutput::error("Say which tabs to close: tab or tabs. To close the whole browser, call close."));
                }
                let (mut closed, mut failed) = (Vec::new(), Vec::new());
                for tab in picked {
                    match ctx.browser.close_tab(tab).await {
                        Ok(()) => closed.push(tab),
                        Err(error) => failed.push(json!({ "tab": tab, "error": format!("{error:#}") })),
                    }
                }
                let mut output = json!({ "closed": closed });
                if !failed.is_empty() {
                    output["failed"] = json!(failed);
                }
                Ok(ToolOutput { is_error: closed.is_empty(), ..text(output) })
            }
            other => Ok(ToolOutput::error(format!("Unknown action {other:?}: use list, new or close"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_the_page_tools_screenshot_and_tabs() {
        let mut names: Vec<String> = registry().iter().map(|tool| tool.spec().name).collect();
        names.push(close_spec().name);
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
    }

    #[test]
    fn descriptions_mention_nothing_agent_browser_lacks() {
        let words = ["handoff", "extension", "lent", "allowedOrigins", "readOnly", "keepVisible", "file roots", "upload", "emulate", "webmcp", "the user's"];
        let mut specs: Vec<ToolSpec> = registry().iter().map(|tool| tool.spec()).collect();
        specs.push(close_spec());
        for spec in specs {
            let text = format!("{} {}", spec.description, spec.input_schema);
            for word in words {
                assert!(!text.contains(word), "{} mentions {word}: {text}", spec.name);
            }
        }
    }

    #[test]
    fn navigate_and_screenshot_lose_the_arguments_that_dont_apply() {
        let specs: Vec<ToolSpec> = registry().iter().map(|tool| tool.spec()).collect();
        let navigate = specs.iter().find(|s| s.name == "navigate").unwrap();
        for key in ["group", "allowedOrigins", "readOnly", "keepVisible", "browser"] {
            assert!(navigate.input_schema["properties"].get(key).is_none(), "{key}");
        }
        assert!(navigate.input_schema["properties"].get("url").is_some());
        let screenshot = specs.iter().find(|s| s.name == "screenshot").unwrap();
        assert!(screenshot.input_schema["properties"].get("path").is_none());
        assert!(screenshot.input_schema["properties"].get("fullPage").is_some());
    }

    #[test]
    fn removed_tools_say_so_without_pointing_at_another_removed_one() {
        for (name, _) in NOT_OFFERED {
            let message = not_offered(name).unwrap();
            for (other, _) in NOT_OFFERED {
                if other != name {
                    assert!(!message.contains(&format!(" {other}")), "{message} mentions {other}");
                }
            }
        }
        assert!(not_offered("navigate").is_none());
    }
}
