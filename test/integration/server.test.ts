// End to end: the MCP server over stdio, driving real Chrome on Xvfb against local fixture pages.
// Needs Chrome and Xvfb (the dev shell sets AGENT_BROWSER_CHROME and AGENT_BROWSER_XVFB).
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server.ts"

const root = path.join(import.meta.dirname, "..", "..")
const available = (command: string | undefined) => {
  if (!command) return false
  try {
    execFileSync("sh", ["-c", `command -v "$0"`, command], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}
const skip = !available(process.env.AGENT_BROWSER_CHROME ?? "google-chrome-stable") || !available(process.env.AGENT_BROWSER_XVFB ?? "Xvfb")
  ? "Chrome or Xvfb not found (run in the dev shell)"
  : false

type Result = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }

describe("agent-browser over MCP", { skip, timeout: 300_000 }, () => {
  let fixtures: FixtureServer
  let client: Client
  let transport: StdioClientTransport
  let tmp: string
  let serverPid: number | undefined

  const call = async (name: string, args: Record<string, unknown> = {}, sessionID = "ses_test_a"): Promise<Result> =>
    (await client.callTool({ name, arguments: args, _meta: { "ai.opencode/sessionID": sessionID } })) as Result
  const text = (result: Result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
  const ok = async (name: string, args: Record<string, unknown> = {}, sessionID?: string) => {
    const result = await call(name, args, sessionID)
    assert.ok(!result.isError, `${name} failed: ${text(result)}`)
    return text(result)
  }
  const refOf = (snapshot: string, pattern: RegExp) => {
    const line = snapshot.split("\n").find((candidate) => pattern.test(candidate))
    const ref = line && /\[ref=([a-z0-9]+)\]/i.exec(line)?.[1]
    assert.ok(ref, `no ref for ${pattern} in:\n${snapshot}`)
    return ref
  }
  const profiles = () => fs.readdirSync(tmp).flatMap((dir) => (dir.startsWith("agent-browser-") ? fs.readdirSync(path.join(tmp, dir)).filter((entry) => entry.startsWith("ses_")) : []))

  before(async () => {
    fixtures = await startFixtureServer()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-test-"))
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "src", "main.ts")],
      env: { ...env, AGENT_BROWSER_TMPDIR: tmp, AGENT_BROWSER_CHALLENGE_WAIT_MS: "8000" },
      stderr: "pipe",
    })
    transport.stderr?.on("data", (chunk: Buffer) => {
      if (process.env.TEST_VERBOSE) process.stderr.write(chunk)
    })
    client = new Client({ name: "agent-browser-test", version: "0" })
    await client.connect(transport)
    serverPid = transport.pid ?? undefined
  })

  after(async () => {
    await client?.close()
    // The server cleans up when its stdin closes; give it a moment.
    for (let i = 0; i < 50 && serverPid && alive(serverPid); i++) await new Promise((resolve) => setTimeout(resolve, 200))
    await fixtures?.close()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("lists the tools and sends instructions", async () => {
    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ["back", "click", "close", "fill_form", "forward", "hover", "open", "press", "reload", "run_script", "screenshot", "scroll", "select", "snapshot", "tabs", "type", "wait"])
    assert.match(client.getInstructions() ?? "", /snapshot/)
  })

  test("opens a page and reads it with refs, including iframes", async () => {
    const opened = await ok("open", { url: `${fixtures.url}/form.html` })
    assert.match(opened, /Page: Test form \(http:\/\/127\.0\.0\.1:\d+\/form\.html\)/)
    const snapshot = await ok("snapshot")
    assert.match(snapshot, /heading "Sign up"/)
    assert.match(snapshot, /textbox "Newsletter email" \[ref=f\d+e\d+\]/)
  })

  test("types, fills a form, hides secrets and submits", async () => {
    let snapshot = await ok("snapshot")
    await ok("type", { ref: refOf(snapshot, /textbox "Name"/), text: "Naif" })
    await ok("fill_form", {
      fields: [
        { ref: refOf(snapshot, /textbox "Email"/), value: "naif@example.com" },
        { ref: refOf(snapshot, /textbox "Password"/), value: "hunter2-secret" },
        { ref: refOf(snapshot, /textbox "Code"/), value: "123456" },
        { ref: refOf(snapshot, /textbox "Card number"/), value: "4111111111111111" },
        { ref: refOf(snapshot, /combobox "Country"/), value: "United States" },
        { ref: refOf(snapshot, /checkbox "I agree"/), value: "true" },
      ],
    })
    snapshot = await ok("snapshot")
    assert.match(snapshot, /textbox "Name" \[ref=\w+\]: Naif/)
    assert.match(snapshot, /textbox "Email" \[ref=\w+\]: naif@example\.com/)
    assert.match(snapshot, /textbox "Password" \[ref=\w+\]: \[hidden\]/)
    assert.match(snapshot, /textbox "Code" \[ref=\w+\]: \[hidden\]/)
    assert.match(snapshot, /textbox "Card number" \[ref=\w+\]: \[hidden\]/)
    assert.doesNotMatch(snapshot, /hunter2|123456|4111111111111111/)
    assert.match(snapshot, /option "United States" \[selected\]/)
    assert.match(snapshot, /checkbox "I agree" \[checked\]/)
    const submitted = await ok("click", { ref: refOf(snapshot, /button "Create account"/) })
    assert.match(submitted, /Page: Echo \/submitted \(http:\/\/127\.0\.0\.1:\d+\/submitted\?name=Naif&email=naif%40example\.com/)
    assert.match(submitted, /country=us/)
    assert.match(submitted, /terms=on/)
    await ok("back")
  })

  test("acts inside an iframe", async () => {
    const snapshot = await ok("snapshot")
    await ok("click", { ref: refOf(snapshot, /button "Subscribe"/) })
    assert.match(await ok("snapshot"), /Subscribed!/)
  })

  test("keeps iframes, also cross-site ones, after going back to a cached page", async () => {
    await ok("open", { url: `${fixtures.url}/cross.html` })
    assert.match(await ok("snapshot"), /button "Subscribe"/)
    await ok("open", { url: `${fixtures.url}/popup.html` })
    // The page comes back from the back/forward cache, which Chrome doesn't announce frames for.
    assert.match(await ok("back"), /Page: Cross-origin frame/)
    const snapshot = await ok("snapshot")
    await ok("click", { ref: refOf(snapshot, /button "Subscribe"/) })
    assert.match(await ok("snapshot"), /Subscribed!/)
    assert.match(await ok("forward"), /Page: Dialogs/)
    await ok("open", { url: `${fixtures.url}/form.html` })
  })

  test("a stale ref fails fast with a hint", async () => {
    const started = Date.now()
    const result = await call("click", { ref: "e9999" })
    assert.ok(result.isError)
    assert.match(text(result), /new snapshot/)
    assert.ok(Date.now() - started < 5_000)
  })

  test("scrolls, by wheel and to a ref", async () => {
    assert.match(await ok("scroll", { direction: "down", amount: 600 }), /Scrolled; the page is/)
    const snapshot = await ok("snapshot")
    assert.match(await ok("scroll", { ref: refOf(snapshot, /paragraph.*: Bottom of the page/) }), /into view/)
    assert.match(await ok("scroll", { direction: "up", amount: 5_000 }), /at the top/)
  })

  test("takes screenshots", async () => {
    const viewport = await call("screenshot")
    assert.equal(viewport.content[0]?.type, "image")
    assert.equal(viewport.content[0]?.mimeType, "image/png")
    assert.ok(Buffer.from(viewport.content[0]!.data!, "base64").length > 1_000)
    const full = await call("screenshot", { fullPage: true })
    assert.equal(full.content[0]?.mimeType, "image/jpeg", text(full))
  })

  test("follows a link that opens a new tab, and manages tabs", async () => {
    const snapshot = await ok("snapshot")
    const clicked = await ok("click", { ref: refOf(snapshot, /link "Open in new tab"/) })
    assert.match(clicked, /new tab/)
    assert.match(clicked, /\[tab 2 of 2\]/)
    let list = await ok("tabs", { action: "list" })
    assert.match(list, /2\. Test form .*<- current/)
    list = await ok("tabs", { action: "close" })
    assert.match(list, /^Closed the tab\.\n1\. Test form .*<- current$/)
  })

  test("accepts dialogs and says so", async () => {
    await ok("open", { url: `${fixtures.url}/popup.html` })
    const clicked = await ok("click", { ref: refOf(await ok("snapshot"), /button "Delete"/) })
    assert.match(clicked, /confirm dialog said "Delete everything\?"; it was accepted/)
    assert.match(await ok("snapshot"), /confirmed/)
  })

  test("waits out a self-clearing bot check", async () => {
    const opened = await ok("open", { url: `${fixtures.url}/challenge.html` })
    assert.match(opened, /Passed a cloudflare bot check/)
    assert.match(opened, /Page: Test form/)
  })

  test("reports block pages and interactive challenges without retrying", async () => {
    const blocked = await ok("open", { url: `${fixtures.url}/blocked.html` })
    assert.match(blocked, /WARNING: Blocked: .* refused the visit \(cloudflare/)
    const captcha = await ok("open", { url: `${fixtures.url}/captcha.html` })
    assert.match(captcha, /WARNING: Blocked by a perimeterx interactive challenge/)
    assert.doesNotMatch(captcha, /handoff/)
  })

  test("runs Playwright scripts", async () => {
    await ok("open", { url: `${fixtures.url}/form.html` })
    const result = await ok("run_script", { code: "log('hi', 1); await page.getByLabel('Name').fill('Script'); return { title: await page.title(), value: await page.getByLabel('Name').inputValue() }" })
    assert.match(result, /Log:\nhi 1/)
    assert.match(result, /"title": "Test form"/)
    assert.match(result, /"value": "Script"/)
    const timedOut = await call("run_script", { code: "await new Promise(() => {})", timeoutMs: 1_000 })
    assert.ok(timedOut.isError)
    assert.match(text(timedOut), /didn't finish within 1000 ms/)
    const broken = await call("run_script", { code: "this is not javascript" })
    assert.ok(broken.isError)
    assert.match(text(broken), /doesn't compile/)
  })

  test("gives each OpenCode session its own browser and profile", async () => {
    await ok("run_script", { code: "await page.evaluate(() => localStorage.setItem('who', 'a')); return true" }, "ses_test_a")
    await ok("open", { url: `${fixtures.url}/form.html` }, "ses_test_b")
    const other = await ok("run_script", { code: "return await page.evaluate(() => localStorage.getItem('who'))" }, "ses_test_b")
    assert.match(other, /Returned:\nnull/)
    const same = await ok("run_script", { code: "return await page.evaluate(() => localStorage.getItem('who'))" }, "ses_test_a")
    assert.match(same, /Returned:\n"a"/)
    assert.equal(profiles().length, 2)
  })

  test("close ends the session's browser and deletes its profile", async () => {
    await ok("run_script", { code: "await page.evaluate(() => localStorage.setItem('who', 'b')); return true" }, "ses_test_b")
    assert.match(await ok("close", {}, "ses_test_b"), /deleted its profile/)
    assert.deepEqual(profiles().filter((dir) => dir.startsWith("ses_test_b")), [])
    assert.match(await ok("close", {}, "ses_test_b"), /had no browser/)
    // The next call starts a fresh browser with an empty profile.
    await ok("open", { url: `${fixtures.url}/form.html` }, "ses_test_b")
    const fresh = await ok("run_script", { code: "return await page.evaluate(() => localStorage.getItem('who'))" }, "ses_test_b")
    assert.match(fresh, /Returned:\nnull/)
  })

  test("stopping the server closes every browser and removes its files", async () => {
    await client.close()
    for (let i = 0; i < 75 && serverPid && alive(serverPid); i++) await new Promise((resolve) => setTimeout(resolve, 200))
    assert.ok(!serverPid || !alive(serverPid), "the server process is still running")
    assert.deepEqual(fs.readdirSync(tmp).filter((dir) => dir.startsWith("agent-browser-")), [])
  })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
