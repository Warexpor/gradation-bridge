import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ensureDirs, saveConfig } from "../src/config/load.js";
import type { BridgeConfig } from "../src/config/types.js";
import { fakeHarnessConfig } from "../src/harness/registry.js";
import { ensurePrimaryToken } from "../src/auth/token.js";
import { SessionManager } from "../src/session/manager.js";
import { startBridgeServer, type BridgeServer } from "../src/server/ws.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeAgent = join(here, "../src/harness/fake-agent.ts");

interface RpcResult {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function withEnv(dir: string): () => void {
  const prevConfig = process.env.XDG_CONFIG_HOME;
  const prevData = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_DATA_HOME = join(dir, "data");
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
  return () => {
    if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevConfig;
    if (prevData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevData;
  };
}

async function openClient(url: string, token: string): Promise<{
  ws: WebSocket;
  call: (method: string, params?: unknown) => Promise<unknown>;
  notify: (method: string, params?: unknown) => void;
  updates: unknown[];
  close: () => Promise<void>;
}> {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const updates: unknown[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as {
      id?: number;
      method?: string;
      result?: unknown;
      error?: RpcResult["error"];
      params?: unknown;
    };
    if (msg.id != null && msg.method === undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) updates.push(msg);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return {
    ws,
    updates,
    call: (method, params) => {
      const id = nextId++;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }, 30_000);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      });
    },
    notify: (method, params) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }));
    },
    close: () =>
      new Promise((resolve) => {
        for (const [id, p] of pending) {
          pending.delete(id);
          p.reject(new Error("socket closed"));
        }
        ws.once("close", () => resolve());
        if (ws.readyState === ws.CLOSED) resolve();
        else ws.close();
      }),
  };
}

