// Settings, all from environment variables. The Nix package bakes in the Chrome and Xvfb paths as defaults.

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}, got ${JSON.stringify(raw)}`)
  return value
}

function words(name: string): string[] {
  return (process.env[name] ?? "").split(/\s+/).filter(Boolean)
}

function screen(): { width: number; height: number } {
  const raw = process.env.AGENT_BROWSER_SCREEN?.trim() || "1920x1080"
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(raw)
  if (!match) throw new Error(`AGENT_BROWSER_SCREEN must look like 1920x1080, got ${JSON.stringify(raw)}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

export type Config = {
  /** Google Chrome executable (the nixpkgs wrapper, google-chrome-stable). */
  readonly chrome: string
  /** Xvfb executable. */
  readonly xvfb: string
  /** Virtual screen size; Chrome's window fills it. */
  readonly screen: { readonly width: number; readonly height: number }
  /** Close a session's browser after this long without a tool call. */
  readonly idleTimeoutMs: number
  /** Default timeout of actions (click, fill, ...). */
  readonly actionTimeoutMs: number
  /** Default timeout of navigations. */
  readonly navigationTimeoutMs: number
  /** How long to wait for a non-interactive bot check (Cloudflare "Just a moment...") to clear. */
  readonly challengeWaitMs: number
  /** Extra Chrome flags, for example --no-sandbox where user namespaces aren't available. */
  readonly extraChromeArgs: readonly string[]
  /** Parent directory of the per-process temporary directory (profiles, X authority). */
  readonly tmpDir: string | undefined
  /** util-linux setpriv, used to kill Xvfb and Chrome if this process dies without cleaning up. Optional. */
  readonly setpriv: string | undefined
  /** xprop, used to give the virtual screen a desktop work area (a panel). Optional. */
  readonly xprop: string | undefined
  /** browse's human-like mouse, keyboard and scrolling. */
  readonly humanInput: boolean
  /** WebGL on the real GPU: auto (when /dev/dri has a usable render node), on, or off (software). */
  readonly gpu: "auto" | "on" | "off"
}

function gpu(): "auto" | "on" | "off" {
  const raw = process.env.AGENT_BROWSER_GPU?.trim().toLowerCase() || "auto"
  if (raw !== "auto" && raw !== "on" && raw !== "off") throw new Error(`AGENT_BROWSER_GPU must be auto, on or off, got ${JSON.stringify(raw)}`)
  return raw
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  return !/^(0|false|off|no)$/i.test(raw)
}

export function loadConfig(): Config {
  return {
    chrome: process.env.AGENT_BROWSER_CHROME?.trim() || "google-chrome-stable",
    xvfb: process.env.AGENT_BROWSER_XVFB?.trim() || "Xvfb",
    screen: screen(),
    idleTimeoutMs: integer("AGENT_BROWSER_IDLE_TIMEOUT_MS", 15 * 60_000, 1_000, 24 * 3_600_000),
    actionTimeoutMs: integer("AGENT_BROWSER_ACTION_TIMEOUT_MS", 15_000, 1_000, 300_000),
    navigationTimeoutMs: integer("AGENT_BROWSER_NAVIGATION_TIMEOUT_MS", 45_000, 1_000, 300_000),
    challengeWaitMs: integer("AGENT_BROWSER_CHALLENGE_WAIT_MS", 15_000, 0, 60_000),
    extraChromeArgs: words("AGENT_BROWSER_CHROME_ARGS"),
    tmpDir: process.env.AGENT_BROWSER_TMPDIR?.trim() || undefined,
    setpriv: process.env.AGENT_BROWSER_SETPRIV?.trim() || undefined,
    xprop: process.env.AGENT_BROWSER_XPROP?.trim() || undefined,
    humanInput: flag("AGENT_BROWSER_HUMAN_INPUT", true),
    gpu: gpu(),
  }
}
