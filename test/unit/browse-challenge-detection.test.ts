// Ported from browse's cli/test/challenge-detection.test.ts (MIT, see vendor/browse) at 53eb63dd: bun:test became
// node:test, and the handoff() expectation follows agent-browser's change to challengeWarning.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { challengeWarning, classifyChallenge, type ChallengeDetection, type ChallengeProbe } from "../../vendor/browse/execute/challenge-detection.ts"

function probe(overrides: Partial<ChallengeProbe>): ChallengeProbe {
  const text = overrides.text ?? ""
  return {
    url: "https://shop.example/",
    title: "",
    text,
    textLength: overrides.textLength ?? text.length,
    frameUrls: [],
    scriptSrcs: [],
    selectors: [],
    visibleSelectors: [],
    ...overrides,
  }
}

/** bun's toMatchObject for the two fields the tests check. */
function matches(actual: ChallengeDetection | undefined, expected: Pick<ChallengeDetection, "vendor" | "kind">) {
  assert.ok(actual, `expected ${JSON.stringify(expected)}, got undefined`)
  assert.deepEqual({ vendor: actual.vendor, kind: actual.kind }, expected)
}

describe("classifyChallenge", () => {
  test("Cloudflare's managed challenge clears by itself until Turnstile shows a checkbox", () => {
    const waiting = probe({ title: "Just a moment...", text: "Checking if the site connection is secure", selectors: ["#challenge-running"] })
    matches(classifyChallenge(waiting), { vendor: "cloudflare", kind: "non-interactive" })
    const widget = probe({
      title: "Just a moment...",
      text: "Verify you are human by completing the action below.",
      frameUrls: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc"],
      selectors: [".cf-turnstile"],
      visibleSelectors: [".cf-turnstile"],
    })
    matches(classifyChallenge(widget), { vendor: "cloudflare", kind: "interactive" })
  })

  test("Cloudflare and Akamai blocks", () => {
    matches(classifyChallenge(probe({ title: "Attention Required! | Cloudflare", text: "Sorry, you have been blocked. Cloudflare Ray ID: 1", selectors: ["#cf-error-details"] })), { vendor: "cloudflare", kind: "block" })
    matches(
      classifyChallenge(probe({ title: "Access Denied", text: "Access Denied\nYou don't have permission to access \"http://shop.example/\" on this server.\nReference #18.abc.1700000000.1" })),
      { vendor: "akamai", kind: "block" },
    )
  })

  test("vendor captchas are interactive", () => {
    matches(classifyChallenge(probe({ selectors: ["#px-captcha"], text: "Press & Hold to confirm you are a human (and not a bot)." })), { vendor: "perimeterx", kind: "interactive" })
    matches(classifyChallenge(probe({ frameUrls: ["https://geo.captcha-delivery.com/captcha/?initialCid=x"] })), { vendor: "datadome", kind: "interactive" })
    matches(classifyChallenge(probe({ frameUrls: ["https://geo.captcha-delivery.com/interstitial/?initialCid=x"] })), { vendor: "datadome", kind: "non-interactive" })
    matches(classifyChallenge(probe({ selectors: ["awswaf-captcha"] })), { vendor: "aws-waf", kind: "interactive" })
    matches(
      classifyChallenge(probe({ text: "Please verify you are a human", frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox"] })),
      { vendor: "hcaptcha", kind: "interactive" },
    )
    matches(
      classifyChallenge(probe({ text: "Our systems have detected unusual traffic", frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=x"] })),
      { vendor: "recaptcha", kind: "interactive" },
    )
  })

  test("Akamai and Imperva interstitials", () => {
    matches(classifyChallenge(probe({ selectors: ["#sec-if-cpt-container"], text: "Please wait while we verify" })), { vendor: "akamai", kind: "non-interactive" })
    matches(classifyChallenge(probe({ frameUrls: ["https://shop.example/_Incapsula_Resource?SWUDNSAI=1"], text: "" })), { vendor: "imperva", kind: "non-interactive" })
    matches(
      classifyChallenge(probe({ scriptSrcs: ["https://shop.example/_Incapsula_Resource?x"], text: "Request unsuccessful. Incapsula incident ID: 1-2" })),
      { vendor: "imperva", kind: "block" },
    )
  })

  test("generic phrases count only on short pages", () => {
    matches(classifyChallenge(probe({ title: "Access Denied", text: "Access denied" })), { vendor: "generic", kind: "block" })
    matches(classifyChallenge(probe({ title: "Security", text: "Please verify you are a human to continue." })), { vendor: "generic", kind: "interactive" })
    const article = `How bot detection works: sites ask you to verify you are human. ${"Long article text. ".repeat(200)}`
    assert.equal(classifyChallenge(probe({ title: "Bot detection explained", text: article.slice(0, 3000), textLength: article.length })), undefined)
    // A login form with an embedded reCAPTCHA is not a wall.
    assert.equal(classifyChallenge(probe({ title: "Sign in", text: "Email\nPassword\nSign in", frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=x"] })), undefined)
    assert.equal(classifyChallenge(probe({ title: "Example Domain", text: "This domain is for use in documentation examples." })), undefined)
  })
})

describe("challengeWarning", () => {
  test("tells the agent to stop for interactive challenges and blocks", () => {
    const base = { vendor: "cloudflare" as const, signal: "title: Just a moment...", url: "https://shop.example/a?b", waitedMs: 15_000 }
    const interactive = challengeWarning({ ...base, kind: "interactive", status: "blocked", recommendation: "handoff" })
    assert.match(interactive ?? "", /Don't retry, reload or try to solve it/)
    assert.match(interactive ?? "", /https:\/\/shop\.example\b/)
    assert.doesNotMatch(interactive ?? "", /handoff\(/)
    assert.match(challengeWarning({ ...base, kind: "block", status: "blocked", recommendation: "stop" }) ?? "", /Don't retry/)
    assert.equal(challengeWarning({ ...base, kind: "non-interactive", status: "cleared", recommendation: "continue" }), undefined)
  })
})
