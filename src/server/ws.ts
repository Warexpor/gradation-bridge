/**
 * WebSocket JSON-RPC 2.0 server on path `/v1` with bearer token auth.
 * Relays ACP session methods to harness processes and answers bridge/* extensions.
 */

import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { parseAuthorizationHeader, verifyBearerToken } from "../auth/token.js";
import { PERMISSION_MODES } from "../approval/policy.js";
import type { BridgeConfig, PermissionMode } from "../config/types.js";
import { saveConfig } from "../config/load.js";
import { BridgeError } from "../errors.js";
import { listHarnesses } from "../harness/registry.js";
import { log, recentLogs } from "../log/diagnostics.js";
import { SessionManager, SandboxError } from "../session/manager.js";
import { assertAllowedRealPath } from "../approval/sandbox.js";
import { getGitDiff, getGitStatus } from "../git/status.js";
import { parseRpcFrame, type JsonRpcMessage } from "./frames.js";
import { SocketOutbox } from "./outbox.js";

export interface WsServerOptions {
  host: string;
  port: number;
  config: BridgeConfig;
  sessions: SessionManager;
  tls?: { keyPem: string; certPem: string };
  version: string;
}

interface BridgeSocket extends WebSocket {
  isAlive?: boolean;
  bridgeToken?: string;
}

interface PendingPhone {
  resolve: (v: { result?: unknown; error?: unknown; requestId: string | number }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  frame: unknown;
  params: unknown;
}

const outboxes = new WeakMap<WebSocket, SocketOutbox>();

function send(ws: WebSocket, obj: unknown, droppable = false): boolean {
  const box = outboxes.get(ws);
  if (box) return box.trySend(obj, droppable);
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function sendImportant(ws: WebSocket, obj: unknown): Promise<boolean> {
  const box = outboxes.get(ws);
  if (!box) return Promise.resolve(send(ws, obj, false));
  return box.send(obj);
}

export interface BridgeServer {
  close(): Promise<void>;
  readonly url: string;
  readonly port: number;
}

const VALID_MODES = new Set<PermissionMode>(["ask", "auto-edit", "plan", "full-auto"]);

function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  const fromHeader = parseAuthorizationHeader(Array.isArray(auth) ? auth[0] : auth);
  if (fromHeader) return fromHeader;
  try {
    const u = new URL(req.url ?? "/", "http://localhost");
    return u.searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}

export async function startBridgeServer(opts: WsServerOptions): Promise<BridgeServer> {
  const useTls = Boolean(opts.tls?.certPem.includes("BEGIN CERTIFICATE"));
  let httpServer: HttpServer | HttpsServer;

  if (useTls && opts.tls) {
    httpServer = createHttpsServer({ key: opts.tls.keyPem, cert: opts.tls.certPem });
  } else {
    httpServer = createHttpServer();
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const clients = new Set<BridgeSocket>();
  let phoneReqId = 1;
  const pendingPhone = new Map<string | number, PendingPhone>();

  const fanout = (msg: unknown, droppable = false): void => {
    for (const ws of clients) send(ws, msg, droppable);
  };

  const broadcast = (msg: unknown, broadcastOpts?: { droppable?: boolean }): void => {
    fanout(msg, broadcastOpts?.droppable === true);
  };

  const resendPending = (ws: WebSocket): void => {
    for (const pending of pendingPhone.values()) {
      send(ws, pending.frame, false);
    }
  };

  const cancelPhoneRequests = (sessionId: string): void => {
    for (const [id, pending] of pendingPhone) {
      const params = pending.params as { sessionId?: string } | null;
      if (!params || typeof params !== "object" || params.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      pendingPhone.delete(id);
      pending.resolve({
        result: { outcome: { outcome: "cancelled" } },
        requestId: id,
      });
    }
  };

  const requestPhone = (
    method: string,
    params: unknown,
  ): Promise<{ result?: unknown; error?: unknown; requestId: string | number }> => {
    const requestId = phoneReqId++;
    const frame = { jsonrpc: "2.0", id: requestId, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingPhone.delete(requestId);
        reject(new Error(`phone did not answer ${method}`));
      }, 300_000);
      pendingPhone.set(requestId, { resolve, reject, timer, frame, params });
      // Keep the request if every phone is briefly gone so a reconnect can answer.
      if (clients.size > 0) fanout(frame, false);
    });
  };

  opts.sessions.setHooks({ broadcast, requestPhone, cancelPhoneRequests });

  httpServer.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/v1") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const token = extractToken(req);
      if (!verifyBearerToken(token)) {
        log("warn", "rejected websocket upgrade: missing or invalid credentials");
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        (ws as BridgeSocket).bridgeToken = token;
        wss.emit("connection", ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    const sock = ws as BridgeSocket;
    sock.isAlive = true;
    clients.add(sock);
    outboxes.set(
      sock,
      new SocketOutbox(sock, {
        onDrop: (n) => {
          if (n === 1 || n % 100 === 0) {
            process.stderr.write(
              `warning: dropped ${n} outbound frame(s) due to backpressure\n`,
            );
          }
        },
      }),
    );
    resendPending(sock);
    sock.on("pong", () => {
      sock.isAlive = true;
    });
    sock.on("message", (raw, isBinary) => {
      if (isBinary) {
        send(sock, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request" },
        });
        return;
      }
      void handleMessage(sock, raw.toString(), opts, pendingPhone);
    });
    sock.on("error", () => {
      clients.delete(sock);
    });
    sock.on("close", () => {
      clients.delete(sock);
      outboxes.get(sock)?.dispose();
      outboxes.delete(sock);
    });
  });

