// Follows browse's detectChallenge (cli/src/execute/code-runner.ts, MIT).
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
  // Patchright's evaluate runs in an isolated world, which the page can't see.
  const probed = await withTimeout(page.evaluate(probePageScript, [...probeSelectors]), probeTimeoutMs)
  if (!probed) return undefined
  return { ...probed, url: page.url(), frameUrls: page.frames().map((frame) => frame.url()).slice(0, 50) }
}

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
    // Checks often clear by navigating, which makes a probe fail: keep waiting.
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

export function challengeNote(outcome: ChallengeOutcome | undefined): string | undefined {
  if (!outcome) return undefined
  if (outcome.status === "cleared") return `Passed a ${outcome.vendor} bot check after ${Math.round(outcome.waitedMs / 1000)} s.`
  const warning = challengeWarning(outcome)
  return warning ? `WARNING: ${warning}` : undefined
}
