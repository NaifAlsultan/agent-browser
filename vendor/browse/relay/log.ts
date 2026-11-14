// agent-browser shim for browse's cli/src/relay/log.ts.
import { debug } from "../../../src/log.ts"

export function relayLog(event: string, fields: Record<string, unknown> = {}): void {
  debug(event, fields)
}
