// Runs agent scripts against a session's browser. Lives in the session's worker thread (see worker.ts).
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { challengeNote, detectChallenge } from "./challenge.ts"
import type { Config } from "./config.ts"
import type { Locator, Page } from "./patchright.ts"
import type { Session } from "./session.ts"
import { locateRef, takeSnapshot } from "./snapshot.ts"

type Image = { type: "image"; data: string; mimeType: string }

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

// Actions only: reads like count() and isVisible() must keep answering for a ref that's gone.
const refActions = new Set([
  "check", "clear", "click", "dblclick", "dispatchEvent", "dragTo", "fill", "focus", "hover", "press", "pressSequentially",
  "scrollIntoViewIfNeeded", "selectOption", "selectText", "setChecked", "setInputFiles", "tap", "type", "uncheck",
])

// As in browse's ref engine: an action on a ref that matches nothing fails after a short grace (a re-render, a
// brief "Saving…" label) instead of waiting out the whole action timeout. A hidden match waits the normal way.
export const staleRefGraceMs = 3_000

export function checkedRef(locator: Locator, id: string, graceMs = staleRefGraceMs): Locator {
  const present = async () => {
    const deadline = Date.now() + graceMs
    while ((await locator.count()) === 0) {
      if (Date.now() >= deadline) throw new Error(`Ref ${id} no longer matches an element: the page changed since the snapshot. Take a new snapshot and use its refs.`)
      await sleep(200)
    }
  }
  return new Proxy(locator, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown
      if (typeof value !== "function") return value
      if (typeof property === "string" && refActions.has(property)) {
        return async (...args: unknown[]) => {
          await present()
          return (value as (...args: unknown[]) => unknown).apply(target, args)
        }
      }
      return (value as (...args: unknown[]) => unknown).bind(target)
    },
  })
}

// The script's own deadline is enforced by the main thread, which ends the worker. Playwright's waits stop a little
// earlier, so a slow action fails as an ordinary error instead of costing the browser. Like browse, 30 s by default.
export function actionTimeouts(config: Pick<Config, "actionTimeoutMs" | "navigationTimeoutMs">, scriptTimeoutMs: number) {
  const cap = Math.max(1_000, scriptTimeoutMs - 2_000)
  return { action: Math.min(config.actionTimeoutMs, cap), navigation: Math.min(config.navigationTimeoutMs, cap) }
}

export class Runner {
  private readonly config: Config
  private readonly session: Session

  constructor(config: Config, session: Session) {
    this.config = config
    this.session = session
  }

  async run(code: string, timeoutMs: number): Promise<CallToolResult> {
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>
    const names = ["page", "context", "state", "snapshot", "ref", "screenshot", "log", "console"]
    let compiled: (...values: unknown[]) => Promise<unknown>
    try {
      compiled = new AsyncFunction(...names, code)
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `The code doesn't compile: ${errorText(error)}` }] }
    }

    const session = this.session
    const context = session.browser.context
    const timeouts = actionTimeouts(this.config, timeoutMs)
    context.setDefaultTimeout(timeouts.action)
    context.setDefaultNavigationTimeout(timeouts.navigation)

    const page = await session.ensurePage()
    const logs: string[] = []
    const images: Image[] = []
    const target = (other?: Page) => other ?? page
    const addLog = (prefix: string, values: unknown[]) => {
      if (logs.length < 200) logs.push((prefix + values.map((value) => (typeof value === "string" ? value : json(value))).join(" ")).slice(0, 2_000))
    }
    const scriptConsole = {
      log: (...values: unknown[]) => addLog("", values),
      info: (...values: unknown[]) => addLog("", values),
      debug: (...values: unknown[]) => addLog("", values),
      warn: (...values: unknown[]) => addLog("warning: ", values),
      error: (...values: unknown[]) => addLog("error: ", values),
    }
    const helpers = {
      snapshot: async (options: { ref?: string; maxChars?: number; page?: Page } = {}) => (await takeSnapshot(target(options.page), options)).text,
      ref: (id: string, other?: Page): Locator => checkedRef(locateRef(target(other), id), id),
      screenshot: async (options: { fullPage?: boolean; ref?: string; page?: Page } = {}) => {
        images.push(await this.screenshot(target(options.page), options))
        return `Screenshot ${images.length} attached.`
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
    try {
      value = await compiled(page, context, session.state, helpers.snapshot, helpers.ref, helpers.screenshot, scriptConsole.log, scriptConsole)
      // A click can start a navigation a moment later.
      if (!navigated) await sleep(300)
    } catch (error) {
      failure = error
    } finally {
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
    parts.push(await this.describe(notes))
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

  private async describe(lines: string[]): Promise<string> {
    const session = this.session
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
