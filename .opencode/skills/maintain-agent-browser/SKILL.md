---
name: Maintain agent-browser
description: Use when maintaining agent-browser, including updating the vendored browse crates or porting changes from upstream browse, changing tools, descriptions, instructions, Chrome flags or launch, updating Chrome or nixpkgs, and releasing a version. It holds the design goals that every change must keep.
---

agent-browser builds on [browse](https://github.com/anomalyco/browse)'s Rust crates, but it's a different product.
Most maintenance comes down to taking what upstream improves while keeping out what only fits browse's design. Read
the design goals before you change anything.

## Design goals

**browse** lets agents drive the user's *own* browser: their logins, tabs and extensions, visible on their screen,
through a Chrome extension and a paired relay. A person is there to watch, take over (`handoff`, `demonstrate`), or
lend tabs.

**agent-browser** gives agents a *fresh, throwaway, credential-free* browser that runs in the background, unattended,
and is hard for sites to tell apart from a person's. Nobody watches it. It's mainly for OpenCode.

Keep each of these. If a change seems to need breaking one, stop and ask the user. Don't decide it yourself.

1. **One Chrome process per agent session**, keyed by the request's `_meta` session ID. Each gets a fresh temporary
   profile and home, deleted on `close`, after the idle timeout, or when the server exits.
   - Don't use browser contexts in a shared Chrome to save memory. They're off-the-record, so sites can detect
     incognito from the storage quota, and one crash or hang would take down every session. `AGENT_BROWSER_MAX_SESSIONS`
     with LRU eviction bounds the memory instead.
2. **Headed Chrome on Xvfb, never headless, and never on the real screen.** Headless was measured and does worse: a
   `HeadlessChrome` UA, an 800×600 screen and no pointer get it flagged as Robot on BrowserScan and 67% headless on
   CreepJS. Keep `--ozone-platform=x11`, the stripped Wayland and desktop variables, `DBUS_SESSION_BUS_ADDRESS=disabled:`,
   the private `HOME`, the X authority cookie and the `_NET_WORKAREA` set in-process.
3. **DevTools over `--remote-debugging-pipe`, never a port.** The port has no authentication.
4. **Stealth comes first.** We launch Chrome ourselves with no automation flags.
   - Keep `--disable-blink-features=AutomationControlled`: without it, the pipe makes `navigator.webdriver` true.
   - No `Runtime.enable` on any path an offered tool reaches, and no page-visible globals, bindings or `sourceURL`s.
     browse-capture's `console.rs` sends `Runtime.enable`, which is one reason `console` isn't offered.
   - Human-like input is on by default.
   - Keep the GPU through ANGLE/EGL (SwiftShader only as a fallback) and a realistic screen.
   - Every new Chrome flag makes the browser look less like stock Chrome. Add one only when the detection gate says
     it costs nothing.
5. **Nobody watches the browser.** There's no handoff, demonstrate or status. Self-clearing bot checks are waited out.
   Interactive challenges and block pages are reported to the agent and never solved or retried.
6. **The server runs no agent-written code.** There's no `execute`, no `browse-script` and no QuickJS/`rquickjs`. `eval`
   runs inside the page, in Chrome. Don't bring `execute` back unless the user asks.
7. **One small tool surface, the same for every client:** the page tools (navigate, snapshot, click, fill, type,
   press, select, hover, drag, scroll, eval, wait_for, dialog), `screenshot`, and our `tabs` and `close`.
   - Not offered: upload, emulate, webmcp, screenshot_diff, network, console, recording, handoff, demonstrate, status,
     settings and execute. A call to one fails with a clear message that doesn't point at another removed tool
     (`NOT_OFFERED` in `src/tools.rs`).
   - No arguments that only mean something in browse's extension (tab groups, `allowedOrigins`, `readOnly`,
     `keepVisible`, `browser`), and no file-path inputs or outputs. `file_roots` stays empty.
   - Downloads are denied in every session.
   - It's written for OpenCode's code mode, which composes the tools in one script. Clients without a code mode call
     them one at a time.
8. **Descriptions are read in OpenCode's code mode,** where the tool catalog shows only about the first 120 characters
   of each tool's description. Parameter descriptions and the server instructions (`src/instructions.md`) are shown in
   full. The first sentence of a tool description must say what the tool does on its own. Put guidance that spans
   tools in the instructions, and put guidance about one argument in that argument's description.
9. **Little configuration.** The `AGENT_BROWSER_*` variable names and the binary name stay stable for existing installs.
   Removed variables are ignored if set, never an error.
