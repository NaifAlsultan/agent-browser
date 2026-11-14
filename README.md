# agent-browser

An [MCP](https://modelcontextprotocol.io) server that gives AI agents a web browser running in the background,
built to be hard for sites to tell apart from a person's.

- **Invisible.** Google Chrome runs headed on its own virtual display (Xvfb), never on your screen.
- **Isolated.** Each agent session gets a fresh, temporary profile, deleted when the session ends.
- **Hard to detect.** Real Chrome driven through [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright),
  no automation flags, human-like mouse, keyboard and scroll input, and a realistic screen and GPU.
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

Measured with Chrome 157 and a GPU (`scripts/detection-compare.ts`). Without a GPU, WebGL falls back to software
rendering, which some of these pages flag.

## How it works

```
MCP client ─stdio─▶ agent-browser ─▶ Patchright ─ws─▶ CDP proxy ═pipe═▶ Chrome ─▶ Xvfb
```

- One Chrome process per agent session, closed after 15 minutes idle.
- Chrome is launched directly, with DevTools over a pipe rather than an unauthenticated port.
- A small CDP proxy adds human-like input and removes Patchright's forced media emulation.
- The virtual display is protected by an X authority cookie.

## Tools

| Tool | What it does |
| --- | --- |
| `open({ url })` | Open a URL |
| `back()`, `forward()`, `reload()` | Navigate history |
| `snapshot({ ref?, maxChars? })` | Page outline with element refs such as `e12`, iframes included; password, one-time-code and card values hidden |
| `screenshot({ fullPage?, ref? })` | Viewport, full page or one element |
| `click({ ref, double?, button? })` | Click an element |
| `type({ ref, text, submit? })` | Type into a field, optionally pressing Enter |
| `fill_form({ fields: [{ ref, value }] })` | Fill text fields, selects, checkboxes and radios |
| `select({ ref, values })` | Choose `<select>` options |
| `press({ key })` | Press a key, such as `Enter` |
| `hover({ ref })` | Hover over an element |
| `scroll({ direction?, amount?, ref? })` | Scroll the page, or an element into view |
| `wait({ text?, textGone?, seconds? })` | Wait for text or a time |
| `tabs({ action, index?, url? })` | List, open, switch or close tabs |
| `close()` | Close the session's browser and delete its profile |
| `run_script({ code, timeoutMs? })` | Run Playwright code with `page` and `context` |

`run_script` is not a sandbox: it runs with the server's permissions.

Sessions are keyed by OpenCode's `ai.opencode/sessionID` request metadata; other clients share one session per
server process.

## Install

With Nix:

```nix
{
  inputs.agent-browser.url = "github:NaifAlsultan/agent-browser";
  # ...
  environment.systemPackages = [ inputs.agent-browser.packages.x86_64-linux.default ];
}
```

The package includes Chrome and Xvfb. Without Nix, you need Node.js 24+, Google Chrome and Xvfb:

```bash
npm ci --omit=dev
node src/main.ts
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
| `AGENT_BROWSER_IDLE_TIMEOUT_MS` | `900000` | Idle time before a session's browser closes |
| `AGENT_BROWSER_HUMAN_INPUT` | on | `off` for faster, more detectable input |
| `AGENT_BROWSER_CHROME_ARGS` | | Extra Chrome flags |
| `AGENT_BROWSER_TMPDIR` | system temp dir | Where profiles go |
| `AGENT_BROWSER_DEBUG` | off | Verbose logs on stderr |

Also: `AGENT_BROWSER_ACTION_TIMEOUT_MS`, `AGENT_BROWSER_NAVIGATION_TIMEOUT_MS`, `AGENT_BROWSER_CHALLENGE_WAIT_MS`,
and optional `AGENT_BROWSER_XPROP` and `AGENT_BROWSER_SETPRIV` paths (set by the Nix package).

Notes:

- Chrome applies machine-wide policies from `/etc/opt/chrome/policies` to every profile, which can make the browser
  stand out.
- Chrome's sandbox needs unprivileged user namespaces. Where they're unavailable, pass `--no-sandbox` in
  `AGENT_BROWSER_CHROME_ARGS`.

## Development

```bash
nix develop
npm ci
npm test                    # unit tests
npm run test:integration    # real Chrome against local pages
npm run typecheck
```

## Credits

- [browse](https://github.com/anomalyco/browse) (MIT): human-like input, challenge detection and Patchright tuning,
  vendored in [`vendor/browse`](vendor/browse).
- [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (Apache-2.0).

## License

MIT
