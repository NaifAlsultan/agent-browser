// The pure parts of the CDP proxy: rewriting Patchright's commands, and tracking which DevTools session belongs to
// which target. Kept free of I/O so they're easy to test.

export type CdpCommand = {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

export type CdpMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: unknown
  error?: { code?: number; message?: string }
}

// Patchright sends Emulation.setEmulatedMedia with its own defaults for these features on every page (light,
// no-preference, none, no-preference). That hides the browser's real settings and makes matchMedia disagree with
// the rest of the browser. Same logic as browse's removeDefaultLightColorSchemeEmulation (cli/src/cdp/shims.ts):
// values other than the defaults can only come from an explicit request, and a request marked with the
// `__bc_explicit__` feature keeps everything.
const patchrightDefaultMediaFeatures: ReadonlyMap<string, string> = new Map([
  ["prefers-color-scheme", "light"],
  ["prefers-reduced-motion", "no-preference"],
  ["forced-colors", "none"],
  ["prefers-contrast", "no-preference"],
])

const explicitMarker = "__bc_explicit__"

type MediaFeature = { name?: unknown; value?: unknown }

const asFeature = (value: unknown): MediaFeature | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as MediaFeature) : undefined

/** Drops Patchright's default media feature overrides unless explicitly requested. Returns the same object when unchanged. */
export function removeDefaultMediaEmulation<T extends CdpCommand>(message: T): T {
  if (message.method !== "Emulation.setEmulatedMedia") return message
  const features = Array.isArray(message.params?.features) ? (message.params.features as unknown[]) : []
  const isExplicit = features.some((feature) => asFeature(feature)?.name === explicitMarker)
  const kept = features.filter((feature) => {
    const object = asFeature(feature)
    if (object?.name === explicitMarker) return false
    if (isExplicit) return true
    const name = typeof object?.name === "string" ? object.name : undefined
    return name === undefined || patchrightDefaultMediaFeatures.get(name) !== object?.value
  })
  if (kept.length === features.length) return message
  return { ...message, params: { ...message.params, features: kept } }
}

/** Commands browse's human-like input paces. */
export const humanInputMethods: ReadonlySet<string> = new Set(["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "DOM.scrollIntoViewIfNeeded"])

export type SessionInfo = {
  readonly sessionId: string
  readonly targetId: string
  readonly type: string
  /** The page (tab) this session's target belongs to; its own target id for a page. */
  readonly pageTargetId: string | undefined
  /** The session the attach was announced on (for an iframe, its parent frame's session). */
  readonly parentSessionId: string | undefined
  /** Target.attachedToTarget's params, to announce the target again. */
  readonly attachParams: Record<string, unknown>
}

/**
 * Follows Target.attachedToTarget / detachedFromTarget so the proxy knows, for each flattened DevTools session,
 * whether it's a tab's top-level page (whose coordinates are the page's) and which tab it belongs to.
 */
export class TargetTracker {
  private readonly sessions = new Map<string, SessionInfo>()
  private readonly pageNumbers = new Map<string, number>()
  private nextPageNumber = 1

  /** Call for every message from Chrome. Returns the numbers of pages whose last session went away. */
  observe(message: CdpMessage): number[] {
    if (message.method === "Target.attachedToTarget") {
      const params = message.params as { sessionId?: string; targetInfo?: { targetId?: string; type?: string } } | undefined
      const sessionId = params?.sessionId
      const targetId = params?.targetInfo?.targetId
      const type = params?.targetInfo?.type ?? "other"
      if (!sessionId || !targetId) return []
      const parent = message.sessionId ? this.sessions.get(message.sessionId) : undefined
      const pageTargetId = type === "page" ? targetId : parent?.pageTargetId
      this.sessions.set(sessionId, { sessionId, targetId, type, pageTargetId, parentSessionId: message.sessionId, attachParams: { ...params } })
      return []
    }
    if (message.method === "Target.detachedFromTarget") {
      const sessionId = (message.params as { sessionId?: string } | undefined)?.sessionId
      const info = sessionId ? this.sessions.get(sessionId) : undefined
      if (!sessionId || !info) return []
      this.sessions.delete(sessionId)
      if (info.type === "page" && ![...this.sessions.values()].some((other) => other.type === "page" && other.targetId === info.targetId)) {
        const number = this.pageNumbers.get(info.targetId)
        this.pageNumbers.delete(info.targetId)
        if (number !== undefined) return [number]
      }
    }
    return []
  }

  /** Out-of-process iframes announced on this session (direct children only). */
  iframeChildren(sessionId: string): SessionInfo[] {
    return [...this.sessions.values()].filter((info) => info.type === "iframe" && info.parentSessionId === sessionId)
  }

  /** Whether commands on this session address a tab's top-level page. */
  isRoot(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.sessions.get(sessionId)?.type === "page"
  }

  /** A stable number for the tab a session belongs to (human-input keeps its pointer state per number). */
  pageNumber(sessionId: string | undefined): number | undefined {
    const pageTargetId = sessionId ? this.sessions.get(sessionId)?.pageTargetId : undefined
    if (!pageTargetId) return undefined
    let number = this.pageNumbers.get(pageTargetId)
    if (number === undefined) {
      number = this.nextPageNumber++
      this.pageNumbers.set(pageTargetId, number)
    }
    return number
  }
}
