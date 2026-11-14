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

// Patchright forces these defaults on every page, hiding the browser's real settings. Same logic as browse's
// removeDefaultLightColorSchemeEmulation.
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

export const humanInputMethods: ReadonlySet<string> = new Set(["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "DOM.scrollIntoViewIfNeeded"])

export type SessionInfo = {
  readonly sessionId: string
  readonly targetId: string
  readonly type: string
  readonly pageTargetId: string | undefined
  readonly parentSessionId: string | undefined
  readonly attachParams: Record<string, unknown>
}

export class TargetTracker {
  private readonly sessions = new Map<string, SessionInfo>()
  private readonly pageNumbers = new Map<string, number>()
  private nextPageNumber = 1

  /** Returns the numbers of pages whose last session went away. */
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

  iframeChildren(sessionId: string): SessionInfo[] {
    return [...this.sessions.values()].filter((info) => info.type === "iframe" && info.parentSessionId === sessionId)
  }

  isRoot(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.sessions.get(sessionId)?.type === "page"
  }

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
