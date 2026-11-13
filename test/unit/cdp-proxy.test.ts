// The CDP proxy against a fake Chrome: streams in place of the pipe, a ws client in place of Patchright.
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { afterEach, describe, test } from "node:test"
import WebSocket from "ws"
import { CdpProxy } from "../../src/cdp-proxy.ts"
import { removeDefaultMediaEmulation, TargetTracker } from "../../src/cdp-rewrite.ts"

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown }

/** A pretend Chrome on the other end of the pipe: records commands, answers through `reply`. */
class FakeChrome {
  readonly toChrome = new PassThrough()
  readonly fromChrome = new PassThrough()
  readonly received: Message[] = []
  private buffer = ""
  private waiters: Array<() => void> = []
  /** Answers each command; return undefined to answer `{}`, or "none" to not answer. */
  responder: (message: Message) => unknown = () => ({})

  constructor() {
    this.toChrome.setEncoding("utf8")
    this.toChrome.on("data", (chunk: string) => {
      this.buffer += chunk
      let end
      while ((end = this.buffer.indexOf("\0")) !== -1) {
        const message = JSON.parse(this.buffer.slice(0, end)) as Message
        this.buffer = this.buffer.slice(end + 1)
        this.received.push(message)
        for (const wake of this.waiters.splice(0)) wake()
        const result = this.responder(message)
        if (result !== "none" && message.id !== undefined) this.send({ id: message.id, result: result ?? {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) })
      }
    })
  }

  send(message: Message) {
    this.fromChrome.write(`${JSON.stringify(message)}\0`)
  }

  async waitFor(predicate: (message: Message) => boolean, timeoutMs = 5_000): Promise<Message> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.received.find(predicate)
      if (found) return found
      if (Date.now() > deadline) throw new Error("timed out waiting for a command to reach Chrome")
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 50)
      })
    }
  }
}

