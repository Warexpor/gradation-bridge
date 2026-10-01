import { describe, expect, it } from "vitest";
import { ACP_PROTOCOL_VERSION, negotiateProtocolVersion } from "../src/acp/protocol.js";

describe("ACP protocol negotiation", () => {
  it("answers version 1 for a missing or matching request", () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1);
    expect(negotiateProtocolVersion(undefined)).toEqual({ version: 1, downgraded: false });
    expect(negotiateProtocolVersion(1)).toEqual({ version: 1, downgraded: false });
  });

  it("keeps version 1 when a peer asks for ACP v2 or a non-integer", () => {
    expect(negotiateProtocolVersion(2)).toEqual({ version: 1, downgraded: true });
    expect(negotiateProtocolVersion("1")).toEqual({ version: 1, downgraded: true });
    expect(negotiateProtocolVersion(1.5)).toEqual({ version: 1, downgraded: true });
  });
});
