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

/**
 * Look up a pending JSON-RPC id when the peer used a string form of a number
 * (or the reverse). Phone and harness stacks do not always agree on the type.
 */
export function mapGetByRpcId<T>(
  map: Map<string | number, T>,
  id: string | number,
): T | undefined {
  if (map.has(id)) return map.get(id);
  for (const alt of rpcIdAliases(id)) {
    if (map.has(alt)) return map.get(alt);
  }
  return undefined;
}

/** Delete by the stored key when the peer used a string/number alias. */
export function mapDeleteByRpcId<T>(map: Map<string | number, T>, id: string | number): boolean {
  if (map.delete(id)) return true;
  for (const alt of rpcIdAliases(id)) {
    if (map.delete(alt)) return true;
  }
  return false;
}

function rpcIdAliases(id: string | number): Array<string | number> {
  if (typeof id === "number") {
    if (!Number.isInteger(id) || !Number.isSafeInteger(id)) return [];
    return [String(id)];
  }
  if (!/^-?\d+$/.test(id)) return [];
  const asNum = Number(id);
  if (!Number.isSafeInteger(asNum)) return [];
  return [asNum];
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
