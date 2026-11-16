//! One agent session's Chrome as a `browse_core::Browser`: its tabs, each a flattened target session on the pipe.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use async_trait::async_trait;
use browse_core::{Browser, Cdp, CdpError, CdpEvent, HandoffResult, TabId, TabInfo, TabOptions, TabState};
use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};

use crate::cdp::{BrowserEvent, Connection};
use crate::chrome::{self, Chrome};
use crate::config::Gpu;
use crate::xvfb::WorkArea;

/// The states of closed tabs kept, so a call that ended with its tab can still read them.
const GONE_KEPT: usize = 64;

pub struct Launch {
    pub executable: String,
    /// The X display (socket path) and its authority file; None runs Chrome headless.
    pub display: Option<(String, PathBuf)>,
    pub window: WorkArea,
    pub directory: PathBuf,
    pub extra_args: Vec<String>,
    pub gpu: Gpu,
    pub human_input: bool,
}

struct Tab {
    target: String,
    session: String,
    cdp: Arc<TabCdp>,
    state: Arc<TabState>,
    url: String,
    title: String,
    opener: Option<TabId>,
}

#[derive(Default)]
struct Tabs {
    live: BTreeMap<TabId, Tab>,
    next: TabId,
    gone: VecDeque<(TabId, Arc<TabState>)>,
    /// A blank page no agent uses, kept so closing the last tab doesn't close the window and with it Chrome.
    spare: Option<String>,
}

struct Inner {
    chrome: Chrome,
    connection: Arc<Connection>,
    directory: PathBuf,
    human_input: bool,
    tabs: Mutex<Tabs>,
    closing: AtomicBool,
}

#[derive(Clone)]
pub struct AgentBrowser(Arc<Inner>);

impl AgentBrowser {
    pub async fn launch(launch: Launch) -> Result<AgentBrowser> {
        let started = Chrome::launch(&chrome::Launch {
            executable: &launch.executable,
            display: launch.display.as_ref().map(|(display, xauthority)| (display.as_str(), xauthority.as_path())),
            window: launch.window,
            directory: &launch.directory,
            extra_args: &launch.extra_args,
            gpu: launch.gpu,
        });
        let (chrome, pipe) = match started {
            Ok(started) => started,
            Err(error) => {
                crate::temp::remove_dir(&launch.directory);
                return Err(error);
            }
        };
        let (connection, events) = Connection::open(pipe.input, pipe.output);
        let browser = AgentBrowser(Arc::new(Inner {
            chrome,
            connection,
            directory: launch.directory.clone(),
            human_input: launch.human_input,
            tabs: Mutex::new(Tabs { next: 1, ..Tabs::default() }),
            closing: AtomicBool::new(false),
        }));
        tokio::spawn(follow(Arc::downgrade(&browser.0), events));
        let mut exited = browser.0.chrome.exited.clone();
        let ready = tokio::select! {
            ready = tokio::time::timeout(Duration::from_secs(30), browser.prepare()) => ready.unwrap_or_else(|_| Err(anyhow!("Chrome didn't answer within 30 s"))),
            _ = exited.wait_for(|gone| *gone) => Err(anyhow!("Chrome exited during startup")),
        };
        if let Err(error) = ready {
            let tail = browser.0.chrome.stderr_tail();
            browser.close().await;
            bail!("{error:#}. Its last output:\n{}", if tail.is_empty() { "(none)" } else { &tail });
        }
        crate::log!("browser.ready", pid = browser.0.chrome.pid);
        Ok(browser)
    }

