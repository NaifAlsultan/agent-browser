# agent-browser

A web browser for AI agents that runs in the background and is hard for sites to tell apart from a person's.
It's an [MCP](https://modelcontextprotocol.io) server: agents open pages, read them, click, type and fill forms
through its tools. Built for [OpenCode](https://opencode.ai), usable from any MCP client.

- **Nothing on your screen.** Google Chrome runs headed (not headless) on its own virtual display (Xvfb). It never
  touches your desktop session: no Wayland, no session D-Bus, no notifications, muted audio.
- **No access to your logins.** Each agent session gets a fresh Chrome profile in a private temporary directory,
  deleted when the session closes the browser, after 15 minutes idle, or when the server exits.
- **Built to avoid bot detection.** Real Google Chrome driven through
  [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (no `Runtime.enable` leak, no automation flags),
  human-like pointer, keyboard and scroll input from [browse](https://github.com/anomalyco/browse), and a realistic
  window, screen and GPU.
- **Reports bot challenges** (Cloudflare, DataDome, PerimeterX, Akamai, Imperva, AWS WAF, CAPTCHA walls) instead of
  fighting them: checks that clear by themselves are waited out; interactive ones and block pages are reported to the
  agent. It never solves CAPTCHAs.

Linux only.

## How it compares

Public bot-detection pages, November 2026, Chrome 157 on a desktop with an AMD GPU and a home connection
(`scripts/detection-compare.ts`):

| Page | Playwright, headless | Playwright, headed on Xvfb | agent-browser |
| --- | --- | --- | --- |
| [bot.sannysoft.com](https://bot.sannysoft.com) (31 checks) | 13 failed or warned | 2 failed | all passed |
| [BrowserScan bot detection](https://www.browserscan.net/bot-detection) | Robot | Robot | Normal |
| [CreepJS](https://abrahamjuliot.github.io/creepjs/) headless / like headless | 100% / 94% | 33% / 50% | 0% / 38% |
| [rebrowser bot detector](https://bot-detector.rebrowser.net/) | 6 red | 4 red | all green |

CreepJS's remaining "like headless" points are traits every desktop Linux Chrome has (no Web Share, Contacts or
Content Index APIs, light color scheme). Without a GPU (`AGENT_BROWSER_GPU=off`, or no `/dev/dri` in a sandbox),
WebGL falls back to SwiftShader, which sannysoft and rebrowser flag and CreepJS counts (44%).

## How it works

```
MCP client ──stdio──▶ agent-browser ──▶ Patchright ──ws://127.0.0.1/<secret>──▶ CDP proxy ══pipe══▶ Chrome ──▶ Xvfb
```

- **One Chrome per agent session**, keyed by OpenCode's `ai.opencode/sessionID` request metadata (calls without it
  share one default session). Separate processes rather than incognito-style contexts, which sites can detect.
- **One Xvfb per server process**: a 1920×1080 screen with a desktop panel work area, protected by an X authority
  cookie so other local users can't connect to it. It stays clear of real displays: the display number skips any
  number with a lock, socket file or abstract socket (Xvfb's own `-displayfd` search can replace the socket file of
  an Xwayland that listens on a file only); it listens on its socket file only, never on an abstract socket (shared
  machine-wide, even with sandboxes that have their own `/tmp`); and Chrome connects by socket path.
- **Chrome is launched by agent-browser, not by Patchright**, so every flag is controlled: no `--enable-automation`,
  no `--headless`, none of Playwright's automation switches. DevTools runs over `--remote-debugging-pipe`, never
  a port: a DevTools port has no authentication, so any local user could take the browser over.
- **An in-process CDP proxy** sits between Patchright and Chrome. It applies browse's human-like input (curved,
  eased pointer paths, paced key presses, wheel scrolling instead of jumps), drops Patchright's forced media
  emulation, and smooths over back/forward-cache restores (see `src/cdp-proxy.ts`).
- **WebGL on the real GPU** through ANGLE when a render node is available, otherwise SwiftShader.

## Tools

| Tool | What it does |
| --- | --- |
| `open({ url })` | Open a URL in the current tab |
| `back()`, `forward()`, `reload()` | History navigation |
| `snapshot({ ref?, maxChars? })` | Page outline (ARIA tree as YAML) with element refs such as `e12`, iframes included. Password, one-time-code and card values show `[hidden]` |
| `screenshot({ fullPage?, ref? })` | Viewport, full page or one element, as an image |
| `click({ ref, double?, button? })` | Click an element |
| `type({ ref, text, submit? })` | Replace a field's text by typing it, optionally pressing Enter |
| `fill_form({ fields: [{ ref, value }] })` | Fill several fields: text, selects, checkboxes and radios |
| `select({ ref, values })` | Choose options of a `<select>` |
| `press({ key })` | Press a key, such as `Enter`, `Escape` or `Control+A` |
| `hover({ ref })` | Move the pointer over an element |
| `scroll({ direction?, amount?, ref? })` | Scroll with the wheel, or scroll an element into view |
| `wait({ text?, textGone?, seconds? })` | Wait for text to appear or disappear, or for a time |
| `tabs({ action, index?, url? })` | List, open, switch to or close tabs |
| `close()` | Close this session's browser now and delete its profile |
| `run_script({ code, timeoutMs? })` | Run Playwright code with `page`, `context` and `log` for multi-step work |

Actions return the page's title and URL afterwards, mention new tabs and accepted dialogs, and warn about bot
challenges. The server's instructions (sent at initialization; OpenCode adds them to the system prompt) explain the
snapshot → act on a ref → snapshot again loop.

`run_script` is **not a sandbox**: the code runs in the server process with its user's permissions, limited only by
a timeout. That adds nothing for an agent that already has a shell; give the server no more access than the agent
should have (for example, run the whole agent in a sandbox).

## Install

### Nix

```nix
{
  inputs.agent-browser.url = "github:NaifAlsultan/agent-browser";
  # ...
  environment.systemPackages = [ inputs.agent-browser.packages.x86_64-linux.default ];
}
```

The package bundles Chrome, Xvfb and the other tools it runs; Google Chrome is unfree, and the flake allows it for
this package only. Try it with `nix run github:NaifAlsultan/agent-browser` (it speaks MCP on stdin and stdout).

### OpenCode

```jsonc
{
  "mcp": {
    "servers": {
      "agent-browser": { "type": "local", "command": ["agent-browser"] }
    }
  }
}
```

Tools then appear as `agent-browser_open` and so on (in Code Mode, under the server's name).

### Without Nix

Node.js 24 or later, Google Chrome, Xvfb and, optionally, `xprop` and `setpriv` (util-linux):

```bash
npm ci --omit=dev
AGENT_BROWSER_CHROME=/usr/bin/google-chrome-stable node src/main.ts
```

## Configuration

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_BROWSER_CHROME` | `google-chrome-stable` (the Nix package: its own Chrome) | Chrome executable |
| `AGENT_BROWSER_XVFB` | `Xvfb` | Xvfb executable |
| `AGENT_BROWSER_XPROP` | unset (the Nix package: its own) | `xprop`, to give the virtual screen a desktop work area |
| `AGENT_BROWSER_SETPRIV` | unset (the Nix package: its own) | util-linux `setpriv`, so Chrome and Xvfb die with the server even if it's killed |
| `AGENT_BROWSER_SCREEN` | `1920x1080` | Virtual screen size |
| `AGENT_BROWSER_GPU` | `auto` | `on`: WebGL on the GPU; `off`: SwiftShader; `auto`: the GPU when `/dev/dri` has a usable render node |
| `AGENT_BROWSER_IDLE_TIMEOUT_MS` | `900000` (15 min) | Close a session's browser after this long without a call |
| `AGENT_BROWSER_ACTION_TIMEOUT_MS` | `15000` | Default timeout of actions |
| `AGENT_BROWSER_NAVIGATION_TIMEOUT_MS` | `45000` | Default timeout of navigations |
| `AGENT_BROWSER_CHALLENGE_WAIT_MS` | `15000` | How long to wait for a self-clearing bot check |
| `AGENT_BROWSER_HUMAN_INPUT` | on | `0`/`off` turns human-like input off (faster, easier to spot) |
| `AGENT_BROWSER_CHROME_ARGS` | none | Extra Chrome flags, space-separated |
| `AGENT_BROWSER_TMPDIR` | the system temporary directory | Where profiles and the X cookie go |
| `AGENT_BROWSER_DEBUG` | off | `1`: log every human-like input step and Chrome's stderr |

Logs go to stderr.

### Things to know

- **Machine-wide Chrome policies apply.** Google Chrome reads `/etc/opt/chrome/policies` for every profile, so
  force-installed extensions or cookie settings there reach the agent's browser too and can make it stand out.
  NixOS's `programs.chromium` writes its policies there as well as for Chromium. The server logs a warning when that
  directory has policies.
- **Chrome's sandbox needs user namespaces** (`clone(CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET)`). Under a
  systemd unit with `RestrictNamespaces=`, allow `user pid net`, or pass `--no-sandbox` in `AGENT_BROWSER_CHROME_ARGS`.
- **A process killed outright** can't delete its profiles; the next server to start removes leftovers of processes
  that are gone.

## Development

```bash
nix develop                  # Node 24, Chrome, Xvfb; sets AGENT_BROWSER_* to them
npm ci
npm test                     # unit tests (also run by `nix flake check`)
npm run test:integration     # the MCP server driving real Chrome on Xvfb against local pages
npm run typecheck
node scripts/mcp-call.ts '[["open", {"url": "example.com"}], ["snapshot", {}]]'
node scripts/detection-compare.ts /tmp/detection   # the comparison above (needs the dev shell's Playwright browsers)
```

TypeScript runs directly on Node's type stripping; there's no build step.

## Credits

- [browse](https://github.com/anomalyco/browse) (MIT): human-like input, challenge detection and Patchright tuning,
  vendored in [`vendor/browse`](vendor/browse), and the ideas behind several proxy fixes.
- [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (Apache-2.0): Playwright without the automation leaks.

## License

MIT
