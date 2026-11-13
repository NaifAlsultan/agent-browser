// One Xvfb (an X server that draws into memory) per MCP process, started on first use. Chrome runs headed on it, so
// sites see a normal browser while nothing appears on a real screen.
//
// The display is protected by an MIT-MAGIC-COOKIE: its socket is visible to other local users (the abstract
// socket lives in the network namespace), and without a cookie any of them could read or drive the browser.
import { execFile, spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { debug, log } from "./log.ts"

const familyWild = 0xffff

/** One entry of an X authority file (the format libXau reads), for any host. */
export function xauthEntry(display: string, cookie: Buffer): Buffer {
  const field = (value: Buffer) => {
    const length = Buffer.alloc(2)
    length.writeUInt16BE(value.length)
    return Buffer.concat([length, value])
  }
  const family = Buffer.alloc(2)
  family.writeUInt16BE(familyWild)
  return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.from(display)), field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(cookie)])
}

export type Display = {
  /** DISPLAY value, for example ":7". */
  readonly display: string
  /** XAUTHORITY file for clients. */
  readonly xauthority: string
  readonly process: ChildProcess
  /** Where a maximized window goes. */
  readonly workArea: WorkArea
}

export type XvfbOptions = {
  readonly executable: string
  readonly width: number
  readonly height: number
  /** Private directory for the authority files. */
  readonly directory: string
  /** Optional `setpriv` that kills Xvfb when this process dies, even by SIGKILL. */
  readonly setpriv?: string
  /** Optional `xprop`, to publish a desktop work area (see setWorkArea). */
  readonly xprop?: string
}

export async function startXvfb(options: XvfbOptions): Promise<Display> {
  const cookie = crypto.randomBytes(16)
  // The server takes every cookie in its file whatever the display number, which -displayfd only reveals later.
  const serverAuth = path.join(options.directory, "xvfb.auth")
  fs.writeFileSync(serverAuth, xauthEntry("0", cookie), { mode: 0o600 })

  const args = [
    "-displayfd", "3",
    "-screen", "0", `${options.width}x${options.height}x24`,
    "-dpi", "96",
    "-auth", serverAuth,
    "-nolisten", "tcp",
    // Without -noreset the server resets when its last client leaves and rereads the auth file.
    "-noreset",
  ]
  const [command, commandArgs] = options.setpriv
    ? [options.setpriv, ["--pdeathsig", "SIGKILL", "--", options.executable, ...args]]
    : [options.executable, args]
  const child = spawn(command, commandArgs, { stdio: ["ignore", "ignore", "pipe", "pipe"], detached: false })
  const stderr: string[] = []
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr.push(chunk)
    if (stderr.length > 50) stderr.shift()
    debug("xvfb.stderr", { text: chunk.trim() })
  })

  const number = await new Promise<string>((resolve, reject) => {
    let output = ""
    const fail = (reason: string) => reject(new Error(`Xvfb didn't start (${reason}): ${stderr.join("").trim().slice(-2000)}`))
    const displayPipe = child.stdio[3] as NodeJS.ReadableStream
    displayPipe.setEncoding("utf8")
    displayPipe.on("data", (chunk: string) => {
      output += chunk
      const match = /^(\d+)\n/.exec(output)
      if (match) resolve(match[1]!)
    })
    child.once("error", (error) => fail(error.message))
    child.once("exit", (code, signal) => fail(`exited with ${signal ?? code}`))
    setTimeout(() => fail("no display number after 15 s"), 15_000).unref()
  }).catch((error: unknown) => {
    child.kill("SIGKILL")
    throw error
  })

  const xauthority = path.join(options.directory, "Xauthority")
  fs.writeFileSync(xauthority, xauthEntry(number, cookie), { mode: 0o600 })
  const workArea = workAreaFor(options.width, options.height)
  if (options.xprop) {
    try {
      await setWorkArea(options.xprop, `:${number}`, xauthority, workArea)
    } catch (error) {
      log("xvfb.workarea-failed", { error: String(error) })
    }
  }
  log("xvfb.started", { display: `:${number}`, pid: child.pid, screen: `${options.width}x${options.height}` })
  child.once("exit", (code, signal) => log("xvfb.exited", { display: `:${number}`, code, signal }))
  return { display: `:${number}`, xauthority, process: child, workArea: options.xprop ? workArea : { x: 0, y: 0, width: options.width, height: options.height } }
}

export type WorkArea = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** Height of the pretend desktop panel at the top of the screen, like GNOME's top bar. */
const panelHeight = 32

export function workAreaFor(width: number, height: number): WorkArea {
  return { x: 0, y: panelHeight, width, height: height - panelHeight }
}

/**
 * With no window manager, the whole screen is the work area, so screen.availHeight equals screen.height, which no
 * desktop with a panel or taskbar has (CreepJS counts it as "noTaskbar", a headless sign). Chrome reads the work
 * area from the root window's EWMH properties, so publish a panel the way a desktop would.
 */
async function setWorkArea(xprop: string, display: string, xauthority: string, area: WorkArea): Promise<void> {
  const env = { ...process.env, DISPLAY: display, XAUTHORITY: xauthority }
  const set = (name: string, value: string) =>
    new Promise<void>((resolve, reject) => {
      execFile(xprop, ["-root", "-f", name, "32c", "-set", name, value], { env, timeout: 5_000 }, (error) => (error ? reject(error) : resolve()))
    })
  await set("_NET_NUMBER_OF_DESKTOPS", "1")
  await set("_NET_CURRENT_DESKTOP", "0")
  await set("_NET_WORKAREA", `${area.x}, ${area.y}, ${area.width}, ${area.height}`)
}
