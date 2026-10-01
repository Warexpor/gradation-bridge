import { describe, expect, it } from "vitest";
import {
  commandArgvFromToolCall,
  optionKindById,
  pathFromToolCall,
  pickOptionId,
  policyKindFromToolCall,
} from "../src/acp/permissions.js";

describe("permissions helpers", () => {
  it("maps delete/move to write for policy", () => {
    expect(policyKindFromToolCall({ kind: "delete" })).toBe("write");
    expect(policyKindFromToolCall({ kind: "move" })).toBe("write");
    expect(policyKindFromToolCall({ kind: "edit" })).toBe("edit");
    expect(policyKindFromToolCall({ kind: "execute" })).toBe("execute");
  });

  it("extracts a command argv without inventing one", () => {
    expect(commandArgvFromToolCall({ rawInput: { command: "npm", args: ["test"] } })).toEqual([
      "npm",
      "test",
    ]);
    expect(commandArgvFromToolCall({ rawInput: { command: "npm test" } })).toEqual(["npm test"]);
    expect(commandArgvFromToolCall({ rawInput: { command: ["npm", "test"] } })).toEqual(["npm", "test"]);
    expect(commandArgvFromToolCall({ rawInput: { command: "npm", args: "test" } })).toBeUndefined();
    expect(commandArgvFromToolCall({ title: "Run command" })).toBeUndefined();
  });

  it("extracts path from locations or rawInput", () => {
    expect(pathFromToolCall({ locations: [{ path: "/tmp/a" }] })).toBe("/tmp/a");
    expect(pathFromToolCall({ rawInput: { filePath: "/tmp/b" } })).toBe("/tmp/b");
    expect(pathFromToolCall({})).toBeUndefined();
  });

  it("picks allow/reject option ids by kind preference", () => {
    const options = [
      { optionId: "a", kind: "allow_always", name: "Always" },
      { optionId: "b", kind: "allow_once", name: "Once" },
      { optionId: "c", kind: "reject_once", name: "No" },
    ];
    expect(pickOptionId(options, "allow")).toBe("b");
    expect(pickOptionId(options, "reject")).toBe("c");
    expect(optionKindById(options, "a")).toBe("allow_always");
  });

  it("does not select an allow option when the policy is rejecting", () => {
    const allowOnly = [
      { optionId: "a", kind: "allow_once" },
      { optionId: "b", kind: "allow_always" },
    ];
    expect(pickOptionId(allowOnly, "reject")).toBeUndefined();
    expect(pickOptionId(allowOnly, "allow")).toBe("a");
  });
});
