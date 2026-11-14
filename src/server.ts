import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Config } from "./config.ts"
import type { SessionManager } from "./session.ts"
import { Tools } from "./tools.ts"

export const serverName = "agent-browser"
export const serverVersion = "0.2.0"

export const instructions = `agent-browser is a web browser for visiting sites, searching, reading pages and filling forms: a real Google Chrome in the background with a fresh profile for this session (no logins, cookies or history of the user's), deleted when the session calls close, after 15 minutes without a call, or when OpenCode exits.

Use it with run({ code }): Playwright JavaScript with \`page\`, \`context\`, \`state\` and these helpers in scope:
- snapshot() returns an outline of the page with element refs like [ref=e12] (in iframes, f1e3).
- ref("e12") is a Locator for a ref from the latest snapshot.
- screenshot({ fullPage, ref }) attaches an image to the result; log(...) adds a line.

A typical loop:
1. run: await page.goto("https://duckduckgo.com/?q=your+query"); return await snapshot()
2. run: await ref("e12").click(); return await snapshot()
Do several steps in one call when you know what they are, and return only what you need: whole snapshots are large.

Tips:
- Type with await ref("e5").pressSequentially("text") (like a person); fill() is instant and easier to spot. Click, hover and scroll as usual: input is paced like a person's automatically, so it takes a moment.
- Go back and forward with page.goBack({ waitUntil: "commit" }) and page.goForward({ waitUntil: "commit" }): pages restored from the back/forward cache never fire load events.
- page.evaluate runs in an isolated world that pages can't see. Avoid page.addInitScript, page.exposeFunction and page.route: pages can detect them.
- Results end with the page's title and URL, new tabs (\`page\` is the newest from the next call), accepted dialogs and bot challenges.

Bot checks: a check that clears itself (Cloudflare's "Just a moment...") is waited out automatically. When a result says WARNING: blocked, don't retry, reload or try to solve the CAPTCHA: use another source or tell the user.

Password, one-time-code and payment-card fields show [hidden] in snapshots. Don't enter the user's real passwords or card details unless they explicitly ask for it.`

export function createServer(config: Config, sessions: SessionManager): McpServer {
  const server = new McpServer({ name: serverName, version: serverVersion }, { instructions })
  new Tools(config, sessions).register(server)
  return server
}
