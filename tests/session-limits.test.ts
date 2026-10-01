import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../src/config/load.js";
import { fakeHarnessConfig } from "../src/harness/registry.js";
import { SessionManager } from "../src/session/manager.js";

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), "../src/harness/fake-agent.ts");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function useEnv(root: string): () => void {
  const prevConfig = process.env.XDG_CONFIG_HOME;
  const prevData = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
  return () => {
    if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevConfig;
    if (prevData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevData;
  };
}

function manager(workspace: string, limits: { maxOpenSessions: number; maxLiveAgents: number }): SessionManager {
  return new SessionManager({
    config: {
      allowedRoots: [workspace],
      defaultPermissionMode: "ask",
      harnesses: [fakeHarnessConfig(fakeAgent)],
    },
    limits,
  });
}

describe("session and agent caps", () => {
  it("refuses another open session, then allows one after close", async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-cap-"));
    const restore = useEnv(root);
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    ensureDirs();
    const sessions = manager(workspace, { maxOpenSessions: 1, maxLiveAgents: 4 });
    cleanups.push(async () => {
      await sessions.closeAll();
      restore();
      rmSync(root, { recursive: true, force: true });
    });

    const first = await sessions.startSession({ harnessId: "fake", cwd: workspace });
    await expect(sessions.startSession({ harnessId: "fake", cwd: workspace })).rejects.toMatchObject({
      code: -32012,
      message: expect.stringMatching(/open sessions/),
    });
    await sessions.deleteSession(first.sessionId);
    const second = await sessions.startSession({ harnessId: "fake", cwd: workspace });
    expect(second.sessionId).toMatch(/^fake-/);
  });

  it("refuses a second live agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-cap-"));
    const restore = useEnv(root);
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    ensureDirs();
    const sessions = manager(workspace, { maxOpenSessions: 4, maxLiveAgents: 1 });
    cleanups.push(async () => {
      await sessions.closeAll();
      restore();
      rmSync(root, { recursive: true, force: true });
    });

    await sessions.startSession({ harnessId: "fake", cwd: workspace });
    await expect(sessions.startSession({ harnessId: "fake", cwd: workspace })).rejects.toMatchObject({
      code: -32012,
      message: expect.stringMatching(/running agents/),
    });
  });
});
