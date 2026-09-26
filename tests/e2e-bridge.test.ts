import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
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
        ws.once("close", () => resolve());
        ws.close();
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
});
