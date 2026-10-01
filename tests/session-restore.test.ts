import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../src/config/load.js";
import { SessionManager } from "../src/session/manager.js";
import { writeSessionMeta, type SessionMeta } from "../src/session/persist.js";

const roots: string[] = [];
const prevConfig = process.env.XDG_CONFIG_HOME;
const prevData = process.env.XDG_DATA_HOME;

afterEach(() => {
  if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevConfig;
  if (prevData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevData;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function useDataDir(): { root: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "gb-restore-"));
  roots.push(root);
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
  const workspace = join(root, "ws");
  mkdirSync(workspace, { recursive: true });
  ensureDirs();
  return { root, workspace };
}

function meta(workspace: string, patch: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  return {
    version: 1,
    sessionId: patch.sessionId,
    harness: "fake",
    cwd: workspace,
    title: patch.title ?? patch.sessionId,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: patch.updatedAt ?? "2026-10-01T00:00:00.000Z",
    preview: "",
    status: patch.status ?? "idle",
    permissionMode: "ask",
    agentSessionId: patch.sessionId,
    mcpServers: [],
    grants: patch.grants ?? [],
    additionalDirectories: patch.additionalDirectories ?? [],
  };
}

describe("persisted sessions", () => {
  it("restores idle sessions, drops closed and corrupt catalogs, and paginates by cursor", () => {
    const { workspace } = useDataDir();
    const dir = join(process.env.XDG_DATA_HOME!, "gradation-bridge", "sessions");
    writeSessionMeta(join(dir, "s-new"), meta(workspace, {
      sessionId: "s-new",
      title: "newest",
      updatedAt: "2026-10-01T00:00:03.000Z",
      status: "running",
      grants: [{ family: "exec", always: true }],
    }));
    writeSessionMeta(join(dir, "s-mid"), meta(workspace, {
      sessionId: "s-mid",
      updatedAt: "2026-10-01T00:00:02.000Z",
    }));
    writeSessionMeta(join(dir, "s-old"), meta(workspace, {
      sessionId: "s-old",
      updatedAt: "2026-10-01T00:00:01.000Z",
      status: "closed",
    }));
    mkdirSync(join(dir, "bad-json"), { recursive: true });
    writeFileSync(join(dir, "bad-json", "meta.json"), "{");
    writeSessionMeta(join(dir, "mismatch"), meta(workspace, { sessionId: "mismatch" }));
    writeFileSync(
      join(dir, "mismatch", "meta.json"),
      JSON.stringify({ ...meta(workspace, { sessionId: "other" }), sessionId: "other" }),
    );

    const sessions = new SessionManager({
      config: {
        allowedRoots: [workspace],
        defaultPermissionMode: "ask",
        harnesses: [],
      },
    });
    expect(sessions.list().map((s) => s.sessionId)).toEqual(["s-new", "s-mid"]);
    expect(sessions.get("s-new")?.status).toBe("idle");
    expect(sessions.get("s-new")?.grants).toEqual([{ family: "exec", always: true }]);

    const page = sessions.listForProtocol({});
    expect(page.sessions.map((s) => s.sessionId)).toEqual(["s-new", "s-mid"]);
    expect(page.nextCursor).toBeUndefined();
    const rest = sessions.listForProtocol({ cursor: "s-new" });
    expect(rest.sessions.map((s) => s.sessionId)).toEqual(["s-mid"]);
    expect(sessions.listForProtocol({ cursor: "missing" }).sessions).toHaveLength(0);
  });
});
