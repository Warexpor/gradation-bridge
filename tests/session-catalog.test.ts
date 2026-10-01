import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../src/config/load.js";
import { SandboxError } from "../src/approval/sandbox.js";
import { SessionManager } from "../src/session/manager.js";
import { sessionsRoot, writeSessionMeta, type SessionMeta } from "../src/session/persist.js";

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
  const root = mkdtempSync(join(tmpdir(), "gb-catalog-"));
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

function meta(cwd: string, patch: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  return {
    version: 1,
    sessionId: patch.sessionId,
    harness: "fake",
    cwd,
    title: patch.title ?? patch.sessionId,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: patch.updatedAt ?? "2026-10-01T00:00:00.000Z",
    preview: patch.preview ?? "",
    status: patch.status ?? "idle",
    permissionMode: "ask",
    agentSessionId: patch.sessionId,
    mcpServers: [],
    grants: patch.grants ?? [],
    additionalDirectories: patch.additionalDirectories ?? [],
    ...(patch.authMethods ? { authMethods: patch.authMethods } : {}),
    ...(patch.logoutSupported ? { logoutSupported: true } : {}),
  };
}

function manager(workspace: string, extraRoots: string[] = []): SessionManager {
  return new SessionManager({
    config: {
      allowedRoots: [workspace, ...extraRoots],
      defaultPermissionMode: "ask",
      harnesses: [],
    },
  });
}

