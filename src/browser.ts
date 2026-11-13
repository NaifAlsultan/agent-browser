// One browser: a Chrome process with a fresh profile on the shared virtual display, the DevTools proxy in front of
// it, and Patchright connected through the proxy. Closing it kills Chrome and deletes the profile.
import fs from "node:fs"
import { CdpProxy } from "./cdp-proxy.ts"
import { killChrome, launchChrome, type Chrome } from "./chrome.ts"
import type { Config } from "./config.ts"
import { log } from "./log.ts"
import { chromium, type Browser, type BrowserContext } from "./patchright.ts"
import { makeDirectory, processDirectory } from "./temp.ts"
import { startXvfb, type Display } from "./xvfb.ts"

let display: Promise<Display> | undefined
let policiesChecked = false

/**
 * Google Chrome applies the machine's managed policies from /etc/opt/chrome/policies to every profile, ours
 * included: force-installed extensions, blocked cookies and the like change what sites see. (NixOS's
 * programs.chromium writes its policies there as well as for Chromium.) There's no flag to turn that off, so say so.
 */
function warnAboutPolicies() {
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

/** The process's Xvfb, started on first use (and again if it died). */
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
      (started) => started.process.once("exit", () => {
        if (display === starting) display = undefined
      }),
      () => {
        if (display === starting) display = undefined
      },
    )
  }
  return display
}

export function stopSharedDisplay(): void {
  void display?.then((started) => started.process.kill("SIGTERM"), () => undefined)
  display = undefined
}

type TargetInfo = { targetId: string; type: string }

/**
 * Chrome shows its "unsupported command-line flag" infobar (see chromeArgs) on the startup tab only, where it
 * shrinks the viewport. Before Patchright connects, open a fresh tab and close the startup one.
 */
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

  /** Whether Chrome still runs and Patchright is connected. */
  get connected(): boolean {
    return this.browser.isConnected() && this.chrome.process.exitCode === null && this.chrome.process.signalCode === null
  }

  static async launch(config: Config, label = "session"): Promise<AgentBrowser> {
    warnAboutPolicies()
    const { display: displayName, xauthority, workArea } = await sharedDisplay(config)
    const directory = makeDirectory(label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "session", config.tmpDir)
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
      // The default context is the profile itself (not an incognito-style context, which sites can detect).
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

  private closing: Promise<void> | undefined

  /** Closes Chrome and deletes its profile. Safe to call more than once. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      // Ask Chrome to quit cleanly first; it then exits by itself, and the group kill below is a backstop.
      await Promise.race([this.proxy.call(undefined, "Browser.close").catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2_000).unref())])
      await this.browser.close().catch(() => undefined)
      await this.proxy.close().catch(() => undefined)
      await killChrome(this.chrome).catch(() => undefined)
      // Chrome's last writes can land just after it exits; retry the removal briefly.
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

  /** Synchronous last-resort cleanup for process exit. */
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
}
