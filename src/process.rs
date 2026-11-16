use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::Duration;

type Request = (Command, mpsc::Sender<io::Result<Child>>);

/// Spawns `command` with `fds` (ours, moved to the child's fd numbers), killed with SIGKILL if this process dies, and
/// optionally in a process group of its own.
pub fn spawn(mut command: Command, fds: Vec<(OwnedFd, RawFd)>, own_group: bool) -> io::Result<Child> {
    // Out of the way of the numbers they're going to, so no dup2 overwrites another.
    let fds: Vec<(OwnedFd, RawFd)> = fds.into_iter().map(|(fd, target)| Ok((high(&fd)?, target))).collect::<io::Result<_>>()?;
    let parent = std::process::id() as libc::pid_t;
    let raw: Vec<(RawFd, RawFd)> = fds.iter().map(|(fd, target)| (fd.as_raw_fd(), *target)).collect();
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            for &(fd, target) in &raw {
                if libc::dup2(fd, target) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            if own_group && libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                return Err(io::Error::other("agent-browser exited"));
            }
            Ok(())
        });
    }
    // The death signal fires when the thread that forked the child ends, not the process: fork from a thread that
    // lives as long as the process, never from a runtime thread that may be retired.
    static LAUNCHER: OnceLock<std::sync::Mutex<mpsc::Sender<Request>>> = OnceLock::new();
    let launcher = LAUNCHER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Request>();
        std::thread::Builder::new()
            .name("launcher".into())
            .spawn(move || {
                for (mut command, reply) in rx {
                    let _ = reply.send(command.spawn());
                }
            })
            .expect("launcher thread");
        std::sync::Mutex::new(tx)
    });
    let (reply, answer) = mpsc::channel();
    launcher.lock().unwrap().send((command, reply)).map_err(|_| io::Error::other("launcher thread is gone"))?;
    let child = answer.recv().map_err(|_| io::Error::other("launcher thread is gone"))?;
    drop(fds);
    child
}

fn high(fd: &OwnedFd) -> io::Result<OwnedFd> {
    // SAFETY: F_DUPFD_CLOEXEC returns a new descriptor we own.
    let raw = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

/// A close-on-exec pipe: (read end, write end).
pub fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    // SAFETY: pipe2 fills both descriptors, which we then own.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

pub fn signal(pid: i32, signal: i32) {
    // SAFETY: kill has no memory effects.
    unsafe {
        libc::kill(pid, signal);
    }
}

pub fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks.
    unsafe { libc::kill(pid, 0) == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

/// Watches a child: `exited` flips to true once it's gone (and reaped).
pub fn watch(mut child: Child) -> tokio::sync::watch::Receiver<bool> {
    let (tx, rx) = tokio::sync::watch::channel(false);
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = tx.send(true);
    });
    rx
}

/// SIGTERM to `target` (a pid, or a negative process group), then SIGKILL if it hasn't exited within `grace`.
pub async fn terminate(target: i32, mut exited: tokio::sync::watch::Receiver<bool>, grace: Duration) {
    if *exited.borrow() {
        return;
    }
    signal(target, libc::SIGTERM);
    if tokio::time::timeout(grace, exited.wait_for(|gone| *gone)).await.is_err() {
        signal(target, libc::SIGKILL);
        let _ = tokio::time::timeout(Duration::from_secs(5), exited.wait_for(|gone| *gone)).await;
    }
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    let mut filled = 0;
    while filled < N {
        // SAFETY: getrandom writes at most the given length into the buffer.
        let n = unsafe { libc::getrandom(bytes[filled..].as_mut_ptr().cast(), N - filled, 0) };
        if n > 0 {
            filled += n as usize;
        }
    }
    bytes
}

pub fn random_below(limit: u64) -> u64 {
    u64::from_ne_bytes(random_bytes::<8>()) % limit
}