    async fn prepare(&self) -> Result<()> {
        let connection = &self.0.connection;
        let mut startup = Vec::new();
        for _ in 0..50 {
            let targets = connection.send("Target.getTargets", json!({}), None).await?;
            startup = pages(&targets);
            if !startup.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        connection.send("Target.setDiscoverTargets", json!({ "discover": true }), None).await?;
        // No agent can reach a downloaded file, and downloads could fill the disk.
        connection.send("Browser.setDownloadBehavior", json!({ "behavior": "deny" }), None).await?;
        // The "unsupported command-line flag" infobar only appears on the startup tab, where it shrinks the viewport.
        let spare = connection.send("Target.createTarget", json!({ "url": "about:blank" }), None).await?;
        self.0.tabs.lock().unwrap().spare = spare["targetId"].as_str().map(str::to_string);
        for target in startup {
            let _ = connection.send("Target.closeTarget", json!({ "targetId": target }), None).await;
        }
        Ok(())
    }

    pub fn alive(&self) -> bool {
        self.0.chrome.alive() && !self.0.connection.closed()
    }

    /// Resolves once Chrome has exited.
    pub fn exited(&self) -> watch::Receiver<bool> {
        self.0.chrome.exited.clone()
    }

    pub fn directory(&self) -> &Path {
        &self.0.directory
    }

    /// Closes Chrome and deletes the session's directory (profile and home).
    pub async fn close(&self) {
        if self.0.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        if self.0.chrome.alive() {
            let _ = tokio::time::timeout(Duration::from_secs(2), self.0.connection.send("Browser.close", json!({}), None)).await;
        }
        self.0.chrome.kill(Duration::from_secs(3)).await;
        crate::temp::remove_dir(&self.0.directory);
        crate::log!("browser.closed", pid = self.0.chrome.pid, removed = !self.0.directory.exists());
    }

    /// For process exit: no waiting.
    pub fn kill_now(&self) {
        self.0.chrome.kill_now();
        crate::temp::remove_dir(&self.0.directory);
    }

    async fn register(&self, target: &str, opener: Option<TabId>, url: &str) -> Result<TabId> {
        let inner = &self.0;
        let (events, _) = broadcast::channel(4096);
        inner.connection.expect_target(target, events.clone());
        let attached = match inner.connection.send("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await {
            Ok(attached) => attached,
            Err(error) => {
                inner.connection.forget_target(target);
                return Err(anyhow!("couldn't attach to the new tab: {error}"));
            }
        };
        let session = attached["sessionId"].as_str().context("attachToTarget returned no session")?.to_string();
        let mut tabs = inner.tabs.lock().unwrap();
        let id = tabs.next;
        tabs.next += 1;
        let cdp = Arc::new(TabCdp { browser: Arc::downgrade(inner), connection: inner.connection.clone(), tab: id, session: session.clone(), events: events.downgrade() });
        tabs.live.insert(id, Tab { target: target.to_string(), session, cdp, state: Arc::new(TabState::default()), url: url.to_string(), title: String::new(), opener });
        crate::debug!("tab.opened", tab = id, target = target, opener = opener.map(|o| o.to_string()).unwrap_or_default());
        Ok(id)
    }

    async fn create(&self, url: Option<&str>, opener: Option<TabId>) -> Result<TabId> {
        let spare = if url.is_none() { self.0.tabs.lock().unwrap().spare.take() } else { None };
        let target = match spare {
            Some(target) => target,
            None => {
                let created = self.0.connection.send("Target.createTarget", json!({ "url": url.unwrap_or("about:blank") }), None).await.map_err(|e| anyhow!("couldn't open a tab: {e}"))?;
                created["targetId"].as_str().context("createTarget returned no target")?.to_string()
            }
        };
        self.register(&target, opener, url.unwrap_or("about:blank")).await
    }

    fn info(&self, id: TabId, tab: &Tab) -> TabInfo {
        TabInfo { tab: id, url: tab.url.clone(), title: tab.title.clone(), lent: false, opener: tab.opener, options: TabOptions::default() }
    }

    fn forget(&self, id: TabId) {
        let mut tabs = self.0.tabs.lock().unwrap();
        if let Some(tab) = tabs.live.remove(&id) {
            self.0.connection.forget_session(&tab.session);
            tabs.gone.push_back((id, tab.state));
            while tabs.gone.len() > GONE_KEPT {
                tabs.gone.pop_front();
            }
            crate::debug!("tab.closed", tab = id);
        }
    }

    async fn close_target(&self, id: TabId) -> Result<()> {
        let (target, last) = {
            let tabs = self.0.tabs.lock().unwrap();
            let tab = tabs.live.get(&id).ok_or_else(|| missing(&tabs, id))?;
            (tab.target.clone(), tabs.live.len() == 1 && tabs.spare.is_none())
        };
        if last {
            let spare = self.0.connection.send("Target.createTarget", json!({ "url": "about:blank" }), None).await?;
            self.0.tabs.lock().unwrap().spare = spare["targetId"].as_str().map(str::to_string);
        }
        self.forget(id);
        self.0.connection.send("Target.closeTarget", json!({ "targetId": target }), None).await?;
        Ok(())
    }

    fn handle(&self, event: BrowserEvent) {
        let info = &event.params["targetInfo"];
        match event.method.as_str() {
            "Target.targetCreated" if info["type"] == "page" => {
                // Pages agents open have no opener; one with an opener is a popup (window.open, target=_blank).
                let Some(opener_target) = info["openerId"].as_str() else { return };
                let target = info["targetId"].as_str().unwrap_or_default().to_string();
                let opener = self.0.tabs.lock().unwrap().live.iter().find(|(_, tab)| tab.target == opener_target).map(|(id, _)| *id);
                let browser = self.clone();
                let url = info["url"].as_str().unwrap_or("about:blank").to_string();
                tokio::spawn(async move {
                    if let Err(error) = browser.register(&target, opener, &url).await {
                        crate::debug!("tab.popup-failed", error = format!("{error:#}"));
                    }
                });
            }
            "Target.targetInfoChanged" => {
                let target = info["targetId"].as_str().unwrap_or_default();
                let mut tabs = self.0.tabs.lock().unwrap();
                if let Some(tab) = tabs.live.values_mut().find(|tab| tab.target == target) {
                    tab.url = info["url"].as_str().unwrap_or_default().to_string();
                    tab.title = info["title"].as_str().unwrap_or_default().to_string();
                }
            }
            "Target.targetDestroyed" | "Target.detachedFromTarget" => {
                let target = event.params["targetId"].as_str().unwrap_or_default();
                let session = event.params["sessionId"].as_str().unwrap_or_default();
                let found = {
                    let mut tabs = self.0.tabs.lock().unwrap();
                    if tabs.spare.as_deref() == Some(target) {
                        tabs.spare = None;
                    }
                    tabs.live.iter().find(|(_, tab)| tab.target == target || tab.session == session).map(|(id, _)| *id)
                };
                if let Some(id) = found {
                    self.forget(id);
                }
            }
            _ => {}
        }
    }
}

async fn follow(browser: Weak<Inner>, mut events: broadcast::Receiver<BrowserEvent>) {
    loop {
        let event = match events.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        };
        let Some(inner) = browser.upgrade() else { break };
        AgentBrowser(inner).handle(event);
    }
    if let Some(inner) = browser.upgrade() {
        let ids: Vec<TabId> = inner.tabs.lock().unwrap().live.keys().copied().collect();
        let browser = AgentBrowser(inner);
        for id in ids {
            browser.forget(id);
        }
    }
}

