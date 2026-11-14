// A Chrome process per session rather than incognito-style contexts in one Chrome: sites can detect incognito.
// Each session's browser and scripts run in a worker thread, so a script that never yields can be stopped without
// stalling other sessions.
import fs from "node:fs"
import { Worker } from "node:worker_threads"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { sharedDisplay, warnAboutPolicies } from "./browser.ts"
import type { Config } from "./config.ts"
import { log } from "./log.ts"
import { makeDirectory } from "./temp.ts"
import type { FromWorker, ToWorker, WorkerData } from "./worker.ts"

export const defaultSessionKey = "default"

const closeGraceMs = 10_000

class SessionWorker {
  readonly key: string
  readonly directory: string
  private readonly worker: Worker
  private chromePid: number | undefined
  private nextId = 1
  private readonly pending = new Map<number, (message: FromWorker) => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private ended = false
  readonly ready: Promise<void>
  readonly exited: Promise<void>
  onEnd: (() => void) | undefined

  constructor(config: Config, data: Omit<WorkerData, "config">) {
    this.key = data.label
    this.directory = data.directory
    // stdout is the MCP stream: anything the worker prints goes to stderr instead.
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { ...data, config } satisfies WorkerData, stdout: true })
    this.worker.stdout.pipe(process.stderr)
    let readied: () => void
    let failed: (error: Error) => void
    this.ready = new Promise<void>((resolve, reject) => {
      readied = resolve
      failed = reject
    })
    this.worker.on("message", (message: FromWorker) => {
      if (message.type === "ready") {
        this.chromePid = message.chromePid
        readied()
      } else if (message.type === "failed") {
        failed(new Error(message.error))
      } else if (message.type === "result") {
        this.pending.get(message.id)?.(message)
        this.pending.delete(message.id)
      } else if (message.type === "lost") {
        log("session.browser-lost", { session: this.key })
        this.end()
      }
    })
    this.worker.on("error", (error) => {
      log("session.worker-error", { session: this.key, error: error.stack ?? String(error) })
      failed(error)
    })
    this.exited = new Promise((resolve) => {
      this.worker.once("exit", () => {
        failed(new Error("The browser's worker exited during startup."))
        this.cleanUp()
        this.end()
        resolve()
      })
    })
  }

  get alive(): boolean {
    return !this.ended
  }

  run(code: string, timeoutMs: number): Promise<CallToolResult> {
    const task = () => this.runNow(code, timeoutMs)
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async runNow(code: string, timeoutMs: number): Promise<CallToolResult> {
    if (this.ended) return { isError: true, content: [{ type: "text", text: "This session's browser closed before the code could run. Run it again to start a fresh browser." }] }
    const id = this.nextId++
    let timer: ReturnType<typeof setTimeout> | undefined
    let settle!: (value: "ended") => void
    const outcome = await new Promise<FromWorker | "timeout" | "ended">((resolve) => {
      settle = resolve
      this.pending.set(id, resolve)
      this.endWaiters.add(resolve)
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
      this.send({ type: "run", id, code, timeoutMs })
    })
    clearTimeout(timer)
    this.pending.delete(id)
    this.endWaiters.delete(settle)
    if (outcome === "timeout") {
      log("session.script-timeout", { session: this.key, timeoutMs })
      await this.kill()
      return {
        isError: true,
        content: [{
          type: "text",
          text: `The code didn't finish within ${timeoutMs} ms, so this session's browser was closed to stop it: its tabs, cookies and \`state\` are gone, and the next run starts a fresh browser. Keep scripts shorter, or raise timeoutMs. A loop that never awaits blocks until then.`,
        }],
      }
    }
    if (outcome === "ended") return { isError: true, content: [{ type: "text", text: "This session's browser closed while the code ran (Chrome exited or crashed). The next run starts a fresh browser." }] }
    return (outcome as Extract<FromWorker, { type: "result" }>).result as CallToolResult
  }

  private readonly endWaiters = new Set<(value: "ended") => void>()

  private send(message: ToWorker) {
    this.worker.postMessage(message)
  }

  async close(): Promise<void> {
    if (!this.ended) {
      this.send({ type: "close" })
      const timer = new Promise((resolve) => setTimeout(resolve, closeGraceMs).unref())
      await Promise.race([this.exited, timer])
    }
    await this.kill()
  }

  async kill(): Promise<void> {
    this.end()
    await this.worker.terminate().catch(() => undefined)
    this.cleanUp()
  }

  // Synchronous, for process exit: Chrome's process group and the profile go even if the worker couldn't close them.
  cleanUp(): void {
    if (this.chromePid !== undefined) {
      try {
        process.kill(-this.chromePid, "SIGKILL")
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(this.directory, { recursive: true, force: true })
  }

  private end() {
    if (this.ended) return
    this.ended = true
    for (const resolve of this.endWaiters) resolve("ended")
    this.endWaiters.clear()
    this.onEnd?.()
  }
}

export class SessionManager {
  private readonly config: Config
  private readonly sessions = new Map<string, Promise<SessionWorker>>()
  private readonly live = new Map<string, SessionWorker>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly busy = new Map<string, number>()

  constructor(config: Config) {
    this.config = config
  }

  async run(key: string, code: string, timeoutMs: number): Promise<CallToolResult> {
    this.busy.set(key, (this.busy.get(key) ?? 0) + 1)
    this.clearTimer(key)
    try {
      const session = await this.get(key)
      return await session.run(code, timeoutMs)
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

  private async get(key: string): Promise<SessionWorker> {
    const existing = this.sessions.get(key)
    if (existing) {
      const session = await existing.catch(() => undefined)
      if (session?.alive) return session
      if (this.sessions.get(key) === existing) this.sessions.delete(key)
    }
    if (!this.sessions.has(key)) {
      const launching = this.launch(key)
      this.sessions.set(key, launching)
      launching.catch(() => {
        if (this.sessions.get(key) === launching) this.sessions.delete(key)
      })
      log("session.started", { session: key })
    }
    return await this.sessions.get(key)!
  }

  private async launch(key: string): Promise<SessionWorker> {
    warnAboutPolicies()
    const { display, xauthority, workArea } = await sharedDisplay(this.config)
    const directory = makeDirectory(key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "session", this.config.tmpDir)
    const session = new SessionWorker(this.config, { display: { display, xauthority, workArea }, directory, label: key })
    this.live.set(key, session)
    session.onEnd = () => {
      if (this.live.get(key) === session) this.live.delete(key)
    }
    try {
      await session.ready
    } catch (error) {
      await session.kill()
      throw error
    }
    return session
  }

  async close(key: string): Promise<boolean> {
    this.clearTimer(key)
    const existing = this.sessions.get(key)
    if (!existing) return false
    this.sessions.delete(key)
    const session = await existing.catch(() => undefined)
    await session?.close()
    log("session.closed", { session: key })
    return true
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((key) => this.close(key)))
  }

  killAll(): void {
    for (const session of this.live.values()) session.cleanUp()
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
