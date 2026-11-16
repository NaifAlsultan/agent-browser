//! Visits public bot-detection pages through agent-browser, as a person would glance at them, and saves what they
//! report plus a full-page screenshot of each. In the dev shell:
//!   cargo run --release --example detection -- <out-dir>

mod support;

use base64::Engine;
use serde_json::{Value, json};

fn main() {
    let out = std::path::PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| "/tmp/agent-browser-detection".into()));
    std::fs::create_dir_all(&out).unwrap();
    let mut client = support::Client::start("detection");
    let session = "detection";
    let mut results = Vec::new();
    let mut tab: Option<i64> = None;
    for (name, url, settle_ms, read) in SITES {
        let started = std::time::Instant::now();
        let mut navigate = json!({ "url": url, "timeout": 60_000 });
        if let Some(tab) = tab {
            navigate["tab"] = json!(tab);
        }
        let opened = client.call("navigate", navigate, session);
        tab = tab.or_else(|| serde_json::from_str::<Value>(&opened.text).ok().and_then(|v| v["tab"].as_i64()));
        let Some(tab) = tab else {
            results.push(json!({ "site": name, "error": opened.text }));
            continue;
        };
        let jitter = started.elapsed().subsec_nanos() as u64;
        client.call("hover", json!({ "tab": tab, "x": 400 + jitter % 200, "y": 300 + jitter % 100 }), session);
        client.call("hover", json!({ "tab": tab, "x": 700, "y": 450 }), session);
        client.call("wait_for", json!({ "tab": tab, "ms": settle_ms, "timeout": settle_ms + 5_000 }), session);
        client.call("scroll", json!({ "tab": tab, "deltaY": 400 }), session);
        client.call("wait_for", json!({ "tab": tab, "ms": 1_000, "timeout": 6_000 }), session);
        let shot = client.call("screenshot", json!({ "tab": tab, "fullPage": true }), session);
        if let Some((_, data)) = shot.images.first() {
            std::fs::write(out.join(format!("{name}.png")), base64::engine::general_purpose::STANDARD.decode(data).unwrap()).unwrap();
        }
        let read = client.call("eval", json!({ "tab": tab, "expression": read, "timeout": 30_000 }), session);
        let result: Value = serde_json::from_str(&read.text).unwrap_or(Value::String(read.text));
        let key = if read.error { "error" } else { "result" };
        results.push(json!({ "site": name, "ms": started.elapsed().as_millis() as u64, key: result }));
    }
    client.call("close", json!({}), session);
    let text = serde_json::to_string_pretty(&results).unwrap();
    std::fs::write(out.join("results.json"), &text).unwrap();
    println!("{text}");
}

const SITES: &[(&str, &str, u64, &str)] = &[
    (
        "sannysoft",
        "https://bot.sannysoft.com/",
        6000,
        r####"(() => {
      const rows = [...document.querySelectorAll("tr")].map((row) => {
        const cells = [...row.querySelectorAll("td")]
        const result = cells.find((cell) => /\b(passed|failed|warn)\b/.test(cell.className))
        return result ? { test: cells[0].innerText.trim(), status: result.className.match(/passed|failed|warn/)[0], value: result.innerText.trim().slice(0, 80) } : undefined
      }).filter(Boolean)
      return { total: rows.length, notPassed: rows.filter((row) => row.status !== "passed") }
    })()"####,
    ),
    (
        "creepjs",
        "https://abrahamjuliot.github.io/creepjs/",
        25000,
        r####"(() => {
      const text = document.body.innerText
      const pick = (pattern) => (text.match(pattern) || [])[0]
      return {
        headless: pick(/\d+% like headless[^\n]*/) ?? pick(/like headless[^\n]*/),
        headlessScore: pick(/\d+% headless:[^\n]*/) ?? pick(/headless:[^\n]*/),
        stealth: pick(/\d+% stealth[^\n]*/) ?? pick(/stealth:[^\n]*/),
        lies: pick(/lies \(\d+\)[^\n]*/),
        botLines: text.split("\n").filter((line) => /headless|stealth|webdriver|automation|bot\b|lies/i.test(line)).slice(0, 40),
      }
    })()"####,
    ),
    (
        "browserscan",
        "https://www.browserscan.net/bot-detection",
        12000,
        r####"(() => {
      const text = document.body.innerText
      const start = text.search(/Test Results|Bot Detection/i)
      return { excerpt: text.slice(Math.max(0, start), start + 2500) }
    })()"####,
    ),
    (
        "rebrowser",
        "https://bot-detector.rebrowser.net/",
        8000,
        r####"(() => {
      const rows = [...document.querySelectorAll("tr")].map((row) => row.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)
      return { rows: rows.slice(0, 40) }
    })()"####,
    ),
];
