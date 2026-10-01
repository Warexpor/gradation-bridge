import { afterEach, describe, expect, it } from "vitest";
import {
  appendTerminalOutput,
  resolveOutputByteLimit,
  TerminalTable,
  terminalOutputText,
} from "../src/session/terminals.js";

describe("terminal output limit", () => {
  it("keeps the newest bytes and does not split a UTF-8 character", () => {
    const state = { chunks: [] as Buffer[], bytes: 0, truncated: false, limit: 4 };
    appendTerminalOutput(state, Buffer.from("ééXYZ", "utf8"));
    expect(state.truncated).toBe(true);
    expect(state.bytes).toBeLessThanOrEqual(4);
    expect(terminalOutputText(state)).toBe("XYZ");
  });

  it("retains nothing when the limit is zero", () => {
    const state = { chunks: [] as Buffer[], bytes: 0, truncated: false, limit: 0 };
    appendTerminalOutput(state, Buffer.from("abc"));
    expect(state.truncated).toBe(true);
    expect(terminalOutputText(state)).toBe("");
  });

  it("rejects a negative outputByteLimit", () => {
    expect(() => resolveOutputByteLimit(-1)).toThrow(/outputByteLimit/);
  });
});

describe("TerminalTable", () => {
  const tables: TerminalTable[] = [];

  afterEach(() => {
    for (const table of tables.splice(0)) table.closeSession();
  });

  function table(): TerminalTable {
    const created = new TerminalTable();
    tables.push(created);
    return created;
  }

  it("returns the tail after the process exits", async () => {
    const terminals = table();
    const { terminalId } = terminals.create({
      sessionId: "s",
      command: process.execPath,
      args: ["-e", "process.stdout.write('ééXYZ')"],
      cwd: process.cwd(),
      env: process.env,
      outputByteLimit: 4,
    });
    await terminals.wait("s", terminalId);
    const out = terminals.output("s", terminalId);
    expect(out.output).toBe("XYZ");
    expect(out.truncated).toBe(true);
    expect(out.exitStatus?.exitCode).toBe(0);
  });

  it("kill keeps the id and release frees it", async () => {
    const terminals = table();
    const { terminalId } = terminals.create({
      sessionId: "s",
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello-term'); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: process.env,
    });
    const deadline = Date.now() + 3_000;
    let output = "";
    while (Date.now() < deadline) {
      output = terminals.output("s", terminalId).output;
      if (output.includes("hello-term")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(output).toContain("hello-term");
    terminals.kill("s", terminalId);
    await terminals.wait("s", terminalId);
    expect(terminals.output("s", terminalId).output).toContain("hello-term");
    expect(terminals.output("s", terminalId).exitStatus).toBeDefined();
    terminals.release("s", terminalId);
    expect(() => terminals.output("s", terminalId)).toThrow(/unknown terminal/);
  });

  it("does not let another session read the terminal", async () => {
    const terminals = table();
    const { terminalId } = terminals.create({
      sessionId: "owner",
      command: process.execPath,
      args: ["-e", "process.stdout.write('secret')"],
      cwd: process.cwd(),
      env: process.env,
    });
    await terminals.wait("owner", terminalId);
    expect(() => terminals.output("other", terminalId)).toThrow(/unknown terminal/);
    expect(terminals.output("owner", terminalId).output).toBe("secret");
  });
});
