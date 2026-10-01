/**
 * ACP `$/cancel_request` (stable on protocol version 1).
 * The receiver must answer the original request with a valid cancellation
 * result or JSON-RPC `-32800`. Feature methods such as `session/cancel` stay.
 */

export const REQUEST_CANCELLED = -32800;
export const CANCEL_REQUEST_METHOD = "$/cancel_request";

export function isCancelRequest(method: string | undefined): boolean {
  return method === CANCEL_REQUEST_METHOD || method === "$/cancelRequest";
}

/** `requestId` is the id of the in-flight JSON-RPC request to stop. */
export function readCancelRequestId(params: unknown): string | number | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const raw = (params as { requestId?: unknown }).requestId;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.length > 0 && raw.length <= 200 && !/[\u0000-\u001f]/.test(raw)) {
    return raw;
  }
  return undefined;
}

/** Domain cancellation marker for a request the bridge forwarded to the phone. */
export function cancelledPhoneResult(method: string): unknown {
  if (method === "elicitation/create") return { action: "cancel" };
  return { outcome: { outcome: "cancelled" } };
}

export function cancelRequestFrame(requestId: string | number): {
  jsonrpc: "2.0";
  method: typeof CANCEL_REQUEST_METHOD;
  params: { requestId: string | number };
} {
  return { jsonrpc: "2.0", method: CANCEL_REQUEST_METHOD, params: { requestId } };
}
