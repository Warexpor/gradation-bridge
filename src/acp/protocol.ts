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
  if (requested === ACP_PROTOCOL_VERSION) return { version: ACP_PROTOCOL_VERSION, downgraded: false };
  return { version: ACP_PROTOCOL_VERSION, downgraded: true };
}
