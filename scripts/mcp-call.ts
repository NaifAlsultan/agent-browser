// Drives the MCP server from the command line, for trying tools by hand. Run in the dev shell:
//   node scripts/mcp-call.ts '[["open", {"url": "example.com"}], ["snapshot", {}]]'
// Each step is [tool, arguments] or [tool, arguments, sessionID]. Images are summarized, not printed.
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const steps = JSON.parse(process.argv[2] ?? "[]") as [string, Record<string, unknown>, string?][]
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(import.meta.dirname, "..", "src", "main.ts")], env, stderr: "inherit" })
const client = new Client({ name: "mcp-call", version: "0" })
await client.connect(transport)
for (const [name, args, session] of steps) {
  const started = Date.now()
  const result = (await client.callTool({ name, arguments: args, _meta: { "ai.opencode/sessionID": session ?? "ses_cli" } })) as {
    content: { type: string; text?: string; data?: string; mimeType?: string }[]
    isError?: boolean
  }
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - started} ms)${result.isError ? " ERROR" : ""}`)
  for (const part of result.content) console.log(part.type === "text" ? part.text : `[${part.type} ${part.mimeType} ${Math.round(((part.data?.length ?? 0) * 3) / 4 / 1024)} KiB]`)
}
await client.close()