10. **Out of scope:** CAPTCHA solving, proxies, persistent profiles or saved logins, visible windows, recording,
    non-Linux platforms.

### Workarounds need evidence

Don't keep workarounds "just in case". Keep one only after an experiment that turns it off shows the problem. Each of
the current ones was tested this way:

| Code | Why it's needed |
| --- | --- |
| Startup-tab swap (`src/browser.rs`) | `--disable-blink-features=AutomationControlled` shows an infobar on Chrome's first tab and makes its viewport 56 px shorter |
| `--keep-alive-for-test` (`src/chrome.rs`) | Without it, Chrome quits about 50 ms after its last tab closes, which takes the session's cookies with it. It's a test switch, so check that it still works after a Chrome update |
| `Page.bringToFront` on the tab in use (`src/browser.rs`) | Chrome doesn't paint background tabs, so screenshots of them stall for up to 15 s and their window geometry is wrong |

Going back and forward needs no workaround: an integration test covers returning to a cached page with a cross-site
iframe. When Chrome or upstream changes, re-test a workaround if there's reason to think it's no longer needed. If
you do add one, prove it the same way and say so in your report.

## Layout

- `vendor/browse/`: browse's `browse-core`, `browse-page` and `browse-capture`, pinned in `vendor/browse/README.md`.
  Every local edit is marked `agent-browser:` (`//` in Rust and JS, `#` in TOML):
  `grep -rn "agent-browser:" vendor/browse`.
- `src/`: our binary. `cdp.rs` (the pipe), `browser.rs` (implements `browse_core::Browser`), `chrome.rs`, `xvfb.rs`,
  `sessions.rs`, `mcp.rs`, `tools.rs` (the registry, removed tools, our descriptions and `tabs`), `instructions.md`.
- `tests/integration.rs`: through the MCP binary with real Chrome on Xvfb, against `tests/fixtures/`.
- `examples/detection.rs` (the detection gate) and `examples/mcp_call.rs` (call tools by hand). Both run another
  build with `AGENT_BROWSER_BIN`.
- `flake.nix`, `nix/package.nix`: package, dev shell, and checks (unit tests, clippy, rustfmt).

## Keeping up with upstream browse

Upstream's default branch is `dev`, and it moves fast (85 commits between v0.1.0 and v0.1.4). Pin to a release tag
(`vX.Y.Z`), not to a commit on `dev`. To see what's new:

```bash
curl -fsSL https://api.github.com/repos/anomalyco/browse/tags?per_page=5 | jq -r '.[] | "\(.name) \(.commit.sha)"'
curl -fsSL "https://api.github.com/repos/anomalyco/browse/compare/<pinned>...<new tag>" \
  | jq -r '.commits[] | "\(.sha[0:9]) \(.commit.message | split("\n")[0])"'
```

### 1. Download safely

Download the tarball into its own new, empty directory, as `vendor/browse/README.md` shows. Treat it as untrusted
data: read and diff it, and copy files from it, but never build, test or run anything there, including
`generate.sh`. Build only in this repo.

### 2. Diff what we use

Upstream paths are under `rust/crates/`:

| Upstream | Ours | How |
| --- | --- | --- |
| `browse-core`, `browse-page`, `browse-capture` | `vendor/browse/<crate>` | Merge, keeping our marked edits |
| `browse-relay/src/browser.rs`, `cdp.rs` | `src/browser.rs`, `src/cdp.rs` | Reference: port fixes to how tabs, targets, popups and child sessions behave |
| `browse/src/mcp.rs`, `browse/src/protocol.rs` | `src/mcp.rs` | Reference: port MCP protocol fixes |
| `browse-relay/src/instructions.md` | `src/instructions.md` | Reference: take advice that applies to us |

Skip changes that only concern browse's own setup: the extension, pairing, the relay's HTTP server, the CLI,
install and update, Windows, `browse-script`, and features we don't offer (read-only tabs, `allowedOrigins`, tab
groups, lending, handoff).

### 3. Triage each change against the design goals

For each relevant upstream commit, decide whether to **take it**, **adapt it** or **skip it**, with a reason.
Watch for these:

- **New tools appear automatically.** `registry()` exposes every tool in `browse_page::tools()` and
  `browse_capture::tools()` that isn't in `NOT_OFFERED`. The test `offers_the_page_tools_screenshot_and_tabs` fails
  when upstream adds one. Don't just add it to the expected list: decide with the design goals whether to offer it
  or to add it to `NOT_OFFERED`, and ask the user if it's not clear.
