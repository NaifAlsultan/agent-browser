import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { defaultSessionMetaKey } from "./config.ts"
import { errorText } from "./runner.ts"
import { defaultSessionKey, type SessionManager } from "./sessions.ts"

type Extra = { _meta?: Record<string, unknown> }

export function sessionKeyOf(extra: Extra | undefined, metaKey = defaultSessionMetaKey): string {
  const value = extra?._meta?.[metaKey]
  return typeof value === "string" && value.trim() ? value.trim() : defaultSessionKey
}

export const runDescription = `Run Playwright JavaScript in this session's browser: a real Google Chrome in the background with a fresh profile. The code is the body of an async function; \`return\` a JSON-serializable value. In scope:
- page: the current tab (Playwright Page); context: the browser context, for other tabs; state: an object kept between calls.
- snapshot({ ref?, maxChars?, page? }): an outline of the page with element refs like [ref=e12], iframes included (refs inside them look like f1e3). Password, one-time-code and card values show [hidden].
- ref(id, page?): a Locator for a ref from the latest snapshot of that page.
- screenshot({ fullPage?, ref?, page? }): attaches a screenshot to the result.
- log(...values), like console.log: adds a line to the result.
These exist only inside \`code\`: from a client's own code mode, pass the Playwright code here as a string. There's no document, location or fetch: use page.evaluate(...) for code in the page.
Type with locator.pressSequentially(text), like a person; fill() is instant and easier to spot. Use page.goBack({ waitUntil: "commit" }) and page.goForward({ waitUntil: "commit" }): pages restored from the back/forward cache fire no load events.
The result also gives the page's title and URL afterwards, new tabs (later calls continue in the newest), dialogs (dismissed, except leave-page prompts) and bot challenges. Code still running at timeoutMs is stopped by closing this session's browser, so its tabs and state are lost. It is not a sandbox: the code runs with the server's permissions.`

export class Tools {
  private readonly sessions: SessionManager
  private readonly sessionMetaKey: string

  constructor(sessions: SessionManager, sessionMetaKey = defaultSessionMetaKey) {
    this.sessions = sessions
    this.sessionMetaKey = sessionMetaKey
  }

  register(server: McpServer) {
    server.registerTool("run", {
      title: "Run a Playwright script in the browser",
      description: runDescription,
      inputSchema: {
        code: z.string().describe("Body of an async function, for example: await page.goto('https://example.com'); return await snapshot()"),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional().describe("Give up after this long (default 60000). A script still running then is stopped by closing this session's browser."),
      },
    }, async ({ code, timeoutMs }, extra) => {
      try {
        return await this.sessions.run(sessionKeyOf(extra, this.sessionMetaKey), code, timeoutMs ?? 60_000)
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: errorText(error) }] }
      }
    })

    server.registerTool("close", {
      title: "Close the browser",
      description: "Close this session's browser now and delete its profile (cookies, history, storage). The next run starts a fresh one.",
      inputSchema: {},
    }, async (_args, extra) => {
      const closed = await this.sessions.close(sessionKeyOf(extra, this.sessionMetaKey))
      return { content: [{ type: "text", text: closed ? "Closed the browser and deleted its profile." : "This session had no browser open." }] }
    })
  }
}
