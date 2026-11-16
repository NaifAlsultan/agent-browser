// stderr: stdout carries the MCP protocol.
use std::fmt::Write as _;
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};

static DEBUG: AtomicBool = AtomicBool::new(false);

pub fn set_debug(enabled: bool) {
    DEBUG.store(enabled, Ordering::Relaxed);
}

pub fn debug_enabled() -> bool {
    DEBUG.load(Ordering::Relaxed)
}

pub fn line(event: &str, fields: &[(&str, String)]) -> String {
    let mut out = format!("agent-browser {} {event}", iso_now());
    for (key, value) in fields {
        let shown = if !value.is_empty() && !value.chars().any(char::is_whitespace) { value.clone() } else { serde_json::to_string(value).unwrap_or_default() };
        let _ = write!(out, " {key}={shown}");
    }
    out.push('\n');
    out
}

pub fn write(event: &str, fields: &[(&str, String)]) {
    let _ = std::io::stderr().lock().write_all(line(event, fields).as_bytes());
}

#[macro_export]
macro_rules! log {
    ($event:expr $(, $key:ident = $value:expr)* $(,)?) => {
        $crate::log::write($event, &[$((stringify!($key), $value.to_string())),*])
    };
}

#[macro_export]
macro_rules! debug {
    ($event:expr $(, $key:ident = $value:expr)* $(,)?) => {
        if $crate::log::debug_enabled() {
            $crate::log::write($event, &[$((stringify!($key), $value.to_string())),*])
        }
    };
}

fn iso_now() -> String {
    iso_time(std::time::SystemTime::now())
}

pub fn iso_time(time: std::time::SystemTime) -> String {
    let millis = time.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
    let seconds = millis.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, millis.rem_euclid(1000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_times_like_javascript() {
        let time = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_794_614_400_123);
        assert_eq!(iso_time(time), "2026-11-14T00:00:00.123Z");
    }

    #[test]
    fn quotes_values_with_spaces() {
        let text = line("chrome.exited", &[("pid", "12".into()), ("reason", "killed by signal".into()), ("empty", String::new())]);
        assert!(text.ends_with(" chrome.exited pid=12 reason=\"killed by signal\" empty=\"\"\n"), "{text}");
    }
}
