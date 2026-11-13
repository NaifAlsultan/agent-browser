// Bot-challenge detection after navigations and actions, on top of browse's challenge-detection.ts.
//
// The waiting loop follows browse's detectChallenge (cli/src/execute/code-runner.ts, MIT): probe the page in
// Patchright's isolated world (the page's scripts can't see it), classify it, and wait out a non-interactive check
// (Cloudflare's "Just a moment...") for a bounded time. Interactive challenges and block pages are reported, never
// touched: this browser doesn't solve CAPTCHAs.
import {
  challengeWarning,
  classifyChallenge,
  probePageScript,
  probeSelectors,
  type ChallengeOutcome,
  type ChallengeProbe,
} from "../vendor/browse/execute/challenge-detection.ts"
import type { Page } from "./patchright.ts"

const probeTimeoutMs = 2_000
const pollMs = 1_000

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: Parameters<typeof clearTimeout>[0]
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => (timer = setTimeout(resolve, ms)))])
  } finally {
    clearTimeout(timer)
  }
}

async function probe(page: Page): Promise<ChallengeProbe | undefined> {
  if (page.isClosed()) return undefined
  if (!/^https?:/i.test(page.url())) return undefined
  // Patchright's evaluate runs in an isolated world by default.
  const probed = await withTimeout(page.evaluate(probePageScript, [...probeSelectors]), probeTimeoutMs)
  if (!probed) return undefined
  return { ...probed, url: page.url(), frameUrls: page.frames().map((frame) => frame.url()).slice(0, 50) }
}

/** Classifies the page; waits up to `waitMs` for a non-interactive check to clear. Undefined: no challenge. */
export async function detectChallenge(page: Page, waitMs: number): Promise<ChallengeOutcome | undefined> {
  const first = await probe(page).catch(() => undefined)
  const detected = first && classifyChallenge(first)
  if (!first || !detected) return undefined
  const started = Date.now()
  let current = detected
  let url = first.url
  while (current.kind === "non-interactive" && Date.now() - started < waitMs) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, waitMs - (Date.now() - started)))))
    if (page.isClosed()) return undefined
    // A probe that fails mid-navigation (the check often clears by navigating) counts as still waiting.
    const next = await probe(page).catch(() => null)
    if (next === null) continue
    if (next === undefined) return { ...current, status: "cleared", url, waitedMs: Date.now() - started, recommendation: "continue" }
    const classified = classifyChallenge(next)
    url = next.url
    if (!classified) return { ...current, status: "cleared", url, waitedMs: Date.now() - started, recommendation: "continue" }
    current = classified
  }
  const waitedMs = current === detected && detected.kind !== "non-interactive" ? 0 : Date.now() - started
  return { ...current, status: "blocked", url, waitedMs, recommendation: current.kind === "block" ? "stop" : "handoff" }
}

/** A line for the tool result, or undefined when there's nothing to say. */
export function challengeNote(outcome: ChallengeOutcome | undefined): string | undefined {
  if (!outcome) return undefined
  if (outcome.status === "cleared") return `Passed a ${outcome.vendor} bot check after ${Math.round(outcome.waitedMs / 1000)} s.`
  const warning = challengeWarning(outcome)
  return warning ? `WARNING: ${warning}` : undefined
}
