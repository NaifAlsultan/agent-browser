// Launched by us, so no automation flags are passed. DevTools goes over a pipe, never a port: the port has no
// authentication, so any local user could take the browser over.
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::os::fd::OwnedFd;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::sync::watch;

use crate::config::Gpu;
use crate::process;
use crate::xvfb::WorkArea;

pub struct Launch<'a> {
    pub executable: &'a str,
    /// The X display (socket path) and its authority file; None runs Chrome headless.
    pub display: Option<(&'a str, &'a Path)>,
    pub window: WorkArea,
    pub directory: &'a Path,
    pub extra_args: &'a [String],
    pub gpu: Gpu,
}

pub struct Chrome {
    pub pid: i32,
    pub exited: watch::Receiver<bool>,
    stderr: Arc<Mutex<Vec<String>>>,
}

/// The DevTools pipe: Chrome reads commands from `input` (its fd 3) and writes to `output` (its fd 4).
pub struct Pipe {
    pub input: OwnedFd,
    pub output: OwnedFd,
}

pub fn render_node() -> Option<PathBuf> {
    let mut names: Vec<String> = std::fs::read_dir("/dev/dri").ok()?.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.starts_with("renderD")).collect();
    names.sort();
    names.into_iter().map(|name| PathBuf::from("/dev/dri").join(name)).find(|path| {
        let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap_or_default();
        // SAFETY: access only reads the NUL-terminated path.
        unsafe { libc::access(path.as_ptr(), libc::R_OK | libc::W_OK) == 0 }
    })
}

// On Xvfb Chrome turns WebGL off, a strong bot signal. ANGLE's EGL backend can use the real GPU; SwiftShader is
// the software fallback.
pub fn gpu_args(gpu: Gpu, has_render_node: bool) -> Vec<String> {
    if gpu == Gpu::On || (gpu == Gpu::Auto && has_render_node) {
        vec!["--use-gl=angle".into(), "--use-angle=gl-egl".into()]
    } else {
        vec!["--enable-unsafe-swiftshader".into()]
    }
}

pub fn args(launch: &Launch, profile: &Path, has_render_node: bool) -> Vec<String> {
    let mut args = vec![
        format!("--user-data-dir={}", profile.display()),
        "--remote-debugging-pipe".into(),
        // The pipe sets navigator.webdriver; this unsets it.
        "--disable-blink-features=AutomationControlled".into(),
    ];
    args.extend(gpu_args(launch.gpu, has_render_node));
    args.extend([
        // On Wayland it would open on the real screen.
        "--ozone-platform=x11".into(),
        format!("--window-position={},{}", launch.window.x, launch.window.y),
        format!("--window-size={},{}", launch.window.width, launch.window.height),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-search-engine-choice-screen".into(),
        "--password-store=basic".into(),
        "--mute-audio".into(),
    ]);
    if launch.display.is_none() {
        args.push("--headless".into());
    }
    args.extend(launch.extra_args.iter().cloned());
    args.push("about:blank".into());
    args
}

const DESKTOP_VARIABLES: &[&str] = &[
    "WAYLAND_DISPLAY",
    "WAYLAND_SOCKET",
    "NIXOS_OZONE_WL",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_DESKTOP",
    "DESKTOP_SESSION",
    "HYPRLAND_INSTANCE_SIGNATURE",
    "GDK_BACKEND",
    "QT_QPA_PLATFORM",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "DISPLAY",
    "XAUTHORITY",
];

pub fn env(base: impl IntoIterator<Item = (OsString, OsString)>, display: Option<(&str, &Path)>, home: &Path) -> BTreeMap<OsString, OsString> {
    let mut env: BTreeMap<OsString, OsString> = base.into_iter().filter(|(name, _)| !DESKTOP_VARIABLES.iter().any(|d| name == d)).collect();
    // The session bus reaches the desktop: notifications, the keyring, portals.
    env.insert("DBUS_SESSION_BUS_ADDRESS".into(), "disabled:".into());
    env.insert("HOME".into(), home.into());
    if let Some((display, xauthority)) = display {
        env.insert("DISPLAY".into(), display.into());
        env.insert("XAUTHORITY".into(), xauthority.into());
        env.insert("XDG_SESSION_TYPE".into(), "x11".into());
    }
    env
}

