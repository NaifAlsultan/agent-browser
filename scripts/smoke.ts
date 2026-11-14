// Prints what a page sees of the browser. In the dev shell: node scripts/smoke.ts [url]
import { AgentBrowser, stopSharedDisplay } from "../src/browser.ts"
import { loadConfig } from "../src/config.ts"
import { removeProcessDirectory } from "../src/temp.ts"

const config = loadConfig()
const browser = await AgentBrowser.launch(config, "smoke")
try {
  const page = browser.context.pages()[0] ?? (await browser.context.newPage())
  await page.goto(process.argv[2] ?? "data:text/html,<title>smoke</title><h1>hello</h1>")
  const seen = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    const gl = canvas.getContext("webgl") as WebGLRenderingContext | null
    const info = gl?.getExtension("WEBGL_debug_renderer_info")
    return {
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      brands: (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands.map((b) => b.brand),
      languages: navigator.languages,
      plugins: navigator.plugins.length,
      screen: `${screen.width}x${screen.height} avail ${screen.availWidth}x${screen.availHeight} depth ${screen.colorDepth}`,
      window: `outer ${outerWidth}x${outerHeight} inner ${innerWidth}x${innerHeight} at ${screenX},${screenY}`,
      dpr: devicePixelRatio,
      webgl: gl ? `${gl.getParameter(info ? info.UNMASKED_VENDOR_WEBGL : gl.VENDOR)} / ${gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)}` : "none",
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      chromeRuntime: typeof (window as Window & { chrome?: unknown }).chrome,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
    }
  }, undefined, undefined, false)
  console.log(JSON.stringify(seen, null, 2))
  // SMOKE_XSHOT=file.png grabs the whole virtual screen (needs xwd and ImageMagick).
  if (process.env.SMOKE_XSHOT) {
    const { execFileSync } = await import("node:child_process")
    const { sharedDisplay } = await import("../src/browser.ts")
    const { display, xauthority } = await sharedDisplay(config)
    const env = { ...process.env, DISPLAY: display, XAUTHORITY: xauthority }
    const xwd = execFileSync("xwd", ["-root", "-silent"], { env, maxBuffer: 64 * 1024 * 1024 })
    execFileSync("magick", ["xwd:-", process.env.SMOKE_XSHOT], { input: xwd })
  }
} finally {
  await browser.close()
  await stopSharedDisplay()
  removeProcessDirectory()
}