fn pages(targets: &Value) -> Vec<String> {
    targets["targetInfos"].as_array().into_iter().flatten().filter(|t| t["type"] == "page").filter_map(|t| t["targetId"].as_str().map(str::to_string)).collect()
}

fn missing(tabs: &Tabs, id: TabId) -> anyhow::Error {
    if tabs.gone.iter().any(|(gone, _)| *gone == id) {
        anyhow!("Tab {id} was closed. Open a new one with navigate (without tab).")
    } else {
        anyhow!("There's no tab {id} in this browser: use a tab id that navigate or tabs returned. To open a tab, call navigate with a url.")
    }
}

#[async_trait]
impl Browser for AgentBrowser {
    async fn open_tab(&self, url: Option<&str>, _options: &TabOptions) -> Result<TabInfo> {
        let id = self.create(None, None).await?;
        if let Some(url) = url {
            let cdp = self.cdp(id).await?;
            let mut events = cdp.events();
            let _ = cdp.send("Page.enable", json!({}), None).await;
            cdp.send("Page.navigate", json!({ "url": url }), None).await?;
            let _ = tokio::time::timeout(Duration::from_secs(30), async {
                while let Ok(event) = events.recv().await {
                    if event.method == "Page.loadEventFired" && event.session_id.is_none() {
                        break;
                    }
                }
            })
            .await;
        }
        let tabs = self.0.tabs.lock().unwrap();
        tabs.live.get(&id).map(|tab| self.info(id, tab)).context("The tab went away")
    }

    async fn tabs(&self) -> Result<Vec<TabInfo>> {
        let tabs = self.0.tabs.lock().unwrap();
        Ok(tabs.live.iter().map(|(id, tab)| self.info(*id, tab)).collect())
    }

    async fn close_tab(&self, tab: TabId) -> Result<()> {
        self.close_target(tab).await
    }

    async fn cdp(&self, tab: TabId) -> Result<Arc<dyn Cdp>> {
        let tabs = self.0.tabs.lock().unwrap();
        Ok(tabs.live.get(&tab).ok_or_else(|| missing(&tabs, tab))?.cdp.clone())
    }

