# agent-browser

An [MCP](https://modelcontextprotocol.io) server that gives AI agents a web browser running in the background,
built to be hard for sites to tell apart from a person's.

- **Invisible.** Google Chrome runs on its own virtual display, never on your screen.
- **Isolated.** Each agent session gets a fresh, temporary profile, deleted when the session ends.
- **Hard to detect.** Real Chrome with human-like input and a realistic screen and GPU.
- **Honest about bot checks.** Self-clearing challenges are waited out; CAPTCHAs and block pages are reported to the
  agent, never solved.

Linux only.

## Detection results

| Page | Playwright (headless) | agent-browser |
| --- | --- | --- |
| [bot.sannysoft.com](https://bot.sannysoft.com) | 13 of 31 failed or warned | all passed |
| [BrowserScan](https://www.browserscan.net/bot-detection) | Robot | Normal |
| [CreepJS](https://abrahamjuliot.github.io/creepjs/) headless | 100% | 0% |
| [rebrowser bot detector](https://bot-detector.rebrowser.net/) | 6 red | all green |

Measured with Chrome 157 and a GPU. Without a GPU, some of these pages flag the software rendering.

## Tools

| Tool | What it does |
| --- | --- |
| `navigate` | Open a URL in a new tab, or go to a URL, back, forward or reload in a tab |
| `snapshot` | Page outline with element refs; password, one-time-code and card values hidden |
| `click`, `fill`, `type`, `press`, `select`, `hover`, `drag`, `scroll` | Act on an element |
| `eval` | Run JavaScript in the page |
| `wait_for` | Wait for text, an element, a URL or a page load |
| `dialog` | Answer an alert, confirm or prompt |
| `screenshot` | The viewport, the full page or an element |
| `tabs` | List, open and close tabs |
| `close` | Close the session's browser and delete its profile |

Clients with a code mode, like OpenCode, compose several tools in one script; others call them one at a time.

Each OpenCode session gets its own browser. Other clients share one per server process, unless they send their own
per-conversation ID in `_meta` and you set `AGENT_BROWSER_SESSION_META_KEY` to its key.

## Install

With Nix:

```nix
{
  inputs.agent-browser.url = "github:NaifAlsultan/agent-browser";
  # ...
  environment.systemPackages = [ inputs.agent-browser.packages.x86_64-linux.default ];
}
```

The package includes Chrome and Xvfb. Without Nix, install Google Chrome and Xvfb, then `cargo build --release`.

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
| `AGENT_BROWSER_GPU` | `auto` | `on`, `off` or `auto` |
| `AGENT_BROWSER_IDLE_TIMEOUT_MS` | `300000` | Idle time before a session's browser closes |
| `AGENT_BROWSER_MAX_SESSIONS` | `4` | Browsers running at once; a new session closes the least recently used |
| `AGENT_BROWSER_HUMAN_INPUT` | on | `off` for faster, more detectable input |
| `AGENT_BROWSER_CHROME_ARGS` | | Extra Chrome flags, such as `--no-sandbox` where user namespaces are unavailable |
| `AGENT_BROWSER_TMPDIR` | system temp dir | Where profiles go |
| `AGENT_BROWSER_SESSION_META_KEY` | `ai.opencode/sessionID` | Request `_meta` key that identifies a session |
| `AGENT_BROWSER_DEBUG` | off | Verbose logs on stderr |

Chrome applies machine-wide policies from `/etc/opt/chrome/policies` to every profile, which can make the browser
stand out.

## Development

```bash
nix develop
cargo test
nix flake check
```

## Credits

[browse](https://github.com/anomalyco/browse) (MIT), vendored in [`vendor/browse`](vendor/browse), including
Playwright's InjectedScript (Apache-2.0).

## License

MIT
