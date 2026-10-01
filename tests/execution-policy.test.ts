import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { configPath, ensureDirs, saveConfig } from "../src/config/load.js";
import type { BridgeConfig, PermissionMode } from "../src/config/types.js";
import { fakeHarnessConfig } from "../src/harness/registry.js";
import { ensurePrimaryToken } from "../src/auth/token.js";
import { SessionManager } from "../src/session/manager.js";
import { startBridgeServer, type BridgeServer } from "../src/server/ws.js";

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), "../src/harness/fake-agent.ts");

class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

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

async function openClient(
  url: string,
  token: string,
  autoAllow = false,
  hooks?: { beforeAllow?: () => Promise<void> },
) {
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
      error?: { code: number; message: string; data?: unknown };
      params?: { options?: Array<{ optionId: string; kind: string }> };
    };
    if (msg.id != null && msg.method === undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.message, msg.error.code, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) updates.push(msg);
    if ((autoAllow || hooks?.beforeAllow) && msg.method === "session/request_permission" && msg.id != null) {
      const allow = msg.params?.options?.find((o) => o.kind === "allow_once");
      const respond = (): void => {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { outcome: { outcome: "selected", optionId: allow?.optionId ?? "allow-once" } },
          }),
        );
      };
      if (hooks?.beforeAllow) void hooks.beforeAllow().then(respond);
      else respond();
    }
  });
  return {
    updates,
    notify: (method: string, params?: unknown) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }));
    },
    call: (method: string, params?: unknown) => {
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
    close: () =>
      new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}

function texts(updates: unknown[]): string[] {
  return updates.flatMap((u) => {
    const update = (u as { params?: { update?: { content?: { text?: string } } } }).params?.update;
    const text = update?.content?.text;
    return text ? [text] : [];
  });
}

