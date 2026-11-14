import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { challengeNote, detectChallenge } from "./challenge.ts"
import type { Config } from "./config.ts"
import type { Locator, Page } from "./patchright.ts"
import { defaultSessionKey, type Session, type SessionManager } from "./session.ts"
import { locateRef, takeSnapshot } from "./snapshot.ts"

export const sessionMetaKey = "ai.opencode/sessionID"

type Extra = { _meta?: Record<string, unknown> }
type Image = { type: "image"; data: string; mimeType: string }

export function sessionKeyOf(extra: Extra | undefined): string {
  const value = extra?._meta?.[sessionMetaKey]
  return typeof value === "string" && value.trim() ? value.trim() : defaultSessionKey
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const lines = message.split("\n")
  const callLog = lines.findIndex((line) => /^\s*Call log:/.test(line))
  const kept = (callLog >= 0 ? lines.slice(0, callLog + 4) : lines).join("\n").trim()
  return kept.length > 2_000 ? `${kept.slice(0, 2_000)}...` : kept
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n... (cut at ${max} characters)` : text)

export const runDescription = `Run Playwright JavaScript in this session's browser: a real Google Chrome in the background with a fresh profile. The code is the body of an async function; \`return\` a JSON-serializable value. In scope:
- page: the current tab (Playwright Page); context: the browser context, for other tabs; state: an object kept between calls.
- snapshot({ ref?, maxChars?, page? }): an outline of the page with element refs like [ref=e12], iframes included (refs inside them look like f1e3). Password, one-time-code and card values show [hidden].
- ref(id, page?): a Locator for a ref from the latest snapshot of that page.
- screenshot({ fullPage?, ref?, page? }): attaches a screenshot to the result.
- log(...values): adds a line to the result.
The result also gives the page's title and URL afterwards, new tabs (later calls continue in the newest), accepted dialogs and bot challenges. It is not a sandbox: the code runs with the server's permissions.`

export class Tools {
  private readonly config: Config
  private readonly sessions: SessionManager

  constructor(config: Config, sessions: SessionManager) {
    this.config = config
    this.sessions = sessions
  }

  register(server: McpServer) {
    server.registerTool("run", {
      title: "Run a Playwright script in the browser",
      description: runDescription,
      inputSchema: {
        code: z.string().describe("Body of an async function, for example: await page.goto('https://example.com'); return await snapshot()"),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional().describe("Give up after this long (default 60000). A script that times out may keep running."),
      },
    }, async ({ code, timeoutMs }, extra) => {
      try {
        return await this.sessions.use(sessionKeyOf(extra), (session) => this.run(session, code, timeoutMs ?? 60_000))
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: errorText(error) }] }
      }
    })

    server.registerTool("close", {
      title: "Close the browser",
      description: "Close this session's browser now and delete its profile (cookies, history, storage). The next run starts a fresh one.",
      inputSchema: {},
    }, async (_args, extra) => {
      const closed = await this.sessions.close(sessionKeyOf(extra))
      return { content: [{ type: "text", text: closed ? "Closed the browser and deleted its profile." : "This session had no browser open." }] }
    })
  }

  private async run(session: Session, code: string, timeoutMs: number): Promise<CallToolResult> {
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>
    const names = ["page", "context", "state", "snapshot", "ref", "screenshot", "log"]
    let compiled: (...values: unknown[]) => Promise<unknown>
    try {
      compiled = new AsyncFunction(...names, code)
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `The code doesn't compile: ${errorText(error)}` }] }
    }

    const page = await session.ensurePage()
    const logs: string[] = []
    const images: Image[] = []
    const target = (other?: Page) => other ?? page
    const helpers = {
      snapshot: async (options: { ref?: string; maxChars?: number; page?: Page } = {}) => (await takeSnapshot(target(options.page), options)).text,
      ref: (id: string, other?: Page): Locator => locateRef(target(other), id),
      screenshot: async (options: { fullPage?: boolean; ref?: string; page?: Page } = {}) => {
        images.push(await this.screenshot(target(options.page), options))
        return `Screenshot ${images.length} attached.`
      },
      log: (...values: unknown[]) => {
        if (logs.length < 200) logs.push(values.map((value) => (typeof value === "string" ? value : json(value))).join(" ").slice(0, 2_000))
      },
    }

    session.takeOpenedPages()
    let navigated = false
    const onNavigated = (frame: { parentFrame(): unknown }) => {
      if (!frame.parentFrame()) navigated = true
    }
    page.on("framenavigated", onNavigated)
    let value: unknown
    let failure: unknown
    let timer: Parameters<typeof clearTimeout>[0]
    try {
      value = await Promise.race([
        compiled(page, session.browser.context, session.state, helpers.snapshot, helpers.ref, helpers.screenshot, helpers.log),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`The code didn't finish within ${timeoutMs} ms (it may still be running).`)), timeoutMs))),
      ])
      // A click can start a navigation a moment later.
      if (!navigated) await sleep(300)
    } catch (error) {
      failure = error
    } finally {
      clearTimeout(timer)
      page.off("framenavigated", onNavigated)
    }

    if (navigated && !page.isClosed()) await this.settle(page)
    const notes: string[] = []
    const opened = session.takeOpenedPages()
    if (opened.length) {
      const newest = opened[opened.length - 1]!
      session.page = newest
      await newest.bringToFront().catch(() => undefined)
      await this.settle(newest)
      notes.push(`${opened.length === 1 ? "A new tab opened" : `${opened.length} new tabs opened`}; \`page\` is the newest from the next call.`)
    }

    // Strings as they are, so a returned snapshot stays readable.
    const shown = typeof value === "string" ? value : json(value)
    const parts = [failure ? `Error: ${errorText(failure)}` : value === undefined ? "Returned nothing." : `Returned:\n${truncate(shown, 50_000)}`]
    if (logs.length) parts.push(`Log:\n${logs.join("\n")}`)
    parts.push(await this.describe(session, notes))
    return { ...(failure ? { isError: true } : {}), content: [{ type: "text", text: parts.join("\n\n") }, ...images] }
  }

  private async screenshot(page: Page, options: { fullPage?: boolean; ref?: string }): Promise<Image> {
    if (options.ref) return { type: "image", data: (await locateRef(page, options.ref).screenshot({ type: "png" })).toString("base64"), mimeType: "image/png" }
    if (!options.fullPage) return { type: "image", data: (await page.screenshot({ type: "png" })).toString("base64"), mimeType: "image/png" }
    const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) }))
    const clip = { x: 0, y: 0, width: Math.min(size.width, 4_000), height: Math.min(size.height, 8_000) }
    return { type: "image", data: (await page.screenshot({ type: "jpeg", quality: 80, fullPage: true, clip })).toString("base64"), mimeType: "image/jpeg" }
  }

  // Polls readyState: a page restored from the back/forward cache fires no load events, so Patchright's waits hang.
  private async settle(page: Page, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !page.isClosed()) {
      const state = await Promise.race([page.evaluate(() => document.readyState).catch(() => undefined), sleep(1_000).then(() => undefined)])
      if (state === "complete") return
      await sleep(state === "interactive" ? 250 : 100)
    }
  }

  private async describe(session: Session, lines: string[]): Promise<string> {
    const page = await session.ensurePage()
    const challenge = challengeNote(await detectChallenge(page, this.config.challengeWaitMs))
    const title = await page.title().catch(() => "")
    const tabs = session.pages()
    const out = [...lines]
    out.push(`Page: ${title ? `${title} ` : ""}(${page.url()})${tabs.length > 1 ? ` [tab ${tabs.indexOf(page) + 1} of ${tabs.length}]` : ""}`)
    out.push(...session.takeEvents())
    if (challenge) out.push(challenge)
    return out.join("\n")
  }
}
