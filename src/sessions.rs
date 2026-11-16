//! One Chrome per agent session, not contexts in one shared Chrome: sites can detect incognito contexts from their
//! storage quota, and one crash or hang would take every session down.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use tokio::sync::OnceCell;

use crate::browser::{AgentBrowser, Launch};
use crate::config::Config;
use crate::temp::ProcessDir;
use crate::xvfb::Display;

pub const DEFAULT_KEY: &str = "default";

type Launched = Arc<OnceCell<Result<AgentBrowser, String>>>;

struct Slot {
    browser: Launched,
    last_used: Instant,
    busy: usize,
}

pub struct Sessions {
    config: Config,
    dir: ProcessDir,
    display: tokio::sync::Mutex<Option<Arc<Display>>>,
    slots: Mutex<HashMap<String, Slot>>,
    /// Sessions whose browser the cap closed, to tell them on their next call.
    evicted: Mutex<HashSet<String>>,
}

/// A session's browser for one call; the session counts as busy (never idle) while it's held.
pub struct Lease {
    sessions: Arc<Sessions>,
    key: String,
    pub browser: AgentBrowser,
    /// Set when this call got a fresh browser because the session cap closed the old one.
    pub notice: Option<String>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(slot) = self.sessions.slots.lock().unwrap().get_mut(&self.key) {
            slot.busy = slot.busy.saturating_sub(1);
            slot.last_used = Instant::now();
        }
    }
}

/// Which session to close to make room: the least recently used one not in a call, else the least recently used.
pub fn choose_eviction<'a>(slots: impl IntoIterator<Item = (&'a str, Instant, usize)>) -> Option<&'a str> {
    let slots: Vec<_> = slots.into_iter().collect();
    let oldest = |idle: bool| slots.iter().filter(|(_, _, busy)| !idle || *busy == 0).min_by_key(|(_, used, _)| *used).map(|(key, _, _)| *key);
    oldest(true).or_else(|| oldest(false))
}

impl Sessions {
    pub fn new(config: Config) -> Result<Arc<Sessions>> {
        let parent = config.tmp_dir.clone().unwrap_or_else(std::env::temp_dir);
        let dir = ProcessDir::create(&parent).map_err(|e| anyhow!("can't create a directory in {}: {e}", parent.display()))?;
        let sessions =
            Arc::new(Sessions { config, dir, display: tokio::sync::Mutex::new(None), slots: Mutex::new(HashMap::new()), evicted: Mutex::new(HashSet::new()) });
        tokio::spawn(reap(Arc::downgrade(&sessions)));
        Ok(sessions)
    }

    /// The session's browser, started if it has none (or its Chrome died).
    pub async fn acquire(self: &Arc<Self>, key: &str) -> Result<Lease> {
        loop {
            let (cell, evict) = {
                let mut slots = self.slots.lock().unwrap();
                let evict = if slots.contains_key(key) || slots.len() < self.config.max_sessions {
                    None
                } else {
                    let victim = choose_eviction(slots.iter().map(|(k, s)| (k.as_str(), s.last_used, s.busy))).map(str::to_string);
                    victim.and_then(|victim| slots.remove(&victim).map(|slot| (victim, slot)))
                };
                let slot = slots.entry(key.to_string()).or_insert_with(|| Slot { browser: Arc::new(OnceCell::new()), last_used: Instant::now(), busy: 0 });
                slot.busy += 1;
                slot.last_used = Instant::now();
                (slot.browser.clone(), evict)
            };
            if let Some((victim, slot)) = evict {
                crate::log!("session.evicted", session = victim, max = self.config.max_sessions);
                self.evicted.lock().unwrap().insert(victim);
                if let Some(Ok(browser)) = slot.browser.get() {
                    browser.close().await;
                }
            }
            let launched = cell.get_or_init(|| async { self.launch(key).await.map_err(|e| format!("{e:#}")) }).await;
            match launched {
                Ok(browser) if browser.alive() => {
                    let notice = self.evicted.lock().unwrap().remove(key).then(|| {
                        format!(
                            "Note: this session's browser was closed to make room for another session (at most {} run at once), so this call started a fresh one: earlier tabs, cookies and logins are gone.",
                            self.config.max_sessions
                        )
                    });
                    return Ok(Lease { sessions: self.clone(), key: key.to_string(), browser: browser.clone(), notice });
                }
                Ok(browser) => {
                    crate::log!("session.browser-lost", session = key);
                    let browser = browser.clone();
                    self.drop_slot(key, &cell);
                    browser.close().await;
                }
                Err(error) => {
                    let error = error.clone();
                    self.drop_slot(key, &cell);
                    return Err(anyhow!("The browser didn't start: {error}"));
                }
            }
        }
    }

