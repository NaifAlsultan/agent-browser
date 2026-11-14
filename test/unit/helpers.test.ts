import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, test } from "node:test"
import { chromeArgs, chromeEnv, gpuArgs } from "../../src/chrome.ts"
import { loadConfig } from "../../src/config.ts"
import { redacted, redactLines, valueLines } from "../../src/snapshot.ts"
import { removeStaleDirectories, removeStaleDisplay } from "../../src/temp.ts"
import { errorText, normalizeUrl, sessionKeyOf } from "../../src/tools.ts"
import { displayInUse, workAreaFor, xauthEntry } from "../../src/xvfb.ts"

describe("snapshot redaction", () => {
  const snapshot = [
    "- generic [ref=e1]:",
    '  - textbox "Name" [ref=e5]: Naif',
    '  - textbox "Password" [ref=e9]: hunter2',
    '  - textbox "Code" [active] [ref=e11]: "123456"',
    '  - textbox "Notes" [ref=e12]: |',
    "      line one",
    "      line two",
    '  - textbox "Empty" [ref=e13]',
    '  - combobox "Country" [ref=e17]:',
    '    - option "Saudi Arabia" [selected]',
    '  - iframe [ref=e20]:',
    '    - textbox "Card" [ref=f1e3]: "4111111111111111"',
    '  - paragraph [ref=e30]: "textbox: not a field"',
  ]

  test("finds the lines that show a field's value, with their refs", () => {
    assert.deepEqual(valueLines(snapshot).map((line) => line.ref), ["e5", "e9", "e11", "e12", "f1e3"])
    assert.equal(valueLines(snapshot).find((line) => line.ref === "e12")!.blockEnd, 6)
  })

  test("hides the chosen values, multi-line ones included, and nothing else", () => {
    const secret = valueLines(snapshot).filter((line) => ["e9", "e11", "e12", "f1e3"].includes(line.ref))
    const out = redactLines(snapshot, secret).join("\n")
    assert.match(out, /textbox "Name" \[ref=e5\]: Naif/)
    assert.ok(out.includes(`textbox "Password" [ref=e9]: ${redacted}`))
    assert.match(out, /textbox "Code" \[active\] \[ref=e11\]: \[hidden\]/)
    assert.match(out, /textbox "Notes" \[ref=e12\]: \[hidden\]\n {2}- textbox "Empty"/)
    assert.match(out, /textbox "Card" \[ref=f1e3\]: \[hidden\]/)
    assert.doesNotMatch(out, /hunter2|123456|4111|line one/)
    assert.match(out, /combobox "Country" \[ref=e17\]:\n {4}- option "Saudi Arabia" \[selected\]/)
  })
})

describe("tool helpers", () => {
  test("normalizeUrl adds a scheme only when there's none", () => {
    assert.equal(normalizeUrl("example.com"), "https://example.com")
    assert.equal(normalizeUrl(" example.com/a?b=c "), "https://example.com/a?b=c")
    assert.equal(normalizeUrl("localhost:3000/x"), "http://localhost:3000/x")
    assert.equal(normalizeUrl("127.0.0.1:8080"), "http://127.0.0.1:8080")
    assert.equal(normalizeUrl("example.com:8443/path"), "https://example.com:8443/path")
    assert.equal(normalizeUrl("http://example.com"), "http://example.com")
    assert.equal(normalizeUrl("about:blank"), "about:blank")
    assert.equal(normalizeUrl("data:text/html,hi"), "data:text/html,hi")
  })

  test("sessionKeyOf reads OpenCode's session ID and falls back to one default session", () => {
    assert.equal(sessionKeyOf({ _meta: { "ai.opencode/sessionID": "ses_abc" } }), "ses_abc")
    assert.equal(sessionKeyOf({ _meta: {} }), "default")
    assert.equal(sessionKeyOf({ _meta: { "ai.opencode/sessionID": 5 } }), "default")
    assert.equal(sessionKeyOf(undefined), "default")
  })

  test("errorText keeps Playwright's message and the start of its call log", () => {
    const error = new Error("locator.click: Timeout 15000ms exceeded.\nCall log:\n  - one\n  - two\n  - three\n  - four\n  - five")
    assert.equal(errorText(error), "locator.click: Timeout 15000ms exceeded.\nCall log:\n  - one\n  - two\n  - three")
  })
})

