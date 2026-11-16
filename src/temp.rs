use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::process::alive;

const PREFIX: &str = "agent-browser-";
const OWNER_FILE: &str = "owner.pid";
const DISPLAY_FILE: &str = "display";
pub const SOCKET_DIR: &str = "/tmp/.X11-unix";
pub const LOCK_DIR: &str = "/tmp";

/// This server's directory under `parent`: Xvfb's authority file and one directory per session (profile + home).
pub struct ProcessDir {
    pub path: PathBuf,
}

impl ProcessDir {
    pub fn create(parent: &Path) -> io::Result<ProcessDir> {
        remove_stale(parent, SOCKET_DIR, LOCK_DIR);
        let path = mkdtemp(&parent.join(PREFIX))?;
        std::fs::write(path.join(OWNER_FILE), std::process::id().to_string())?;
        Ok(ProcessDir { path })
    }

    pub fn session_dir(&self, label: &str) -> io::Result<PathBuf> {
        let clean: String = label.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).take(40).collect();
        let name = if clean.is_empty() { "session".to_string() } else { clean };
        mkdtemp(&self.path.join(format!("{name}-")))
    }

    pub fn record_display(&self, number: u32) {
        let _ = std::fs::write(self.path.join(DISPLAY_FILE), number.to_string());
    }

    pub fn remove(&self) {
        remove_dir(&self.path);
    }
}

pub fn remove_dir(path: &Path) {
    for _ in 0..5 {
        match std::fs::remove_dir_all(path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => std::thread::sleep(Duration::from_millis(100)),
            _ => return,
        }
    }
}

/// A directory named `<prefix>XXXXXX`, readable only by us.
fn mkdtemp(prefix: &Path) -> io::Result<PathBuf> {
    let template = CString::new([prefix.as_os_str().as_bytes(), b"XXXXXX"].concat()).map_err(io::Error::other)?;
    let mut bytes = template.into_bytes_with_nul();
    // SAFETY: the template is NUL-terminated and mkdtemp rewrites it in place.
    if unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) }.is_null() {
        return Err(io::Error::last_os_error());
    }
    bytes.pop();
    let path = PathBuf::from(std::ffi::OsStr::from_bytes(&bytes));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    Ok(path)
}

fn uid() -> u32 {
    // SAFETY: getuid can't fail.
    unsafe { libc::getuid() }
}

// A process killed outright can't clean up after itself; the next one removes what it left.
pub fn remove_stale(parent: &Path, socket_dir: &str, lock_dir: &str) {
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(PREFIX) {
            continue;
        }
        let dir = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&dir) else { continue };
        if !meta.is_dir() || meta.uid() != uid() {
            continue;
        }
        match std::fs::read_to_string(dir.join(OWNER_FILE)).ok().and_then(|text| text.trim().parse::<i32>().ok()) {
            Some(pid) if pid > 0 && alive(pid) => continue,
            Some(_) => {}
            // Without an owner file, it may still be being set up.
            None => {
                let young = meta.modified().ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_none_or(|age| age < Duration::from_secs(60));
                if young {
                    continue;
                }
            }
        }
        remove_stale_display(&dir, socket_dir, lock_dir);
        remove_dir(&dir);
        crate::log!("tmp.stale-removed", dir = dir.display());
    }
}

// A killed server's Xvfb leaves its socket and lock files behind.
fn remove_stale_display(dir: &Path, socket_dir: &str, lock_dir: &str) {
    let Some(number) = std::fs::read_to_string(dir.join(DISPLAY_FILE)).ok().and_then(|text| text.trim().parse::<u32>().ok()) else { return };
    if number < 1 {
        return;
    }
    let lock = Path::new(lock_dir).join(format!(".X{number}-lock"));
    let socket = Path::new(socket_dir).join(format!("X{number}"));
    if let Some(holder) = std::fs::read_to_string(&lock).ok().and_then(|text| text.trim().parse::<i32>().ok())
        && holder > 0
        && alive(holder)
    {
        return;
    }
    for file in [socket, lock] {
        let ours = std::fs::symlink_metadata(&file).is_ok_and(|meta| meta.uid() == uid());
        if ours && std::fs::remove_file(&file).is_ok() {
            crate::log!("tmp.stale-display-removed", file = file.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        mkdtemp(&std::env::temp_dir().join("agent-browser-unit-")).unwrap()
    }

    #[test]
    fn removes_leftovers_of_dead_servers_only() {
        let parent = scratch();
        let x11 = parent.join("x11");
        std::fs::create_dir(&x11).unwrap();
        let dead = parent.join("agent-browser-dead");
        std::fs::create_dir(&dead).unwrap();
        // Way above pid_max: never alive.
        std::fs::write(dead.join(OWNER_FILE), "999999999").unwrap();
        std::fs::write(dead.join(DISPLAY_FILE), "4242").unwrap();
        std::fs::write(x11.join("X4242"), "").unwrap();
        std::fs::write(parent.join(".X4242-lock"), "999999999").unwrap();
        let live = parent.join("agent-browser-live");
        std::fs::create_dir(&live).unwrap();
        std::fs::write(live.join(OWNER_FILE), std::process::id().to_string()).unwrap();
        let fresh = parent.join("agent-browser-fresh");
        std::fs::create_dir(&fresh).unwrap();
        let other = parent.join("something-else");
        std::fs::create_dir(&other).unwrap();

        remove_stale(&parent, x11.to_str().unwrap(), parent.to_str().unwrap());
        assert!(!dead.exists());
        assert!(!x11.join("X4242").exists());
        assert!(!parent.join(".X4242-lock").exists());
        assert!(live.exists());
        assert!(fresh.exists(), "a directory without an owner may still be being set up");
        assert!(other.exists());
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn makes_private_session_directories() {
        let parent = scratch();
        let dir = ProcessDir::create(&parent).unwrap();
        assert!(dir.path.file_name().unwrap().to_string_lossy().starts_with(PREFIX));
        assert_eq!(std::fs::read_to_string(dir.path.join(OWNER_FILE)).unwrap(), std::process::id().to_string());
        let session = dir.session_dir("ses_a/b c").unwrap();
        assert!(session.file_name().unwrap().to_string_lossy().starts_with("ses_a_b_c-"));
        assert_eq!(std::fs::metadata(&session).unwrap().permissions().mode() & 0o777, 0o700);
        dir.remove();
        assert!(!dir.path.exists());
        std::fs::remove_dir_all(&parent).unwrap();
    }
}
