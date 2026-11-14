import crypto from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import type { Readable, Writable } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import { beforeInput, forgetTab } from "../vendor/browse/execute/human-input.ts"
import type { JsonObject } from "../vendor/browse/protocol.ts"
import { humanInputMethods, removeDefaultMediaEmulation, TargetTracker, type CdpCommand, type CdpMessage } from "./cdp-rewrite.ts"
import { debug, log } from "./log.ts"

// Far above Patchright's ids; CDP ids are 32-bit.
const ownIdBase = 1_900_000_000
const maxPayload = 256 * 1024 * 1024

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void }

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: Parameters<typeof clearTimeout>[0]
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

export type CdpProxyOptions = {
  readonly toChrome: Writable
  readonly fromChrome: Readable
  readonly humanInput?: boolean
}

export class CdpProxy {
  readonly tracker = new TargetTracker()
  private server: WebSocketServer | undefined
  private client: WebSocket | undefined
  private readonly pending = new Map<number, Pending>()
  private nextId = ownIdBase
  private readonly queues = new Map<string, Promise<void>>()
  private chromeBuffer: Buffer[] = []
  private chromeClosed = false
  private readonly humanInput: boolean
  private endpoint: string | undefined
  private readonly options: CdpProxyOptions

  constructor(options: CdpProxyOptions) {
    this.options = options
    this.humanInput = options.humanInput ?? true
    options.fromChrome.on("data", (chunk: Buffer) => this.readChrome(chunk))
    options.fromChrome.on("end", () => this.chromeGone())
    options.fromChrome.on("close", () => this.chromeGone())
    options.fromChrome.on("error", () => this.chromeGone())
    options.toChrome.on("error", () => this.chromeGone())
  }

