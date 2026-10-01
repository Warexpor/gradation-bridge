import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpStdioClient } from "../src/acp/client.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ACP stdio client errors", () => {
  it("includes redacted stderr when the harness exits", async () => {
    const client = new AcpStdioClient({
      harness: {
        id: "boom",
        name: "boom",
        command: process.execPath,
        args: [
          "-e",
          "console.error('fail TOKEN=sk-abcdefghijklmnopqrstuvwxyz'); process.exit(2)",
        ],
      },
      cwd: process.cwd(),
    });
    client.start();
    await expect(
      client.initialize({ clientInfo: { name: "t", version: "0" } }),
    ).rejects.toThrow(/exited \(code=2/);
    expect(client.stderrTail()).toContain("TOKEN=[redacted]");
    expect(client.stderrTail()).not.toContain("sk-abc");
  });

  it("starts the bridge-PATH binary when harness env replaces PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-spawn-path-"));
    dirs.push(dir);
    const binDir = join(dir, "bin");
    const shadowDir = join(dir, "shadow");
    mkdirSync(binDir);
    mkdirSync(shadowDir);
    const real = join(binDir, "gb-probe");
    writeFileSync(real, "#!/bin/sh\nprintf '%s' \"$0\" > \"$OUT\"\n");
    chmodSync(real, 0o755);
    writeFileSync(join(shadowDir, "gb-probe"), "#!/bin/sh\nprintf shadow > \"$OUT\"\n");
    chmodSync(join(shadowDir, "gb-probe"), 0o755);
    const out = join(dir, "out");
    const prev = process.env.PATH;
    process.env.PATH = `${binDir}${prev ? `:${prev}` : ""}`;
    try {
      const client = new AcpStdioClient({
        harness: { id: "probe", name: "probe", command: "gb-probe", args: [] },
        cwd: dir,
        env: { PATH: shadowDir, OUT: out },
      });
      client.start();
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        try {
          expect(readFileSync(out, "utf8")).toBe(real);
          return;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("probe did not run the bridge-PATH binary");
    } finally {
      if (prev === undefined) delete process.env.PATH;
      else process.env.PATH = prev;
    }
  });

  it("reports a missing command instead of hanging", async () => {
    const client = new AcpStdioClient({
      harness: {
        id: "missing",
        name: "missing",
        command: "gradation-bridge-not-a-real-binary",
        args: [],
      },
      cwd: process.cwd(),
    });
    client.start();
    await expect(
      client.initialize({ clientInfo: { name: "t", version: "0" } }),
    ).rejects.toThrow(/command not found: gradation-bridge-not-a-real-binary|ACP process exited/);
  });

  it.skipIf(process.platform === "win32")("reaps grandchildren when the harness leader exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-reap-"));
    dirs.push(dir);
    const pidFile = join(dir, "grand.pid");
    const script = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const grand = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(process.env.PIDFILE, String(grand.pid));
      setTimeout(() => process.exit(0), 150);
    `;
    let exited = false;
    const client = new AcpStdioClient({
      harness: {
        id: "reap",
        name: "reap",
        command: process.execPath,
        args: ["-e", script],
      },
      cwd: dir,
      env: { PIDFILE: pidFile },
      onExit: () => {
        exited = true;
      },
    });
    client.start();
    const start = Date.now();
    let grandPid = 0;
    while (Date.now() - start < 5_000) {
      try {
        grandPid = Number(readFileSync(pidFile, "utf8"));
        if (grandPid > 0) break;
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(grandPid).toBeGreaterThan(0);
    const deadline = Date.now() + 4_000;
    while (!exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(exited).toBe(true);
    const deadAt = Date.now() + 3_000;
    while (Date.now() < deadAt) {
      try {
        process.kill(grandPid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
        throw err;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`grandchild ${grandPid} still alive after harness exit`);
  });
});