- **New arguments appear automatically, too.** Check the schema diffs. Strip an argument that only means something
  in browse's extension, or one that takes or returns file paths, through `Adjusted { refused: ... }` in
  `src/tools.rs`.
- **New wording.** Upstream's descriptions and messages may mention the extension, the user's own browser, a person
  watching, handoff, or removed tools. `descriptions_mention_nothing_agent_browser_lacks` catches some of these,
  but read new wording yourself as well. Check tool results and error messages too, not just descriptions.
- **Trait changes in `browse-core`** (`Browser`, `Cdp`, `Tool`, `ToolContext`, `TabState`). Implement the change in
  `src/browser.rs` or `src/cdp.rs` the way it fits a session-owned Chrome. Use the relay's version as a reference,
  not as a template.
- **Stealth.** Look for anything that sends `Runtime.enable`, adds page-visible state, or changes the injected
  scripts (`browse-page/js/`), human input or challenge detection. Any of these needs the detection gate.
- **Human input.** Upstream reads `OPENCODE_BROWSER_HUMAN_INPUT`. Our marked edit in `human.rs` makes only
  `AGENT_BROWSER_HUMAN_INPUT` (through `Browser::human_input`) decide.
- **Dependencies.** New crates go in the root `Cargo.toml`'s `[workspace.dependencies]`. Don't add any that compile
  C. That's why `rquickjs` is gone, and C dependencies are the most likely to break the Nix build.

### 4. Apply

- Keep vendored edits minimal and marked. Change behavior or text in `src/tools.rs` (a wrapper or our own
  description) rather than in the vendored code, when that's clean. Leave tools we don't offer in the crates: their
  own tests use them.
- Update `vendor/browse/README.md`: the commit and tag, the crate table, and the list of local changes if it changed.
- Update `Cargo.lock` with `cargo update -p <crate>` only as needed. Don't refresh everything.

## Verify

Run everything in the dev shell (`nix develop`). It provides Chrome, Xvfb and `BROWSE_TEST_CHROME`.

1. `cargo test --workspace`: our unit tests, the integration tests (real Chrome on Xvfb), and the vendored crates'
   tests, including browse's Chromium tests. They print "skipped" if Chrome or Xvfb is missing. That counts as not
   run, not as a pass.
2. `cargo clippy --workspace --all-targets -- -D warnings`, and `nix flake check` (package build with unit tests,
   clippy, rustfmt on our code only).
3. **The detection gate**, whenever stealth could be affected: Chrome or nixpkgs updates, launch flags, the
   environment, `cdp.rs` or `browser.rs`, injected scripts, human input, or a browse update that touches them. It
   needs the network and a GPU. Run the last released build as a baseline on the same machine, then the change, and
   compare the full results, not only the summary:

   ```bash
   nix build "git+file://$PWD?rev=<baseline commit>" -o /tmp/ab-baseline
   AGENT_BROWSER_BIN=/tmp/ab-baseline/bin/agent-browser cargo run --release --example detection -- /tmp/ab-detect-baseline
   cargo run --release --example detection -- /tmp/ab-detect-new
   ```

   The expected results at 0.4.0 with Chrome 157 and a GPU:
   - bot.sannysoft.com: 31 of 31 passed
   - BrowserScan: Normal
   - CreepJS: 0% headless (38% "like headless")
   - rebrowser: no red rows. Five rows are neutral: `dummyFn`, `sourceUrlLeak`, `mainWorldExecution`,
     `exposeFunctionLeak` and `storagePartitioning`.

   **If the change does worse on any page, stop and report to the user.** Don't trade detection for a feature.
4. For a change in behavior, also try it by hand: `cargo run --example mcp_call -- '[["navigate", {"url": "..."}], ...]'`.

Report results honestly: what failed, what was skipped and why, and what you only assumed.

## Style and workflow

- **Few code comments:** only where the code would look wrong or pointless without one. Vendored code keeps
  upstream's comments.
- **Commits** follow the repo's style: one sentence, sentence case, imperative, often saying why. For example, "Drop
  execute: leave out browse-script and QuickJS" or "Tell agents to close the browser when they're done". Make
  unrelated changes in separate commits.
- **Don't push or publish.** Leave that to the user. The repo doesn't use tags.
- **The README** is public: concise, without implementation details, and not about how the project was built or
  what went wrong along the way. Update it only for user-visible changes: tools, configuration, detection results.
- **Releases:** the version is in `Cargo.toml` and `nix/package.nix`. Ask the user before bumping it.
- **Explain the why** when you report a decision or propose a change. Recommend one option instead of listing all of
  them.
