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
  const run = async (code: string, sessionID?: string) => {
    const result = await call("run", { code }, sessionID)
    assert.ok(!result.isError, `run failed: ${text(result)}`)
    return text(result)
  }
  const refOf = (snapshot: string, pattern: RegExp) => {
    const line = snapshot.split("\n").find((candidate) => pattern.test(candidate))
    const ref = line && /\[ref=([a-z0-9]+)\]/i.exec(line)?.[1]
    assert.ok(ref, `no ref for ${pattern} in:\n${snapshot}`)
    return ref
  }
  const profiles = () => fs.readdirSync(tmp).flatMap((dir) => (dir.startsWith("agent-browser-") ? fs.readdirSync(path.join(tmp, dir)).filter((entry) => entry.startsWith("ses_")) : []))
  const xSockets = () => {
    try {
      return Object.fromEntries(fs.readdirSync("/tmp/.X11-unix").map((name) => [name, fs.lstatSync(path.join("/tmp/.X11-unix", name)).ino]))
    } catch {
      return {}
    }
  }
  let xSocketsBefore: Record<string, number> = {}

  before(async () => {
    xSocketsBefore = xSockets()
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
    for (let i = 0; i < 50 && serverPid && alive(serverPid); i++) await new Promise((resolve) => setTimeout(resolve, 200))
    await fixtures?.close()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("has run and close, and instructions", async () => {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["close", "run"])
    assert.match(client.getInstructions() ?? "", /run\(\{ code \}\)/)
  })

  test("opens a page and reads it with refs, including iframes", async () => {
    const result = await run(`await page.goto(${JSON.stringify(`${fixtures.url}/form.html`)}); return await snapshot()`)
    assert.match(result, /heading "Sign up"/)
    assert.match(result, /textbox "Newsletter email" \[ref=f\d+e\d+\]/)
    assert.match(result, /Page: Test form \(http:\/\/127\.0\.0\.1:\d+\/form\.html\)/)
  })

  test("types, fills a form, hides secrets and submits", async () => {
    const snapshot = await run("return await snapshot()")
    const fields = {
      name: refOf(snapshot, /textbox "Name"/),
      email: refOf(snapshot, /textbox "Email"/),
      password: refOf(snapshot, /textbox "Password"/),
      code: refOf(snapshot, /textbox "Code"/),
      card: refOf(snapshot, /textbox "Card number"/),
      country: refOf(snapshot, /combobox "Country"/),
      terms: refOf(snapshot, /checkbox "I agree"/),
    }
    const filled = await run(`
      await ref("${fields.name}").pressSequentially("Naif")
      await ref("${fields.email}").pressSequentially("naif@example.com")
      await ref("${fields.password}").fill("hunter2-secret")
      await ref("${fields.code}").fill("123456")
      await ref("${fields.card}").fill("4111111111111111")
      await ref("${fields.country}").selectOption({ label: "United States" })
      await ref("${fields.terms}").check()
      return await snapshot()
    `)
    assert.match(filled, /textbox "Name" \[ref=\w+\]: Naif/)
    assert.match(filled, /textbox "Email" \[ref=\w+\]: naif@example\.com/)
    assert.match(filled, /textbox "Password" \[ref=\w+\]: \[hidden\]/)
    assert.match(filled, /textbox "Code" \[ref=\w+\]: \[hidden\]/)
    assert.match(filled, /textbox "Card number" \[ref=\w+\]: \[hidden\]/)
    assert.doesNotMatch(filled, /hunter2|123456|4111111111111111/)
    assert.match(filled, /option "United States" \[selected\]/)
    assert.match(filled, /checkbox "I agree" \[checked\]/)
    const submitted = await run(`await ref("${refOf(filled, /button "Create account"/)}").click()`)
    assert.match(submitted, /Page: Echo \/submitted \(http:\/\/127\.0\.0\.1:\d+\/submitted\?name=Naif&email=naif%40example\.com/)
    assert.match(submitted, /country=us/)
    assert.match(submitted, /terms=on/)
    await run(`await page.goBack({ waitUntil: "commit" })`)
  })

  test("acts inside an iframe", async () => {
    const snapshot = await run("return await snapshot()")
    assert.match(await run(`await ref("${refOf(snapshot, /button "Subscribe"/)}").click(); return await snapshot()`), /Subscribed!/)
  })

  test("keeps iframes, also cross-site ones, after going back to a cached page", async () => {
    await run(`await page.goto(${JSON.stringify(`${fixtures.url}/cross.html`)})`)
    await run(`await page.goto(${JSON.stringify(`${fixtures.url}/popup.html`)})`)
    const back = await run(`await page.goBack({ waitUntil: "commit" }); return await snapshot()`)
    assert.match(back, /Page: Cross-origin frame/)
    assert.match(await run(`await ref("${refOf(back, /button "Subscribe"/)}").click(); return await snapshot()`), /Subscribed!/)
  })

  test("scrolls and takes screenshots", async () => {
    await run(`await page.goto(${JSON.stringify(`${fixtures.url}/form.html`)})`)
    const scrolled = await run(`await page.mouse.move(600, 400); await page.mouse.wheel(0, 600); await page.waitForTimeout(300); return await page.evaluate(() => scrollY)`)
    assert.match(scrolled, /Returned:\n[1-9]\d*/)
    const shots = await call("run", { code: "await screenshot(); await screenshot({ fullPage: true }); return 'done'" })
    assert.ok(!shots.isError, text(shots))
    const images = shots.content.filter((part) => part.type === "image")
    assert.deepEqual(images.map((image) => image.mimeType), ["image/png", "image/jpeg"])
    assert.ok(Buffer.from(images[0]!.data!, "base64").length > 1_000)
  })

  test("follows a link that opens a new tab", async () => {
    const snapshot = await run("return await snapshot()")
    const clicked = await run(`await ref("${refOf(snapshot, /link "Open in new tab"/)}").click()`)
    assert.match(clicked, /A new tab opened/)
    assert.match(clicked, /\[tab 2 of 2\]/)
    assert.match(await run("const pages = context.pages(); const i = pages.indexOf(page); await page.close(); return i"), /Returned:\n1/)
    assert.match(await run("return context.pages().length"), /Returned:\n1/)
  })

  test("dismisses dialogs and says so", async () => {
    const result = await run(`await page.goto(${JSON.stringify(`${fixtures.url}/popup.html`)}); await page.getByRole("button", { name: "Delete" }).click(); return await page.locator("#answer").textContent()`)
    assert.match(result, /Returned:\ncancelled/)
    assert.match(result, /confirm dialog said "Delete everything\?"; it was dismissed/)
  })

  test("an action on a ref that's gone fails after a short grace, not the action timeout", async () => {
    await run(`await page.goto(${JSON.stringify(`${fixtures.url}/form.html`)})`)
    const button = refOf(await run("return await snapshot()"), /button "Create account"/)
    const started = Date.now()
    const result = await call("run", { code: `await page.evaluate(() => document.querySelector("button[type=submit]").remove()); await ref("${button}").click()` })
    assert.ok(result.isError)
    assert.match(text(result), new RegExp(`Ref ${button} no longer matches an element`))
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`)
    assert.match(await run(`return await ref("${button}").count()`), /Returned:\n0/)
  })

  test("waits out a self-clearing bot check", async () => {
    const result = await run(`await page.goto(${JSON.stringify(`${fixtures.url}/challenge.html`)})`)
    assert.match(result, /Passed a cloudflare bot check/)
    assert.match(result, /Page: Test form/)
  })

  test("reports block pages and interactive challenges", async () => {
    assert.match(await run(`await page.goto(${JSON.stringify(`${fixtures.url}/blocked.html`)})`), /WARNING: Blocked: .* refused the visit \(cloudflare/)
    const captcha = await run(`await page.goto(${JSON.stringify(`${fixtures.url}/captcha.html`)})`)
    assert.match(captcha, /WARNING: Blocked by a perimeterx interactive challenge/)
    assert.doesNotMatch(captcha, /handoff/)
  })

  test("logs, keeps state between calls, and reports script errors with the page state", async () => {
    await run(`await page.goto(${JSON.stringify(`${fixtures.url}/form.html`)}); state.visits = 1`)
    assert.match(await run("log('hi', 1); state.visits++; return state.visits"), /Returned:\n2\n\nLog:\nhi 1/)
    assert.match(await run("console.log('from', { console: true }); console.error('bad'); return 1"), /Log:\nfrom \{\n  "console": true\n\}\nerror: bad/)
    const thrown = await call("run", { code: "throw new Error('nope')" })
    assert.ok(thrown.isError)
    assert.match(text(thrown), /^Error: nope[\s\S]*Page: Test form/)
    const timedOut = await call("run", { code: "await new Promise(() => {})", timeoutMs: 1_000 })
    assert.ok(timedOut.isError)
    assert.match(text(timedOut), /didn't finish within 1000 ms, so this session's browser was closed/)
    assert.match(await run(`await page.goto(${JSON.stringify(`${fixtures.url}/form.html`)}); return state.visits ?? "fresh"`), /Returned:\nfresh/)
    const broken = await call("run", { code: "this is not javascript" })
    assert.ok(broken.isError)
    assert.match(text(broken), /doesn't compile/)
  })

  test("gives each OpenCode session its own browser and profile", async () => {
    await run("await page.evaluate(() => localStorage.setItem('who', 'a'))", "ses_test_a")
    await run(`await page.goto(${JSON.stringify(`${fixtures.url}/form.html`)})`, "ses_test_b")
    assert.match(await run("return await page.evaluate(() => localStorage.getItem('who'))", "ses_test_b"), /Returned:\nnull/)
    assert.match(await run("return await page.evaluate(() => localStorage.getItem('who'))", "ses_test_a"), /Returned:\na/)
    assert.equal(profiles().length, 2)
  })

  test("close ends the session's browser and deletes its profile", async () => {
    await run("await page.evaluate(() => localStorage.setItem('who', 'b'))", "ses_test_b")
    assert.match(text(await call("close", {}, "ses_test_b")), /deleted its profile/)
    assert.deepEqual(profiles().filter((dir) => dir.startsWith("ses_test_b")), [])
    assert.match(text(await call("close", {}, "ses_test_b")), /had no browser/)
    await run(`await page.goto(${JSON.stringify(`${fixtures.url}/form.html`)})`, "ses_test_b")
    assert.match(await run("return await page.evaluate(() => localStorage.getItem('who'))", "ses_test_b"), /Returned:\nnull/)
  })

  test("a script that never yields is stopped, without stalling other sessions", async () => {
    await run("return 1", "ses_test_c")
    const order: string[] = []
    const looping = call("run", { code: "for (;;) {}", timeoutMs: 3_000 }, "ses_test_c").then((result) => {
      order.push("loop")
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const started = Date.now()
    await run("return 1", "ses_test_a")
    order.push("other")
    assert.ok(Date.now() - started < 2_000, `another session waited ${Date.now() - started} ms`)
    const stopped = await looping
    assert.deepEqual(order, ["other", "loop"])
    assert.ok(stopped.isError)
    assert.match(text(stopped), /didn't finish within 3000 ms/)
    assert.deepEqual(profiles().filter((dir) => dir.startsWith("ses_test_c")), [])
    assert.match(await run("return 2", "ses_test_c"), /Returned:\n2/)
    await call("close", {}, "ses_test_c")
  })

  test("stopping the server closes every browser and removes its files", async () => {
    await client.close()
    for (let i = 0; i < 75 && serverPid && alive(serverPid); i++) await new Promise((resolve) => setTimeout(resolve, 200))
    assert.ok(!serverPid || !alive(serverPid), "the server process is still running")
    assert.deepEqual(fs.readdirSync(tmp).filter((dir) => dir.startsWith("agent-browser-")), [])
  })

  test("left every X server that was already running alone", () => {
    const after = xSockets()
    for (const [name, inode] of Object.entries(xSocketsBefore)) assert.equal(after[name], inode, `/tmp/.X11-unix/${name} was replaced or removed`)
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
