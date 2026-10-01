import { describe, expect, it } from "vitest";
import { assertAgentAuthMethod, readAgentInitialize } from "../src/acp/auth-method.js";
import { BridgeError } from "../src/errors.js";

describe("auth method parsing", () => {
  it("drops terminal env and unknown method types", () => {
    const info = readAgentInitialize({
      agentInfo: { name: "demo", version: "1" },
      agentCapabilities: { auth: { logout: {} } },
      authMethods: [
        { id: "agent", name: "Agent login" },
        {
          id: "term",
          name: "Terminal",
          type: "terminal",
          args: ["--login"],
          env: { LEAK_TOKEN: "super-secret-token" },
        },
        { id: "future", name: "Future", type: "magic" },
        { name: "missing id" },
      ],
    });
    expect(info.logoutSupported).toBe(true);
    expect(info.agentInfo).toEqual({ name: "demo", version: "1" });
    expect(info.authMethods).toEqual([
      { id: "agent", name: "Agent login", type: "agent" },
      { id: "term", name: "Terminal", type: "terminal", args: ["--login"] },
    ]);
    expect(JSON.stringify(info)).not.toContain("super-secret-token");
    expect(JSON.stringify(info)).not.toContain("LEAK_TOKEN");
  });

  it("refuses terminal methods and unknown ids", () => {
    const methods = readAgentInitialize({
      authMethods: [
        { id: "agent", name: "Agent" },
        { id: "term", name: "Terminal", type: "terminal", env: { TOKEN: "x" } },
      ],
    }).authMethods;
    expect(() => assertAgentAuthMethod(methods, "missing")).toThrow(BridgeError);
    expect(() => assertAgentAuthMethod(methods, "term")).toThrow(/terminal/);
    const err = (() => {
      try {
        assertAgentAuthMethod(methods, "term");
      } catch (e) {
        return e as BridgeError;
      }
      throw new Error("expected throw");
    })();
    expect(err.code).toBe(-32602);
    expect(JSON.stringify(err.data)).not.toContain("TOKEN");
    expect(() => assertAgentAuthMethod(methods, "agent")).not.toThrow();
  });

  it("redacts secret terminal args and keeps the first duplicate id", () => {
    const info = readAgentInitialize({
      authMethods: [
        { id: "agent", name: "Agent" },
        { id: "agent", name: "Duplicate", type: "terminal", args: ["--login"] },
        {
          id: "term",
          name: "Terminal",
          type: "terminal",
          args: ["--token", "sekret-value", "--login"],
        },
        { id: "bad\nid", name: "Broken" },
      ],
    });
    expect(info.authMethods).toEqual([
      { id: "agent", name: "Agent", type: "agent" },
      { id: "term", name: "Terminal", type: "terminal", args: ["--token", "[redacted]", "--login"] },
    ]);
    expect(JSON.stringify(info)).not.toContain("sekret-value");
  });
});
