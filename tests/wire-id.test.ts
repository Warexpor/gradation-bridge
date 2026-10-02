import { describe, expect, it } from "vitest";
import { mapDeleteByRpcId, mapGetByRpcId } from "../src/acp/cancel.js";
import {
  findOptionById,
  normalizePermissionOptions,
  optionKindById,
} from "../src/acp/permissions.js";
import { assertAgentAuthMethod, readAgentInitialize } from "../src/acp/auth-method.js";
import { wireIdString, wireIdsEqual, wholeNumberDigitString } from "../src/acp/wire-id.js";

describe("wire id coercion", () => {
  it("maps whole-number doubles and digit strings onto the integer form", () => {
    expect(wireIdString(5)).toBe("5");
    expect(wireIdString(5.0)).toBe("5");
    expect(wireIdString("5")).toBe("5");
    expect(wireIdString("5.0")).toBe("5");
    expect(wireIdString(" 5.00 ")).toBe("5");
    expect(wireIdString("fake_login")).toBe("fake_login");
    expect(wireIdString(5.5)).toBeUndefined();
    expect(wireIdString("5.5")).toBe("5.5");
    expect(wholeNumberDigitString("42.0")).toBe("42");
    expect(wireIdsEqual(5, "5.0")).toBe(true);
    expect(wireIdsEqual("fake_login", "fake_login")).toBe(true);
  });
});

describe("RPC id aliases for whole-number double strings", () => {
  it("matches pending 9 when the peer cancels with \"9.0\"", () => {
    const map = new Map<string | number, string>();
    map.set(9, "permission");
    expect(mapGetByRpcId(map, "9.0")).toBe("permission");
    expect(mapDeleteByRpcId(map, "9.0")).toBe(true);
    expect(map.size).toBe(0);
  });

  it("matches pending \"42\" when the peer answers with 42 and \"42.0\"", () => {
    const map = new Map<string | number, string>();
    map.set("42", "auth");
    expect(mapGetByRpcId(map, 42)).toBe("auth");
    map.set("7", "x");
    expect(mapGetByRpcId(map, "7.0")).toBe("x");
  });
});

describe("permission optionId aliases", () => {
  it("normalizes numeric option ids from the agent", () => {
    expect(
      normalizePermissionOptions([
        { optionId: 5, kind: "allow_once", name: "Once" },
        { optionId: "5.0", kind: "reject_once" },
        { optionId: "keep-me", kind: "allow_always" },
        { optionId: 1.5, kind: "allow_once" },
      ]),
    ).toEqual([
      { optionId: "5", kind: "allow_once", name: "Once" },
      { optionId: "5", kind: "reject_once" },
      { optionId: "keep-me", kind: "allow_always" },
    ]);
  });

  it("matches a phone optionId sent as a JSON number or \"5.0\"", () => {
    const options = [
      { optionId: "5", kind: "allow_once", name: "Once" },
      { optionId: "no", kind: "reject_once", name: "No" },
    ];
    expect(optionKindById(options, 5)).toBe("allow_once");
    expect(optionKindById(options, "5.0")).toBe("allow_once");
    expect(findOptionById(options, 5)?.optionId).toBe("5");
  });
});

describe("auth method id aliases", () => {
  it("accepts whole-number method ids from harness initialize", () => {
    const info = readAgentInitialize({
      authMethods: [
        { id: 5, name: "Digit login" },
        { id: "5.0", name: "Duplicate spelling" },
        { id: "agent", name: "Named" },
      ],
    });
    expect(info.authMethods).toEqual([
      { id: "5", name: "Digit login", type: "agent" },
      { id: "agent", name: "Named", type: "agent" },
    ]);
    expect(() => assertAgentAuthMethod(info.authMethods, "5.0")).not.toThrow();
    expect(() => assertAgentAuthMethod(info.authMethods, "5")).not.toThrow();
  });
});