describe("Chrome's command line and environment", () => {
  const window = { x: 0, y: 32, width: 1920, height: 1048 }

  test("no automation or headless switches, DevTools over a pipe, X11, the window in the work area", () => {
    const args = chromeArgs({ window }, "/tmp/profile", true)
    for (const forbidden of ["--enable-automation", "--headless", "--remote-debugging-port", "--disable-popup-blocking", "--disable-ipc-flooding-protection", "--disable-back-forward-cache"]) {
      assert.ok(!args.some((arg) => arg.startsWith(forbidden)), `${forbidden} must not be passed`)
    }
    for (const expected of ["--remote-debugging-pipe", "--ozone-platform=x11", "--user-data-dir=/tmp/profile", "--disable-blink-features=AutomationControlled", "--window-position=0,32", "--window-size=1920,1048", "--no-first-run"]) {
      assert.ok(args.includes(expected), `${expected} missing`)
    }
    assert.equal(args.at(-1), "about:blank")
  })

  test("WebGL: the GPU through ANGLE when there's a render node, SwiftShader otherwise", () => {
    assert.deepEqual(gpuArgs("auto", true), ["--use-gl=angle", "--use-angle=gl-egl"])
    assert.deepEqual(gpuArgs("auto", false), ["--enable-unsafe-swiftshader"])
    assert.deepEqual(gpuArgs("off", true), ["--enable-unsafe-swiftshader"])
    assert.deepEqual(gpuArgs("on", false), ["--use-gl=angle", "--use-angle=gl-egl"])
  })

  test("extra flags go before the start URL", () => {
    const args = chromeArgs({ window, extraArgs: ["--no-sandbox"] }, "/p", false)
    assert.deepEqual(args.slice(-2), ["--no-sandbox", "about:blank"])
  })

  test("the environment has the virtual display and nothing of the desktop session", () => {
    const env = chromeEnv(
      { WAYLAND_DISPLAY: "wayland-1", NIXOS_OZONE_WL: "1", DISPLAY: ":0", XAUTHORITY: "/home/u/.Xauthority", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", HOME: "/home/u", XDG_CONFIG_HOME: "/home/u/.config", XDG_SESSION_TYPE: "wayland", HYPRLAND_INSTANCE_SIGNATURE: "x", PATH: "/bin", LANG: "en_US.UTF-8" },
      { display: ":7", xauthority: "/tmp/ab/Xauthority" },
      "/tmp/ab/home",
    )
    assert.equal(env.DISPLAY, ":7")
    assert.equal(env.XAUTHORITY, "/tmp/ab/Xauthority")
    assert.equal(env.HOME, "/tmp/ab/home")
    assert.equal(env.XDG_SESSION_TYPE, "x11")
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "disabled:")
    for (const gone of ["WAYLAND_DISPLAY", "NIXOS_OZONE_WL", "XDG_CONFIG_HOME", "HYPRLAND_INSTANCE_SIGNATURE"]) assert.equal(env[gone], undefined, gone)
    assert.equal(env.PATH, "/bin")
    assert.equal(env.LANG, "en_US.UTF-8")
  })
})