  async listen(): Promise<string> {
    if (this.endpoint) return this.endpoint
    const secret = crypto.randomBytes(24).toString("hex")
    const path = `/devtools/browser/${secret}`
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path,
      maxPayload,
      perMessageDeflate: false,
      // Browsers always send Origin, so this also refuses web pages.
      verifyClient: ({ req }: { req: IncomingMessage }) => this.client === undefined && req.headers.origin === undefined,
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve)
      server.once("error", reject)
    })
    server.on("connection", (socket) => this.attach(socket))
    const { port } = server.address() as AddressInfo
    this.endpoint = `ws://127.0.0.1:${port}${path}`
    return this.endpoint
  }

  call(sessionId: string | undefined, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.chromeClosed) return Promise.reject(new Error("Chrome is gone"))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.writeChrome(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  async close(): Promise<void> {
    this.client?.terminate()
    this.client = undefined
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private attach(socket: WebSocket) {
    this.client = socket
    debug("proxy.client-connected")
    socket.on("message", (data, isBinary) => {
      if (isBinary) return
      this.fromClient(data.toString())
    })
    socket.on("close", () => {
      if (this.client === socket) this.client = undefined
      debug("proxy.client-disconnected")
    })
    socket.on("error", () => socket.terminate())
  }

  private fromClient(text: string) {
    let message: CdpCommand
    try {
      message = JSON.parse(text) as CdpCommand
    } catch {
      return
    }
    if (typeof message.id !== "number" || typeof message.method !== "string") return
    let rewritten = removeDefaultMediaEmulation(message)
    if (rewritten.method === "Page.captureScreenshot" && rewritten.sessionId) this.nudgeScreenshot(rewritten)
    if (rewritten.method === "Page.createIsolatedWorld") rewritten = this.freshWorld(rewritten)
    const key = rewritten.sessionId ?? ""
    const paced = this.humanInput && humanInputMethods.has(rewritten.method)
    const queue = this.queues.get(key)
    if (!queue && !paced) {
      this.writeChrome(rewritten === message ? text : JSON.stringify(rewritten))
      return
    }
    const run = (queue ?? Promise.resolve()).then(async () => {
      if (paced) await this.pace(rewritten)
      // Pacing may move the click's coordinates, so serialize afterwards.
      this.writeChrome(JSON.stringify(rewritten))
    })
    const tail = run.catch((error: unknown) => debug("proxy.pace-failed", { error: String(error) }))
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
  }

  // After human-like scrolling, captures often stall for ~15 s until another capture releases them (as in browse's
  // captureScreenshotNudged). The nudge keeps the clip, so Chrome answers the original at its own size.
  private nudgeScreenshot(command: CdpCommand) {
    const params: Record<string, unknown> = { ...command.params, format: "jpeg", quality: 1 }
    if (params.clip !== undefined) delete params.captureBeyondViewport
    const delays = [...Array<number>(12).fill(250), 500, 1_000, 2_000, 4_000]
    const done = () => !this.screenshotsPending.has(command.id) || this.chromeClosed
    this.screenshotsPending.add(command.id)
    void (async () => {
      for (const delay of delays) {
        await new Promise((resolve) => setTimeout(resolve, delay))
        if (done()) return
        debug("proxy.screenshot-nudge", { afterMs: delay })
        void this.call(command.sessionId, "Page.captureScreenshot", params).catch(() => undefined)
      }
    })()
  }

  private readonly screenshotsPending = new Set<number>()

  private readonly pointers = new Map<number, { x: number; y: number }>()

  private async pace(command: CdpCommand) {
    const page = this.tracker.pageNumber(command.sessionId)
    if (page === undefined) return
    const params = (command.params ??= {})
    const root = this.tracker.isRoot(command.sessionId)
    const mouse = command.method === "Input.dispatchMouseEvent"
    try {
      if (root && mouse && params.type === "mouseWheel" && params.x === 0 && params.y === 0) {
        const pointer = this.pointers.get(page) ?? (await this.restPointer(page, command.sessionId))
        if (pointer) Object.assign(params, pointer)
      }
      await beforeInput(page, command.method, params as JsonObject, root, (method, sent) => this.call(command.sessionId, method, sent as Record<string, unknown>))
      if (root && mouse && params.type !== "mouseWheel" && typeof params.x === "number" && typeof params.y === "number") this.pointers.set(page, { x: params.x, y: params.y })
    } catch (error) {
      debug("proxy.human-input-failed", { method: command.method, error: String(error) })
    }
  }

  // Playwright's mouse starts at (0, 0), so a wheel before any move would scroll from the page's corner. As browse's
  // scrollToward does, the pointer first comes to rest over the page.
  private async restPointer(page: number, sessionId: string | undefined): Promise<{ x: number; y: number } | undefined> {
    const metrics = (await this.call(sessionId, "Page.getLayoutMetrics")) as { cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }
    const width = metrics.cssLayoutViewport?.clientWidth
    const height = metrics.cssLayoutViewport?.clientHeight
    if (!width || !height) return undefined
    const between = (size: number) => Math.round(size * (0.35 + Math.random() * 0.3))
    const move: Record<string, unknown> = { type: "mouseMoved", x: between(width), y: between(height), button: "none" }
    await beforeInput(page, "Input.dispatchMouseEvent", move as JsonObject, true, (method, sent) => this.call(sessionId, method, sent as Record<string, unknown>))
    await this.call(sessionId, "Input.dispatchMouseEvent", move)
    const pointer = { x: move.x as number, y: move.y as number }
    this.pointers.set(page, pointer)
    return pointer
  }

  private writeChrome(text: string) {
    if (this.chromeClosed) return
    this.options.toChrome.write(text)
    this.options.toChrome.write("\0")
  }

  private readChrome(chunk: Buffer) {
    let start = 0
    let end = chunk.indexOf(0)
    while (end !== -1) {
      this.chromeBuffer.push(chunk.subarray(start, end))
      const text = Buffer.concat(this.chromeBuffer).toString("utf8")
      this.chromeBuffer = []
      this.fromChrome(text)
      start = end + 1
      end = chunk.indexOf(0, start)
    }
    if (start < chunk.length) this.chromeBuffer.push(chunk.subarray(start))
  }

  private fromChrome(text: string) {
    const idMatch = /^\{"id":(\d+)/.exec(text)
    if (idMatch && this.screenshotsPending.size) this.screenshotsPending.delete(Number(idMatch[1]))
    if (idMatch && Number(idMatch[1]) >= ownIdBase) {
      const message = JSON.parse(text) as CdpMessage
      const pending = this.pending.get(message.id!)
      this.pending.delete(message.id!)
      if (message.error) pending?.reject(new Error(`${message.error.message ?? "CDP error"} (${message.error.code ?? "?"})`))
      else pending?.resolve(message.result)
      return
    }
    if (!idMatch && text.includes('"method":"Target.')) {
      try {
        for (const page of this.tracker.observe(JSON.parse(text) as CdpMessage)) {
          forgetTab(page)
          this.pointers.delete(page)
        }
      } catch {
      }
    }
    if (this.held) {
      this.held.push(text)
      return
    }
    this.client?.send(text)
    if (!idMatch && text.includes('"BackForwardCacheRestore"') && text.startsWith('{"method":"Page.frameNavigated"')) {
      const message = JSON.parse(text) as CdpMessage & { params: { frame?: { parentId?: string } } }
      if (message.sessionId && !message.params.frame?.parentId) {
        const page = this.tracker.pageNumber(message.sessionId)
        if (page !== undefined) this.worldGenerations.set(page, (this.worldGenerations.get(page) ?? 0) + 1)
        void this.replayRestoredFrames(message.sessionId)
      }
    }
  }

  private readonly worldGenerations = new Map<number, number>()

  // A bfcache-restored page keeps Patchright's isolated world, where elements cache refs naming their old frame
  // number. A new world name gives Patchright a clean one.
  private freshWorld(command: CdpCommand): CdpCommand {
    const page = this.tracker.pageNumber(command.sessionId)
    const generation = page === undefined ? 0 : (this.worldGenerations.get(page) ?? 0)
    const name = command.params?.worldName
    if (!generation || typeof name !== "string") return command
    return { ...command, params: { ...command.params, worldName: `${name}:${generation}` } }
  }

  private held: string[] | undefined

  // On a bfcache restore Chrome doesn't announce the page's iframes again, and Patchright drops them. Playwright
  // avoids this by disabling the cache, which sites can detect; instead, re-announce the frames (like browse's
  // replayChildTargetsForParent) and hold Chrome's other messages until done.
  private async replayRestoredFrames(sessionId: string) {
    this.held ??= []
    try {
      await withTimeout(this.announceFrames(sessionId), 5_000)
    } catch (error) {
      debug("proxy.bfcache-replay-failed", { error: String(error) })
    } finally {
      const held = this.held ?? []
      this.held = undefined
      for (const text of held) this.client?.send(text)
    }
  }

  private event(method: string, params: Record<string, unknown>, sessionId: string) {
    this.client?.send(JSON.stringify({ method, params, sessionId }))
  }

  private async announceFrames(sessionId: string) {
    type FrameTree = { frame: { id: string; parentId?: string }; childFrames?: FrameTree[] }
    const { frameTree } = (await this.call(sessionId, "Page.getFrameTree")) as { frameTree: FrameTree }
    const outOfProcess = this.tracker.iframeChildren(sessionId)
    const outOfProcessIds = new Set(outOfProcess.map((child) => child.targetId))
    const walk = (node: FrameTree) => {
      for (const child of node.childFrames ?? []) {
        if (outOfProcessIds.has(child.frame.id)) continue
        this.event("Page.frameAttached", { frameId: child.frame.id, parentFrameId: node.frame.id }, sessionId)
        this.event("Page.frameNavigated", { frame: child.frame, type: "Navigation" }, sessionId)
        walk(child)
      }
    }
    walk(frameTree)
    for (const child of outOfProcess) {
      // A fresh session: reusing the old id would mix up replies to commands sent on it before.
      const targetInfo = (child.attachParams.targetInfo ?? {}) as { parentFrameId?: string }
      this.event("Page.frameAttached", { frameId: child.targetId, parentFrameId: targetInfo.parentFrameId ?? frameTree.frame.id }, sessionId)
      await this.call(sessionId, "Target.detachFromTarget", { sessionId: child.sessionId }).catch(() => undefined)
      await this.call(sessionId, "Target.attachToTarget", { targetId: child.targetId, flatten: true })
    }
    debug("proxy.bfcache-replayed", { sessionId, outOfProcess: outOfProcess.length })
  }

  private chromeGone() {
    if (this.chromeClosed) return
    this.chromeClosed = true
    for (const { reject } of this.pending.values()) reject(new Error("Chrome is gone"))
    this.pending.clear()
    log("proxy.chrome-disconnected")
    this.client?.close(1000, "browser closed")
  }
}
