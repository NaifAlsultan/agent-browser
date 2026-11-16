// Staying clear of real displays:
// - We pick the display number, skipping any in use: Xvfb's -displayfd search can replace another server's
//   socket file.
// - No abstract socket: those are shared machine-wide, even with sandboxes that have a private /tmp.
// - Chrome connects by socket path, so an impostor's abstract socket can't capture it.
use std::io::Read;
use std::os::linux::net::SocketAddrExt;
use std::os::unix::net::{SocketAddr, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::sync::watch;

use crate::process;
use crate::temp::{LOCK_DIR, SOCKET_DIR};

const FAMILY_WILD: u16 = 0xffff;
const COOKIE_NAME: &str = "MIT-MAGIC-COOKIE-1";
const PANEL_HEIGHT: u32 = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkArea {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

pub struct Display {
    /// The socket path, which is what DISPLAY is set to.
    pub display: String,
    pub number: u32,
    pub xauthority: PathBuf,
    pub work_area: WorkArea,
    pid: i32,
    exited: watch::Receiver<bool>,
}

// An empty display number matches any display, which a socket-path DISPLAY needs (libxcb looks it up as 0).
pub fn xauth_entry(display: &str, cookie: &[u8]) -> Vec<u8> {
    let mut out = FAMILY_WILD.to_be_bytes().to_vec();
    for field in [&b""[..], display.as_bytes(), COOKIE_NAME.as_bytes(), cookie] {
        out.extend_from_slice(&(field.len() as u16).to_be_bytes());
        out.extend_from_slice(field);
    }
    out
}

pub fn work_area_for(width: u32, height: u32) -> WorkArea {
    WorkArea { x: 0, y: PANEL_HEIGHT, width, height: height - PANEL_HEIGHT }
}

fn abstract_in_use(name: &str) -> bool {
    let Ok(address) = SocketAddr::from_abstract_name(name.as_bytes()) else { return true };
    UnixStream::connect_addr(&address).is_ok()
}

pub fn display_in_use(number: u32, socket_dir: &str, lock_dir: &str) -> bool {
    let exists = |path: PathBuf| std::fs::symlink_metadata(path).is_ok();
    exists(Path::new(socket_dir).join(format!("X{number}")))
        || exists(Path::new(lock_dir).join(format!(".X{number}-lock")))
        || abstract_in_use(&format!("{SOCKET_DIR}/X{number}"))
}

/// The first free display number from `base`, trying `count` numbers.
pub fn free_display(base: u32, count: u32, in_use: impl Fn(u32) -> bool) -> Option<u32> {
    (base..base + count).find(|number| !in_use(*number))
}

impl Display {
    pub async fn start(executable: &str, (width, height): (u32, u32), directory: &Path) -> Result<Display> {
        let cookie = process::random_bytes::<16>();
        let xauthority = directory.join("Xauthority");
        write_private(&xauthority, &xauth_entry("", &cookie))?;
        let base = 100 + process::random_below(800) as u32;
        let mut failures = Vec::new();
        let mut number = base;
        while number < base + 40 {
            let Some(free) = free_display(number, base + 40 - number, |n| display_in_use(n, SOCKET_DIR, LOCK_DIR)) else { break };
            number = free + 1;
            match launch(executable, free, (width, height), &xauthority).await {
                Ok((pid, exited)) => {
                    let display = format!("{SOCKET_DIR}/X{free}");
                    let mut work_area = WorkArea { x: 0, y: 0, width, height };
                    let area = work_area_for(width, height);
                    match set_work_area(&display, &cookie, area) {
                        Ok(()) => work_area = area,
                        Err(error) => crate::log!("xvfb.workarea-failed", error = format!("{error:#}")),
                    }
                    crate::log!("xvfb.started", display = format!(":{free}"), pid = pid, screen = format!("{width}x{height}"));
                    return Ok(Display { display, number: free, xauthority, work_area, pid, exited });
                }
                Err(error) => {
                    failures.push(format!(":{free}: {error:#}"));
                    if failures.len() >= 5 {
                        break;
                    }
                }
            }
        }
        if failures.is_empty() {
            bail!("Xvfb didn't start: every display number tried was in use.");
        }
        bail!("Xvfb didn't start. {}", failures.join("\n"))
    }

    pub fn alive(&self) -> bool {
        !*self.exited.borrow()
    }

    /// Waits for Xvfb to exit, so it removes its socket and lock first.
    pub async fn stop(&self) {
        process::terminate(self.pid, self.exited.clone(), Duration::from_secs(3)).await;
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file =
        std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path).with_context(|| format!("writing {}", path.display()))?;
    file.write_all(bytes)?;
    Ok(())
}

async fn launch(executable: &str, number: u32, (width, height): (u32, u32), xauthority: &Path) -> Result<(i32, watch::Receiver<bool>)> {
    let (ready_read, ready_write) = process::pipe()?;
    let mut command = Command::new(executable);
    command
        .args([format!(":{number}"), "-displayfd".into(), "3".into(), "-screen".into(), "0".into(), format!("{width}x{height}x24"), "-dpi".into(), "96".into()])
        .arg("-auth")
        .arg(xauthority)
        // "local" is the abstract socket.
        .args(["-nolisten", "tcp", "-nolisten", "local", "-noreset"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = process::spawn(command, vec![(ready_write, 3)], false).with_context(|| format!("starting {executable}"))?;
    let pid = child.id() as i32;
    let stderr = child.stderr.take();
    let tail = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    if let Some(mut stderr) = stderr {
        let tail = tail.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&buffer[..n]).to_string();
                crate::debug!("xvfb.stderr", text = text.trim());
                let mut tail = tail.lock().unwrap();
                tail.push_str(&text);
                if tail.len() > 2000 {
                    let cut = tail.len() - 1000;
                    let cut = (cut..tail.len()).find(|i| tail.is_char_boundary(*i)).unwrap_or(0);
                    tail.drain(..cut);
                }
            }
        });
    }
    let exited = process::watch(child);
    let mut early = exited.clone();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut file = std::fs::File::from(ready_read);
        let mut output = String::new();
        let mut buffer = [0u8; 64];
        while let Ok(n) = file.read(&mut buffer) {
            if n == 0 {
                break;
            }
            output.push_str(&String::from_utf8_lossy(&buffer[..n]));
            if output.contains('\n') {
                let _ = ready_tx.send(());
                return;
            }
        }
    });
    let failed = |reason: String| {
        process::signal(pid, libc::SIGKILL);
        anyhow::anyhow!("{reason}: {}", tail.lock().unwrap().trim().chars().rev().take(1000).collect::<Vec<_>>().into_iter().rev().collect::<String>())
    };
    tokio::select! {
        ready = ready_rx => match ready {
            Ok(()) => {
                let watcher = exited.clone();
                tokio::spawn(async move {
                    let mut watcher = watcher;
                    let _ = watcher.wait_for(|gone| *gone).await;
                    crate::log!("xvfb.exited", display = format!(":{number}"));
                });
                Ok((pid, exited))
            }
            Err(_) => Err(failed("exited before it was ready".into())),
        },
        _ = early.wait_for(|gone| *gone) => Err(failed("exited before it was ready".into())),
        _ = tokio::time::sleep(Duration::from_secs(15)) => Err(failed("not ready after 15 s".into())),
    }
}

