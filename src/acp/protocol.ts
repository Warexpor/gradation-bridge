/**
 * ACP protocol version this process speaks.
 *
 * The version integer only changes for breaking revisions. Every stable ACP v1
 * schema (including elicitation and terminal auth) still uses `1`. ACP v2 is a
 * draft that removes `session/load`, client `fs/*`, and client `terminal/*`,
 * which this bridge implements, so it is not negotiated.
 */
export const ACP_PROTOCOL_VERSION = 1;

export function negotiateProtocolVersion(requested: unknown): {
  version: number;
  /** The peer asked for a version other than the one we speak. */
  downgraded: boolean;
} {
  if (requested == null) return { version: ACP_PROTOCOL_VERSION, downgraded: false };
  if (sameProtocolVersion(requested)) {
    return { version: ACP_PROTOCOL_VERSION, downgraded: false };
  }
  return { version: ACP_PROTOCOL_VERSION, downgraded: true };
}

/** Accept number `1` / `1.0` and string `"1"` / `"1.0"` as a match for ACP 1. */
export function sameProtocolVersion(requested: unknown): boolean {
  if (requested === ACP_PROTOCOL_VERSION) return true;
  if (typeof requested === "number") {
    return Number.isFinite(requested) && requested === ACP_PROTOCOL_VERSION;
  }
  if (typeof requested === "string") {
    const trimmed = requested.trim();
    if (trimmed === String(ACP_PROTOCOL_VERSION)) return true;
    if (trimmed === `${ACP_PROTOCOL_VERSION}.0`) return true;
    const asNum = Number(trimmed);
    return Number.isFinite(asNum) && asNum === ACP_PROTOCOL_VERSION;
  }
  return false;
}
