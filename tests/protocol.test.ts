import { describe, expect, it } from "vitest";
import {
  ACP_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  sameProtocolVersion,
} from "../src/acp/protocol.js";
import { mapDeleteByRpcId, mapGetByRpcId } from "../src/acp/cancel.js";

describe("ACP protocol negotiation", () => {
  it("answers version 1 for a missing or matching request", () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1);
    expect(negotiateProtocolVersion(undefined)).toEqual({ version: 1, downgraded: false });
    expect(negotiateProtocolVersion(1)).toEqual({ version: 1, downgraded: false });
    expect(negotiateProtocolVersion(1.0)).toEqual({ version: 1, downgraded: false });
    expect(negotiateProtocolVersion("1")).toEqual({ version: 1, downgraded: false });
    expect(negotiateProtocolVersion("1.0")).toEqual({ version: 1, downgraded: false });
    expect(sameProtocolVersion(" 1 ")).toBe(true);
  });

  it("keeps version 1 when a peer asks for ACP v2 or a non-matching value", () => {
    expect(negotiateProtocolVersion(2)).toEqual({ version: 1, downgraded: true });
    expect(negotiateProtocolVersion("2")).toEqual({ version: 1, downgraded: true });
    expect(negotiateProtocolVersion(1.5)).toEqual({ version: 1, downgraded: true });
    expect(negotiateProtocolVersion("nope")).toEqual({ version: 1, downgraded: true });
  });
});

describe("RPC id aliases", () => {
  it("finds a pending entry when the peer used a string form of the number", () => {
    const map = new Map<string | number, string>();
    map.set(9, "permission");
    expect(mapGetByRpcId(map, "9")).toBe("permission");
    expect(mapDeleteByRpcId(map, "9")).toBe(true);
    expect(map.size).toBe(0);
  });

  it("finds a pending entry when the peer used a number form of the string", () => {
    const map = new Map<string | number, string>();
    map.set("42", "auth");
    expect(mapGetByRpcId(map, 42)).toBe("auth");
    expect(mapDeleteByRpcId(map, 42)).toBe(true);
    expect(map.size).toBe(0);
  });
});