describe("bridge e2e with fake ACP agent", () => {
  let restore: (() => void) | undefined;
  let server: BridgeServer | undefined;
  let workspace: string;
  let token: string;

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-e2e-"));
    restore = withEnv(root);
    workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "README.md"), "# test\n");
    ensureDirs();
    const config: BridgeConfig = {
      allowedRoots: [workspace],
      workspaces: [workspace],
      defaultPermissionMode: "auto-edit",
      port: 0,
      harnesses: [fakeHarnessConfig(fakeAgent)],
    };
    saveConfig(config);
    token = ensurePrimaryToken().token;
    const sessions = new SessionManager({ config, version: "0.1.0-test" });
    server = await startBridgeServer({
      host: "127.0.0.1",
      port: 0,
      config,
      sessions,
      version: "0.1.0-test",
    });
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    restore?.();
    restore = undefined;
  });

  it("runs initialize → session/new → prompt → load → close", async () => {
    const client = await openClient(server!.url, token);

    const init = (await client.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "0" },
    })) as {
      protocolVersion: number;
      _meta: { bridge: { version: string; harnesses: Array<{ id: string }> } };
    };
    expect(init.protocolVersion).toBe(1);
    expect(init._meta.bridge.harnesses.some((h) => h.id === "fake")).toBe(true);

    const harnesses = (await client.call("bridge/listHarnesses")) as {
      harnesses: Array<{ id: string; available: boolean }>;
    };
    expect(harnesses.harnesses[0]?.id).toBe("fake");
    expect(harnesses.harnesses[0]?.available).toBe(true);

    const workspaces = (await client.call("bridge/listWorkspaces")) as { workspaces: string[] };
    expect(workspaces.workspaces).toContain(workspace);

    const browsed = (await client.call("bridge/browse", { path: workspace })) as {
      entries: Array<{ name: string; dir: boolean }>;
    };
    expect(browsed.entries.some((e) => e.name === "README.md")).toBe(true);

    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "auto-edit" },
    })) as { sessionId: string };
    expect(created.sessionId).toMatch(/^fake-/);
    expect(created).toMatchObject({
      modes: { currentModeId: "agent" },
      _meta: { harness: "fake", permissionMode: "auto-edit" },
    });

    const promptResult = (await client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "hello bridge" }],
    })) as { stopReason: string };
    expect(promptResult.stopReason).toBe("end_turn");

    // Wait briefly for notifications to land
    await new Promise((r) => setTimeout(r, 50));
    const updateMethods = client.updates.map((u) => (u as { method?: string }).method);
    expect(updateMethods).toContain("session/update");
    const withSeq = client.updates.filter((u) => {
      const p = (u as { params?: { _meta?: { seq?: number } } }).params;
      return typeof p?._meta?.seq === "number";
    });
    expect(withSeq.length).toBeGreaterThan(0);

    const listed = (await client.call("bridge/listSessions")) as {
      sessions: Array<{ sessionId: string; lastSeq: number }>;
    };
    expect(listed.sessions[0]?.sessionId).toBe(created.sessionId);
    expect(listed.sessions[0]?.lastSeq).toBeGreaterThan(0);

    const lastSeq = listed.sessions[0]!.lastSeq;
    const beforeLoad = client.updates.length;
    await client.call("session/load", {
      sessionId: created.sessionId,
      cwd: workspace,
      mcpServers: [],
      _meta: { afterSeq: lastSeq - 1 },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.updates.length).toBeGreaterThan(beforeLoad);

    await client.call("bridge/closeSession", { sessionId: created.sessionId });
    const afterClose = (await client.call("bridge/listSessions")) as { sessions: unknown[] };
    expect(afterClose.sessions).toHaveLength(0);

    await client.close();
  }, 60_000);

  it("rejects bad bearer tokens", async () => {
    await expect(openClient(server!.url, "deadbeef")).rejects.toThrow();
  });

  it("forwards permission requests in ask mode and applies phone outcome", async () => {
    // Restart-ish: new server config with ask + FAKE_ACP_PERMISSION
    await server!.close();
    const wsDir = workspace;
    const config: BridgeConfig = {
      allowedRoots: [wsDir],
      workspaces: [wsDir],
      defaultPermissionMode: "ask",
      port: 0,
      harnesses: [
        {
          ...fakeHarnessConfig(fakeAgent),
          env: { FAKE_ACP_PERMISSION: "1" },
        },
      ],
    };
    saveConfig(config);
    const sessions = new SessionManager({ config, version: "0.1.0-test" });
    server = await startBridgeServer({
      host: "127.0.0.1",
      port: 0,
      config,
      sessions,
      version: "0.1.0-test",
    });

    const client = await openClient(server.url, token);
    await client.call("initialize", { protocolVersion: 1 });

    // Auto-answer permission requests from the bridge
    client.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        id?: number;
        method?: string;
        params?: { options?: Array<{ optionId: string; kind: string }> };
      };
      if (msg.method === "session/request_permission" && msg.id != null) {
        const allow = msg.params?.options?.find((o) => o.kind === "allow_once");
        client.ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              outcome: {
                outcome: "selected",
                optionId: allow?.optionId ?? "allow-once",
              },
            },
          }),
        );
      }
    });

    const created = (await client.call("session/new", {
      cwd: wsDir,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };

    const promptResult = (await client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "need permission" }],
    })) as { stopReason: string };
    expect(promptResult.stopReason).toBe("end_turn");

    const perm = client.updates.find(
      (u) => (u as { method?: string }).method === "session/request_permission",
    );
    expect(perm).toBeTruthy();

    await client.call("bridge/closeSession", { sessionId: created.sessionId });
    await client.close();
  }, 60_000);

  it("bridge/gitStatus and bridge/diff reflect workspace git state", async () => {
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: workspace,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace, stdio: "ignore" });
    writeFileSync(join(workspace, "tracked.txt"), "v1\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
    writeFileSync(join(workspace, "tracked.txt"), "v2\n");
    writeFileSync(join(workspace, "extra.txt"), "new\n");

    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "auto-edit" },
    })) as { sessionId: string };

    const status = (await client.call("bridge/gitStatus", {
      sessionId: created.sessionId,
    })) as {
      branch: string;
      ahead: number;
      behind: number;
      files: Array<{ path: string; status: string }>;
    };
    expect(status.branch).toMatch(/^(master|main)$/);
    expect(status.files.some((f) => f.path === "tracked.txt")).toBe(true);
    expect(status.files.some((f) => f.path === "extra.txt")).toBe(true);

    const diff = (await client.call("bridge/diff", {
      sessionId: created.sessionId,
      path: "tracked.txt",
    })) as { unified: string };
    expect(diff.unified).toContain("-v1");
    expect(diff.unified).toContain("+v2");

    await client.call("bridge/closeSession", { sessionId: created.sessionId });
    await client.close();
  }, 60_000);

  it("bridge/browse denies symlink escape outside allowedRoots", async () => {
    const outside = join(dirname(workspace), "outside-secret");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "leak\n");
    symlinkSync(outside, join(workspace, "escape-link"));

    const client = await openClient(server!.url, token);
    await expect(client.call("bridge/browse", { path: join(workspace, "escape-link") })).rejects.toThrow(
      /outside allowed workspace roots/,
    );
    await client.close();
  });

  async function boot(config: BridgeConfig): Promise<void> {
    await server?.close();
    saveConfig(config);
    const sessions = new SessionManager({ config, version: "0.1.0-test" });
    server = await startBridgeServer({
      host: "127.0.0.1",
      port: 0,
      config,
      sessions,
      version: "0.1.0-test",
    });
  }

  async function waitFor(pred: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("rejects malformed frames and still serves the next request", async () => {
    const client = await openClient(server!.url, token);
    const errors: Array<{ code?: number; message?: string }> = [];
    client.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { error?: { code?: number; message?: string } };
      if (msg.error) errors.push(msg.error);
    });
    client.ws.send("not json");
    client.ws.send("null");
    client.ws.send("[]");
    client.ws.send(JSON.stringify({ jsonrpc: "1.0", id: 99, method: "initialize" }));
    await waitFor(() => errors.length >= 4, "malformed frame errors");
    expect(errors.map((e) => e.code)).toEqual([-32700, -32600, -32600, -32600]);

    const init = (await client.call("initialize", { protocolVersion: 1 })) as { protocolVersion: number };
    expect(init.protocolVersion).toBe(1);
    await client.close();
  });

  it("cancels an in-flight prompt and rejects a second concurrent prompt", async () => {
    await boot({
      allowedRoots: [workspace],
      workspaces: [workspace],
      defaultPermissionMode: "auto-edit",
      port: 0,
      harnesses: [{ ...fakeHarnessConfig(fakeAgent), env: { FAKE_ACP_SLOW_MS: "400" } }],
    });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "auto-edit" },
    })) as { sessionId: string };

    const first = client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "slow" }],
    }) as Promise<{ stopReason: string }>;
    await waitFor(
      () => client.updates.some((u) => (u as { method?: string }).method === "session/update"),
      "first update",
    );
    await expect(
      client.call("session/prompt", {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "overlap" }],
      }),
    ).rejects.toThrow(/already in progress/);

    client.notify("session/cancel", { sessionId: created.sessionId });
    await expect(first).resolves.toMatchObject({ stopReason: "cancelled" });

    const second = client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "again" }],
    }) as Promise<{ stopReason: string }>;
    await waitFor(
      () =>
        client.updates.filter((u) => (u as { method?: string }).method === "session/update").length > 1,
      "second prompt update",
    );
    await expect(
      client.call("session/cancel", { sessionId: created.sessionId }),
    ).resolves.toEqual({});
    await expect(second).resolves.toMatchObject({ stopReason: "cancelled" });

    await client.call("bridge/closeSession", { sessionId: created.sessionId });
    await client.close();
  }, 20_000);

  it("cancel during a permission prompt unblocks the agent", async () => {
    await boot({
      allowedRoots: [workspace],
      workspaces: [workspace],
      defaultPermissionMode: "ask",
      port: 0,
      harnesses: [{ ...fakeHarnessConfig(fakeAgent), env: { FAKE_ACP_PERMISSION: "1" } }],
    });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };

    const promptP = client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "need a decision" }],
    }) as Promise<{ stopReason: string }>;
    await waitFor(
      () =>
        client.updates.some((u) => (u as { method?: string }).method === "session/request_permission"),
      "permission request",
    );
    client.notify("session/cancel", { sessionId: created.sessionId });
    await expect(promptP).resolves.toMatchObject({ stopReason: "cancelled" });
    await client.close();
  }, 20_000);

  it("redelivers an unanswered permission after the phone reconnects", async () => {
    await boot({
      allowedRoots: [workspace],
      workspaces: [workspace],
      defaultPermissionMode: "ask",
      port: 0,
      harnesses: [{ ...fakeHarnessConfig(fakeAgent), env: { FAKE_ACP_PERMISSION: "1" } }],
    });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };

    const orphan = client
      .call("session/prompt", {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "hold for reconnect" }],
      })
      .catch(() => undefined);
    await waitFor(
      () =>
        client.updates.some((u) => (u as { method?: string }).method === "session/request_permission"),
      "permission before disconnect",
    );
    await client.close();

    const client2 = await openClient(server!.url, token);
    const answer = (msg: unknown): void => {
      const m = msg as {
        id?: number;
        method?: string;
        params?: { options?: Array<{ optionId: string; kind: string }> };
      };
      if (m.method !== "session/request_permission" || m.id == null) return;
      const allow = m.params?.options?.find((o) => o.kind === "allow_once");
      client2.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            outcome: { outcome: "selected", optionId: allow?.optionId ?? "allow-once" },
          },
        }),
      );
    };
    client2.ws.on("message", (raw) => {
      try {
        answer(JSON.parse(raw.toString()));
      } catch {
        // ignore
      }
    });
    for (const update of client2.updates) answer(update);

    await waitFor(
      () =>
        client2.updates.some((u) => (u as { method?: string }).method === "session/request_permission"),
      "permission redelivered",
    );
    await waitFor(
      () => client2.updates.some((u) => (u as { method?: string }).method === "bridge/promptResult"),
      "prompt result after reconnect",
    );
    const result = client2.updates.find(
      (u) => (u as { method?: string }).method === "bridge/promptResult",
    ) as { params?: { result?: { stopReason?: string } } };
    expect(result.params?.result?.stopReason).toBe("end_turn");
    await orphan;
    await client2.close();
  }, 20_000);

  it("session/load respawns an agent that exited", async () => {
    await boot({
      allowedRoots: [workspace],
      workspaces: [workspace],
      defaultPermissionMode: "auto-edit",
      port: 0,
      harnesses: [{ ...fakeHarnessConfig(fakeAgent), env: { FAKE_ACP_EXIT_AFTER_PROMPT: "1" } }],
    });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "auto-edit" },
    })) as { sessionId: string };

    const first = (await client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "die after this" }],
    })) as { stopReason: string };
    expect(first.stopReason).toBe("end_turn");

    const deadline = Date.now() + 5_000;
    let status = "";
    while (Date.now() < deadline) {
      const listed = (await client.call("bridge/listSessions")) as {
        sessions: Array<{ status: string }>;
      };
      status = listed.sessions[0]?.status ?? "";
      if (status === "error") break;
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(status).toBe("error");

    const loaded = (await client.call("session/load", {
      sessionId: created.sessionId,
      cwd: workspace,
      mcpServers: [],
      _meta: { afterSeq: 0 },
    })) as { agentAlive: boolean; replayed: number; status: string };
    expect(loaded.replayed).toBeGreaterThan(0);
    expect(loaded.agentAlive).toBe(true);

    const second = (await client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "still here" }],
    })) as { stopReason: string };
    expect(second.stopReason).toBe("end_turn");
    await client.close();
  }, 20_000);

});