describe("session catalog edges", () => {
  it("pages 50 at a time and treats a missing cursor as the end", () => {
    const { workspace } = useDataDir();
    const dir = sessionsRoot();
    for (let i = 0; i < 51; i++) {
      const id = `s${String(i).padStart(3, "0")}`;
      writeSessionMeta(
        join(dir, id),
        meta(workspace, {
          sessionId: id,
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    const sessions = manager(workspace);
    const page = sessions.listForProtocol({});
    expect(page.sessions).toHaveLength(50);
    expect(page.sessions[0]?.sessionId).toBe("s050");
    expect(page.nextCursor).toBe("s001");
    const rest = sessions.listForProtocol({ cursor: page.nextCursor });
    expect(rest.sessions.map((s) => s.sessionId)).toEqual(["s000"]);
    expect(rest.nextCursor).toBeUndefined();
    expect(sessions.listForProtocol({ cursor: "s000" }).sessions).toEqual([]);
  });

  it("omits nextCursor when the page is exact", () => {
    const { workspace } = useDataDir();
    const dir = sessionsRoot();
    for (let i = 0; i < 50; i++) {
      const id = `p${String(i).padStart(3, "0")}`;
      writeSessionMeta(
        join(dir, id),
        meta(workspace, {
          sessionId: id,
          updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
        }),
      );
    }
    const page = manager(workspace).listForProtocol({});
    expect(page.sessions).toHaveLength(50);
    expect(page.nextCursor).toBeUndefined();
  });

  it("filters by realpath, hides grants, and rejects a cwd outside the sandbox", () => {
    const { root, workspace } = useDataDir();
    const real = join(workspace, "real");
    const other = join(workspace, "other");
    mkdirSync(real);
    mkdirSync(other);
    symlinkSync(real, join(workspace, "link"));
    const dir = sessionsRoot();
    writeSessionMeta(
      join(dir, "in-real"),
      meta(real, {
        sessionId: "in-real",
        updatedAt: "2026-10-01T00:00:02.000Z",
        grants: [{ family: "write", path: join(real, "secret-name"), always: true }],
        preview: "visible",
      }),
    );
    writeSessionMeta(
      join(dir, "in-other"),
      meta(other, {
        sessionId: "in-other",
        updatedAt: "2026-10-01T00:00:01.000Z",
      }),
    );
    const sessions = manager(workspace);
    const viaLink = sessions.listForProtocol({ cwd: join(workspace, "link") });
    expect(viaLink.sessions.map((s) => s.sessionId)).toEqual(["in-real"]);
    expect(sessions.listForProtocol({ cwd: other }).sessions.map((s) => s.sessionId)).toEqual([
      "in-other",
    ]);
    expect(sessions.listForProtocol({ cwd: real, cursor: "in-other" }).sessions).toEqual([]);
    const blob = JSON.stringify(viaLink);
    expect(blob).not.toContain("secret-name");
    expect(blob).not.toContain("grants");
    expect(blob).not.toContain("always");
    expect(viaLink.sessions[0]?._meta).toMatchObject({ status: "idle", preview: "visible" });
    expect(() => sessions.listForProtocol({ cwd: "/etc" })).toThrow(SandboxError);
    expect(sessions.list({ limit: 0 })).toEqual([]);
    expect(sessions.list({ limit: -4 })).toEqual([]);
    expect(sessions.list({ limit: 1.9 }).map((s) => s.sessionId)).toEqual(["in-real"]);
    expect(sessions.list({ before: "2026-10-01T00:00:02.000Z" }).map((s) => s.sessionId)).toEqual([
      "in-other",
    ]);
    expect(sessions.list({ before: "2026-10-01T00:00:01.000Z" })).toEqual([]);
    expect(sessions.listForProtocol({ cursor: "" }).sessions).toHaveLength(2);
    expect(root).toBeTruthy();
  });

  it("skips unsafe names, symlinked catalogs, closed rows, and caps the restore", () => {
    const { root, workspace } = useDataDir();
    const dir = sessionsRoot();
    writeSessionMeta(join(dir, "kept"), meta(workspace, { sessionId: "kept" }));
    mkdirSync(join(dir, "bad id"), { recursive: true });
    writeFileSync(
      join(dir, "bad id", "meta.json"),
      JSON.stringify(meta(workspace, { sessionId: "bad id" })),
    );
    const outside = join(root, "outside", "link-sess");
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, "meta.json"),
      JSON.stringify(meta(workspace, { sessionId: "link-sess", title: "should-not-load" })) + "\n",
    );
    symlinkSync(outside, join(dir, "link-sess"));
    writeSessionMeta(
      join(dir, "shut"),
      meta(workspace, { sessionId: "shut", status: "closed", updatedAt: "2026-10-03T00:00:00.000Z" }),
    );
    writeSessionMeta(
      join(dir, "escaped"),
      meta(workspace, {
        sessionId: "escaped",
        additionalDirectories: ["/etc"],
        updatedAt: "2026-10-01T00:00:03.000Z",
      }),
    );

    const sessions = manager(workspace);
    const ids = sessions.list().map((s) => s.sessionId);
    expect(ids).not.toContain("link-sess");
    expect(ids).not.toContain("shut");
    expect(ids).not.toContain("bad id");
    expect(ids).toContain("kept");
    expect(sessions.get("escaped")?.status).toBe("error");
    expect(sessions.get("escaped")?.preview).toMatch(/allowed roots/);
    expect(sessions.listForProtocol({}).sessions.find((s) => s.sessionId === "escaped")?._meta).toMatchObject({
      status: "error",
    });
  });

  it("restores at most 200 sessions, dropping the oldest", () => {
    const { workspace } = useDataDir();
    const dir = sessionsRoot();
    for (let i = 0; i < 201; i++) {
      const id = `n${String(i).padStart(3, "0")}`;
      writeSessionMeta(
        join(dir, id),
        meta(workspace, {
          sessionId: id,
          updatedAt: new Date(Date.UTC(2026, 0, 3, 0, 0, i)).toISOString(),
        }),
      );
    }
    const ids = manager(workspace).list().map((s) => s.sessionId);
    expect(ids).toContain("n200");
    expect(ids).not.toContain("n000");
    expect(ids).toHaveLength(200);
  });

  it("restores logout and public auth methods, and skips symlinked catalog files", () => {
    const { root, workspace } = useDataDir();
    const dir = sessionsRoot();
    writeSessionMeta(
      join(dir, "authed"),
      meta(workspace, {
        sessionId: "authed",
        updatedAt: "2026-10-01T00:00:05.000Z",
        authMethods: [
          { id: "agent", name: "Agent", type: "agent" },
          { id: "term", name: "Terminal", type: "terminal", args: ["--token", "sekret-value"] },
        ],
        logoutSupported: true,
      }),
    );
    mkdirSync(join(dir, "linked-meta"));
    const evilMeta = join(root, "evil-meta.json");
    writeFileSync(
      evilMeta,
      JSON.stringify(meta(workspace, { sessionId: "linked-meta", title: "should-not-load" })),
    );
    symlinkSync(evilMeta, join(dir, "linked-meta", "meta.json"));

    writeSessionMeta(
      join(dir, "linked-log"),
      meta(workspace, { sessionId: "linked-log", title: "log-should-not-load" }),
    );
    const leak = join(root, "leak.jsonl");
    writeFileSync(leak, "LEAK-OUTSIDE\n");
    symlinkSync(leak, join(dir, "linked-log", "events.jsonl"));

    const sessions = manager(workspace);
    const page = sessions.listForProtocol({});
    const ids = page.sessions.map((s) => s.sessionId);
    expect(ids).toContain("authed");
    expect(ids).not.toContain("linked-meta");
    expect(ids).not.toContain("linked-log");
    const authed = page.sessions.find((s) => s.sessionId === "authed");
    expect(authed?._meta).toMatchObject({
      logout: true,
      authMethods: [
        { id: "agent", name: "Agent", type: "agent" },
        { id: "term", name: "Terminal", type: "terminal", args: ["--token", "[redacted]"] },
      ],
    });
    const blob = JSON.stringify(page);
    expect(blob).not.toContain("sekret-value");
    expect(blob).not.toContain("should-not-load");
    expect(blob).not.toContain("LEAK-OUTSIDE");
    expect(sessions.list().find((s) => s.sessionId === "authed")?.logout).toBe(true);
    expect(readFileSync(join(dir, "authed", "meta.json"), "utf8")).not.toContain("sekret-value");
    expect(readFileSync(leak, "utf8")).toBe("LEAK-OUTSIDE\n");
  });

  it("skips a mismatched agent session id and a symlinked sessions directory", () => {
    const { root, workspace } = useDataDir();
    const dir = sessionsRoot();
    const body = meta(workspace, { sessionId: "diverged", title: "should-not-load" });
    body.agentSessionId = "other-id";
    mkdirSync(join(dir, "diverged"), { recursive: true });
    writeFileSync(join(dir, "diverged", "meta.json"), JSON.stringify(body));
    expect(manager(workspace).list().map((s) => s.sessionId)).not.toContain("diverged");

    rmSync(dir, { recursive: true, force: true });
    const outside = join(root, "outside-sessions", "hidden");
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, "meta.json"),
      JSON.stringify(meta(workspace, { sessionId: "hidden", title: "via-symlink" })),
    );
    symlinkSync(join(root, "outside-sessions"), dir);
    const sessions = manager(workspace);
    expect(sessions.list()).toEqual([]);
    expect(JSON.stringify(sessions.listForProtocol({}))).not.toContain("via-symlink");
  });

  it("replaces additional directories on load and refuses a closed session", async () => {
    const { workspace } = useDataDir();
    const extra = join(workspace, "extra");
    mkdirSync(extra);
    const dir = sessionsRoot();
    writeSessionMeta(
      join(dir, "rooted"),
      meta(workspace, { sessionId: "rooted", additionalDirectories: [extra] }),
    );
    const sessions = manager(workspace);
    await expect(
      sessions.load("rooted", { additionalDirectories: ["/etc"], send: async () => true }),
    ).rejects.toThrow(SandboxError);
    expect(sessions.get("rooted")?.additionalDirectories).toEqual([extra]);

    const loaded = await sessions.load("rooted", {
      additionalDirectories: [],
      send: async () => true,
    });
    expect(sessions.get("rooted")?.additionalDirectories).toEqual([]);
    expect(loaded.agentAlive).toBe(false);

    sessions.close("rooted");
    await expect(sessions.load("rooted", { send: async () => true })).rejects.toThrow(/unknown session/);
  });
});