  wss.on("error", (err) => {
    process.stderr.write(`websocket server error: ${err.message}\n`);
  });

  const ping = setInterval(() => {
    for (const sock of clients) {
      if (sock.isAlive === false) {
        sock.terminate();
        continue;
      }
      if (sock.bridgeToken && !verifyBearerToken(sock.bridgeToken)) {
        sock.close(1008, "unauthorized");
        continue;
      }
      sock.isAlive = false;
      try {
        sock.ping();
      } catch {
        sock.terminate();
      }
    }
  }, 20_000);
  ping.unref?.();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(opts.port, opts.host, () => {
      httpServer.off("error", onError);
      resolve();
    });
  });
  httpServer.on("error", (err) => {
    process.stderr.write(`http server error: ${err.message}\n`);
  });

  const scheme = useTls ? "wss" : "ws";
  const address = httpServer.address();
  const boundPort =
    typeof address === "object" && address ? address.port : opts.port;
  const url = `${scheme}://${opts.host}:${boundPort}/v1`;

  return {
    url,
    port: boundPort,
    close: async () => {
      clearInterval(ping);
      for (const [, p] of pendingPhone) {
        clearTimeout(p.timer);
        p.reject(new Error("server closing"));
      }
      pendingPhone.clear();
      for (const sock of clients) {
        outboxes.get(sock)?.dispose();
        outboxes.delete(sock);
        try {
          sock.terminate();
        } catch {
          // ignore
        }
      }
      clients.clear();
      await opts.sessions.closeAll();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => {
          if (err) reject(err);
          else httpServer.close((e) => (e ? reject(e) : resolve()));
        });
      });
    },
  };
}

async function handleMessage(
  ws: WebSocket,
  text: string,
  opts: WsServerOptions,
  pendingPhone: Map<string | number, PendingPhone>,
): Promise<void> {
  const parsed = parseRpcFrame(text);
  if (!parsed.ok) {
    send(ws, {
      jsonrpc: "2.0",
      id: parsed.id,
      error: { code: parsed.code, message: parsed.message },
    });
    return;
  }
  const msg: JsonRpcMessage = parsed.msg;
  try {
    await routeMessage(ws, msg, opts, pendingPhone);
  } catch {
    send(ws, {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      error: { code: -32603, message: "Internal error" },
    });
  }
}

async function routeMessage(
  ws: WebSocket,
  msg: JsonRpcMessage,
  opts: WsServerOptions,
  pendingPhone: Map<string | number, PendingPhone>,
): Promise<void> {

  // Phone answering a bridge→phone request (permission)
  if (
    msg.id != null &&
    msg.method === undefined &&
    (msg.result !== undefined || msg.error !== undefined)
  ) {
    const pending = pendingPhone.get(msg.id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingPhone.delete(msg.id);
      pending.resolve({ result: msg.result, error: msg.error, requestId: msg.id });
    }
    return;
  }

  if (!msg.method) {
    send(ws, {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      error: { code: -32600, message: "Invalid Request" },
    });
    return;
  }

  // Notifications from phone (no response)
  if (msg.id === undefined || msg.id === null) {
    try {
      await dispatchNotification(msg.method, msg.params, opts);
    } catch {
      /* notifications don't get errors */
    }
    return;
  }

  try {
    const result = await dispatch(msg.method, msg.params, opts, ws);
    send(ws, { jsonrpc: "2.0", id: msg.id, result });
  } catch (e) {
    const err = e as Error & { code?: number; data?: unknown };
    const code = e instanceof SandboxError ? -32003 : (err.code ?? -32603);
    const data = e instanceof BridgeError ? e.data : err.data;
    send(ws, {
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code,
        message: err.message || "Internal error",
        ...(data !== undefined ? { data } : {}),
      },
    });
  }
}

