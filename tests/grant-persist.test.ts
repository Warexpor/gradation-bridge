import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../src/config/load.js";
import { fakeHarnessConfig } from "../src/harness/registry.js";
import { readPersistedSession } from "../src/session/persist.js";
import { SessionManager, type SessionRecord } from "../src/session/manager.js";

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

type Spender = {
  assertMutatingTool(
    rec: SessionRecord,
    family: "write" | "exec",
    path?: string,
    argv?: string[],
  ): void;
};

describe("approval state on disk", () => {
  it("drops a spent allow_once and a mode change before the next crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-grant-"));
    const restore = useEnv(root);
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "README.md"), "# test\n");
    ensureDirs();
    const sessions = new SessionManager({
      config: {
        allowedRoots: [workspace],
        defaultPermissionMode: "ask",
        harnesses: [fakeHarnessConfig(fakeAgent)],
      },
    });
    let restored: SessionManager | undefined;
    cleanups.push(async () => {
      await restored?.closeAll();
      await sessions.closeAll();
      restore();
      rmSync(root, { recursive: true, force: true });
    });

    const rec = await sessions.startSession({ harnessId: "fake", cwd: workspace });
    const file = join(workspace, "README.md");
    rec.grants.push({ family: "write", path: file, always: false });
    sessions.noteBranch(rec.sessionId, "main");
    expect(readPersistedSession(rec.sessionId)?.grants).toEqual([
      { family: "write", path: file, always: false },
    ]);

    (sessions as unknown as Spender).assertMutatingTool(rec, "write", file);
    expect(rec.grants).toEqual([]);
    expect(readPersistedSession(rec.sessionId)?.grants).toEqual([]);

    rec.grants.push({ family: "exec", always: true });
    sessions.noteBranch(rec.sessionId, "topic");
    expect(readPersistedSession(rec.sessionId)?.grants).toEqual([{ family: "exec", always: true }]);
    sessions.setPermissionMode(rec.sessionId, "plan");
    const saved = readPersistedSession(rec.sessionId);
    expect(saved?.permissionMode).toBe("plan");
    expect(saved?.grants).toEqual([]);

    await sessions.closeAll();
    restored = new SessionManager({
      config: {
        allowedRoots: [workspace],
        defaultPermissionMode: "ask",
        harnesses: [fakeHarnessConfig(fakeAgent)],
      },
    });
    const again = restored.get(rec.sessionId);
    expect(again?.permissionMode).toBe("plan");
    expect(again?.grants).toEqual([]);
  });
});
