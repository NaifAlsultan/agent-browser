// A session's worker thread: its Patchright connection, Chrome and scripts. The main thread can end it at any
// moment, even in the middle of a script that never yields, without touching other sessions.
import { parentPort, workerData } from "node:worker_threads"
import { AgentBrowser, type DisplayInfo } from "./browser.ts"
import type { Config } from "./config.ts"
import { log } from "./log.ts"
import { errorText, Runner } from "./runner.ts"
import { Session } from "./session.ts"

export type WorkerData = { readonly config: Config; readonly display: DisplayInfo; readonly directory: string; readonly label: string }

export type ToWorker = { type: "run"; id: number; code: string; timeoutMs: number } | { type: "close" }

export type FromWorker =
  | { type: "ready"; chromePid: number | undefined }
  | { type: "failed"; error: string }
  | { type: "result"; id: number; result: unknown }
  | { type: "closed" }
  | { type: "lost" }

const port = parentPort!
const post = (message: FromWorker) => port.postMessage(message)
const { config, display, directory, label } = workerData as WorkerData

process.on("unhandledRejection", (error) => {
  // Playwright can reject unawaited promises when a page goes away; not fatal.
  log("worker.unhandled-rejection", { session: label, error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
})

let browser: AgentBrowser
try {
  browser = await AgentBrowser.launch(config, display, directory, label)
} catch (error) {
  post({ type: "failed", error: errorText(error) })
  process.exit(1)
}

const runner = new Runner(config, new Session(browser))
let closing = false
browser.onLost(() => {
  if (closing) return
  closing = true
  post({ type: "lost" })
  void browser.close().finally(() => process.exit(0))
})

port.on("message", async (message: ToWorker) => {
  if (message.type === "close") {
    closing = true
    await browser.close()
    post({ type: "closed" })
    process.exit(0)
  }
  if (message.type === "run") {
    let result: unknown
    try {
      result = await runner.run(message.code, message.timeoutMs)
    } catch (error) {
      result = { isError: true, content: [{ type: "text", text: errorText(error) }] }
    }
    post({ type: "result", id: message.id, result })
  }
})

post({ type: "ready", chromePid: browser.chromePid })
