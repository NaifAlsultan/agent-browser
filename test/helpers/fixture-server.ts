// Serves test/fixtures over HTTP on 127.0.0.1. Any other path answers with a page echoing the request, so form
// submissions (GET /submitted?...) can be checked.
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"

const fixtures = path.join(import.meta.dirname, "..", "fixtures")

export type FixtureServer = { readonly url: string; close(): Promise<void> }

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const name = url.pathname === "/" ? "form.html" : path.basename(url.pathname)
    const file = path.join(fixtures, name)
    response.setHeader("content-type", "text/html; charset=utf-8")
    if (name.endsWith(".html") && fs.existsSync(file)) {
      response.end(fs.readFileSync(file))
      return
    }
    const echo = [...url.searchParams].map(([key, value]) => `<li>${escape(key)}=${escape(value)}</li>`).join("")
    response.end(`<!doctype html><title>Echo ${escape(url.pathname)}</title><h1>${escape(url.pathname)}</h1><ul>${echo}</ul>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
}
