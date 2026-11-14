#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { killSharedDisplayNow, stopSharedDisplay } from "./browser.ts"
import { loadConfig } from "./config.ts"
import { log } from "./log.ts"
import { createServer, serverVersion } from "./server.ts"
import { SessionManager } from "./session.ts"
import { removeProcessDirectory } from "./temp.ts"

const config = loadConfig()
const sessions = new SessionManager(config)
const server = createServer(config, sessions)

let shuttingDown = false
async function shutdown(reason: string, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  log("server.stopping", { reason })
  const deadline = new Promise((resolve) => setTimeout(resolve, 10_000).unref())
  await Promise.race([sessions.closeAll(), deadline]).catch(() => undefined)
  sessions.killAll()
  await stopSharedDisplay()
  removeProcessDirectory()
  process.exit(code)
}

process.on("exit", () => {
  sessions.killAll()
  killSharedDisplayNow()
  try {
    removeProcessDirectory()
  } catch {
  }
})
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGHUP", () => void shutdown("SIGHUP"))
process.stdin.on("end", () => void shutdown("stdin closed"))
process.on("uncaughtException", (error) => {
  log("server.uncaught", { error: error.stack ?? String(error) })
  void shutdown("uncaught exception", 1)
})
process.on("unhandledRejection", (error) => {
  // Playwright can reject unawaited promises when a page goes away; not fatal.
  log("server.unhandled-rejection", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
})

const transport = new StdioServerTransport()
transport.onclose = () => void shutdown("transport closed")
await server.connect(transport)
log("server.started", { version: serverVersion, pid: process.pid, chrome: config.chrome, xvfb: config.xvfb })
