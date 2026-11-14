// agent-browser shim for browse's cli/src/protocol.ts.
export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }
