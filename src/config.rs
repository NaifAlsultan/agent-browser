use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Result, bail};

/// OpenCode's per-session request metadata; AGENT_BROWSER_SESSION_META_KEY picks another client's key.
pub const DEFAULT_SESSION_META_KEY: &str = "ai.opencode/sessionID";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gpu {
    Auto,
    On,
    Off,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub chrome: String,
    pub xvfb: String,
    pub screen: (u32, u32),
    pub gpu: Gpu,
    pub idle_timeout: Duration,
    pub extra_chrome_args: Vec<String>,
    pub tmp_dir: Option<PathBuf>,
    pub session_meta_key: String,
    pub human_input: bool,
    pub max_sessions: usize,
    pub debug: bool,
}

impl Config {
    pub fn from_env() -> Result<Config> {
        Config::load(|name| std::env::var(name).ok())
    }

    pub fn load(var: impl Fn(&str) -> Option<String>) -> Result<Config> {
        let get = |name: &str| var(name).map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
        let integer = |name: &str, fallback: u64, min: u64, max: u64| -> Result<u64> {
            let Some(raw) = get(name) else { return Ok(fallback) };
            match raw.parse::<u64>() {
                Ok(value) if (min..=max).contains(&value) => Ok(value),
                _ => bail!("{name} must be an integer from {min} to {max}, got {raw:?}"),
            }
        };
        let flag = |name: &str, fallback: bool| match get(name) {
            None => fallback,
            Some(raw) => !matches!(raw.to_ascii_lowercase().as_str(), "0" | "false" | "off" | "no"),
        };
        let screen = {
            let raw = get("AGENT_BROWSER_SCREEN").unwrap_or_else(|| "1920x1080".into());
            let parsed = raw.split_once('x').and_then(|(w, h)| {
                let ok = |s: &str| (3..=5).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
                (ok(w) && ok(h)).then(|| Some((w.parse().ok()?, h.parse().ok()?))).flatten()
            });
            match parsed {
                Some(size) => size,
                None => bail!("AGENT_BROWSER_SCREEN must look like 1920x1080, got {raw:?}"),
            }
        };
        let gpu = match get("AGENT_BROWSER_GPU").map(|raw| raw.to_ascii_lowercase()).as_deref() {
            None | Some("auto") => Gpu::Auto,
            Some("on") => Gpu::On,
            Some("off") => Gpu::Off,
            Some(other) => bail!("AGENT_BROWSER_GPU must be auto, on or off, got {other:?}"),
        };
        Ok(Config {
            chrome: get("AGENT_BROWSER_CHROME").unwrap_or_else(|| "google-chrome-stable".into()),
            xvfb: get("AGENT_BROWSER_XVFB").unwrap_or_else(|| "Xvfb".into()),
            screen,
            gpu,
            idle_timeout: Duration::from_millis(integer("AGENT_BROWSER_IDLE_TIMEOUT_MS", 5 * 60_000, 1_000, 24 * 3_600_000)?),
            extra_chrome_args: get("AGENT_BROWSER_CHROME_ARGS").map(|raw| raw.split_whitespace().map(str::to_string).collect()).unwrap_or_default(),
            tmp_dir: get("AGENT_BROWSER_TMPDIR").map(PathBuf::from),
            session_meta_key: get("AGENT_BROWSER_SESSION_META_KEY").unwrap_or_else(|| DEFAULT_SESSION_META_KEY.into()),
            human_input: flag("AGENT_BROWSER_HUMAN_INPUT", true),
            max_sessions: integer("AGENT_BROWSER_MAX_SESSIONS", 4, 1, 64)? as usize,
            debug: flag("AGENT_BROWSER_DEBUG", false),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn load(vars: &[(&str, &str)]) -> Result<Config> {
        let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::load(|name| map.get(name).cloned())
    }

    #[test]
    fn defaults() {
        let config = load(&[]).unwrap();
        assert_eq!(config.chrome, "google-chrome-stable");
        assert_eq!(config.xvfb, "Xvfb");
        assert_eq!(config.screen, (1920, 1080));
        assert_eq!(config.gpu, Gpu::Auto);
        assert_eq!(config.idle_timeout, Duration::from_secs(300));
        assert!(config.extra_chrome_args.is_empty());
        assert_eq!(config.tmp_dir, None);
        assert_eq!(config.session_meta_key, "ai.opencode/sessionID");
        assert!(config.human_input);
        assert_eq!(config.max_sessions, 4);
        assert!(!config.debug);
    }

    #[test]
    fn reads_every_variable() {
        let config = load(&[
            ("AGENT_BROWSER_CHROME", " /opt/chrome "),
            ("AGENT_BROWSER_XVFB", "/bin/Xvfb"),
            ("AGENT_BROWSER_SCREEN", "2560x1440"),
            ("AGENT_BROWSER_GPU", "OFF"),
            ("AGENT_BROWSER_IDLE_TIMEOUT_MS", "60000"),
            ("AGENT_BROWSER_CHROME_ARGS", " --no-sandbox  --lang=de "),
            ("AGENT_BROWSER_TMPDIR", "/var/tmp"),
            ("AGENT_BROWSER_SESSION_META_KEY", "client/conversation"),
            ("AGENT_BROWSER_HUMAN_INPUT", "off"),
            ("AGENT_BROWSER_MAX_SESSIONS", "2"),
            ("AGENT_BROWSER_DEBUG", "1"),
        ])
        .unwrap();
        assert_eq!(config.chrome, "/opt/chrome");
        assert_eq!(config.screen, (2560, 1440));
        assert_eq!(config.gpu, Gpu::Off);
        assert_eq!(config.idle_timeout, Duration::from_secs(60));
        assert_eq!(config.extra_chrome_args, ["--no-sandbox", "--lang=de"]);
        assert_eq!(config.tmp_dir, Some(PathBuf::from("/var/tmp")));
        assert_eq!(config.session_meta_key, "client/conversation");
        assert!(!config.human_input);
        assert_eq!(config.max_sessions, 2);
        assert!(config.debug);
    }

    #[test]
    fn refuses_bad_values() {
        assert!(load(&[("AGENT_BROWSER_SCREEN", "big")]).unwrap_err().to_string().contains("1920x1080"));
        assert!(load(&[("AGENT_BROWSER_SCREEN", "19x10")]).is_err());
        assert!(load(&[("AGENT_BROWSER_GPU", "maybe")]).is_err());
        assert!(load(&[("AGENT_BROWSER_IDLE_TIMEOUT_MS", "10")]).unwrap_err().to_string().contains("from 1000"));
        assert!(load(&[("AGENT_BROWSER_MAX_SESSIONS", "0")]).is_err());
        assert!(load(&[("AGENT_BROWSER_MAX_SESSIONS", "two")]).is_err());
    }

    #[test]
    fn ignores_dropped_variables() {
        let config = load(&[
            ("AGENT_BROWSER_ACTION_TIMEOUT_MS", "nonsense"),
            ("AGENT_BROWSER_NAVIGATION_TIMEOUT_MS", "1"),
            ("AGENT_BROWSER_CHALLENGE_WAIT_MS", "x"),
            ("AGENT_BROWSER_SETPRIV", "/bin/setpriv"),
            ("AGENT_BROWSER_XPROP", "/bin/xprop"),
            ("AGENT_BROWSER_TOOLS", "execute"),
        ]);
        assert!(config.is_ok());
    }
}
