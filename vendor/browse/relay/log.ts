// agent-browser shim: stands in for browse's cli/src/relay/log.ts. Its relayLog writes to a log file in browse's
// state directory; here it goes to agent-browser's logger (stderr, debug level).
import { debug } from "../../../src/log.ts"

export function relayLog(event: string, fields: Record<string, unknown> = {}): void {
  debug(event, fields)
}
