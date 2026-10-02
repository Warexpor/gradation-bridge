import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ensureDirs, saveConfig } from "../src/config/load.js";
import type { BridgeConfig } from "../src/config/types.js";
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
  answer?: (method: string, params: unknown) => unknown,
) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const inbound: Array<{ method?: string; params?: unknown }> = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
      params?: unknown;
    };
    if (msg.id != null && msg.method === undefined) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new RpcError(msg.error.message, msg.error.code, msg.error.data));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.method) inbound.push({ method: msg.method, params: msg.params });
    if (answer && msg.method && msg.id != null) {
      const result = answer(msg.method, msg.params);
      if (result !== undefined) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      }
    }
  });
  return {
    inbound,
    call: (method: string, params?: unknown) => {
      const id = nextId++;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }, 15_000);
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


async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = readFileSync(path, "utf8");
      if (text.trim().length > 0) {
        JSON.parse(text);
        return text;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${path}`);
}

describe("auth and elicitation relay", () => {
  let restore: (() => void) | undefined;
  let server: BridgeServer | undefined;
  let sessions: SessionManager | undefined;
  let workspace: string;
  let token: string;
  let root: string;
  const roots: string[] = [];

  afterEach(async () => {
    await server?.close();
    server = undefined;
    restore?.();
    restore = undefined;
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function boot(
    envFor: (paths: { root: string; workspace: string }) => Record<string, string>,
  ): Promise<void> {
    if (server) {
      await server.close();
      server = undefined;
    }
    restore?.();
    root = mkdtempSync(join(tmpdir(), "gb-auth-"));
    roots.push(root);
    restore = useEnv(root);
    workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "README.md"), "# test\n");
    ensureDirs();
    const env = envFor({ root, workspace });
    const config: BridgeConfig = {
      allowedRoots: [workspace],
      workspaces: [],
      defaultPermissionMode: "ask",
      port: 0,
      harnesses: [{ ...fakeHarnessConfig(fakeAgent), env }],
    };
    saveConfig(config);
    token = ensurePrimaryToken().token;
    sessions = new SessionManager({ config, version: "0.4.0-test" });
    server = await startBridgeServer({
      host: "127.0.0.1",
      port: 0,
      config,
      sessions,
      version: "0.4.0-test",
    });
  }

  it("stays on ACP 1 and relays authenticate, elicitation, and logout on one process", async () => {
    const dump = join(tmpdir(), `gb-auth-dump-${Date.now()}.json`);
    await boot(() => ({
      FAKE_ACP_AUTH_REQUIRED: "1",
      FAKE_ACP_ELICIT_FORM: "1",
      FAKE_ACP_LOGOUT: "1",
      FAKE_ACP_TRACE: join(root, "trace.txt"),
      FAKE_ACP_DUMP: dump,
    }));
    const client = await openClient(server!.url, token, (method, params) => {
      if (method !== "elicitation/create") return undefined;
      const body = params as { mode?: string; requestedSchema?: { properties?: Record<string, unknown> } };
      expect(body.mode).toBe("form");
      expect(body.requestedSchema?.properties).toHaveProperty("name");
      return { action: "accept", content: { name: "Ada" } };
    });
    const init = (await client.call("initialize", {
      protocolVersion: 2,
      clientCapabilities: {
        elicitation: { form: {} },
        auth: { terminal: true },
      },
    })) as { protocolVersion: number; authMethods: unknown[] };
    expect(init.protocolVersion).toBe(1);
    expect(init.authMethods).toEqual([]);

    let startErr: RpcError | undefined;
    try {
      await client.call("session/new", {
        cwd: workspace,
        mcpServers: [],
        _meta: { harness: "fake", permissionMode: "ask" },
      });
    } catch (e) {
      startErr = e as RpcError;
    }
    expect(startErr?.code).toBe(-32011);
    const methods = (startErr?.data as { authMethods?: Array<{ id: string; type: string }> }).authMethods;
    expect(methods?.[0]).toMatchObject({ id: "fake_login", type: "agent" });
    expect(JSON.stringify(startErr?.data)).not.toContain("super-secret-token");
    const dumped = JSON.parse(readFileSync(dump, "utf8")) as {
      protocolVersion: number;
      clientCapabilities: { auth?: { terminal?: boolean }; terminal?: boolean };
    };
    expect(dumped.protocolVersion).toBe(1);
    expect(dumped.clientCapabilities.terminal).toBe(true);
    expect(dumped.clientCapabilities.auth?.terminal).toBe(false);

    const authed = (await client.call("authenticate", {
      methodId: "fake_login",
      _meta: { harness: "fake", cwd: workspace },
    })) as { _meta: { authenticated: boolean; logout: boolean } };
    expect(authed._meta.authenticated).toBe(true);
    expect(authed._meta.logout).toBe(true);

    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string; _meta: { logout?: boolean } };
    expect(created._meta.logout).toBe(true);
    const lines = readFileSync(join(root, "trace.txt"), "utf8").trim().split("\n");
    const pids = lines.map((line) => line.split(" ").at(-1));
    expect(lines.some((line) => line.startsWith("auth fake_login "))).toBe(true);
    expect(lines.some((line) => line.startsWith("new "))).toBe(true);
    const authPid = lines.find((line) => line.startsWith("auth "))?.split(" ").at(-1);
    const newPid = lines.find((line) => line.startsWith("new "))?.split(" ").at(-1);
    expect(authPid).toBe(newPid);
    expect(new Set(pids).size).toBeGreaterThan(1);

    await client.call("logout", { sessionId: created.sessionId });
    await expect(
      client.call("session/new", {
        cwd: workspace,
        mcpServers: [],
        _meta: { harness: "fake", permissionMode: "ask" },
      }),
    ).rejects.toThrow(/auth_required/);
    await client.close();
    rmSync(dump, { force: true });
  }, 20_000);

  it("accepts auth/login when the harness does not implement authenticate", async () => {
    await boot(() => ({
      FAKE_ACP_AUTH_REQUIRED: "1",
      FAKE_ACP_AUTH_ALIAS: "1",
      FAKE_ACP_TRACE: join(root, "trace.txt"),
    }));
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    await client.call("auth/login", {
      methodId: "fake_login",
      _meta: { harness: "fake", cwd: workspace },
    });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };
    expect(created.sessionId).toBeTruthy();
    const lines = readFileSync(join(root, "trace.txt"), "utf8");
    expect(lines).toMatch(/auth fake_login/);
    const authLine = lines.split("\n").find((line) => line.startsWith("auth "));
    const newLine = lines.split("\n").find((line) => line.startsWith("new "));
    expect(authLine?.split(" ").at(-1)).toBe(newLine?.split(" ").at(-1));
    await client.close();
  }, 20_000);

  it("does not relay terminal auth env to the phone", async () => {
    await boot(() => ({ FAKE_ACP_AUTH_TERMINAL: "1", FAKE_ACP_AUTH: "1" }));
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string; _meta: { authMethods?: Array<{ id: string; type?: string; args?: string[] }> } };
    const blob = JSON.stringify(created);
    expect(blob).not.toContain("super-secret-token");
    expect(blob).not.toContain("LEAK_TOKEN");
    const terminal = created._meta.authMethods?.find((method) => method.id === "term_login");
    expect(terminal).toMatchObject({ type: "terminal", args: ["--login"] });
    let err: RpcError | undefined;
    try {
      await client.call("authenticate", {
        methodId: "term_login",
        sessionId: created.sessionId,
      });
    } catch (e) {
      err = e as RpcError;
    }
    expect(err?.code).toBe(-32602);
    expect(err?.message).toMatch(/terminal/);
    expect(JSON.stringify(err?.data)).not.toContain("super-secret-token");
    await client.close();
  }, 20_000);

  it("blocks secret forms and credential urls, and forwards a plain https url", async () => {
    await boot(() => ({ FAKE_ACP_ELICIT_SECRET: "1" }));
    const secretClient = await openClient(server!.url, token);
    await secretClient.call("initialize", { protocolVersion: 1 });
    const secretSession = (await secretClient.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };
    const secretResult = (await secretClient.call("session/prompt", {
      sessionId: secretSession.sessionId,
      prompt: [{ type: "text", text: "go" }],
    })) as { stopReason: string };
    expect(secretResult.stopReason).toBe("end_turn");
    expect(JSON.stringify(secretClient.inbound)).not.toContain("password");
    expect(JSON.stringify(secretClient.inbound)).toContain("elicitation-blocked");
    await secretClient.close();

    await boot(() => ({ FAKE_ACP_ELICIT_URL: "http://user:pass@example.com/hook" }));
    const badClient = await openClient(server!.url, token, (method) => {
      if (method === "elicitation/create") return { action: "accept" };
      return undefined;
    });
    await badClient.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { url: {} } },
    });
    const badSession = (await badClient.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };
    await badClient.call("session/prompt", {
      sessionId: badSession.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    expect(JSON.stringify(badClient.inbound)).not.toContain("user:pass");
    expect(JSON.stringify(badClient.inbound)).toContain("elicitation-blocked");
    await badClient.close();

    await boot(() => ({ FAKE_ACP_ELICIT_URL: "https://example.com/connect" }));
    const okClient = await openClient(server!.url, token, (method, params) => {
      if (method !== "elicitation/create") return undefined;
      expect((params as { url?: string }).url).toBe("https://example.com/connect");
      return { action: "accept" };
    });
    await okClient.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { url: {} } },
    });
    const okSession = (await okClient.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };
    await okClient.call("session/prompt", {
      sessionId: okSession.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    expect(JSON.stringify(okClient.inbound)).toContain("https://example.com/connect");
    expect(JSON.stringify(okClient.inbound)).toContain("Echo: go");
    await okClient.close();
  }, 20_000);

  it("refuses a second pre-session login and drops a warm process whose env changed", async () => {
    await boot(() => ({
      FAKE_ACP_AUTH_REQUIRED: "1",
      FAKE_ACP_AUTH_HOLD_MS: "400",
      FAKE_ACP_TRACE: join(root, "trace.txt"),
      TOKEN_A: "one",
    }));
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const first = client.call("authenticate", {
      methodId: "fake_login",
      _meta: { harness: "fake", cwd: workspace },
    });
    const second = client.call("authenticate", {
      methodId: "fake_login",
      _meta: { harness: "fake", cwd: workspace },
    });
    await expect(second).rejects.toMatchObject({ code: -32005 });
    await first;
    sessions!.updateConfig({
      ...sessions!.config,
      harnesses: sessions!.config.harnesses.map((harness) => ({
        ...harness,
        env: { ...(harness.env ?? {}), TOKEN_A: "two" },
      })),
    });
    await expect(
      client.call("session/new", {
        cwd: workspace,
        mcpServers: [],
        _meta: { harness: "fake", permissionMode: "ask" },
      }),
    ).rejects.toThrow(/auth_required/);
    await client.close();
  }, 20_000);

  it("rewrites a foreign elicitation session id and cancels with action cancel", async () => {
    const dump = join(tmpdir(), `gb-elicit-dump-${Date.now()}.json`);
    await boot(() => ({
      FAKE_ACP_ELICIT_URL: "https://example.com/connect",
      FAKE_ACP_ELICIT_FOREIGN: "1",
      FAKE_ACP_ELICIT_DUMP: dump,
      FAKE_ACP_AUTH: "1",
      FAKE_ACP_LOGOUT: "1",
    }));
    const client = await openClient(server!.url, token);
    await client.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { url: {} } },
    });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string; _meta: { logout?: boolean; authMethods?: Array<{ id: string }> } };
    expect(created._meta.logout).toBe(true);
    expect(created._meta.authMethods?.[0]?.id).toBe("fake_login");
    const prompt = client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    const seen = await waitFor(
      () => client.inbound.find((msg) => msg.method === "elicitation/create")?.params,
    );
    const body = seen as { sessionId?: string; url?: string };
    expect(body.sessionId).toBe(created.sessionId);
    expect(body.sessionId).not.toBe("victim-session");
    expect(body.url).toBe("https://example.com/connect");
    await client.call("session/cancel", { sessionId: created.sessionId });
    await prompt;
    const dumped = JSON.parse(await waitForFile(dump)) as { action?: string };
    expect(dumped).toEqual({ action: "cancel" });
    const listed = (await client.call("session/list", {})) as {
      sessions: Array<{ sessionId: string; _meta?: { logout?: boolean; authMethods?: Array<{ id: string }> } }>;
    };
    expect(listed.sessions.find((s) => s.sessionId === created.sessionId)?._meta).toMatchObject({
      logout: true,
      authMethods: [expect.objectContaining({ id: "fake_login", type: "agent" })],
    });
    await client.close();
    rmSync(dump, { force: true });
  }, 20_000);
});

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting");
}