describe("execution policy and protocol surfaces", () => {
  let restore: (() => void) | undefined;
  let server: BridgeServer | undefined;
  let workspace: string;
  let token: string;
  const roots: string[] = [];

  afterEach(async () => {
    await server?.close();
    server = undefined;
    restore?.();
    restore = undefined;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function boot(opts: {
    mode: PermissionMode;
    env?: Record<string, string>;
    extraHarness?: BridgeConfig["harnesses"][number];
  }): Promise<void> {
    if (server) {
      await server.close();
      server = undefined;
    }
    restore?.();
    restore = undefined;
    const root = mkdtempSync(join(tmpdir(), "gb-exec-"));
    roots.push(root);
    restore = useEnv(root);
    workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "README.md"), "# test\n");
    ensureDirs();
    const config: BridgeConfig = {
      allowedRoots: [workspace],
      workspaces: [],
      defaultPermissionMode: opts.mode,
      port: 0,
      harnesses: [
        { ...fakeHarnessConfig(fakeAgent), env: opts.env },
        ...(opts.extraHarness ? [opts.extraHarness] : []),
      ],
    };
    saveConfig(config);
    token = ensurePrimaryToken().token;
    const sessions = new SessionManager({ config, version: "0.2.0-test" });
    server = await startBridgeServer({
      host: "127.0.0.1",
      port: 0,
      config,
      sessions,
      version: "0.2.0-test",
    });
  }

  async function session(mode: PermissionMode, autoAllow = false) {
    const client = await openClient(server!.url, token, autoAllow);
    await client.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { _meta: { ping: true } },
    });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: mode },
    })) as { sessionId: string };
    return { client, sessionId: created.sessionId };
  }

  it("plan mode blocks direct writes and terminal calls", async () => {
    await boot({ mode: "plan", env: { FAKE_ACP_FS_WRITE: "1" } });
    const write = await session("plan");
    await write.client.call("session/prompt", {
      sessionId: write.sessionId,
      prompt: [{ type: "text", text: "edit" }],
    });
    expect(texts(write.client.updates).join("\n")).toMatch(/write failed:.*plan mode rejects/);
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("# test\n");
    await write.client.close();

    await boot({ mode: "plan", env: { FAKE_ACP_TERMINAL: "1" } });
    const term = await session("plan");
    await term.client.call("session/prompt", {
      sessionId: term.sessionId,
      prompt: [{ type: "text", text: "run" }],
    });
    expect(texts(term.client.updates).join("\n")).toMatch(/terminal failed:.*plan mode rejects/);
    await term.client.close();
  });

  it("auto-edit allows the approved file write and still blocks a terminal", async () => {
    await boot({ mode: "auto-edit", env: { FAKE_ACP_FS_WRITE: "1", FAKE_ACP_TERMINAL: "1" } });
    const { client, sessionId } = await session("auto-edit");
    await client.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "edit" }],
    });
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("agent write\n");
    expect(texts(client.updates).join("\n")).toMatch(/terminal failed/);
    await client.close();
  });

  it("ask mode requires an approval grant before writing or running a command", async () => {
    await boot({ mode: "ask", env: { FAKE_ACP_FS_WRITE: "1" } });
    const denied = await session("ask");
    await denied.client.call("session/prompt", {
      sessionId: denied.sessionId,
      prompt: [{ type: "text", text: "edit" }],
    });
    expect(texts(denied.client.updates).join("\n")).toMatch(/write requires approval/);
    await denied.client.close();

    await boot({
      mode: "ask",
      env: { FAKE_ACP_FS_WRITE: "1", FAKE_ACP_PERMISSION: "1" },
    });
    const allowed = await session("ask", true);
    await allowed.client.call("session/prompt", {
      sessionId: allowed.sessionId,
      prompt: [{ type: "text", text: "edit" }],
    });
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("agent write\n");
    await allowed.client.close();
  });

  it("ask mode runs a terminal only after an execute approval", async () => {
    await boot({
      mode: "ask",
      env: { FAKE_ACP_TERMINAL: "1", FAKE_ACP_PERMISSION: "1", FAKE_ACP_PERMISSION_KIND: "execute" },
    });
    const { client, sessionId } = await session("ask", true);
    await client.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "run" }],
    });
    expect(texts(client.updates).join("\n")).not.toMatch(/terminal failed/);
    expect(texts(client.updates).join("\n")).toMatch(/Echo: run/);
    await client.close();
  });

  it("forwards agent modes, permission changes, auth hints, and recent workspaces", async () => {
    const dump = join(tmpdir(), `gb-dump-${Date.now()}.json`);
    await boot({
      mode: "auto-edit",
      env: { FAKE_ACP_AUTH: "1", FAKE_ACP_DUMP: dump, FAKE_ACP_FS_WRITE: "1" },
    });
    const client = await openClient(server!.url, token);
    const init = (await client.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { _meta: { ping: true } },
    })) as {
      authMethods: unknown[];
      agentCapabilities: { sessionCapabilities: { additionalDirectories?: unknown } };
      _meta: { bridge: { permissionModes: Array<{ id: string }> } };
    };
    expect(init.agentCapabilities?.sessionCapabilities?.additionalDirectories).toEqual({});
    expect(init.authMethods).toEqual([]);
    expect(init._meta.bridge.permissionModes.map((m) => m.id)).toEqual([
      "ask",
      "auto-edit",
      "plan",
      "full-auto",
    ]);

    const nested = join(workspace, "app");
    mkdirSync(nested);
    writeFileSync(join(nested, "README.md"), "# nested\n");
    const created = (await client.call("session/new", {
      cwd: nested,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "auto-edit" },
    })) as {
      sessionId: string;
      modes: { currentModeId: string };
      _meta: { authMethods?: Array<{ id: string }>; agentInfo?: { name: string } };
    };
    expect(created.modes.currentModeId).toBe("agent");
    expect(created._meta.agentInfo?.name).toBe("fake-acp-agent");
    expect(created._meta.authMethods?.[0]?.id).toBe("fake_login");

    const dumped = JSON.parse(readFileSync(dump, "utf8")) as {
      clientCapabilities: { terminal?: boolean; _meta?: { ping?: boolean } };
    };
    expect(dumped.clientCapabilities.terminal).toBe(true);
    expect(dumped.clientCapabilities._meta?.ping).toBe(true);

    const saved = JSON.parse(readFileSync(configPath(), "utf8")) as { workspaces: string[] };
    expect(saved.workspaces[0]).toBe(nested);

    const forwarded = (await client.call("session/set_mode", {
      sessionId: created.sessionId,
      modeId: "agent",
    })) as { forwarded: boolean; permissionMode?: string };
    expect(forwarded.forwarded).toBe(true);
    expect(forwarded.permissionMode).toBeUndefined();

    await client.call("session/set_mode", { sessionId: created.sessionId, modeId: "plan" });
    await client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "later" }],
    });
    expect(texts(client.updates).join("\n")).toMatch(/write failed:.*plan mode/);
    expect(readFileSync(join(nested, "README.md"), "utf8")).toBe("# nested\n");

    const diag = (await client.call("bridge/diagnostics")) as { log: unknown; harnesses: unknown };
    const blob = JSON.stringify(diag);
    expect(blob).not.toContain(token);
    expect(diag.harnesses).toBeTruthy();
    await client.close();
    rmSync(dump, { force: true });
  });

  it("returns install details when a harness command is missing", async () => {
    await boot({
      mode: "ask",
      extraHarness: {
        id: "missing",
        name: "Missing",
        command: "gradation-bridge-missing-bin",
        args: ["--api-key", "sk-supersecretvalue"],
        env: { ANTHROPIC_API_KEY: "should-not-leak" },
      },
    });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    let err: RpcError | undefined;
    try {
      await client.call("session/new", {
        cwd: workspace,
        mcpServers: [],
        _meta: { harness: "missing", permissionMode: "ask" },
      });
    } catch (e) {
      err = e as RpcError;
    }
    expect(err).toBeInstanceOf(RpcError);
    expect(err?.code).toBe(-32010);
    const data = err?.data as { readiness?: string; args?: string[]; install?: string };
    expect(data.readiness).toBe("missing");
    expect(data.install).toBeTruthy();
    expect(JSON.stringify(data)).not.toContain("sk-supersecretvalue");
    expect(JSON.stringify(data)).not.toContain("should-not-leak");
    await client.close();
  });

  it("drops an in-flight approval when the permission mode changes", async () => {
    await boot({
      mode: "ask",
      env: { FAKE_ACP_PERMISSION: "1", FAKE_ACP_FS_WRITE: "1" },
    });
    let sessionId = "";
    let client!: Awaited<ReturnType<typeof openClient>>;
    client = await openClient(server!.url, token, false, {
      beforeAllow: async () => {
        await client.call("bridge/setPermissionMode", { sessionId, permissionMode: "plan" });
      },
    });
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };
    sessionId = created.sessionId;
    const result = (await client.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "edit" }],
    })) as { stopReason: string };
    expect(result.stopReason).toBe("cancelled");
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("# test\n");
    await client.close();
  });

  it("refuses a write that arrives after the prompt was cancelled", async () => {
    await boot({
      mode: "auto-edit",
      env: { FAKE_ACP_FS_WRITE: "1", FAKE_ACP_IGNORE_CANCEL: "1", FAKE_ACP_SLOW_MS: "300" },
    });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "auto-edit" },
    })) as { sessionId: string };
    const pending = client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "edit" }],
    });
    const deadline = Date.now() + 5_000;
    while (client.updates.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    client.notify("session/cancel", { sessionId: created.sessionId });
    await pending;
    expect(texts(client.updates).join("\n")).toMatch(/write failed:.*cancel/i);
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("# test\n");
    await client.close();
  });
});
