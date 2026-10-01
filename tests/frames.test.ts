import { describe, expect, it } from "vitest";
import { parseRpcFrame } from "../src/server/frames.js";

describe("parseRpcFrame", () => {
  it("accepts a JSON-RPC request", () => {
    const parsed = parseRpcFrame(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.msg.method).toBe("initialize");
  });

  it("rejects non-objects, bad versions, and oversized frames", () => {
    expect(parseRpcFrame("")).toMatchObject({ ok: false, code: -32700 });
    expect(parseRpcFrame("null")).toMatchObject({ ok: false, code: -32600, id: null });
    expect(parseRpcFrame("[]")).toMatchObject({ ok: false, code: -32600 });
    expect(parseRpcFrame("42")).toMatchObject({ ok: false, code: -32600 });
    expect(parseRpcFrame(JSON.stringify({ jsonrpc: "1.0", id: "x", method: "ping" }))).toMatchObject({
      ok: false,
      code: -32600,
      id: "x",
    });
    expect(parseRpcFrame(JSON.stringify({ id: { bad: true }, method: "ping" }))).toMatchObject({
      ok: false,
      code: -32600,
      id: null,
    });
    expect(parseRpcFrame("{}", 1)).toMatchObject({ ok: false, code: -32600, message: "Frame too large" });
  });
});
