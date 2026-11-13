// agent-browser shim: stands in for browse's cli/src/protocol.ts, of which the vendored files only use JsonObject.
export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }
