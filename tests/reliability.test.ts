import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function openClient(url: string, token: string, answer?: (method: string, params: unknown) => unknown) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const inbound: Array<{ id?: number; method?: string; params?: unknown }> = [];
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
    if (msg.method) inbound.push({ id: msg.id, method: msg.method, params: msg.params });
    if (answer && msg.method && msg.id != null) {
      const result = answer(msg.method, msg.params);
      if (result !== undefined) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      }
    }
  });
  return {
    inbound,
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

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < 8_000) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting");
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

describe("protocol and process reliability", () => {
  let restore: (() => void) | undefined;
  let server: BridgeServer | undefined;
  let workspace: string;
  let token: string;
  let root: string;
  const roots: string[] = [];
  const extras: string[] = [];

  function tempFile(name: string): string {
    const path = join(tmpdir(), `gb-rel-${process.pid}-${Date.now()}-${name}`);
    extras.push(path);
    return path;
  }

  afterEach(async () => {
    await server?.close();
    server = undefined;
    restore?.();
    restore = undefined;
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const file of extras.splice(0)) rmSync(file, { force: true });
  });

  async function boot(
    env: Record<string, string>,
    opts?: { harnessId?: string },
  ): Promise<void> {
    if (server) {
      await server.close();
      server = undefined;
    }
    restore?.();
    root = mkdtempSync(join(tmpdir(), "gb-rel-"));
    roots.push(root);
    restore = useEnv(root);
    workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "README.md"), "# test\n");
    ensureDirs();
    const config: BridgeConfig = {
      allowedRoots: [workspace],
      workspaces: [],
      defaultPermissionMode: "ask",
      port: 0,
      harnesses: [
        {
          ...fakeHarnessConfig(fakeAgent),
          ...(opts?.harnessId ? { id: opts.harnessId } : {}),
          env,
        },
      ],
    };
    saveConfig(config);
    token = ensurePrimaryToken().token;
    const sessions = new SessionManager({ config, version: "0.4.2-test" });
    server = await startBridgeServer({
      host: "127.0.0.1",
      port: 0,
      config,
      sessions,
      version: "0.4.2-test",
    });
  }

  it("replays a finished authenticate instead of spawning another process", async () => {
    const trace = tempFile("trace.txt");
    await boot({
      FAKE_ACP_AUTH: "1",
      FAKE_ACP_AUTH_REQUIRED: "1",
      FAKE_ACP_TRACE: trace,
    });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const first = await client.call("authenticate", {
      methodId: "fake_login",
      _meta: { harness: "fake", cwd: workspace },
    });
    const second = await client.call("authenticate", {
      methodId: "fake_login",
      _meta: { harness: "fake", cwd: workspace },
    });
    expect(first).toMatchObject({ _meta: { authenticated: true } });
    expect(second).toMatchObject({ _meta: { authenticated: true } });
    const lines = readFileSync(trace, "utf8").trim().split("\n");
    expect(lines.filter((line) => line.startsWith("auth "))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("init "))).toHaveLength(1);
    await client.close();
  }, 20_000);

  it("waits for an in-flight login before session/new", async () => {
    const trace = tempFile("hold-trace.txt");
    await boot({
      FAKE_ACP_AUTH: "1",
      FAKE_ACP_AUTH_REQUIRED: "1",
      FAKE_ACP_AUTH_HOLD_MS: "400",
      FAKE_ACP_TRACE: trace,
    });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const auth = client.call("authenticate", {
      methodId: "fake_login",
      _meta: { harness: "fake", cwd: workspace },
    });
    await waitFor(() => (existsSync(trace) ? readFileSync(trace, "utf8") : undefined));
    const created = client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    });
    await auth;
    const session = (await created) as { sessionId: string };
    expect(session.sessionId).toBeTruthy();
    const lines = readFileSync(trace, "utf8").trim().split("\n");
    const authLine = lines.find((line) => line.startsWith("auth "));
    const newLine = lines.find((line) => line.startsWith("new "));
    expect(lines.filter((line) => line.startsWith("init "))).toHaveLength(1);
    expect(authLine?.split(" ").at(-1)).toBe(newLine?.split(" ").at(-1));
    await client.close();
  }, 20_000);

  it("aborts an in-flight authenticate on $/cancel_request", async () => {
    const trace = tempFile("cancel-trace.txt");
    await boot({
      FAKE_ACP_AUTH: "1",
      FAKE_ACP_AUTH_REQUIRED: "1",
      FAKE_ACP_AUTH_HOLD_MS: "4000",
      FAKE_ACP_TRACE: trace,
    });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const auth = client.call("authenticate", {
      methodId: "fake_login",
      _meta: { harness: "fake", cwd: workspace },
    });
    await waitFor(() => (existsSync(trace) ? "up" : undefined));
    client.notify("$/cancel_request", { requestId: 2 });
    const err = await auth.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32800);
    await expect(
      client.call("session/new", {
        cwd: workspace,
        mcpServers: [],
        _meta: { harness: "fake", permissionMode: "ask" },
      }),
    ).rejects.toThrow(/auth/);
    const lines = readFileSync(trace, "utf8");
    expect(lines).not.toMatch(/^auth /m);
    await client.close();
  }, 20_000);

  it("cancels elicitation when the harness sends $/cancel_request", async () => {
    const dump = tempFile("cancel-elicit.json");
    await boot({
      FAKE_ACP_ELICIT_URL: "https://example.com/connect",
      FAKE_ACP_CANCEL_ELICIT: "1",
      FAKE_ACP_ELICIT_DUMP: dump,
    });
    const client = await openClient(server!.url, token, (method) => {
      if (method === "elicitation/create") return { action: "accept", content: { name: "late" } };
      return undefined;
    });
    await client.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { url: {} } },
    });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };
    await client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    expect(JSON.parse(readFileSync(dump, "utf8"))).toEqual({ action: "cancel" });
    const cancel = client.inbound.find((msg) => msg.method === "$/cancel_request");
    expect(cancel?.params).toMatchObject({ requestId: expect.any(Number) });
    expect(JSON.stringify(client.inbound)).not.toContain("agent-");
    await client.close();
  }, 20_000);

  it("does not accept elicitation after the session was cancelled", async () => {
    const dump = tempFile("late-elicit.json");
    await boot({
      FAKE_ACP_ELICIT_URL: "https://example.com/connect",
      FAKE_ACP_ELICIT_IGNORE_CANCEL: "1",
      FAKE_ACP_ELICIT_DUMP: dump,
      FAKE_ACP_SLOW_MS: "400",
    });
    const client = await openClient(server!.url, token, (method) => {
      if (method === "elicitation/create") return { action: "accept" };
      return undefined;
    });
    await client.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { url: {} } },
    });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };
    const prompt = client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    await waitFor(() => client.inbound.find((msg) => msg.method === "session/update"));
    await client.call("session/cancel", { sessionId: created.sessionId });
    await prompt;
    expect(JSON.parse(await waitForFile(dump))).toEqual({ action: "cancel" });
    expect(client.inbound.some((msg) => msg.method === "elicitation/create")).toBe(false);
    await client.close();
  }, 20_000);

  it("treats $/cancel_request of session/prompt like session/cancel", async () => {
    await boot({ FAKE_ACP_SLOW_MS: "500" });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };
    const prompt = client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "slow" }],
    });
    await waitFor(() => client.inbound.find((msg) => msg.method === "session/update"));
    client.notify("$/cancel_request", { requestId: 3 });
    await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
    await client.close();
  }, 20_000);

  it("answers a cancelled prompt immediately when the harness ignores cancel", async () => {
    await boot({
      FAKE_ACP_SLOW_MS: "3000",
      FAKE_ACP_IGNORE_CANCEL: "1",
    });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };
    const prompt = client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "slow" }],
    });
    await waitFor(() => client.inbound.find((msg) => msg.method === "session/update"));
    const started = Date.now();
    client.notify("$/cancel_request", { requestId: 3 });
    await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(Date.now() - started).toBeLessThan(1500);
    await client.close();
  }, 20_000);

  it("uses -32004 when set_mode needs a dead agent, and rejects a mismatched load cwd", async () => {
    await boot({ FAKE_ACP_EXIT_AFTER_PROMPT: "1" });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };
    const other = join(workspace, "other");
    mkdirSync(other);
    await expect(
      client.call("session/load", {
        sessionId: created.sessionId,
        cwd: other,
        mcpServers: [],
        _meta: { afterSeq: 0 },
      }),
    ).rejects.toThrow(/does not match/);
    await expect(
      client.call("session/load", {
        sessionId: created.sessionId,
        cwd: "/etc",
        mcpServers: [],
      }),
    ).rejects.toThrow(/outside allowed/);
    await client.call("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "die" }],
    });
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
    const err = await client
      .call("session/set_mode", { sessionId: created.sessionId, modeId: "agent" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32004);
    await client.close();
  }, 20_000);


  it("prompts and cancels when the phone sends sessionId as a number or \"42.0\"", async () => {
    await boot({
      FAKE_ACP_SESSION_ID: "42",
      FAKE_ACP_SESSION_AS_NUMBER: "1",
      FAKE_ACP_SLOW_MS: "400",
    });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };
    expect(created.sessionId).toBe("42");
    const prompt = client.call("session/prompt", {
      sessionId: "42.0",
      prompt: [{ type: "text", text: "go" }],
    });
    await waitFor(() => client.inbound.find((msg) => msg.method === "session/update"));
    await client.call("session/cancel", { sessionId: 42 });
    const result = (await prompt) as { stopReason?: string };
    expect(result.stopReason).toBe("cancelled");
    await client.close();
  }, 20_000);

  it("starts a session when _meta.harness arrives as a number or \"5.0\"", async () => {
    await boot({}, { harnessId: "5" });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: 5, permissionMode: "ask" },
    })) as { sessionId: string; _meta?: { harness?: string } };
    expect(created._meta?.harness).toBe("5");
    await client.close();

    await boot({}, { harnessId: "5" });
    const client2 = await openClient(server!.url, token);
    await client2.call("initialize", { protocolVersion: 1 });
    const created2 = (await client2.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "5.0", permissionMode: "ask" },
    })) as { sessionId: string; _meta?: { harness?: string } };
    expect(created2._meta?.harness).toBe("5");
    await client2.close();
  }, 20_000);

  it("forwards digit-string model / modeId / configId sent as JSON numbers or \"5.0\"", async () => {
    const dumpNew = tempFile("dump-new.json");
    await boot({ FAKE_ACP_DUMP_NEW: dumpNew });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask", model: 5 },
    })) as { sessionId: string; configOptions?: Array<{ currentValue?: string }> };
    expect(created.configOptions?.[0]?.currentValue).toBe("5");
    const dumped = JSON.parse(await waitForFile(dumpNew)) as {
      _meta?: { model?: unknown };
    };
    expect(dumped._meta?.model).toBe("5");

    await client.call("session/set_mode", { sessionId: created.sessionId, modeId: "5.0" });
    await client.call("session/set_mode", { sessionId: created.sessionId, modeId: 5 });

    const configured = (await client.call("session/set_config_option", {
      sessionId: created.sessionId,
      configId: 7,
      value: "9.0",
    })) as { configOptions: Array<{ id?: string; currentValue?: string }> };
    expect(configured.configOptions[0]?.id).toBe("7");
    expect(configured.configOptions[0]?.currentValue).toBe("9");

    await client.call("session/close", { sessionId: created.sessionId });
    const dumpNew2 = tempFile("dump-new-2.json");
    await boot({ FAKE_ACP_DUMP_NEW: dumpNew2 });
    const client2 = await openClient(server!.url, token);
    await client2.call("initialize", { protocolVersion: 1 });
    const created2 = (await client2.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask", model: "5.0" },
    })) as { configOptions?: Array<{ currentValue?: string }> };
    expect(created2.configOptions?.[0]?.currentValue).toBe("5");
    const dumped2 = JSON.parse(await waitForFile(dumpNew2)) as {
      _meta?: { model?: unknown };
    };
    expect(dumped2._meta?.model).toBe("5");
    await client2.close();
  }, 20_000);

  it("ignores stdout from a harness that was already replaced", async () => {
    await boot({ FAKE_ACP_WRITE_ON_TERM: "1" });
    const client = await openClient(server!.url, token);
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: { harness: "fake", permissionMode: "ask" },
    })) as { sessionId: string };
    await client.call("session/close", { sessionId: created.sessionId });
    await new Promise((r) => setTimeout(r, 200));
    expect(JSON.stringify(client.inbound)).not.toContain("stale-after-kill");
    await client.close();
  }, 20_000);
});