// Without a window manager screen.availHeight equals screen.height, which no desktop with a panel has (CreepJS
// counts it as a headless sign). Chrome reads the work area from these root window properties.
fn set_work_area(display: &str, cookie: &[u8], area: WorkArea) -> Result<()> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, PropMode};
    use x11rb::rust_connection::{DefaultStream, RustConnection};
    use x11rb::wrapper::ConnectionExt as _;

    let stream = UnixStream::connect(display).with_context(|| format!("connecting to {display}"))?;
    let (stream, _) = DefaultStream::from_unix_stream(stream)?;
    let connection = RustConnection::connect_to_stream_with_auth_info(stream, 0, COOKIE_NAME.as_bytes().to_vec(), cookie.to_vec())?;
    let root = connection.setup().roots[0].root;
    let atom = |name: &str| -> Result<u32> { Ok(connection.intern_atom(false, name.as_bytes())?.reply()?.atom) };
    let set = |name: &str, values: &[u32]| -> Result<()> {
        connection.change_property32(PropMode::REPLACE, root, atom(name)?, AtomEnum::CARDINAL, values)?;
        Ok(())
    };
    set("_NET_NUMBER_OF_DESKTOPS", &[1])?;
    set("_NET_CURRENT_DESKTOP", &[0])?;
    set("_NET_WORKAREA", &[area.x, area.y, area.width, area.height])?;
    connection.sync()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xauth_entry_is_a_wildcard_cookie() {
        let cookie = [7u8; 16];
        let entry = xauth_entry("", &cookie);
        let mut expected = vec![0xff, 0xff, 0, 0, 0, 0, 0, 18];
        expected.extend_from_slice(b"MIT-MAGIC-COOKIE-1");
        expected.extend_from_slice(&[0, 16]);
        expected.extend_from_slice(&cookie);
        assert_eq!(entry, expected);
        assert_eq!(&xauth_entry("12", &cookie)[4..8], &[0, 2, b'1', b'2']);
    }

    #[test]
    fn work_area_leaves_room_for_a_panel() {
        assert_eq!(work_area_for(1920, 1080), WorkArea { x: 0, y: 32, width: 1920, height: 1048 });
    }

    #[test]
    fn skips_displays_in_use() {
        assert_eq!(free_display(100, 10, |n| n < 103), Some(103));
        assert_eq!(free_display(100, 3, |_| true), None);
        assert_eq!(free_display(100, 3, |_| false), Some(100));
    }

    #[test]
    fn sees_socket_and_lock_files() {
        let dir = std::env::temp_dir().join(format!("agent-browser-xvfb-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_str().unwrap();
        // Way above any display number in use, so the abstract socket check finds nothing.
        assert!(!display_in_use(64_999, path, path));
        std::fs::write(dir.join("X64999"), "").unwrap();
        assert!(display_in_use(64_999, path, path));
        std::fs::remove_file(dir.join("X64999")).unwrap();
        std::fs::write(dir.join(".X64999-lock"), "").unwrap();
        assert!(display_in_use(64_999, path, path));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
