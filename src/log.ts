// stderr: stdout carries the MCP protocol.

const debugEnabled = /^(1|true|on|yes)$/i.test(process.env.AGENT_BROWSER_DEBUG?.trim() ?? "")

function format(event: string, fields: Record<string, unknown>): string {
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === "string" && !/\s/.test(value) ? value : JSON.stringify(value)}`)
    .join(" ")
  return `agent-browser ${new Date().toISOString()} ${event}${detail ? ` ${detail}` : ""}\n`
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(format(event, fields))
}

export function debug(event: string, fields: Record<string, unknown> = {}): void {
  if (debugEnabled) process.stderr.write(format(event, fields))
}