impl Chrome {
    pub fn launch(launch: &Launch) -> Result<(Chrome, Pipe)> {
        let profile = launch.directory.join("profile");
        let home = launch.directory.join("home");
        let mut dirs = std::fs::DirBuilder::new();
        dirs.mode(0o700);
        dirs.create(&profile)?;
        dirs.create(&home)?;
        let args = args(launch, &profile, render_node().is_some());
        let (commands_read, commands_write) = process::pipe()?;
        let (events_read, events_write) = process::pipe()?;
        let mut command = Command::new(launch.executable);
        command.args(&args).env_clear().envs(env(std::env::vars_os(), launch.display, &home)).current_dir(&home).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        let mut child = process::spawn(command, vec![(commands_read, 3), (events_write, 4)], true).with_context(|| format!("starting {}", launch.executable))?;
        let pid = child.id() as i32;
        let stderr = Arc::new(Mutex::new(Vec::new()));
        if let Some(output) = child.stderr.take() {
            let tail = stderr.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(output).lines().map_while(Result::ok) {
                    if line.trim().is_empty() {
                        continue;
                    }
                    crate::debug!("chrome.stderr", pid = pid, line = line);
                    let mut tail = tail.lock().unwrap();
                    tail.push(line);
                    if tail.len() > 40 {
                        tail.remove(0);
                    }
                }
            });
        }
        let exited = process::watch(child);
        let mut watcher = exited.clone();
        tokio::spawn(async move {
            let _ = watcher.wait_for(|gone| *gone).await;
            crate::log!("chrome.exited", pid = pid);
        });
        crate::log!("chrome.started", pid = pid, display = launch.display.map(|(d, _)| d).unwrap_or("headless"));
        Ok((Chrome { pid, exited, stderr }, Pipe { input: commands_write, output: events_read }))
    }

    pub fn stderr_tail(&self) -> String {
        self.stderr.lock().unwrap().join("\n")
    }

    pub fn alive(&self) -> bool {
        !*self.exited.borrow()
    }

    pub async fn kill(&self, grace: Duration) {
        process::terminate(-self.pid, self.exited.clone(), grace).await;
        // Helpers left in the group.
        process::signal(-self.pid, libc::SIGKILL);
    }

    pub fn kill_now(&self) {
        process::signal(-self.pid, libc::SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(display: Option<(&'static str, &'static Path)>) -> Launch<'static> {
        static EXTRA: [String; 0] = [];
        Launch {
            executable: "chrome",
            display,
            window: WorkArea { x: 0, y: 32, width: 1920, height: 1048 },
            directory: Path::new("/tmp/session"),
            extra_args: &EXTRA,
            gpu: Gpu::Auto,
        }
    }

    #[test]
    fn launch_flags() {
        let args = args(&launch(Some(("/tmp/.X11-unix/X123", Path::new("/tmp/x")))), Path::new("/tmp/session/profile"), true);
        assert_eq!(
            args,
            [
                "--user-data-dir=/tmp/session/profile",
                "--remote-debugging-pipe",
                "--disable-blink-features=AutomationControlled",
                "--use-gl=angle",
                "--use-angle=gl-egl",
                "--ozone-platform=x11",
                "--window-position=0,32",
                "--window-size=1920,1048",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-search-engine-choice-screen",
                "--password-store=basic",
                "--mute-audio",
                "about:blank",
            ]
        );
        assert!(!args.iter().any(|a| a.contains("remote-debugging-port") || a.contains("enable-automation") || a == "--headless"));
    }

    #[test]
    fn gpu_choice() {
        assert_eq!(gpu_args(Gpu::Auto, false), ["--enable-unsafe-swiftshader"]);
        assert_eq!(gpu_args(Gpu::Auto, true), ["--use-gl=angle", "--use-angle=gl-egl"]);
        assert_eq!(gpu_args(Gpu::On, false), ["--use-gl=angle", "--use-angle=gl-egl"]);
        assert_eq!(gpu_args(Gpu::Off, true), ["--enable-unsafe-swiftshader"]);
    }

    #[test]
    fn extra_args_come_before_the_url() {
        let extra = vec!["--no-sandbox".to_string()];
        let mut launch = launch(None);
        launch.extra_args = &extra;
        let args = args(&launch, Path::new("/p"), false);
        assert_eq!(&args[args.len() - 3..], ["--headless", "--no-sandbox", "about:blank"]);
    }

    #[test]
    fn environment_is_stripped_of_the_desktop() {
        let base = [
            ("PATH", "/bin"),
            ("WAYLAND_DISPLAY", "wayland-1"),
            ("DISPLAY", ":0"),
            ("XAUTHORITY", "/home/u/.Xauthority"),
            ("XDG_CONFIG_HOME", "/home/u/.config"),
            ("XDG_SESSION_TYPE", "wayland"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ("HYPRLAND_INSTANCE_SIGNATURE", "x"),
            ("HOME", "/home/u"),
        ]
        .map(|(k, v)| (OsString::from(k), OsString::from(v)));
        let env = env(base, Some(("/tmp/.X11-unix/X5", Path::new("/tmp/d/Xauthority"))), Path::new("/tmp/d/home"));
        let get = |k: &str| env.get(&OsString::from(k)).map(|v| v.to_string_lossy().to_string());
        assert_eq!(get("PATH").as_deref(), Some("/bin"));
        assert_eq!(get("WAYLAND_DISPLAY"), None);
        assert_eq!(get("XDG_CONFIG_HOME"), None);
        assert_eq!(get("HYPRLAND_INSTANCE_SIGNATURE"), None);
        assert_eq!(get("DBUS_SESSION_BUS_ADDRESS").as_deref(), Some("disabled:"));
        assert_eq!(get("HOME").as_deref(), Some("/tmp/d/home"));
        assert_eq!(get("DISPLAY").as_deref(), Some("/tmp/.X11-unix/X5"));
        assert_eq!(get("XAUTHORITY").as_deref(), Some("/tmp/d/Xauthority"));
        assert_eq!(get("XDG_SESSION_TYPE").as_deref(), Some("x11"));
        let headless = super::env([(OsString::from("DISPLAY"), OsString::from(":0"))], None, Path::new("/h"));
        assert_eq!(headless.get(&OsString::from("DISPLAY")), None);
    }
}
