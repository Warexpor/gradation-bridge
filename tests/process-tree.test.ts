import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killProcessTree } from "../src/proc/tree.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitDead(pid: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 3_000) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
      throw err;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`pid ${pid} still alive`);
}

describe("killProcessTree", () => {
  it.skipIf(process.platform === "win32")("stops descendants of a detached child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-tree-"));
    dirs.push(dir);
    const pidFile = join(dir, "grand.pid");
    const script = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const grand = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(process.env.PIDFILE, String(grand.pid));
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PIDFILE: pidFile },
    });
    try {
      const start = Date.now();
      while (!existsSync(pidFile)) {
        if (Date.now() - start > 5_000) throw new Error("grandchild pid was not written");
        await new Promise((r) => setTimeout(r, 20));
      }
      const grandPid = Number(readFileSync(pidFile, "utf8"));
      expect(grandPid).toBeGreaterThan(0);
      killProcessTree(child, "SIGTERM");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("parent did not exit")), 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await waitDead(grandPid);
    } finally {
      try {
        killProcessTree(child, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});
