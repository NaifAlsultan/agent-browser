// Every MCP process keeps its files (Chrome profiles, the X authority cookie) in one private temporary directory,
// removed when the process exits. A process killed outright can't clean up, so the next one to start removes
// directories whose owner is gone.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { log } from "./log.ts"

const prefix = "agent-browser-"
const ownerFile = "owner.pid"

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
      fs.rmSync(dir, { recursive: true, force: true })
      log("tmp.stale-removed", { dir })
    } catch {
      // Unreadable or racing with another process: leave it.
    }
  }
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