async function dispatchNotification(
  method: string,
  params: unknown,
  opts: WsServerOptions,
): Promise<void> {
  const p = (params ?? {}) as Record<string, unknown>;
  if (method === "session/cancel") {
    opts.sessions.cancel(String(p.sessionId ?? ""));
  }
}

async function dispatch(
  method: string,
  params: unknown,
  opts: WsServerOptions,
  ws: WebSocket,
): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "initialize": {
      opts.sessions.notePhoneInitialize(p);
      const requested = p.protocolVersion;
      if (requested != null && requested !== 1) {
        log("warn", `phone requested protocolVersion ${String(requested)}; bridge speaks ACP 1`);
      }
      const harnesses = listHarnesses(opts.config).map(
        ({ id, name, available, readiness, detail, notice }) => ({
          id,
          name,
          available,
          readiness,
          detail,
          ...(notice ? { notice } : {}),
        }),
      );
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          sessionCapabilities: {
            list: {},
            close: {},
            resume: {},
            delete: {},
          },
        },
        // WebSocket bearer auth already happened. Per-harness auth is on session/new _meta.
        authMethods: [],
        agentInfo: { name: "gradation-bridge", version: opts.version },
        _meta: {
          bridge: {
            version: opts.version,
            harnesses,
            hostName: opts.config.hostName ?? hostname(),
            permissionModes: PERMISSION_MODES,
          },
        },
      };
    }
    case "bridge/diagnostics": {
      return {
        version: opts.version,
        permissionMode: opts.config.defaultPermissionMode,
        harnesses: listHarnesses(opts.config),
        sessions: opts.sessions.list().length,
        log: recentLogs(),
      };
    }
    case "bridge/setPermissionMode": {
      const sessionId = String(p.sessionId ?? "");
      const modeId = String(p.permissionMode ?? p.modeId ?? "");
      if (!VALID_MODES.has(modeId as PermissionMode)) {
        throw new BridgeError(-32602, `unknown permission mode: ${modeId}`, { modeId });
      }
      opts.sessions.setPermissionMode(sessionId, modeId as PermissionMode);
      return { permissionMode: modeId };
    }
    case "bridge/listHarnesses":
      return { harnesses: listHarnesses(opts.config) };
    case "bridge/listWorkspaces": {
      const roots = opts.config.allowedRoots ?? [];
      const recent = opts.config.workspaces ?? [];
      const workspaces = [...new Set([...recent, ...roots])];
      return { workspaces };
    }
    case "bridge/browse": {
      const path = String(p.path ?? "");
      const allowed = assertAllowedRealPath(path, opts.config.allowedRoots);
      const entries = readdirSync(allowed).map((name) => {
        let dir = false;
        try {
          dir = statSync(join(allowed, name)).isDirectory();
        } catch {
          dir = false;
        }
        return { name, dir };
      });
      return { entries };
    }
    case "bridge/listSessions": {
      const sessions = opts.sessions.list({
        limit: typeof p.limit === "number" ? p.limit : undefined,
        before: typeof p.before === "string" ? p.before : undefined,
      });
      return { sessions };
    }
    case "bridge/closeSession": {
      const sessionId = String(p.sessionId ?? "");
      await opts.sessions.closeSession(sessionId, { missing: "ignore" });
      return {};
    }
    case "session/list":
      return opts.sessions.listForProtocol({
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        cursor: typeof p.cursor === "string" ? p.cursor : undefined,
      });
    case "session/close": {
      const sessionId = String(p.sessionId ?? "");
      await opts.sessions.closeSession(sessionId, { missing: "error" });
      return {};
    }
    case "session/delete": {
      const sessionId = String(p.sessionId ?? "");
      await opts.sessions.deleteSession(sessionId);
      return {};
    }
    case "session/resume": {
      const sessionId = String(p.sessionId ?? "");
      return opts.sessions.resume(sessionId, {
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        mcpServers: Array.isArray(p.mcpServers) ? p.mcpServers : [],
      });
    }
    case "session/set_config_option": {
      const sessionId = String(p.sessionId ?? "");
      return opts.sessions.setConfigOption(sessionId, p);
    }
    case "bridge/diff": {
      const sessionId = String(p.sessionId ?? "");
      const filePath = String(p.path ?? "");
      const rec = opts.sessions.get(sessionId);
      if (!rec) {
        const err = new Error(`unknown session: ${sessionId}`) as Error & { code?: number };
        err.code = -32002;
        throw err;
      }
      // Ensure workspace still under allowed roots; resolve file via realpath.
      assertAllowedRealPath(rec.cwd, opts.config.allowedRoots);
      if (!filePath) {
        const err = new Error("path required") as Error & { code?: number };
        err.code = -32602;
        throw err;
      }
      const allowedFile = assertAllowedRealPath(filePath, opts.config.allowedRoots, rec.cwd);
      return getGitDiff(rec.cwd, allowedFile);
    }
    case "bridge/gitStatus": {
      const sessionId = String(p.sessionId ?? "");
      const rec = opts.sessions.get(sessionId);
      if (!rec) {
        const err = new Error(`unknown session: ${sessionId}`) as Error & { code?: number };
        err.code = -32002;
        throw err;
      }
      const cwd = assertAllowedRealPath(rec.cwd, opts.config.allowedRoots);
      const status = await getGitStatus(cwd);
      if (status.branch) opts.sessions.noteBranch(sessionId, status.branch);
      return status;
    }

    case "session/new": {
      const meta = (p._meta ?? {}) as Record<string, unknown>;
      const harnessId = String(meta.harness ?? opts.config.harnesses[0]?.id ?? "");
      const modeRaw = String(meta.permissionMode ?? opts.config.defaultPermissionMode ?? "ask");
      const permissionMode = (
        VALID_MODES.has(modeRaw as PermissionMode) ? modeRaw : "ask"
      ) as PermissionMode;
      const cwd = String(p.cwd ?? "");
      const additionalDirectories = Array.isArray(p.additionalDirectories)
        ? p.additionalDirectories.filter((entry): entry is string => typeof entry === "string")
        : undefined;
      const rec = await opts.sessions.startSession({
        harnessId,
        cwd,
        permissionMode,
        mcpServers: Array.isArray(p.mcpServers) ? p.mcpServers : [],
        additionalDirectories,
        model: typeof meta.model === "string" ? meta.model : undefined,
      });
      rememberWorkspace(opts.config, cwd);
      return {
        sessionId: rec.sessionId,
        ...(rec.sessionModes ? { modes: rec.sessionModes } : {}),
        ...(rec.configOptions !== undefined ? { configOptions: rec.configOptions } : {}),
        _meta: {
          permissionMode: rec.permissionMode,
          harness: rec.harness,
          ...(rec.agentInfo ? { agentInfo: rec.agentInfo } : {}),
          ...(rec.authMethods ? { authMethods: rec.authMethods } : {}),
        },
      };
    }

    case "session/prompt": {
      const sessionId = String(p.sessionId ?? "");
      return opts.sessions.prompt(sessionId, p);
    }

    case "session/load": {
      const sessionId = String(p.sessionId ?? "");
      const meta = (p._meta ?? {}) as Record<string, unknown>;
      const afterSeq =
        typeof meta.afterSeq === "number"
          ? meta.afterSeq
          : typeof meta.afterSeq === "string"
            ? Number(meta.afterSeq)
            : 0;
      return opts.sessions.load(sessionId, {
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        afterSeq: Number.isFinite(afterSeq) ? afterSeq : 0,
        mcpServers: Array.isArray(p.mcpServers) ? p.mcpServers : [],
        send: (frame) => sendImportant(ws, frame),
      });
    }

    case "session/cancel": {
      opts.sessions.cancel(String(p.sessionId ?? ""));
      return {};
    }

    case "session/set_mode": {
      const sessionId = String(p.sessionId ?? "");
      const modeId = String(p.modeId ?? "");
      if (!modeId) {
        throw new BridgeError(-32602, "modeId required");
      }
      return opts.sessions.applyMode(sessionId, modeId);
    }

    default: {
      throw new BridgeError(-32601, `Method not found: ${method}`);
    }
  }
}

function rememberWorkspace(config: BridgeConfig, cwd: string): void {
  if (!cwd || config.workspaces?.includes(cwd)) return;
  config.workspaces = [cwd, ...(config.workspaces ?? [])].slice(0, 20);
  try {
    saveConfig(config);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("warn", `could not save recent workspace: ${message}`);
  }
}