    fn drop_slot(&self, key: &str, cell: &Launched) {
        let mut slots = self.slots.lock().unwrap();
        if slots.get(key).is_some_and(|slot| Arc::ptr_eq(&slot.browser, cell)) {
            slots.remove(key);
        }
    }

    /// Whether the session has a browser, or one starting.
    pub fn has(&self, key: &str) -> bool {
        self.slots.lock().unwrap().contains_key(key)
    }

    async fn launch(&self, key: &str) -> Result<AgentBrowser> {
        let display = self.display().await?;
        let directory = self.dir.session_dir(key)?;
        crate::log!("session.started", session = key);
        AgentBrowser::launch(Launch {
            executable: self.config.chrome.clone(),
            display: display.display.clone(),
            xauthority: display.xauthority.clone(),
            window: display.work_area,
            directory,
            extra_args: self.config.extra_chrome_args.clone(),
            gpu: self.config.gpu,
            human_input: self.config.human_input,
        })
        .await
    }

    async fn display(&self) -> Result<Arc<Display>> {
        let mut display = self.display.lock().await;
        if let Some(running) = display.as_ref().filter(|d| d.alive()) {
            return Ok(running.clone());
        }
        let started = Arc::new(Display::start(&self.config.xvfb, self.config.screen, &self.dir.path).await?);
        self.dir.record_display(started.number);
        *display = Some(started.clone());
        Ok(started)
    }

    /// Ends the session's browser and deletes its profile. False when it had none.
    pub async fn close(&self, key: &str) -> bool {
        let slot = self.slots.lock().unwrap().remove(key);
        self.evicted.lock().unwrap().remove(key);
        self.end(key, slot).await
    }

    async fn close_if_idle(&self, key: &str) {
        let slot = {
            let mut slots = self.slots.lock().unwrap();
            let idle = slots.get(key).is_some_and(|slot| slot.busy == 0 && slot.last_used.elapsed() >= self.config.idle_timeout);
            if !idle {
                return;
            }
            slots.remove(key)
        };
        crate::log!("session.idle", session = key, idle_ms = self.config.idle_timeout.as_millis());
        self.end(key, slot).await;
    }

    async fn end(&self, key: &str, slot: Option<Slot>) -> bool {
        let Some(slot) = slot else { return false };
        let had = matches!(slot.browser.get(), Some(Ok(_)));
        if let Some(Ok(browser)) = slot.browser.get() {
            browser.close().await;
            crate::log!("session.closed", session = key);
        }
        had
    }

    pub async fn shutdown(self: &Arc<Self>) {
        let keys: Vec<String> = self.slots.lock().unwrap().keys().cloned().collect();
        let mut closing = tokio::task::JoinSet::new();
        for key in keys {
            let sessions = self.clone();
            closing.spawn(async move { sessions.close(&key).await });
        }
        let _ = tokio::time::timeout(Duration::from_secs(10), closing.join_all()).await;
        self.kill_all();
        if let Some(display) = self.display.lock().await.take() {
            display.stop().await;
        }
        self.dir.remove();
    }

    /// For when there's no time to wait: Chrome's process groups and the files go now.
    pub fn kill_all(&self) {
        for slot in self.slots.lock().unwrap().drain().map(|(_, slot)| slot) {
            if let Some(Ok(browser)) = slot.browser.get() {
                browser.kill_now();
            }
        }
    }
}

/// Closes the browsers of sessions idle for longer than the idle timeout.
async fn reap(sessions: std::sync::Weak<Sessions>) {
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let Some(sessions) = sessions.upgrade() else { return };
        let idle = sessions.config.idle_timeout;
        let expired: Vec<String> =
            sessions.slots.lock().unwrap().iter().filter(|(_, slot)| slot.busy == 0 && slot.last_used.elapsed() >= idle).map(|(key, _)| key.clone()).collect();
        for key in expired {
            sessions.close_if_idle(&key).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_the_least_recently_used_idle_session() {
        let now = Instant::now();
        let ago = |s: u64| now - Duration::from_secs(s);
        assert_eq!(choose_eviction([("a", ago(10), 0), ("b", ago(30), 0), ("c", ago(20), 0)]), Some("b"));
        assert_eq!(choose_eviction([("a", ago(10), 0), ("b", ago(30), 1), ("c", ago(20), 0)]), Some("c"), "a session in a call is spared");
        assert_eq!(choose_eviction([("a", ago(10), 1), ("b", ago(30), 2)]), Some("b"), "when all are busy, the oldest goes");
        assert_eq!(choose_eviction(std::iter::empty()), None);
    }
}
