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
import type { BridgeConfig, PermissionMode } from "../config/types.js";
import { listHarnesses } from "../harness/registry.js";
import { SessionManager, SandboxError } from "../session/manager.js";
import { assertAllowedPath } from "../approval/sandbox.js";

export interface WsServerOptions {
  host: string;
  port: number;
  config: BridgeConfig;
  sessions: SessionManager;
  tls?: { keyPem: string; certPem: string };
  version: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
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

function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

export async function startBridgeServer(opts: WsServerOptions): Promise<BridgeServer> {
  const useTls = Boolean(opts.tls?.certPem.includes("BEGIN CERTIFICATE"));
  let httpServer: HttpServer | HttpsServer;

  if (useTls && opts.tls) {
    httpServer = createHttpsServer({ key: opts.tls.keyPem, cert: opts.tls.certPem });
  } else {
    httpServer = createHttpServer();
  }

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  let phoneReqId = 1;
  const pendingPhone = new Map<
    string | number,
    {
      resolve: (v: { result?: unknown; error?: unknown; requestId: string | number }) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  const broadcast = (msg: unknown): void => {
    const raw = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  };

  const requestPhone = (
    method: string,
    params: unknown,
  ): Promise<{ result?: unknown; error?: unknown; requestId: string | number }> => {
    if (clients.size === 0) {
      return Promise.reject(new Error("no phone connected"));
    }
    const requestId = phoneReqId++;
    const frame = { jsonrpc: "2.0", id: requestId, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingPhone.delete(requestId);
        reject(new Error(`phone did not answer ${method}`));
      }, 300_000);
      pendingPhone.set(requestId, { resolve, reject, timer });
      const raw = JSON.stringify(frame);
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(raw);
      }
    });
  };

  opts.sessions.setHooks({ broadcast, requestPhone });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const token = extractToken(req);
    if (!verifyBearerToken(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("message", (raw) => {
      void handleMessage(ws, raw.toString(), opts, pendingPhone);
    });
    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => resolve());
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
      for (const [, p] of pendingPhone) {
        clearTimeout(p.timer);
        p.reject(new Error("server closing"));
      }
      pendingPhone.clear();
      await opts.sessions.closeAll();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => {
          if (err) reject(err);
          httpServer.close((e) => (e ? reject(e) : resolve()));
        });
      });
    },
  };
}

async function handleMessage(
  ws: WebSocket,
  text: string,
  opts: WsServerOptions,
  pendingPhone: Map<
    string | number,
    {
      resolve: (v: { result?: unknown; error?: unknown; requestId: string | number }) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >,
): Promise<void> {
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(text) as JsonRpcMessage;
  } catch {
    send(ws, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

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
    const err = e as Error & { code?: number };
    const code =
      e instanceof SandboxError ? -32003 : (err.code ?? -32603);
    send(ws, {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code, message: err.message || "Internal error" },
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
      const harnesses = listHarnesses(opts.config).map(({ id, name, available }) => ({
        id,
        name,
        available,
      }));
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        agentInfo: { name: "gradation-bridge", version: opts.version },
        _meta: {
          bridge: {
            version: opts.version,
            harnesses,
            hostName: opts.config.hostName ?? hostname(),
          },
        },
      };
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
      const allowed = assertAllowedPath(path, opts.config.allowedRoots);
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
      opts.sessions.close(sessionId);
      return {};
    }
    case "bridge/diff":
      return { unified: "" };
    case "bridge/gitStatus":
      return { branch: "", ahead: 0, behind: 0, files: [] };

    case "session/new": {
      const meta = (p._meta ?? {}) as Record<string, unknown>;
      const harnessId = String(meta.harness ?? opts.config.harnesses[0]?.id ?? "");
      const modeRaw = String(meta.permissionMode ?? opts.config.defaultPermissionMode ?? "ask");
      const permissionMode = (
        VALID_MODES.has(modeRaw as PermissionMode) ? modeRaw : "ask"
      ) as PermissionMode;
      const cwd = String(p.cwd ?? "");
      const rec = await opts.sessions.startSession({
        harnessId,
        cwd,
        permissionMode,
        mcpServers: Array.isArray(p.mcpServers) ? p.mcpServers : [],
        model: typeof meta.model === "string" ? meta.model : undefined,
      });
      // Remember workspace
      if (!opts.config.workspaces?.includes(cwd)) {
        opts.config.workspaces = [cwd, ...(opts.config.workspaces ?? [])].slice(0, 20);
      }
      return { sessionId: rec.sessionId };
    }

    case "session/prompt": {
      const sessionId = String(p.sessionId ?? "");
      return opts.sessions.prompt(sessionId, p.prompt);
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
        send: (frame) => send(ws, frame),
      });
    }

    case "session/set_mode": {
      const sessionId = String(p.sessionId ?? "");
      const modeId = String(p.modeId ?? "");
      if (!VALID_MODES.has(modeId as PermissionMode)) {
        const err = new Error(`unknown modeId: ${modeId}`) as Error & { code?: number };
        err.code = -32602;
        throw err;
      }
      opts.sessions.setPermissionMode(sessionId, modeId as PermissionMode);
      return {};
    }

    default: {
      const err = new Error(`Method not found: ${method}`) as Error & { code?: number };
      err.code = -32601;
      throw err;
    }
  }
}
