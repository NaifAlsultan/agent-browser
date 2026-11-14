// Launched by us rather than Patchright, so none of Playwright's automation flags are passed. DevTools goes over a
// pipe, never a port: the port has no authentication, so any local user could take the browser over.
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Readable, Writable } from "node:stream"
import { debug, log } from "./log.ts"

export type ChromeOptions = {
  readonly executable: string
  readonly display: string
  readonly xauthority: string
  readonly window: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly directory: string
  readonly extraArgs?: readonly string[]
  readonly gpu?: Gpu
  readonly setpriv?: string
}

export type Chrome = {
  readonly process: ChildProcess
  readonly input: Writable
  readonly output: Readable
  readonly profile: string
  stderrTail(): string
  readonly exited: Promise<void>
}

export type Gpu = "auto" | "on" | "off"

export function renderNode(): string | undefined {
  let names: string[]
  try {
    names = fs.readdirSync("/dev/dri").filter((name) => name.startsWith("renderD")).sort()
  } catch {
    return undefined
  }
  for (const name of names) {
    try {
      fs.accessSync(`/dev/dri/${name}`, fs.constants.R_OK | fs.constants.W_OK)
      return `/dev/dri/${name}`
    } catch {
    }
  }
  return undefined
}

// On Xvfb Chrome turns WebGL off, a strong bot signal. ANGLE's EGL backend can use the real GPU; SwiftShader is
// the software fallback.
export function gpuArgs(gpu: Gpu, hasRenderNode: boolean): string[] {
  if (gpu === "on" || (gpu === "auto" && hasRenderNode)) return ["--use-gl=angle", "--use-angle=gl-egl"]
  return ["--enable-unsafe-swiftshader"]
}

export function chromeArgs(options: Pick<ChromeOptions, "window" | "extraArgs" | "gpu">, profile: string, hasRenderNode = renderNode() !== undefined): string[] {
  return [
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    // The pipe sets navigator.webdriver; this unsets it, as Patchright's launcher does.
    "--disable-blink-features=AutomationControlled",
    ...gpuArgs(options.gpu ?? "auto", hasRenderNode),
    // On Wayland it would open on the real screen.
    "--ozone-platform=x11",
    `--window-position=${options.window.x},${options.window.y}`,
    `--window-size=${options.window.width},${options.window.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--password-store=basic",
    "--mute-audio",
    ...(options.extraArgs ?? []),
    "about:blank",
  ]
}

export function chromeEnv(base: NodeJS.ProcessEnv, options: Pick<ChromeOptions, "display" | "xauthority">, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const name of ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "NIXOS_OZONE_WL", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION", "HYPRLAND_INSTANCE_SIGNATURE", "GDK_BACKEND", "QT_QPA_PLATFORM"]) delete env[name]
  // The session bus reaches the desktop: notifications, the keyring, portals.
  env.DBUS_SESSION_BUS_ADDRESS = "disabled:"
  for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) delete env[name]
  env.HOME = home
  env.DISPLAY = options.display
  env.XAUTHORITY = options.xauthority
  env.XDG_SESSION_TYPE = "x11"
  return env
}

export function launchChrome(options: ChromeOptions): Chrome {
  const profile = path.join(options.directory, "profile")
  const home = path.join(options.directory, "home")
  fs.mkdirSync(profile, { mode: 0o700 })
  fs.mkdirSync(home, { mode: 0o700 })
  const args = chromeArgs(options, profile)
  const [command, commandArgs] = options.setpriv
    ? [options.setpriv, ["--pdeathsig", "SIGKILL", "--", options.executable, ...args]]
    : [options.executable, args]
  const child = spawn(command, commandArgs, {
    env: chromeEnv(process.env, options, home),
    cwd: home,
    detached: true,
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  })
  const stderr: string[] = []
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue
      stderr.push(line)
      if (stderr.length > 40) stderr.shift()
      debug("chrome.stderr", { pid: child.pid, line })
    }
  })
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      log("chrome.exited", { pid: child.pid, code, signal })
      resolve()
    })
    child.once("error", (error) => {
      log("chrome.error", { message: error.message })
      resolve()
    })
  })
  log("chrome.started", { pid: child.pid, display: options.display })
  return {
    process: child,
    input: child.stdio[3] as Writable,
    output: child.stdio[4] as Readable,
    profile,
    stderrTail: () => stderr.join("\n"),
    exited,
  }
}

export async function killChrome(chrome: Chrome, graceMs = 3_000): Promise<void> {
  const pid = chrome.process.pid
  if (pid === undefined || chrome.process.exitCode !== null || chrome.process.signalCode !== null) return
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal)
    } catch {
    }
  }
  signalGroup("SIGTERM")
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), graceMs).unref())
  if ((await Promise.race([chrome.exited, timer])) === "timeout") {
    signalGroup("SIGKILL")
    await chrome.exited
  }
  signalGroup("SIGKILL")
}
