import fs from "node:fs"
import { CdpProxy } from "./cdp-proxy.ts"
import { killChrome, launchChrome, type Chrome } from "./chrome.ts"
import type { Config } from "./config.ts"
import { log } from "./log.ts"
import { chromium, type Browser, type BrowserContext } from "./patchright.ts"
import { makeDirectory, processDirectory, recordDisplay } from "./temp.ts"
import { startXvfb, type Display, type WorkArea } from "./xvfb.ts"

let display: Promise<Display> | undefined
let running: Display | undefined
let policiesChecked = false

// Chrome applies /etc/opt/chrome/policies to every profile and has no flag to ignore them.
export function warnAboutPolicies() {
  if (policiesChecked) return
  policiesChecked = true
  for (const kind of ["managed", "recommended"]) {
    const dir = `/etc/opt/chrome/policies/${kind}`
    const files = (() => {
      try {
        return fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
      } catch {
        return []
      }
    })()
    if (files.length) log("chrome.policies-warning", { dir, files: files.join(","), note: "Chrome applies these policies to agent-browser's profiles too (extensions, cookie settings); sites may notice. Remove them if this machine's Chrome is only used by agent-browser." })
  }
}

export function sharedDisplay(config: Config): Promise<Display> {
  if (!display) {
    const starting = startXvfb({
      executable: config.xvfb,
      width: config.screen.width,
      height: config.screen.height,
      directory: processDirectory(config.tmpDir),
      setpriv: config.setpriv,
      xprop: config.xprop,
    })
    display = starting
    starting.then(
      (started) => {
        running = started
        recordDisplay(started.number)
        started.process.once("exit", () => {
          if (display === starting) display = undefined
          if (running === started) running = undefined
        })
      },
      () => {
        if (display === starting) display = undefined
      },
    )
  }
  return display
}

// Waits for Xvfb to exit, or setpriv's death signal kills it before it removes its socket and lock.
export async function stopSharedDisplay(waitMs = 3_000): Promise<void> {
  const current = display
  display = undefined
  const started = await current?.catch(() => undefined)
  if (!started || started.process.exitCode !== null || started.process.signalCode !== null) return
  const exited = new Promise<void>((resolve) => started.process.once("exit", () => resolve()))
  started.process.kill("SIGTERM")
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, waitMs).unref())])
}

export function killSharedDisplayNow(): void {
  running?.process.kill("SIGKILL")
}

type TargetInfo = { targetId: string; type: string }

// The "unsupported command-line flag" infobar only appears on the startup tab, where it shrinks the viewport.
async function replaceStartupTab(proxy: CdpProxy): Promise<void> {
  const pages = async () => ((await proxy.call(undefined, "Target.getTargets")) as { targetInfos: TargetInfo[] }).targetInfos.filter((target) => target.type === "page")
  let startup: TargetInfo[] = []
  for (let attempt = 0; attempt < 50 && startup.length === 0; attempt++) {
    startup = await pages()
    if (startup.length === 0) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await proxy.call(undefined, "Target.createTarget", { url: "about:blank" })
  for (const target of startup) await proxy.call(undefined, "Target.closeTarget", { targetId: target.targetId }).catch(() => undefined)
}

// What a session's worker needs of the shared display; the Xvfb process itself stays with the main thread.
export type DisplayInfo = { readonly display: string; readonly xauthority: string; readonly workArea: WorkArea }

export class AgentBrowser {
  readonly browser: Browser
  readonly context: BrowserContext
  private readonly chrome: Chrome
  private readonly proxy: CdpProxy
  private readonly directory: string

  private constructor(browser: Browser, context: BrowserContext, chrome: Chrome, proxy: CdpProxy, directory: string) {
    this.browser = browser
    this.context = context
    this.chrome = chrome
    this.proxy = proxy
    this.directory = directory
  }

  get connected(): boolean {
    return this.browser.isConnected() && this.chrome.process.exitCode === null && this.chrome.process.signalCode === null
  }

  static async launch(config: Config, { display: displayName, xauthority, workArea }: DisplayInfo, directory: string, label = "session"): Promise<AgentBrowser> {
    let chrome: Chrome | undefined
    let proxy: CdpProxy | undefined
    try {
      chrome = launchChrome({
        executable: config.chrome,
        display: displayName,
        xauthority,
        window: workArea,
        directory,
        extraArgs: config.extraChromeArgs,
        gpu: config.gpu,
        setpriv: config.setpriv,
      })
      const exitedEarly = chrome.exited.then(() => {
        throw new Error(`Chrome exited during startup. Its last output:\n${chrome!.stderrTail() || "(none)"}`)
      })
      proxy = new CdpProxy({ toChrome: chrome.input, fromChrome: chrome.output, humanInput: config.humanInput })
      await Promise.race([replaceStartupTab(proxy), exitedEarly])
      const endpoint = await proxy.listen()
      const browser = await Promise.race([chromium.connectOverCDP(endpoint, { timeout: 30_000 }), exitedEarly])
      exitedEarly.catch(() => undefined)
      const context = browser.contexts()[0]
      if (!context) throw new Error("Chrome has no default browser context")
      context.setDefaultTimeout(config.actionTimeoutMs)
      context.setDefaultNavigationTimeout(config.navigationTimeoutMs)
      if (context.pages().length === 0) await context.newPage()
      log("browser.ready", { label, pid: chrome.process.pid, version: browser.version() })
      return new AgentBrowser(browser, context, chrome, proxy, directory)
    } catch (error) {
      await proxy?.close().catch(() => undefined)
      if (chrome) await killChrome(chrome).catch(() => undefined)
      fs.rmSync(directory, { recursive: true, force: true })
      throw error
    }
  }

  // For scripts that drive one browser in-process; the server launches each session in a worker instead.
  static async launchHere(config: Config, label: string): Promise<AgentBrowser> {
    const { display, xauthority, workArea } = await sharedDisplay(config)
    return AgentBrowser.launch(config, { display, xauthority, workArea }, makeDirectory(label, config.tmpDir), label)
  }

  private closing: Promise<void> | undefined

  close(): Promise<void> {
    this.closing ??= (async () => {
      await Promise.race([this.proxy.call(undefined, "Browser.close").catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2_000).unref())])
      await this.browser.close().catch(() => undefined)
      await this.proxy.close().catch(() => undefined)
      await killChrome(this.chrome).catch(() => undefined)
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(this.directory, { recursive: true, force: true })
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
      log("browser.closed", { directory: this.directory, removed: !fs.existsSync(this.directory) })
    })()
    return this.closing
  }

  killNow(): void {
    try {
      if (this.chrome.process.pid) process.kill(-this.chrome.process.pid, "SIGKILL")
    } catch {
      // Already gone.
    }
    fs.rmSync(this.directory, { recursive: true, force: true })
  }

  get profileDirectory(): string {
    return this.directory
  }

  get chromePid(): number | undefined {
    return this.chrome.process.pid
  }

  onLost(listener: () => void): void {
    this.browser.on("disconnected", listener)
    void this.chrome.exited.then(listener)
  }
}
