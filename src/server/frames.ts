/**
 * JSON-RPC 2.0 frame parsing for phone WebSocket messages.
 * Never throws: bad input becomes a JSON-RPC error object.
 */

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export type ParseRpcResult =
  | { ok: true; msg: JsonRpcMessage }
  | { ok: false; code: number; message: string; id: number | string | null };

function rpcId(id: unknown): number | string | null {
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

export const DEFAULT_MAX_FRAME_CHARS = 8 * 1024 * 1024;

export function parseRpcFrame(
  text: string,
  maxChars: number = DEFAULT_MAX_FRAME_CHARS,
): ParseRpcResult {
  if (text.length > maxChars) {
    return { ok: false, code: -32600, message: "Frame too large", id: null };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: -32700, message: "Parse error", id: null };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: -32600, message: "Invalid Request", id: null };
  }
  const msg = value as JsonRpcMessage;
  if (msg.jsonrpc !== undefined && msg.jsonrpc !== "2.0") {
    return { ok: false, code: -32600, message: "Invalid Request", id: rpcId(msg.id) };
  }
  if (msg.id != null && typeof msg.id !== "string" && typeof msg.id !== "number") {
    return { ok: false, code: -32600, message: "Invalid Request", id: null };
  }
  return { ok: true, msg };
}
