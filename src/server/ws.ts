/**
 * WebSocket JSON-RPC 2.0 server stub on path `/v1` with bearer token auth.
 * Full product relays ACP + bridge/* methods; MVP accepts connections,
 * rejects bad tokens, and answers a few bridge methods from stubs.
 */

import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { parseAuthorizationHeader, verifyBearerToken } from "../auth/token.js";
import type { BridgeConfig } from "../config/types.js";
import { listHarnesses } from "../harness/registry.js";
import type { SessionManager } from "../session/manager.js";
import { assertAllowedPath } from "../approval/sandbox.js";

export interface WsServerOptions {
  host: string;
  port: number;
  config: BridgeConfig;
  sessions: SessionManager;
  /** When set, serve WSS with this material. */
  tls?: { keyPem: string; certPem: string };
  version: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

export interface BridgeServer {
  close(): Promise<void>;
  readonly url: string;
}

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

export function startBridgeServer(opts: WsServerOptions): BridgeServer {
  const useTls = Boolean(opts.tls?.certPem.includes("BEGIN CERTIFICATE"));
  let httpServer: HttpServer | HttpsServer;

  if (useTls && opts.tls) {
    httpServer = createHttpsServer({
      key: opts.tls.keyPem,
      cert: opts.tls.certPem,
    });
  } else {
    httpServer = createHttpServer();
  }

  const wss = new WebSocketServer({ noServer: true });

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
    ws.on("message", (raw) => {
      void handleMessage(ws, raw.toString(), opts);
    });
  });

  httpServer.listen(opts.port, opts.host);

  const scheme = useTls ? "wss" : "ws";
  const url = `${scheme}://${opts.host}:${opts.port}/v1`;

  return {
    url,
    close: () =>
      new Promise((resolve, reject) => {
        wss.close((err) => {
          if (err) reject(err);
          httpServer.close((e) => (e ? reject(e) : resolve()));
        });
      }),
  };
}

async function handleMessage(ws: WebSocket, text: string, opts: WsServerOptions): Promise<void> {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(text) as JsonRpcRequest;
  } catch {
    send(ws, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
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

  try {
    const result = await dispatch(msg.method, msg.params, opts);
    if (msg.id !== undefined && msg.id !== null) {
      send(ws, { jsonrpc: "2.0", id: msg.id, result });
    }
  } catch (e) {
    const err = e as Error & { code?: number };
    if (msg.id !== undefined && msg.id !== null) {
      send(ws, {
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: err.code ?? -32603,
          message: err.message || "Internal error",
        },
      });
    }
  }
}

function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

async function dispatch(method: string, params: unknown, opts: WsServerOptions): Promise<unknown> {
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
        agentCapabilities: {},
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
    case "bridge/listHarnesses": {
      return { harnesses: listHarnesses(opts.config) };
    }
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
    default: {
      const err = new Error(`Method not found: ${method}`) as Error & { code?: number };
      err.code = -32601;
      throw err;
    }
  }
}
