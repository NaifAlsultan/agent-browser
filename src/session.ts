// One session's browser: its tabs, events and script state. Lives in the session's worker thread (see worker.ts).
import type { AgentBrowser } from "./browser.ts"
import type { Dialog, Page } from "./patchright.ts"

export class Session {
  readonly browser: AgentBrowser
  private current: Page
  private readonly events: string[] = []
  private opened: Page[] = []
  readonly state: Record<string, unknown> = {}

  constructor(browser: AgentBrowser) {
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

  async ensurePage(): Promise<Page> {
    const page = this.page
    if (!page.isClosed()) return page
    this.current = await this.browser.context.newPage()
    return this.current
  }

  takeOpenedPages(): Page[] {
    const opened = this.opened.filter((page) => !page.isClosed())
    this.opened = []
    return opened
  }

  takeEvents(): string[] {
    return this.events.splice(0)
  }

  private watch(page: Page) {
    // Nobody can see a dialog. Dismissed, as Playwright does by default (and browse leaves it), except "leave this
    // page?", where leaving is what the agent asked for.
    page.on("dialog", (dialog: Dialog) => {
      const text = dialog.message().replace(/\s+/g, " ").slice(0, 300)
      const leave = dialog.type() === "beforeunload"
      this.events.push(leave ? `The page asked to confirm leaving${text ? ` ("${text}")` : ""}; it was accepted.` : `A ${dialog.type()} dialog said "${text}"; it was dismissed.`)
      void (leave ? dialog.accept() : dialog.dismiss()).catch(() => undefined)
    })
    page.on("close", () => {
      if (page === this.current) this.events.push("The current tab was closed.")
    })
  }
}
