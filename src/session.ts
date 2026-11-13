// One browser per OpenCode session. The first tool call of a session launches Chrome with a fresh profile; after
// the idle timeout, a close call, or process exit, Chrome is closed and the profile deleted. Separate Chrome
// processes rather than incognito-style contexts in one Chrome, because sites can detect incognito.
import { AgentBrowser } from "./browser.ts"
import type { Config } from "./config.ts"
import { log } from "./log.ts"
import type { Dialog, Page } from "./patchright.ts"

export const defaultSessionKey = "default"

export class Session {
  readonly key: string
  readonly browser: AgentBrowser
  private current: Page
  /** Things that happened between tool calls (dialogs, tabs opened or closed), reported with the next result. */
  private readonly events: string[] = []
  /** Pages opened since the last call to takeOpenedPages. */
  private opened: Page[] = []
  /** Pages the pointer has been over (wheel scrolling needs the pointer on the page). */
  readonly pointerPlaced = new WeakSet<Page>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(key: string, browser: AgentBrowser) {
    this.key = key
    this.browser = browser
    const first = browser.context.pages()[0]
    if (!first) throw new Error("the browser has no tab")
    this.current = first
    for (const page of browser.context.pages()) this.watch(page)
    browser.context.on("page", (page) => {
      this.watch(page)
      this.opened.push(page)
    })
  }

  get page(): Page {
    if (this.current.isClosed()) {
      const remaining = this.pages()
      if (remaining.length) this.current = remaining[remaining.length - 1]!
    }
    return this.current
  }

  set page(page: Page) {
    this.current = page
  }

  pages(): Page[] {
    return this.browser.context.pages().filter((page) => !page.isClosed())
  }

  /** A page to work in: the current one, or a new tab if every tab was closed. */
  async ensurePage(): Promise<Page> {
    const page = this.page
    if (!page.isClosed()) return page
    this.current = await this.browser.context.newPage()
    return this.current
  }

  /** Pages opened since the last call (popups, target=_blank links, tabs opened by scripts). */
  takeOpenedPages(): Page[] {
    const opened = this.opened.filter((page) => !page.isClosed())
    this.opened = []
    return opened
  }

  takeEvents(): string[] {
    return this.events.splice(0)
  }

  /** Runs tool calls of this session one at a time. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => undefined)
    return result
  }

  private watch(page: Page) {
    // Nobody can see a dialog, and an unanswered one blocks the page: accept it, and tell the agent.
    page.on("dialog", (dialog: Dialog) => {
      const text = dialog.message().replace(/\s+/g, " ").slice(0, 300)
      this.events.push(`A ${dialog.type()} dialog said "${text}"; it was accepted.`)
      void dialog.accept().catch(() => undefined)
    })
    page.on("close", () => {
      if (page === this.current) this.events.push("The current tab was closed.")
    })
  }
}

export class SessionManager {
  private readonly config: Config
  private readonly sessions = new Map<string, Promise<Session>>()
  /** Sessions whose browser is up, for synchronous cleanup at exit. */
  private readonly live = new Map<string, Session>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly busy = new Map<string, number>()

  constructor(config: Config) {
    this.config = config
  }

  /** Runs `task` with the session's browser, launching it on first use. Calls of one session run in order. */
  async use<T>(key: string, task: (session: Session) => Promise<T>): Promise<T> {
    this.busy.set(key, (this.busy.get(key) ?? 0) + 1)
    this.clearTimer(key)
    try {
      const session = await this.get(key)
      return await session.run(() => task(session))
    } finally {
      const left = (this.busy.get(key) ?? 1) - 1
      if (left > 0) this.busy.set(key, left)
      else {
        this.busy.delete(key)
        this.armTimer(key)
      }
    }
  }

  has(key: string): boolean {
    return this.sessions.has(key)
  }

  get size(): number {
    return this.sessions.size
  }

  private async get(key: string): Promise<Session> {
    const existing = this.sessions.get(key)
    if (existing) {
      const session = await existing.catch(() => undefined)
      if (session?.browser.connected) return session
      // Chrome died or failed to start: start over.
      if (this.sessions.get(key) === existing) this.sessions.delete(key)
      if (session && this.live.get(key) === session) this.live.delete(key)
      if (session) await session.browser.close().catch(() => undefined)
      if (session) log("session.browser-lost", { session: key })
    }
    if (!this.sessions.has(key)) {
      const launching = AgentBrowser.launch(this.config, key).then((browser) => {
        const session = new Session(key, browser)
        this.live.set(key, session)
        return session
      })
      this.sessions.set(key, launching)
      launching.catch(() => {
        if (this.sessions.get(key) === launching) this.sessions.delete(key)
      })
      log("session.started", { session: key })
    }
    return await this.sessions.get(key)!
  }

  /** Closes the session's browser and deletes its profile. False when it had none. */
  async close(key: string): Promise<boolean> {
    this.clearTimer(key)
    const existing = this.sessions.get(key)
    if (!existing) return false
    this.sessions.delete(key)
    const session = await existing.catch(() => undefined)
    if (session && this.live.get(key) === session) this.live.delete(key)
    await session?.browser.close()
    log("session.closed", { session: key })
    return true
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((key) => this.close(key)))
  }

  /** Last-resort synchronous cleanup at process exit. */
  killAll(): void {
    for (const session of this.live.values()) session.browser.killNow()
    this.live.clear()
  }

  private armTimer(key: string) {
    if (!this.sessions.has(key)) return
    this.clearTimer(key)
    const timer = setTimeout(() => {
      log("session.idle", { session: key, idleMs: this.config.idleTimeoutMs })
      void this.close(key)
    }, this.config.idleTimeoutMs)
    timer.unref()
    this.timers.set(key, timer)
  }

  private clearTimer(key: string) {
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
  }
}