/** A connected client, as Patchright would be. */
async function connect(proxy: CdpProxy) {
  const socket = new WebSocket(await proxy.listen())
  const received: Message[] = []
  socket.on("message", (data) => received.push(JSON.parse(data.toString()) as Message))
  await new Promise((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  const until = async (predicate: (message: Message) => boolean, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs
    while (!received.some(predicate)) {
      if (Date.now() > deadline) throw new Error(`timed out; client got ${JSON.stringify(received).slice(0, 500)}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return received.find(predicate)!
  }
  return { socket, received, send: (message: Message) => socket.send(JSON.stringify(message)), until }
}

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step()
})

function setup(options: { humanInput?: boolean } = {}) {
  const chrome = new FakeChrome()
  const proxy = new CdpProxy({ toChrome: chrome.toChrome, fromChrome: chrome.fromChrome, humanInput: options.humanInput ?? false })
  cleanup.push(() => proxy.close())
  return { chrome, proxy }
}

const attachPage = (chrome: FakeChrome, sessionId = "PAGE", targetId = "T1") =>
  chrome.send({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { targetId, type: "page", url: "about:blank" }, waitingForDebugger: false } })

describe("removeDefaultMediaEmulation", () => {
  const command = (features: unknown[]) => ({ id: 1, method: "Emulation.setEmulatedMedia", params: { media: "", features } })

  test("drops Patchright's defaults and keeps the rest", () => {
    const out = removeDefaultMediaEmulation(command([
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-motion", value: "no-preference" },
      { name: "forced-colors", value: "none" },
      { name: "prefers-contrast", value: "no-preference" },
      { name: "prefers-color-scheme", value: "dark" },
    ]))
    assert.deepEqual(out.params.features, [{ name: "prefers-color-scheme", value: "dark" }])
  })

  test("leaves other commands and requests without defaults untouched (same object)", () => {
    const other = { id: 2, method: "Page.navigate", params: { url: "https://example.com" } }
    assert.equal(removeDefaultMediaEmulation(other), other)
    const custom = command([{ name: "prefers-reduced-motion", value: "reduce" }])
    assert.equal(removeDefaultMediaEmulation(custom), custom)
  })

  test("an explicit marker keeps every feature and is itself removed", () => {
    const out = removeDefaultMediaEmulation(command([{ name: "__bc_explicit__", value: "" }, { name: "prefers-color-scheme", value: "light" }]))
    assert.deepEqual(out.params.features, [{ name: "prefers-color-scheme", value: "light" }])
  })
})

describe("TargetTracker", () => {
  test("knows pages, their iframes, and forgets a page when its session goes", () => {
    const tracker = new TargetTracker()
    tracker.observe({ method: "Target.attachedToTarget", params: { sessionId: "P", targetInfo: { targetId: "T1", type: "page" } } })
    tracker.observe({ method: "Target.attachedToTarget", sessionId: "P", params: { sessionId: "F", targetInfo: { targetId: "T2", type: "iframe", parentFrameId: "T1" } } })
    assert.equal(tracker.isRoot("P"), true)
    assert.equal(tracker.isRoot("F"), false)
    assert.equal(tracker.isRoot(undefined), false)
    const page = tracker.pageNumber("P")
    assert.equal(tracker.pageNumber("F"), page)
    assert.deepEqual(tracker.iframeChildren("P").map((child) => child.targetId), ["T2"])
    assert.deepEqual(tracker.observe({ method: "Target.detachedFromTarget", params: { sessionId: "P" } }), [page])
    assert.equal(tracker.pageNumber("P"), undefined)
  })
})

describe("CdpProxy", () => {
  test("only accepts its secret path, one client, and no browser origins", async () => {
    const { proxy } = setup()
    const url = await proxy.listen()
    assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f]{48}$/)
    const refused = (target: string, headers: Record<string, string> = {}) =>
      new Promise<boolean>((resolve) => {
        const socket = new WebSocket(target, { headers })
        socket.once("open", () => {
          socket.close()
          resolve(false)
        })
        socket.once("error", () => resolve(true))
      })
    assert.equal(await refused(url.replace(/[0-9a-f]{48}$/, "0".repeat(48))), true)
    assert.equal(await refused(url, { Origin: "https://evil.example" }), true)
    const client = await connect(proxy)
    cleanup.push(() => client.socket.close())
    assert.equal(await refused(url), true)
  })

  test("passes commands and replies through, NUL-framed, even when split across chunks", async () => {
    const { chrome, proxy } = setup()
    const client = await connect(proxy)
    cleanup.push(() => client.socket.close())
    chrome.responder = () => "none"
    client.send({ id: 1, method: "Browser.getVersion" })
    const command = await chrome.waitFor((message) => message.id === 1)
    assert.equal(command.method, "Browser.getVersion")
    const reply = `${JSON.stringify({ id: 1, result: { product: "Chrome/157 ünïcode" } })}\0`
    const bytes = Buffer.from(reply)
    // Split inside a multi-byte character.
    const cut = bytes.indexOf(Buffer.from("ü")) + 1
    chrome.fromChrome.write(bytes.subarray(0, cut))
    chrome.fromChrome.write(bytes.subarray(cut))
    const got = await client.until((message) => message.id === 1)
    assert.deepEqual(got.result, { product: "Chrome/157 ünïcode" })
  })

  test("strips Patchright's media defaults on the way to Chrome", async () => {
    const { chrome, proxy } = setup()
    const client = await connect(proxy)
    cleanup.push(() => client.socket.close())
    client.send({ id: 7, method: "Emulation.setEmulatedMedia", sessionId: "PAGE", params: { media: "", features: [{ name: "prefers-color-scheme", value: "light" }] } })
    const command = await chrome.waitFor((message) => message.id === 7)
    assert.deepEqual(command.params?.features, [])
  })

  test("its own commands get ids of their own, and their replies don't reach the client", async () => {
    const { chrome, proxy } = setup()
    const client = await connect(proxy)
    cleanup.push(() => client.socket.close())
    chrome.responder = (message) => (message.method === "Target.getTargets" ? { targetInfos: [] } : {})
    assert.deepEqual(await proxy.call(undefined, "Target.getTargets"), { targetInfos: [] })
    const own = chrome.received.find((message) => message.method === "Target.getTargets")!
    assert.ok(own.id! >= 1_900_000_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(client.received.length, 0)
  })

  test("human-like input: a click's move becomes a path, sent before the click, which lands near its target", async () => {
    const { chrome, proxy } = setup({ humanInput: true })
    const client = await connect(proxy)
    cleanup.push(() => client.socket.close())
    chrome.responder = (message) => (message.method === "Page.getLayoutMetrics" ? { cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 } } : {})
    attachPage(chrome)
    await client.until((message) => message.method === "Target.attachedToTarget")
    client.send({ id: 10, method: "Input.dispatchMouseEvent", sessionId: "PAGE", params: { type: "mouseMoved", x: 600, y: 400, button: "none" } })
    client.send({ id: 11, method: "Input.dispatchMouseEvent", sessionId: "PAGE", params: { type: "mousePressed", x: 600, y: 400, button: "left", clickCount: 1 } })
    client.send({ id: 12, method: "Runtime.evaluate", sessionId: "PAGE", params: { expression: "1" } })
    await client.until((message) => message.id === 12, 10_000)
    const order = chrome.received.filter((message) => message.sessionId === "PAGE").map((message) => message.id)
    const moveIndex = order.indexOf(10)
    const pressIndex = order.indexOf(11)
    // Proxy-generated pointer samples came first, then Patchright's commands in their original order.
    const path = chrome.received.filter((message) => message.method === "Input.dispatchMouseEvent" && message.id! >= 1_900_000_000)
    assert.ok(path.length > 3, `expected a path of moves, got ${path.length}`)
    assert.ok(order.indexOf(path[0]!.id!) < moveIndex)
    assert.ok(moveIndex < pressIndex && pressIndex < order.indexOf(12))
    const move = chrome.received.find((message) => message.id === 10)!
    const press = chrome.received.find((message) => message.id === 11)!
    assert.ok(Math.abs(Number(move.params!.x) - 600) < 8 && Math.abs(Number(move.params!.y) - 400) < 8)
    // Press and move land on the same jittered point.
    assert.deepEqual([press.params!.x, press.params!.y], [move.params!.x, move.params!.y])
    // Patchright only sees replies to its own commands.
    assert.deepEqual(client.received.filter((message) => message.id !== undefined).map((message) => message.id).sort(), [10, 11, 12])
  })

  test("without human input, input goes straight through unchanged", async () => {
    const { chrome, proxy } = setup({ humanInput: false })
    const client = await connect(proxy)
    cleanup.push(() => client.socket.close())
    attachPage(chrome)
    client.send({ id: 20, method: "Input.dispatchMouseEvent", sessionId: "PAGE", params: { type: "mouseMoved", x: 600, y: 400 } })
    await client.until((message) => message.id === 20)
    assert.deepEqual(chrome.received.map((message) => message.id), [20])
    assert.deepEqual(chrome.received[0]!.params, { type: "mouseMoved", x: 600, y: 400 })
  })

  test("nudges a stalled screenshot until Chrome answers it", async () => {
    const { chrome, proxy } = setup()
    const client = await connect(proxy)
    cleanup.push(() => client.socket.close())
    let stalled = true
    chrome.responder = (message) => {
      if (message.method !== "Page.captureScreenshot") return {}
      if (message.id === 30) return "none"
      // The second nudge releases the original.
      if (chrome.received.filter((m) => m.method === "Page.captureScreenshot").length >= 3 && stalled) {
        stalled = false
        chrome.send({ id: 30, sessionId: "PAGE", result: { data: "original" } })
      }
      return { data: "nudge" }
    }
    client.send({ id: 30, method: "Page.captureScreenshot", sessionId: "PAGE", params: { format: "png", clip: { x: 0, y: 0, width: 10, height: 10, scale: 1 }, captureBeyondViewport: true } })
    const reply = await client.until((message) => message.id === 30, 5_000)
    assert.deepEqual(reply.result, { data: "original" })
    const nudge = chrome.received.find((message) => message.method === "Page.captureScreenshot" && message.id !== 30)!
    assert.equal(nudge.params!.format, "jpeg")
    assert.deepEqual(nudge.params!.clip, { x: 0, y: 0, width: 10, height: 10, scale: 1 })
    assert.equal("captureBeyondViewport" in nudge.params!, false)
    // Nudges stop once it's answered.
    const count = chrome.received.length
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(chrome.received.length, count)
  })

  test("after a back/forward-cache restore: re-announces frames and gives Patchright a fresh isolated world", async () => {
    const { chrome, proxy } = setup()
    const client = await connect(proxy)
    cleanup.push(() => client.socket.close())
    chrome.responder = (message) => {
      if (message.method === "Page.getFrameTree" && message.sessionId === "PAGE") {
        return { frameTree: { frame: { id: "MAIN", url: "https://a.example/" }, childFrames: [{ frame: { id: "SAME", parentId: "MAIN", url: "https://a.example/frame" } }, { frame: { id: "OOPIF", parentId: "MAIN", url: "https://b.example/" } }] } }
      }
      if (message.method === "Target.attachToTarget") {
        chrome.send({ method: "Target.attachedToTarget", sessionId: "PAGE", params: { sessionId: "NEWFRAME", targetInfo: { targetId: "OOPIF", type: "iframe", parentFrameId: "MAIN" }, waitingForDebugger: false } })
        return { sessionId: "NEWFRAME" }
      }
      return {}
    }
    attachPage(chrome, "PAGE", "MAIN")
    chrome.send({ method: "Target.attachedToTarget", sessionId: "PAGE", params: { sessionId: "OLDFRAME", targetInfo: { targetId: "OOPIF", type: "iframe", parentFrameId: "MAIN" }, waitingForDebugger: false } })
    client.send({ id: 40, method: "Page.createIsolatedWorld", sessionId: "PAGE", params: { frameId: "MAIN", worldName: "utility" } })
    await chrome.waitFor((message) => message.id === 40)
    assert.equal(chrome.received.find((message) => message.id === 40)!.params!.worldName, "utility")

    chrome.send({ method: "Page.frameNavigated", sessionId: "PAGE", params: { frame: { id: "MAIN", url: "https://a.example/" }, type: "BackForwardCacheRestore" } })
    // Something Chrome sends meanwhile waits until the frames are announced.
    chrome.send({ method: "Page.lifecycleEvent", sessionId: "PAGE", params: { frameId: "MAIN", name: "load" } })
    await client.until((message) => message.method === "Page.lifecycleEvent")
    const events = client.received.map((message) => `${message.method}${message.sessionId ? `@${message.sessionId}` : ""}${message.method === "Page.frameAttached" ? `:${message.params!.frameId}` : ""}`)
    const restore = events.indexOf("Page.frameNavigated@PAGE")
    // Chrome's own messages keep their order, after the frames the proxy announced.
    assert.deepEqual(events.slice(restore), [
      "Page.frameNavigated@PAGE",
      "Page.frameAttached@PAGE:SAME",
      "Page.frameNavigated@PAGE",
      "Page.frameAttached@PAGE:OOPIF",
      "Page.lifecycleEvent@PAGE",
      "Target.attachedToTarget@PAGE",
    ])
    assert.ok(chrome.received.some((message) => message.method === "Target.detachFromTarget" && message.params!.sessionId === "OLDFRAME"))
    // The same isolated world would carry refs from before the restore; Patchright gets a new one.
    client.send({ id: 41, method: "Page.createIsolatedWorld", sessionId: "PAGE", params: { frameId: "MAIN", worldName: "utility" } })
    await chrome.waitFor((message) => message.id === 41)
    assert.equal(chrome.received.find((message) => message.id === 41)!.params!.worldName, "utility:1")
  })

  test("when Chrome goes away, the client is disconnected and pending calls fail", async () => {
    const { chrome, proxy } = setup()
    const client = await connect(proxy)
    chrome.responder = () => "none"
    const pending = proxy.call(undefined, "Browser.getVersion")
    const closed = new Promise((resolve) => client.socket.once("close", resolve))
    chrome.fromChrome.end()
    await assert.rejects(pending, /Chrome is gone/)
    await closed
  })
})
