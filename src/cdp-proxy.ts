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
    const rewritten = removeDefaultMediaEmulation(message)
    if (rewritten.method === "Page.captureScreenshot" && rewritten.sessionId) this.nudgeScreenshot(rewritten)
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
    this.client?.send(text)
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