describe("X display", () => {
  test("xauthEntry writes libXau's format: wildcard family, display number, MIT cookie", () => {
    const cookie = Buffer.alloc(16, 0xab)
    const entry = xauthEntry("12", cookie)
    let at = 0
    const u16 = () => {
      const value = entry.readUInt16BE(at)
      at += 2
      return value
    }
    const field = () => {
      const length = u16()
      const value = entry.subarray(at, at + length)
      at += length
      return value
    }
    assert.equal(u16(), 0xffff)
    assert.equal(field().length, 0)
    assert.equal(field().toString(), "12")
    assert.equal(field().toString(), "MIT-MAGIC-COOKIE-1")
    assert.deepEqual(field(), cookie)
    assert.equal(at, entry.length)
  })

  test("an empty display number (any display, as socket-path DISPLAYs need) is written as an empty field", () => {
    const entry = xauthEntry("", Buffer.alloc(16))
    assert.deepEqual([...entry.subarray(0, 6)], [0xff, 0xff, 0, 0, 0, 0])
  })

  test("the work area leaves a panel at the top", () => {
    assert.deepEqual(workAreaFor(1920, 1080), { x: 0, y: 32, width: 1920, height: 1048 })
  })

  test("a display number counts as taken with a lock, a socket file (even a stale symlink) or a live abstract socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-display-test-"))
    const sockets = path.join(dir, "sockets")
    fs.mkdirSync(sockets)
    const number = 50_000 + Math.floor(Math.random() * 10_000)
    try {
      assert.equal(await displayInUse(number, sockets, dir), false)
      fs.writeFileSync(path.join(dir, `.X${number}-lock`), "123")
      assert.equal(await displayInUse(number, sockets, dir), true)
      fs.rmSync(path.join(dir, `.X${number}-lock`))
      fs.symlinkSync("nowhere", path.join(sockets, `X${number}`))
      assert.equal(await displayInUse(number, sockets, dir), true)
      fs.rmSync(path.join(sockets, `X${number}`))
      // The abstract name is always the conventional one, whatever the socket directory.
      const server = net.createServer().listen(`\0/tmp/.X11-unix/X${number}`)
      await new Promise((resolve) => server.once("listening", resolve))
      try {
        assert.equal(await displayInUse(number, sockets, dir), true)
      } finally {
        server.close()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("config", () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("AGENT_BROWSER_")) delete process.env[key]
    Object.assign(process.env, saved)
  })

  test("defaults", () => {
    for (const key of Object.keys(process.env)) if (key.startsWith("AGENT_BROWSER_")) delete process.env[key]
    const config = loadConfig()
    assert.equal(config.idleTimeoutMs, 15 * 60_000)
    assert.deepEqual(config.screen, { width: 1920, height: 1080 })
    assert.equal(config.humanInput, true)
    assert.equal(config.gpu, "auto")
    assert.equal(config.chrome, "google-chrome-stable")
  })

  test("reads and validates settings", () => {
    process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = "5000"
    process.env.AGENT_BROWSER_SCREEN = "1366x768"
    process.env.AGENT_BROWSER_HUMAN_INPUT = "off"
    process.env.AGENT_BROWSER_CHROME_ARGS = "--no-sandbox  --lang=en-GB"
    const config = loadConfig()
    assert.equal(config.idleTimeoutMs, 5000)
    assert.deepEqual(config.screen, { width: 1366, height: 768 })
    assert.equal(config.humanInput, false)
    assert.deepEqual(config.extraChromeArgs, ["--no-sandbox", "--lang=en-GB"])
    process.env.AGENT_BROWSER_SCREEN = "big"
    assert.throws(() => loadConfig(), /AGENT_BROWSER_SCREEN/)
    process.env.AGENT_BROWSER_SCREEN = "1920x1080"
    process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = "soon"
    assert.throws(() => loadConfig(), /AGENT_BROWSER_IDLE_TIMEOUT_MS/)
  })
})

describe("leftover displays", () => {
  test("a dead server's socket and lock are removed; a live lock keeps them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ab-stale-display-"))
    try {
      const sockets = path.join(root, "sockets")
      const dir = path.join(root, "agent-browser-x")
      fs.mkdirSync(sockets)
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, "display"), "321")
      const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString()
      fs.writeFileSync(path.join(sockets, "X321"), "")
      fs.writeFileSync(path.join(root, ".X321-lock"), `${process.pid}\n`)
      removeStaleDisplay(dir, process.getuid?.(), sockets, root)
      assert.equal(fs.existsSync(path.join(sockets, "X321")), true, "a live lock holder keeps the display")
      fs.writeFileSync(path.join(root, ".X321-lock"), `${dead}\n`)
      removeStaleDisplay(dir, process.getuid?.(), sockets, root)
      assert.equal(fs.existsSync(path.join(sockets, "X321")), false)
      assert.equal(fs.existsSync(path.join(root, ".X321-lock")), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("leftover directories", () => {
  test("removes directories of agent-browser processes that are gone, and keeps the rest", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ab-stale-test-"))
    try {
      const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString()
      const make = (name: string, pid?: string) => {
        const dir = path.join(parent, name)
        fs.mkdirSync(path.join(dir, "profile"), { recursive: true })
        if (pid) fs.writeFileSync(path.join(dir, "owner.pid"), pid)
        return dir
      }
      const gone = make("agent-browser-gone", dead)
      const live = make("agent-browser-live", String(process.pid))
      const fresh = make("agent-browser-fresh")
      const other = make("something-else", dead)
      removeStaleDirectories(parent)
      assert.equal(fs.existsSync(gone), false)
      assert.equal(fs.existsSync(live), true)
      assert.equal(fs.existsSync(fresh), true)
      assert.equal(fs.existsSync(other), true)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})
