import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Config } from "./config.ts"
import type { SessionManager } from "./session.ts"
import { Tools } from "./tools.ts"

export const serverName = "agent-browser"
export const serverVersion = "0.1.0"

export const instructions = `agent-browser is a web browser for visiting sites, searching, reading pages and filling forms. It's a real Google Chrome that runs in the background (nobody sees it), with a fresh profile for this session: no logins, cookies or history of the user's. Its profile is deleted when the session closes it, after 15 minutes without a call, or when OpenCode exits.

How to use it:
1. open({ url }) a page. For a web search, open a search engine with the query in the URL, for example https://duckduckgo.com/?q=your+query or https://www.google.com/search?q=your+query.
2. snapshot() to read the page. It's an outline of the page with element refs like [ref=e12] (refs inside iframes look like f1e3).
3. Act on refs: click({ ref }), type({ ref, text, submit }), fill_form({ fields: [{ ref, value }] }), select({ ref, values }), hover({ ref }), scroll({ ref }) or scroll({ direction }), press({ key }).
4. snapshot() again after anything that changes the page: refs are only valid for the latest snapshot.

Results of actions give the page's title and URL afterwards, say when a new tab opened (work continues in it) or a dialog was accepted, and warn about bot challenges.

Other tools: back, forward, reload; screenshot({ fullPage, ref }) to see layout or images (use snapshot for text); wait({ text | textGone | seconds }); tabs({ action: "list" | "new" | "select" | "close" }); close() to throw this browser away now; run_script({ code }) for many steps in one call with Playwright's API (\`page\`, \`context\`, \`log\` in scope; \`return\` a value).

Bot checks: the browser is built to look like a person's. A check that clears itself (Cloudflare's "Just a moment...") is waited out automatically. When a result says WARNING: blocked, don't retry, reload or try to solve the CAPTCHA, which makes it worse: use another source or tell the user. Input is paced like a person's, so clicks and typing take a moment.

Password, one-time-code and payment-card fields show [hidden] in snapshots. Don't enter the user's real passwords or card details unless they explicitly ask for it.`

export function createServer(config: Config, sessions: SessionManager): McpServer {
  const server = new McpServer({ name: serverName, version: serverVersion }, { instructions })
  new Tools(config, sessions).register(server)
  return server
}
