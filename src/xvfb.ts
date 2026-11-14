// Staying clear of real displays:
// - We pick the display number. Xvfb's -displayfd search only checks that it can bind, then replaces another
//   server's socket file, which broke an Xwayland that listens on /tmp/.X11-unix/X0 only.
// - No abstract socket: those are shared machine-wide, even with sandboxes that have a private /tmp.
// - Chrome connects by socket path, so an impostor's abstract socket can't capture it.
import { execFile, spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { debug, log } from "./log.ts"

const familyWild = 0xffff

// An empty display number matches any display, which a socket-path DISPLAY needs (libxcb looks it up as 0).
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

export type WorkArea = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export type Display = {
  readonly display: string
  readonly number: number
  readonly xauthority: string
  readonly process: ChildProcess
  readonly workArea: WorkArea
}

export type XvfbOptions = {
  readonly executable: string
  readonly width: number
  readonly height: number
  readonly directory: string
  readonly setpriv?: string
  readonly xprop?: string
  readonly socketDir?: string
  readonly lockDir?: string
}

const socketDirDefault = "/tmp/.X11-unix"
const lockDirDefault = "/tmp"

function abstractInUse(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: `\0${name}` })
    const done = (inUse: boolean) => {
      socket.destroy()
      resolve(inUse)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    setTimeout(() => done(true), 1_000).unref()
  })
}

export async function displayInUse(number: number, socketDir = socketDirDefault, lockDir = lockDirDefault): Promise<boolean> {
  const exists = (file: string) => {
    try {
      fs.lstatSync(file)
      return true
    } catch {
      return false
    }
  }
  if (exists(path.join(socketDir, `X${number}`)) || exists(path.join(lockDir, `.X${number}-lock`))) return true
  return abstractInUse(path.join(socketDirDefault, `X${number}`))
}

export async function startXvfb(options: XvfbOptions): Promise<Display> {
  const socketDir = options.socketDir ?? socketDirDefault
  const cookie = crypto.randomBytes(16)
  const xauthority = path.join(options.directory, "Xauthority")
  fs.writeFileSync(xauthority, xauthEntry("", cookie), { mode: 0o600 })

  const base = 100 + crypto.randomInt(0, 800)
  const failures: string[] = []
  for (let attempt = 0; attempt < 40; attempt++) {
    const number = base + attempt
    if (await displayInUse(number, socketDir, options.lockDir)) continue
    try {
      const child = await launch(options, number, xauthority)
      const display = path.join(socketDir, `X${number}`)
      const workArea = workAreaFor(options.width, options.height)
      if (options.xprop) {
        try {
          await setWorkArea(options.xprop, display, xauthority, workArea)
        } catch (error) {
          log("xvfb.workarea-failed", { error: String(error) })
        }
      }
      log("xvfb.started", { display: `:${number}`, pid: child.pid, screen: `${options.width}x${options.height}` })
      child.once("exit", (code, signal) => log("xvfb.exited", { display: `:${number}`, code, signal }))
      return { display, number, xauthority, process: child, workArea: options.xprop ? workArea : { x: 0, y: 0, width: options.width, height: options.height } }
    } catch (error) {
      failures.push(`:${number}: ${String(error)}`)
      if (failures.length >= 5) break
    }
  }
  throw new Error(`Xvfb didn't start. ${failures.length ? failures.join("\n") : "Every display number tried was in use."}`)
}

function launch(options: XvfbOptions, number: number, xauthority: string): Promise<ChildProcess> {
  const args = [
    `:${number}`,
    "-displayfd", "3",
    "-screen", "0", `${options.width}x${options.height}x24`,
    "-dpi", "96",
    "-auth", xauthority,
    "-nolisten", "tcp",
    // "local" is the abstract socket.
    "-nolisten", "local",
    "-noreset",
  ]
  const [command, commandArgs] = options.setpriv
    ? [options.setpriv, ["--pdeathsig", "SIGKILL", "--", options.executable, ...args]]
    : [options.executable, args]
  const child = spawn(command, commandArgs, { stdio: ["ignore", "ignore", "pipe", "pipe"] })
  const stderr: string[] = []
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr.push(chunk)
    if (stderr.length > 50) stderr.shift()
    debug("xvfb.stderr", { text: chunk.trim() })
  })
  return new Promise<ChildProcess>((resolve, reject) => {
    let output = ""
    let settled = false
    const fail = (reason: string) => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(new Error(`${reason}: ${stderr.join("").trim().slice(-1000)}`))
    }
    const displayPipe = child.stdio[3] as NodeJS.ReadableStream
    displayPipe.setEncoding("utf8")
    displayPipe.on("data", (chunk: string) => {
      output += chunk
      if (!settled && /^\d+\n/.test(output)) {
        settled = true
        resolve(child)
      }
    })
    child.once("error", (error) => fail(error.message))
    child.once("exit", (code, signal) => fail(`exited with ${signal ?? code}`))
    setTimeout(() => fail("not ready after 15 s"), 15_000).unref()
  })
}

const panelHeight = 32

export function workAreaFor(width: number, height: number): WorkArea {
  return { x: 0, y: panelHeight, width, height: height - panelHeight }
}

// Without a window manager screen.availHeight equals screen.height, which no desktop with a panel has (CreepJS
// counts it as a headless sign). Chrome reads the work area from these root window properties.
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
