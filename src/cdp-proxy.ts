// An in-process DevTools proxy between Patchright and Chrome.
//
// Chrome speaks CDP over its pipe (NUL-separated JSON on fds 3 and 4); Patchright connects to this proxy with
// connectOverCDP over a loopback WebSocket whose path holds a random secret. On the way to Chrome the proxy:
//
// - drops Patchright's forced media emulation (see cdp-rewrite.ts), and
// - runs browse's human-like input before mouse, keyboard and scroll-into-view commands: a curved pointer path
//   before a click, paced key presses, wheel scrolling instead of a jump. Commands on one DevTools session keep
//   their order: anything Patchright sends after an input command waits for that command to go out.
import crypto from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import type { Readable, Writable } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import { beforeInput, forgetTab } from "../vendor/browse/execute/human-input.ts"
import type { JsonObject } from "../vendor/browse/protocol.ts"
import { humanInputMethods, removeDefaultMediaEmulation, TargetTracker, type CdpCommand, type CdpMessage } from "./cdp-rewrite.ts"
import { debug, log } from "./log.ts"

/** Ids of the proxy's own commands start here, far above anything Patchright reaches. CDP ids are 32-bit. */
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
  /** Chrome's fd 3: commands go here. */
  readonly toChrome: Writable
  /** Chrome's fd 4: responses and events come from here. */
  readonly fromChrome: Readable
  /** Whether to apply human-like input (default: on). */
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

  /** Starts listening; resolves to the ws:// endpoint for connectOverCDP. */
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
      // Only one client (our Patchright), and never a web page: browsers always send Origin.
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

  /** Sends a command to Chrome from the proxy itself (not from Patchright) and waits for the result. */
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
      // Pacing may adjust the command (a click lands a few pixels off center), so serialize it afterwards.
      this.writeChrome(JSON.stringify(rewritten))
    })
    const tail = run.catch((error: unknown) => debug("proxy.pace-failed", { error: String(error) }))
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
  }

  /**
   * After human-like scrolling, Page.captureScreenshot on the virtual display often stalls for ~15 s (the page itself
   * keeps rendering: requestAnimationFrame stays prompt, so pages see nothing). Another capture releases it (browse's relay does the same for hidden tabs:
   * captureScreenshotNudged in cli/src/relay/cdp-dispatch.ts). Chrome answers every pending capture with the
   * surface at the size the original asked for, so the nudge keeps the clip and only changes the encoding; with a
   * clip, captureBeyondViewport is dropped so the nudge doesn't re-apply full-page settings.
   */
  private nudgeScreenshot(command: CdpCommand) {
    const params: Record<string, unknown> = { ...command.params, format: "jpeg", quality: 1 }
    if (params.clip !== undefined) delete params.captureBeyondViewport
    // Measured on Chrome 157: a nudge every 250 ms releases a stalled capture in well under a second.
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

  private async pace(command: CdpCommand) {
    const page = this.tracker.pageNumber(command.sessionId)
    if (page === undefined) return
    command.params ??= {}
    await beforeInput(page, command.method, command.params as JsonObject, this.tracker.isRoot(command.sessionId), (method, params) =>
      this.call(command.sessionId, method, params as Record<string, unknown>),
    ).catch((error: unknown) => debug("proxy.human-input-failed", { method: command.method, error: String(error) }))
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
    // Only parse what the proxy needs: replies to its own commands, and target attach/detach events.
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
        for (const page of this.tracker.observe(JSON.parse(text) as CdpMessage)) forgetTab(page)
      } catch {
        // Not JSON: forwarded as is, Patchright reports it.
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

  /** Per tab: how many times it was restored from the back/forward cache (see freshWorld). */
  private readonly worldGenerations = new Map<number, number>()

  /**
   * A restored page keeps its documents, and with them Patchright's isolated world and what Patchright stored on
   * elements there: element refs carry the number of the frame they were made in, which changes when Patchright
   * sees the frame again, so cached refs in a restored iframe would point at a frame that no longer exists. After a
   * restore, Patchright gets a fresh isolated world (another world name; pages can't see isolated worlds).
   */
  private freshWorld(command: CdpCommand): CdpCommand {
    const page = this.tracker.pageNumber(command.sessionId)
    const generation = page === undefined ? 0 : (this.worldGenerations.get(page) ?? 0)
    const name = command.params?.worldName
    if (!generation || typeof name !== "string") return command
    return { ...command, params: { ...command.params, worldName: `${name}:${generation}` } }
  }

  /** Messages from Chrome held back while frames are announced again (see replayRestoredFrames). */
  private held: string[] | undefined

  /**
   * A page restored from the back/forward cache keeps its iframes, but Chrome doesn't announce them again, and
   * Patchright forgets every child frame when the main frame navigates. Its iframes would then be invisible to
   * snapshots and actions. (Stock Playwright avoids this by turning the cache off, which sites can detect.) So,
   * like browse's relay does after reconnects (replayChildTargetsForParent in cli/src/cdp/shims.ts), tell
   * Patchright about them again: same-process frames as frameAttached + frameNavigated, out-of-process iframes as
   * a fresh attach of their existing session. Other messages from Chrome wait until that's done.
   */
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
      // Patchright needs the frame before the iframe's target; then a fresh session for the target (reusing the old
      // session id would mix up replies to commands sent on it before), which Patchright sets up by itself. Chrome
      // sends the detach and attach events; they're held until this is done, so they land after frameAttached.
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
    // Patchright sees the browser disconnect.
    this.client?.close(1000, "browser closed")
  }
}
