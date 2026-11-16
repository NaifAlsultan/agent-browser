# agent-browser

An [MCP](https://modelcontextprotocol.io) server that gives AI agents a web browser running in the background,
built to be hard for sites to tell apart from a person's.

- **Invisible.** Google Chrome runs headed on its own virtual display (Xvfb), never on your screen.
- **Isolated.** Each agent session gets a fresh, temporary profile, deleted when the session ends.
- **Hard to detect.** Real Chrome driven over the DevTools protocol directly, with no automation flags and nothing
  added to pages; human-like mouse, keyboard and scroll input; a realistic screen and GPU.
- **Honest about bot checks.** Self-clearing challenges are waited out; CAPTCHAs and block pages are reported to the
  agent, never solved.

Linux only.

> [!WARNING]
> agent-browser is not a security boundary. The server runs no code agents write: their JavaScript (`eval`) runs
> inside the page, in Chrome. What remains is Chrome itself, which runs with the server's permissions: it can open
> `file:` URLs, so an agent can read any file the server can, and a browser exploit on a malicious page would reach
> the rest. The pages agents read can also prompt-inject them. Run the server in an OS-level sandbox (for example
> bubblewrap) that hides your files and environment, and don't rely on your MCP client's tool permissions to contain
> it.

## Detection results

| Page | Playwright (headless) | agent-browser |
| --- | --- | --- |
| [bot.sannysoft.com](https://bot.sannysoft.com) | 13 of 31 failed or warned | all passed |
| [BrowserScan](https://www.browserscan.net/bot-detection) | Robot | Normal |
| [CreepJS](https://abrahamjuliot.github.io/creepjs/) headless | 100% | 0% |
| [rebrowser bot detector](https://bot-detector.rebrowser.net/) | 6 red | all green |

Measured with Chrome 157 and a GPU on the same machine; `cargo run --example detection` reproduces the agent-browser
column. Without a GPU, WebGL falls back to software rendering, which some of these pages flag.

## How it works

```
MCP client ─stdio─▶ agent-browser ═DevTools pipe═▶ Chrome ─▶ Xvfb
```

- One Chrome process per agent session, closed after 5 minutes idle.
- Chrome is launched directly, with DevTools over a pipe rather than an unauthenticated port.
- Pages are read and driven through [browse](https://github.com/anomalyco/browse)'s page tools, which run
  Playwright's selector engine in isolated worlds the page can't see.
- The tab an agent acts on is brought to the front first, as a person would switch to it.
- Downloads are refused.
- The virtual display is protected by an X authority cookie.

## Tools

| Tool | What it does |
| --- | --- |
| `navigate` | Open a URL in a new tab (returning its id), or go to a URL, back, forward or reload in a tab |
| `snapshot` | Page outline with element refs such as `e12`, iframes included; password, one-time-code and card values hidden |
| `click`, `fill`, `type`, `press`, `select`, `hover`, `drag`, `scroll` | Act on a ref or selector, with human-like input |
| `eval` | Run JavaScript in the page, in an isolated world by default |
| `wait_for` | Wait for text, an element, a URL or a load state |
| `dialog` | Answer an alert, confirm or prompt |
| `screenshot` | The viewport, the full page, an element or a rectangle |
| `tabs` | List, open and close tabs |
| `close` | Close the session's browser and delete its profile |

Results report what changed: navigations, new tabs, dialogs and bot challenges. Clients with a code mode (OpenCode)
compose several tools in one script; clients without one call the tools one at a time. The instructions tell agents
to call `close` when they're done browsing, so a session's Chrome doesn't hold memory until the idle timeout.

Sessions are keyed by OpenCode's `ai.opencode/sessionID` request metadata, so each OpenCode session gets its own
browser. Clients that don't send it share one browser per server process, which for stdio clients is usually one per
client instance: parallel chats or subagents in it share tabs and cookies. If your client sends its own
per-conversation ID in `_meta`, set `AGENT_BROWSER_SESSION_META_KEY` to that key. At most
`AGENT_BROWSER_MAX_SESSIONS` browsers run at once; a new session closes the least recently used one, whose next call
gets a fresh browser and is told so.

## Install

With Nix:

```nix
{
  inputs.agent-browser.url = "github:NaifAlsultan/agent-browser";
  # ...
  environment.systemPackages = [ inputs.agent-browser.packages.x86_64-linux.default ];
}
```

The package includes Chrome and Xvfb. Without Nix, you need Rust, Google Chrome and Xvfb:

```bash
cargo build --release
./target/release/agent-browser
```

Then add it to your MCP client, for example OpenCode:

```json
{ "mcp": { "servers": { "agent-browser": { "type": "local", "command": ["agent-browser"] } } } }
```

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `AGENT_BROWSER_CHROME` | `google-chrome-stable` | Chrome executable |
| `AGENT_BROWSER_XVFB` | `Xvfb` | Xvfb executable |
| `AGENT_BROWSER_SCREEN` | `1920x1080` | Screen size |
| `AGENT_BROWSER_GPU` | `auto` | `on`, `off` or `auto` (use `/dev/dri` when available) |
| `AGENT_BROWSER_IDLE_TIMEOUT_MS` | `300000` | Idle time before a session's browser closes |
| `AGENT_BROWSER_MAX_SESSIONS` | `4` | Browsers running at once; each takes a few hundred MB or more |
| `AGENT_BROWSER_HUMAN_INPUT` | on | `off` for faster, more detectable input |
| `AGENT_BROWSER_CHROME_ARGS` | | Extra Chrome flags |
| `AGENT_BROWSER_TMPDIR` | system temp dir | Where profiles go |
| `AGENT_BROWSER_SESSION_META_KEY` | `ai.opencode/sessionID` | Request `_meta` key that identifies a session |
| `AGENT_BROWSER_DEBUG` | off | Verbose logs on stderr |

Notes:

- Chrome applies machine-wide policies from `/etc/opt/chrome/policies` to every profile, which can make the browser
  stand out.
- Chrome's sandbox needs unprivileged user namespaces. Where they're unavailable, pass `--no-sandbox` in
  `AGENT_BROWSER_CHROME_ARGS`.

## Development

```bash
nix develop
cargo test                  # unit tests, and integration tests with real Chrome on Xvfb
cargo run --example mcp_call -- '[["navigate", {"url": "example.com"}], ["snapshot", {"tab": 1}]]'
nix flake check             # the package with its unit tests, clippy and rustfmt
```

## Credits

- [browse](https://github.com/anomalyco/browse) (MIT): the page tools, screenshots, human-like input and challenge
  detection, vendored in [`vendor/browse`](vendor/browse).
- Playwright's InjectedScript (Apache-2.0), part of browse's page tools.

## License

MIT
