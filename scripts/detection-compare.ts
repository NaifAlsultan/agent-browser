// Compares agent-browser with plain Playwright on public bot-detection pages. In the dev shell:
//   node scripts/detection-compare.ts <out-dir> [ours|playwright-headless|playwright-xvfb ...]
import fs from "node:fs"
import path from "node:path"
import { chromium as playwright, type Page as PlaywrightPage } from "playwright-core"
import { AgentBrowser, sharedDisplay, stopSharedDisplay } from "../src/browser.ts"
import { loadConfig } from "../src/config.ts"
import { removeProcessDirectory } from "../src/temp.ts"

type AnyPage = PlaywrightPage | import("../src/patchright.ts").Page
type Site = { name: string; url: string; settleMs: number; read: string }

const sites: Site[] = [
  {
    name: "sannysoft",
    url: "https://bot.sannysoft.com/",
    settleMs: 6_000,
    read: `(() => {
      const rows = [...document.querySelectorAll("tr")].map((row) => {
        const cells = [...row.querySelectorAll("td")]
        const result = cells.find((cell) => /\\b(passed|failed|warn)\\b/.test(cell.className))
        return result ? { test: cells[0].innerText.trim(), status: result.className.match(/passed|failed|warn/)[0], value: result.innerText.trim().slice(0, 80) } : undefined
      }).filter(Boolean)
      return { total: rows.length, notPassed: rows.filter((row) => row.status !== "passed") }
    })()`,
  },
  {
    name: "creepjs",
    url: "https://abrahamjuliot.github.io/creepjs/",
    settleMs: 25_000,
    read: `(() => {
      const text = document.body.innerText
      const pick = (pattern) => (text.match(pattern) || [])[0]
      return {
        headless: pick(/\\d+% like headless[^\\n]*/) ?? pick(/like headless[^\\n]*/),
        headlessScore: pick(/\\d+% headless:[^\\n]*/) ?? pick(/headless:[^\\n]*/),
        stealth: pick(/\\d+% stealth[^\\n]*/) ?? pick(/stealth:[^\\n]*/),
        lies: pick(/lies \\(\\d+\\)[^\\n]*/),
        botLines: text.split("\\n").filter((line) => /headless|stealth|webdriver|automation|bot\\b|lies/i.test(line)).slice(0, 40),
      }
    })()`,
  },
  {
    name: "browserscan",
    url: "https://www.browserscan.net/bot-detection",
    settleMs: 12_000,
    read: `(() => {
      const text = document.body.innerText
      const start = text.search(/Test Results|Bot Detection/i)
      return { excerpt: text.slice(Math.max(0, start), start + 2500) }
    })()`,
  },
  {
    name: "rebrowser",
    url: "https://bot-detector.rebrowser.net/",
    settleMs: 8_000,
    read: `(() => {
      const rows = [...document.querySelectorAll("tr")].map((row) => row.innerText.replace(/\\s+/g, " ").trim()).filter(Boolean)
      return { rows: rows.slice(0, 40) }
    })()`,
  },
]

async function visit(page: AnyPage, site: Site, out: string, setup: string) {
  const started = Date.now()
  try {
    await page.goto(site.url, { waitUntil: "load", timeout: 60_000 })
    await page.mouse.move(400 + Math.random() * 200, 300 + Math.random() * 100)
    await page.mouse.move(700, 450)
    await page.waitForTimeout(site.settleMs)
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(1_000)
    await page.screenshot({ path: path.join(out, `${setup}-${site.name}.png`), fullPage: true, timeout: 30_000 }).catch((error: unknown) => console.error(`screenshot failed: ${error}`))
    const result = await (page as PlaywrightPage).evaluate(site.read)
    return { setup, site: site.name, ms: Date.now() - started, result }
  } catch (error) {
    return { setup, site: site.name, ms: Date.now() - started, error: String(error).slice(0, 500) }
  }
}

const out = process.argv[2] ?? "/tmp/agent-browser-detection"
const setups = process.argv.slice(3).length ? process.argv.slice(3) : ["playwright-headless", "playwright-xvfb", "ours"]
fs.mkdirSync(out, { recursive: true })
const config = loadConfig()
const results: unknown[] = []

for (const setup of setups) {
  if (setup === "ours") {
    const browser = await AgentBrowser.launch(config, "detection")
    try {
      const page = browser.context.pages()[0]!
      for (const site of sites) results.push(await visit(page, site, out, setup))
    } finally {
      await browser.close()
    }
  } else {
    const headless = setup === "playwright-headless"
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    if (!headless) {
      const { display, xauthority } = await sharedDisplay(config)
      delete env.WAYLAND_DISPLAY
      Object.assign(env, { DISPLAY: display, XAUTHORITY: xauthority })
    }
    const browser = await playwright.launch({ headless, env, args: headless ? [] : ["--ozone-platform=x11"] })
    try {
      const page = await (await browser.newContext()).newPage()
      for (const site of sites) results.push(await visit(page, site, out, setup))
    } finally {
      await browser.close()
    }
  }
}
await stopSharedDisplay()
removeProcessDirectory()
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