    async fn state(&self, tab: TabId) -> Result<Arc<TabState>> {
        let tabs = self.0.tabs.lock().unwrap();
        if let Some(live) = tabs.live.get(&tab) {
            return Ok(live.state.clone());
        }
        match tabs.gone.iter().rev().find(|(gone, _)| *gone == tab) {
            Some((_, state)) => Ok(state.clone()),
            None => Err(missing(&tabs, tab)),
        }
    }

    async fn handoff(&self, _tab: TabId, _message: &str) -> Result<HandoffResult> {
        bail!("No person watches this browser, so nothing can be handed off. Tell the user what's needed instead.")
    }

    async fn human_input(&self, _tab: TabId) -> bool {
        self.0.human_input
    }
}

/// One tab's CDP: commands on its session (or a child session), and its events.
pub struct TabCdp {
    browser: Weak<Inner>,
    connection: Arc<Connection>,
    tab: TabId,
    session: String,
    events: broadcast::WeakSender<CdpEvent>,
}

impl TabCdp {
    fn browser(&self) -> Result<AgentBrowser, CdpError> {
        self.browser.upgrade().map(AgentBrowser).ok_or(CdpError::Disconnected)
    }

    // From browse's relay: a background tab's screenshot can wait for a frame that never comes; tiny screenshots
    // nudge it along.
    async fn screenshot(&self, params: Value) -> Result<Value, CdpError> {
        let mut nudge = params.clone();
        nudge["format"] = "jpeg".into();
        nudge["quality"] = 1.into();
        if nudge.get("clip").is_some()
            && let Some(object) = nudge.as_object_mut()
        {
            object.remove("captureBeyondViewport");
        }
        let connection = self.connection.clone();
        let session = self.session.clone();
        let nudges = async move {
            for delay in [600u64, 1_000, 1_500, 2_000, 3_000, 5_000, 8_000] {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                crate::debug!("screenshot.nudge", after_ms = delay);
                let (connection, session, nudge) = (connection.clone(), session.clone(), nudge.clone());
                tokio::spawn(async move {
                    let _ = connection.send("Page.captureScreenshot", nudge, Some(&session)).await;
                });
            }
            std::future::pending::<()>().await;
        };
        tokio::select! {
            result = self.connection.send("Page.captureScreenshot", params, Some(&self.session)) => result,
            _ = nudges => unreachable!(),
        }
    }
}

#[async_trait]
impl Cdp for TabCdp {
    async fn send(&self, method: &str, params: Value, session_id: Option<&str>) -> Result<Value, CdpError> {
        let protocol = |error: anyhow::Error| CdpError::Protocol(format!("{error:#}"));
        match method {
            "Target.createTarget" => {
                let url = params.get("url").and_then(Value::as_str).filter(|url| *url != "about:blank");
                let browser = self.browser()?;
                let tab = browser.create(url, Some(self.tab)).await.map_err(protocol)?;
                let target = browser.0.tabs.lock().unwrap().live.get(&tab).map(|t| t.target.clone()).unwrap_or_default();
                return Ok(json!({ "targetId": target, "tabId": tab }));
            }
            "Target.closeTarget" => {
                let target = params.get("targetId").and_then(Value::as_str).unwrap_or_default();
                let browser = self.browser()?;
                let found = browser.0.tabs.lock().unwrap().live.iter().find(|(_, tab)| tab.target == target).map(|(id, _)| *id);
                let Some(tab) = found else { return Ok(json!({ "success": false })) };
                browser.close_target(tab).await.map_err(protocol)?;
                return Ok(json!({ "success": true }));
            }
            "Page.close" => {
                if let Some(session) = session_id {
                    return Err(CdpError::Protocol(format!("Page.close needs the tab's own page session, not child session {session}")));
                }
                self.browser()?.close_target(self.tab).await.map_err(protocol)?;
                return Ok(json!({}));
            }
            "Page.captureScreenshot" if session_id.is_none() => return self.screenshot(params).await,
            _ => {}
        }
        self.connection.send(method, params, Some(session_id.unwrap_or(&self.session))).await
    }

    fn events(&self) -> broadcast::Receiver<CdpEvent> {
        match self.events.upgrade() {
            Some(sender) => sender.subscribe(),
            None => broadcast::channel(1).1,
        }
    }
}
