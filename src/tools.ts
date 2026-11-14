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

export function normalizeUrl(input: string): string {
  const url = input.trim()
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(url)) return `http://${url}`
  // host:port looks like a scheme, but isn't one.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[^/:]+:\d+([/?#]|$)/.test(url)) return url
  return `https://${url}`
}

export class Tools {
  private readonly config: Config
  private readonly sessions: SessionManager

  constructor(config: Config, sessions: SessionManager) {
    this.config = config
    this.sessions = sessions
  }

  private async call(extra: Extra | undefined, body: (session: Session) => Promise<CallToolResult | string>): Promise<CallToolResult> {
    try {
      return await this.sessions.use(sessionKeyOf(extra), async (session) => {
        const result = await body(session)
        return typeof result === "string" ? { content: [{ type: "text", text: result }] } : result
      })
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: errorText(error) }] }
    }
  }

  // Checked up front, so a stale ref fails fast instead of timing out.
  private async ref(page: Page, ref: string): Promise<Locator> {
    const locator = locateRef(page, ref)
    const count = await locator.count().catch(() => 0)
    if (count === 0) throw new Error(`Ref ${ref} isn't on the page any more. Take a new snapshot and use a ref from it.`)
    return locator
  }

  private async act(session: Session, action: (page: Page) => Promise<string | void>): Promise<string> {
    const page = await session.ensurePage()
    session.takeOpenedPages()
    let navigated = false
    const onNavigated = (frame: { parentFrame(): unknown }) => {
      if (!frame.parentFrame()) navigated = true
    }
    page.on("framenavigated", onNavigated)
    let summary: string | void
    try {
      summary = await action(page)
      // A click can start a navigation a moment later.
      if (!navigated) await sleep(300)
    } finally {
      page.off("framenavigated", onNavigated)
    }
    const notes: string[] = []
    if (navigated && !page.isClosed()) await this.settle(page)
    const opened = session.takeOpenedPages()
    if (opened.length) {
      const newest = opened[opened.length - 1]!
      session.page = newest
      await newest.bringToFront().catch(() => undefined)
      await this.settle(newest)
      notes.push(`It opened ${opened.length === 1 ? "a new tab" : `${opened.length} new tabs`}; now working in the newest one.`)
    }
    return this.describe(session, [summary ?? "", ...notes])
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

  private async traverse(page: Page, delta: -1 | 1): Promise<boolean> {
    const cdp = await page.context().newCDPSession(page)
    try {
      const history = (await cdp.send("Page.getNavigationHistory")) as { currentIndex: number; entries: unknown[] }
      const target = history.currentIndex + delta
      if (target < 0 || target >= history.entries.length) return false
    } finally {
      await cdp.detach().catch(() => undefined)
    }
    if (delta < 0) await page.goBack({ waitUntil: "commit" })
    else await page.goForward({ waitUntil: "commit" })
    return true
  }

  private async describe(session: Session, lines: string[] = []): Promise<string> {
    const page = await session.ensurePage()
    const challenge = challengeNote(await detectChallenge(page, this.config.challengeWaitMs))
    const title = await page.title().catch(() => "")
    const tabs = session.pages()
    const out = [...lines.filter(Boolean)]
    out.push(`Page: ${title ? `${title} ` : ""}(${page.url()})${tabs.length > 1 ? ` [tab ${tabs.indexOf(page) + 1} of ${tabs.length}]` : ""}`)
    out.push(...session.takeEvents())
    if (challenge) out.push(challenge)
    return out.join("\n")
  }

  private async placePointer(session: Session, page: Page) {
    if (session.pointerPlaced.has(page)) return
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    await page.mouse.move(size.width * (0.35 + Math.random() * 0.3), size.height * (0.35 + Math.random() * 0.3))
    session.pointerPlaced.add(page)
  }

  private async typeInto(session: Session, page: Page, locator: Locator, text: string) {
    await locator.click()
    session.pointerPlaced.add(page)
    const hasText = await locator.evaluate((element) => {
      const value = (element as HTMLInputElement).value
      return typeof value === "string" ? value.length > 0 : (element.textContent ?? "").trim().length > 0
    })
    if (hasText) {
      await page.keyboard.press("ControlOrMeta+A")
      await page.keyboard.press("Backspace")
    }
    // Human pacing types about 15 keys a second; very long text is inserted at once.
    if (text.length > 400) await page.keyboard.insertText(text)
    else await locator.pressSequentially(text)
  }

  register(server: McpServer) {
    const ref = z.string().describe("Element ref from the latest snapshot, for example e12 (or f1e3 inside an iframe)")

    server.registerTool("open", {
      title: "Open a URL",
      description: "Open a URL in the current tab. A bare host like example.com gets https://. Starts this session's browser if needed.",
      inputSchema: { url: z.string().describe("The URL to open") },
    }, ({ url }, extra) => this.call(extra, (session) => this.act(session, async (page) => {
      const response = await page.goto(normalizeUrl(url), { waitUntil: "commit" })
      const status = response?.status()
      return status && status >= 400 ? `The server answered HTTP ${status}.` : undefined
    })))

    for (const [name, description] of [["back", "Go back in the current tab's history."], ["forward", "Go forward in the current tab's history."], ["reload", "Reload the current tab."]] as const) {
      server.registerTool(name, { title: description, description, inputSchema: {} }, (_args, extra) =>
        this.call(extra, (session) => this.act(session, async (page) => {
          if (name === "reload") {
            await page.reload({ waitUntil: "commit" })
            return undefined
          }
          if (!(await this.traverse(page, name === "back" ? -1 : 1))) return name === "back" ? "There's no page to go back to." : "There's no page to go forward to."
          return undefined
        })))
    }

    server.registerTool("snapshot", {
      title: "Read the page",
      description: "Outline of the current page (accessibility tree as YAML) with element refs like [ref=e12] that click, type, select, hover and scroll accept. Includes iframes. Password, one-time-code and card fields show [hidden] instead of their value. Refs are only valid until the next snapshot.",
      inputSchema: {
        ref: ref.optional().describe("Only this element's part of the page"),
        maxChars: z.number().int().min(1_000).max(500_000).optional().describe("Cut the outline after this many characters (default 40000)"),
      },
    }, ({ ref: scope, maxChars }, extra) => this.call(extra, async (session) => {
      const page = await session.ensurePage()
      const { text } = await takeSnapshot(page, { ref: scope, maxChars })
      return `${await this.describe(session)}\n\n${text}`
    }))

    server.registerTool("screenshot", {
      title: "Take a screenshot",
      description: "Screenshot of the current tab's viewport, the full page, or one element, returned as an image. Use snapshot to read text and find refs; use this to see layout or images.",
      inputSchema: {
        fullPage: z.boolean().optional().describe("The whole scrollable page instead of the viewport (cut at 8000 px)"),
        ref: ref.optional().describe("Only this element"),
      },
    }, ({ fullPage, ref: target }, extra) => this.call(extra, async (session) => {
      const page = await session.ensurePage()
      let image: Buffer
      let note = ""
      if (target) image = await (await this.ref(page, target)).screenshot({ type: "png" })
      else if (fullPage) {
        const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) }))
        const height = Math.min(size.height, 8_000)
        if (size.height > height) note = `The page is ${size.height} px tall; the screenshot shows the top ${height} px.`
        image = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true, clip: { x: 0, y: 0, width: Math.min(size.width, 4_000), height } })
      } else image = await page.screenshot({ type: "png" })
      return {
        content: [
          { type: "image", data: image.toString("base64"), mimeType: target || !fullPage ? "image/png" : "image/jpeg" },
          { type: "text", text: await this.describe(session, [note]) },
        ],
      }
    }))

    server.registerTool("click", {
      title: "Click an element",
      description: "Click an element by ref. The pointer moves there like a person's would.",
      inputSchema: {
        ref,
        double: z.boolean().optional().describe("Double-click"),
        button: z.enum(["left", "right", "middle"]).optional(),
      },
    }, ({ ref: target, double, button }, extra) => this.call(extra, (session) => this.act(session, async (page) => {
      const locator = await this.ref(page, target)
      if (double) await locator.dblclick({ button })
      else await locator.click({ button })
      session.pointerPlaced.add(page)
      return `Clicked ${target}.`
    })))

    server.registerTool("type", {
      title: "Type into a field",
      description: "Replace the text of an input, textarea or editable element by clicking it and typing key by key. Set submit to press Enter afterwards.",
      inputSchema: {
        ref,
        text: z.string().describe("The text to type (replaces what's there)"),
        submit: z.boolean().optional().describe("Press Enter afterwards"),
      },
    }, ({ ref: target, text, submit }, extra) => this.call(extra, (session) => this.act(session, async (page) => {
      const locator = await this.ref(page, target)
      await this.typeInto(session, page, locator, text)
      if (submit) await page.keyboard.press("Enter")
      return `Typed into ${target}${submit ? " and pressed Enter" : ""}.`
    })))

    server.registerTool("fill_form", {
      title: "Fill several fields",
      description: "Fill several form fields in order. Text fields are typed into; selects take an option's label or value; checkboxes and radios take \"true\" or \"false\". Doesn't submit: click the submit button afterwards.",
      inputSchema: {
        fields: z.array(z.object({ ref, value: z.string() })).min(1).describe("Fields and values, in the order to fill them"),
      },
    }, ({ fields }, extra) => this.call(extra, (session) => this.act(session, async (page) => {
      for (const field of fields) {
        const locator = await this.ref(page, field.ref)
        const kind = await locator.evaluate((element) => {
          const role = element.getAttribute("role")
          if (element instanceof HTMLSelectElement) return "select"
          if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) return "check"
          if (role === "checkbox" || role === "radio" || role === "switch") return "check"
          return "text"
        })
        if (kind === "select") {
          await locator.hover()
          await locator.selectOption(field.value).catch(async () => locator.selectOption({ label: field.value }))
        } else if (kind === "check") {
          await locator.setChecked(/^(true|yes|on|1|checked)$/i.test(field.value.trim()))
        } else {
          await this.typeInto(session, page, locator, field.value)
        }
        session.pointerPlaced.add(page)
      }
      return `Filled ${fields.length} field${fields.length === 1 ? "" : "s"}.`
    })))

    server.registerTool("select", {
      title: "Choose options",
      description: "Choose one or more options of a <select> by label or value.",
      inputSchema: { ref, values: z.array(z.string()).min(1).describe("Option labels or values") },
    }, ({ ref: target, values }, extra) => this.call(extra, (session) => this.act(session, async (page) => {
      const locator = await this.ref(page, target)
      await locator.hover()
      session.pointerPlaced.add(page)
      const chosen = await locator.selectOption(values)
      return `Selected ${chosen.map((value) => JSON.stringify(value)).join(", ") || "nothing"} in ${target}.`
    })))

    server.registerTool("press", {
      title: "Press a key",
      description: "Press a key or combination in the focused element, for example Enter, Escape, Tab, ArrowDown, PageDown or Control+A.",
      inputSchema: { key: z.string().describe("Key name as in Playwright's keyboard.press") },
    }, ({ key }, extra) => this.call(extra, (session) => this.act(session, async (page) => {
      await page.keyboard.press(key)
      return `Pressed ${key}.`
    })))

    server.registerTool("hover", {
      title: "Hover over an element",
      description: "Move the pointer over an element, for menus and tooltips.",
      inputSchema: { ref },
    }, ({ ref: target }, extra) => this.call(extra, (session) => this.act(session, async (page) => {
      await (await this.ref(page, target)).hover()
      session.pointerPlaced.add(page)
      return `Hovering over ${target}.`
    })))

    server.registerTool("scroll", {
      title: "Scroll",
      description: "Scroll the page with the mouse wheel (direction and amount), or scroll an element into view (ref).",
      inputSchema: {
        direction: z.enum(["down", "up", "left", "right"]).optional().describe("Default: down"),
        amount: z.number().int().min(1).max(20_000).optional().describe("Pixels (default: most of a screen)"),
        ref: ref.optional().describe("Scroll this element into view instead"),
      },
    }, ({ direction, amount, ref: target }, extra) => this.call(extra, (session) => this.act(session, async (page) => {
      if (target) {
        await (await this.ref(page, target)).scrollIntoViewIfNeeded()
      } else {
        await this.placePointer(session, page)
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        const dir = direction ?? "down"
        const pixels = amount ?? Math.round((dir === "left" || dir === "right" ? viewport.width : viewport.height) * 0.8)
        await page.mouse.wheel(dir === "left" ? -pixels : dir === "right" ? pixels : 0, dir === "up" ? -pixels : dir === "down" ? pixels : 0)
        await sleep(200)
      }
      const at = await page.evaluate(() => ({ y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight }))
      const where = at.y + at.viewport >= at.height - 2 ? "at the bottom" : at.y <= 0 ? "at the top" : `${Math.round(((at.y + at.viewport) / at.height) * 100)}% down`
      return target ? `Scrolled ${target} into view (page ${where}).` : `Scrolled; the page is ${where}.`
    })))

    server.registerTool("wait", {
      title: "Wait",
      description: "Wait for text to appear or disappear in the current tab, or for a number of seconds.",
      inputSchema: {
        text: z.string().optional().describe("Wait until this text is visible"),
        textGone: z.string().optional().describe("Wait until this text is no longer visible"),
        seconds: z.number().min(0).max(60).optional().describe("Wait this long"),
        timeoutSeconds: z.number().min(1).max(120).optional().describe("Give up on text after this long (default 15)"),
      },
    }, ({ text, textGone, seconds, timeoutSeconds }, extra) => this.call(extra, async (session) => {
      const page = await session.ensurePage()
      const timeout = (timeoutSeconds ?? 15) * 1_000
      if (seconds !== undefined) await sleep(seconds * 1_000)
      if (text !== undefined) await page.getByText(text).first().waitFor({ state: "visible", timeout })
      if (textGone !== undefined) await page.getByText(textGone).first().waitFor({ state: "hidden", timeout })
      if (seconds === undefined && text === undefined && textGone === undefined) throw new Error("Give text, textGone or seconds.")
      return this.describe(session, [text !== undefined ? `"${text}" is visible.` : textGone !== undefined ? `"${textGone}" is gone.` : `Waited ${seconds} s.`])
    }))

    server.registerTool("tabs", {
      title: "Manage tabs",
      description: "List tabs, open a new one, switch to one, or close one. Tabs are numbered from 1.",
      inputSchema: {
        action: z.enum(["list", "new", "select", "close"]),
        index: z.number().int().min(1).optional().describe("Tab number for select and close (close defaults to the current tab)"),
        url: z.string().optional().describe("URL to open in the new tab"),
      },
    }, ({ action, index, url }, extra) => this.call(extra, async (session) => {
      const pick = (number: number | undefined) => {
        const tabs = session.pages()
        const page = number === undefined ? session.page : tabs[number - 1]
        if (!page) throw new Error(`There's no tab ${number}; there ${tabs.length === 1 ? "is 1 tab" : `are ${tabs.length} tabs`}.`)
        return page
      }
      if (action === "new") {
        return this.act(session, async () => {
          const page = await session.browser.context.newPage()
          session.takeOpenedPages()
          session.page = page
          await page.bringToFront()
          if (url) {
            await page.goto(normalizeUrl(url), { waitUntil: "commit" })
            await this.settle(page)
          }
          return "Opened a new tab."
        })
      }
      if (action === "select") {
        if (index === undefined) throw new Error("select needs an index.")
        const page = pick(index)
        session.page = page
        await page.bringToFront()
        return this.describe(session, [`Switched to tab ${index}.`])
      }
      if (action === "close") {
        const page = pick(index)
        await page.close()
        if (session.pages().length === 0) {
          session.page = await session.browser.context.newPage()
        } else if (page === session.page || session.page.isClosed()) {
          const tabs = session.pages()
          session.page = tabs[tabs.length - 1]!
        }
        await session.page.bringToFront().catch(() => undefined)
        session.takeEvents()
      }
      const tabs = session.pages()
      const list = await Promise.all(tabs.map(async (page, i) => `${i + 1}. ${(await page.title().catch(() => "")) || "(no title)"} (${page.url()})${page === session.page ? " <- current" : ""}`))
      return `${action === "close" ? "Closed the tab.\n" : ""}${list.join("\n")}`
    }))

    server.registerTool("close", {
      title: "Close the browser",
      description: "Close this session's browser now and delete its profile (cookies, history, storage). The next browser call starts a fresh one.",
      inputSchema: {},
    }, async (_args, extra) => {
      const closed = await this.sessions.close(sessionKeyOf(extra))
      return { content: [{ type: "text", text: closed ? "Closed the browser and deleted its profile." : "This session had no browser open." }] }
    })

    server.registerTool("run_script", {
      title: "Run a Playwright script",
      description: "Run JavaScript with Playwright's API for multi-step work in one call. The code is the body of an async function with `page` (the current tab), `context` (the browser context, for other tabs) and `log(...)` in scope; `return` a JSON-serializable value. page.evaluate runs in an isolated world that page scripts can't see; pass `undefined, undefined, false` after the argument to run in the page's own world (which sites can detect). Not a sandbox: it runs with the MCP server's permissions.",
      inputSchema: {
        code: z.string().describe("Body of an async function, for example: await page.getByRole('link', { name: 'Next' }).click(); return await page.title()"),
        timeoutMs: z.number().int().min(1_000).max(600_000).optional().describe("Give up after this long (default 60000). A script that times out may keep running in the background."),
      },
    }, ({ code, timeoutMs }, extra) => this.call(extra, async (session) => {
      const logs: string[] = []
      const log = (...args: unknown[]) => {
        if (logs.length < 200) logs.push(args.map((arg) => (typeof arg === "string" ? arg : safeJson(arg))).join(" ").slice(0, 2_000))
      }
      let value: unknown
      const summary = await this.act(session, async (page) => {
        const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>
        let compiled: (...values: unknown[]) => Promise<unknown>
        try {
          compiled = new AsyncFunction("page", "context", "log", code)
        } catch (error) {
          throw new Error(`The script doesn't compile: ${errorText(error)}`)
        }
        const limit = timeoutMs ?? 60_000
        let timer: Parameters<typeof clearTimeout>[0]
        try {
          value = await Promise.race([
            compiled(page, session.browser.context, log),
            new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`The script didn't finish within ${limit} ms (it may still be running).`)), limit))),
          ])
        } finally {
          clearTimeout(timer)
        }
      })
      const parts = [summary]
      if (logs.length) parts.push(`Log:\n${logs.join("\n")}`)
      parts.push(value === undefined ? "Returned nothing." : `Returned:\n${truncate(safeJson(value), 50_000)}`)
      return parts.join("\n\n")
    }))
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n... (cut at ${max} characters)` : text
}
