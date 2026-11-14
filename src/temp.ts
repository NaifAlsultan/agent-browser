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
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// A process killed outright can't clean up after itself; the next one removes what it left.
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
      // Without an owner file, it may still be being set up.
      if (!Number.isInteger(pid) && Date.now() - fs.statSync(dir).mtimeMs < 60_000) continue
      removeStaleDisplay(dir, uid)
      fs.rmSync(dir, { recursive: true, force: true })
      log("tmp.stale-removed", { dir })
    } catch {
    }
  }
}

// A killed server's Xvfb leaves its socket and lock files in /tmp.
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
  }
  for (const file of [socket, lock]) {
    if (!ours(file)) continue
    try {
      fs.unlinkSync(file)
      log("tmp.stale-display-removed", { file })
    } catch {
    }
  }
}

export function recordDisplay(number: number): void {
  if (root) fs.writeFileSync(path.join(root, displayFile), String(number))
}

let root: string | undefined

export function processDirectory(parent = os.tmpdir()): string {
  if (root) return root
  removeStaleDirectories(parent)
  root = fs.mkdtempSync(path.join(parent, prefix))
  fs.chmodSync(root, 0o700)
  fs.writeFileSync(path.join(root, ownerFile), String(process.pid))
  return root
}

export function makeDirectory(name: string, parent?: string): string {
  return fs.mkdtempSync(path.join(processDirectory(parent), `${name}-`))
}

export function removeProcessDirectory(): void {
  if (!root) return
  fs.rmSync(root, { recursive: true, force: true })
  root = undefined
}
