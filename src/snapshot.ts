// The page outline agents read: Playwright's AI-mode ARIA snapshot (element refs like [ref=e5], iframes included,
// refs from iframes look like f1e3), with the values of secret fields hidden.
import type { Locator, Page } from "./patchright.ts"

export const redacted = "[hidden]"

/** Roles whose snapshot line can end in the field's value. */
const valueRoles = /^(\s*- )(textbox|searchbox|combobox|spinbutton)\b/

type ValueLine = { index: number; ref: string; blockEnd: number }

/** Lines showing a form field's value, with the ref of the field. Exported for tests. */
export function valueLines(lines: readonly string[]): ValueLine[] {
  const found: ValueLine[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (!valueRoles.test(line)) continue
    const match = /\[ref=([A-Za-z0-9]+)\][^:]*: (.*)$/.exec(line)
    if (!match) continue
    let blockEnd = index
    // A multi-line value is a YAML block scalar: `: |` followed by more-indented lines.
    if (/^[|>][-+]?$/.test(match[2]!.trim())) {
      const indent = line.length - line.trimStart().length
      while (blockEnd + 1 < lines.length) {
        const next = lines[blockEnd + 1]!
        if (next.trim() !== "" && next.length - next.trimStart().length <= indent) break
        blockEnd++
      }
    }
    found.push({ index, ref: match[1]!, blockEnd })
  }
  return found
}

/** Replaces the values on the given lines. Exported for tests. */
export function redactLines(lines: readonly string[], secret: readonly ValueLine[]): string[] {
  const out = [...lines]
  const drop = new Set<number>()
  for (const field of secret) {
    out[field.index] = out[field.index]!.replace(/(\[ref=[A-Za-z0-9]+\][^:]*: ).*$/, `$1${redacted}`)
    for (let line = field.index + 1; line <= field.blockEnd; line++) drop.add(line)
  }
  return out.filter((_, index) => !drop.has(index))
}

/**
 * Whether a field holds a secret: passwords, one-time codes and payment card details. Runs in the page (in
 * Patchright's isolated world), so it must stay self-contained.
 */
export const isSecretField = (element: Element): boolean => {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false
  if (element instanceof HTMLInputElement && element.type === "password") return true
  const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase()
  if (/\b(one-time-code|current-password|new-password|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)\b/.test(autocomplete)) return true
  const labels = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? Array.from(element.labels ?? [], (label) => label.textContent ?? "") : []
  const hints = [element.name, element.id, element.getAttribute("aria-label"), element.getAttribute("placeholder"), element.getAttribute("data-testid"), ...labels].join(" ")
  return /(pass(word|wd|code)|\botp\b|one[\s_-]?time|verification[\s_-]?code|\b(2fa|mfa|totp)\b|\b(cvv|cvc|csc|cvn)\d?\b|security[\s_-]?code|card[\s_-]?(number|num|no)\b|\bcc[\s_-]?(num|number)\b|cardnumber|ccnumber|expiry|expiration)/i.test(hints)
}

export type SnapshotOptions = {
  /** Only this element's subtree. */
  readonly ref?: string
  /** Cut the outline after this many characters. */
  readonly maxChars?: number
}

export const defaultMaxChars = 40_000

/** Resolves an element ref from the latest snapshot. */
export function locateRef(page: Page, ref: string): Locator {
  if (!/^(f\d+)?e\d+$/.test(ref)) throw new Error(`"${ref}" isn't an element ref. Refs look like e12 or f1e3 and come from the latest snapshot.`)
  return page.getByRef(ref)
}

export async function takeSnapshot(page: Page, options: SnapshotOptions = {}): Promise<{ text: string; truncated: boolean }> {
  const raw = options.ref ? await locateRef(page, options.ref).ariaSnapshot({ mode: "ai", timeout: 10_000 }) : await page.ariaSnapshot({ mode: "ai", timeout: 15_000 })
  const lines = raw.split("\n")
  const candidates = valueLines(lines)
  // Fail closed: a field that can't be checked counts as secret.
  const secret = (await Promise.all(candidates.map(async (field) => {
    const isSecret = await page.getByRef(field.ref).evaluate(isSecretField, undefined, { timeout: 2_000 }).catch(() => true)
    return isSecret ? field : undefined
  }))).filter((field): field is ValueLine => field !== undefined)
  let text = redactLines(lines, secret).join("\n")
  const maxChars = options.maxChars ?? defaultMaxChars
  const truncated = text.length > maxChars
  if (truncated) text = `${text.slice(0, text.lastIndexOf("\n", maxChars))}\n- ... (outline cut at ${maxChars} characters: snapshot one section with snapshot({ ref }), or raise maxChars)`
  return { text, truncated }
}
