// Every MCP process keeps its files (Chrome profiles, the X authority cookie) in one private temporary directory,
// removed when the process exits. A process killed outright can't clean up, so the next one to start removes
// directories whose owner is gone.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { log } from "./log.ts"

const prefix = "agent-browser-"
const ownerFile = "owner.pid"
const displayFile = "display"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Removes leftover directories of agent-browser processes (of this user) that no longer run. */
export function removeStaleDirectories(parent: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return
  }
  const uid = process.getuid?.()
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const dir = path.join(parent, entry.name)
    try {
      if (uid !== undefined && fs.statSync(dir).uid !== uid) continue
      const pid = Number(fs.readFileSync(path.join(dir, ownerFile), "utf8"))
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) continue
      // No owner file: a process that died while creating the directory, or someone else's naming. Only take
      // directories that are clearly ours and old enough not to be in the middle of being set up.
      if (!Number.isInteger(pid) && Date.now() - fs.statSync(dir).mtimeMs < 60_000) continue
      removeStaleDisplay(dir, uid)
      fs.rmSync(dir, { recursive: true, force: true })
      log("tmp.stale-removed", { dir })
    } catch {
      // Unreadable or racing with another process: leave it.
    }
  }
}

/**
 * A killed server's Xvfb dies without removing its socket and lock files. Remove them when they're this user's and
 * no live process holds the lock, so they don't pile up in /tmp.
 */
export function removeStaleDisplay(dir: string, uid: number | undefined, socketDir = "/tmp/.X11-unix", lockDir = "/tmp") {
  let number: number
  try {
    number = Number(fs.readFileSync(path.join(dir, displayFile), "utf8"))
  } catch {
    return
  }
  if (!Number.isInteger(number) || number < 1) return
  const lock = path.join(lockDir, `.X${number}-lock`)
  const socket = path.join(socketDir, `X${number}`)
  const ours = (file: string) => {
    try {
      return uid === undefined || fs.lstatSync(file).uid === uid
    } catch {
      return false
    }
  }
  try {
    const holder = Number(fs.readFileSync(lock, "utf8").trim())
    if (Number.isInteger(holder) && holder > 0 && alive(holder)) return
  } catch {
    // No lock: nothing holds the number.
  }
  for (const file of [socket, lock]) {
    if (!ours(file)) continue
    try {
      fs.unlinkSync(file)
      log("tmp.stale-display-removed", { file })
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/** Remembers the process's display number, for cleanup after a crash. */
export function recordDisplay(number: number): void {
  if (root) fs.writeFileSync(path.join(root, displayFile), String(number))
}

let root: string | undefined

/** This process's private directory (mode 0700), created on first use. */
export function processDirectory(parent = os.tmpdir()): string {
  if (root) return root
  removeStaleDirectories(parent)
  root = fs.mkdtempSync(path.join(parent, prefix))
  fs.chmodSync(root, 0o700)
  fs.writeFileSync(path.join(root, ownerFile), String(process.pid))
  return root
}

/** A new private subdirectory of the process directory. */
export function makeDirectory(name: string, parent?: string): string {
  return fs.mkdtempSync(path.join(processDirectory(parent), `${name}-`))
}

export function removeProcessDirectory(): void {
  if (!root) return
  fs.rmSync(root, { recursive: true, force: true })
  root = undefined
}
