/**
 * WebSocket JSON-RPC 2.0 server on path `/v1` with bearer token auth.
 * Relays ACP session methods to harness processes and answers bridge/* extensions.
 */

import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { listDirectory } from "../fs/browse.js";
import { hostname } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { parseAuthorizationHeader, verifyBearerToken } from "../auth/token.js";
import { PERMISSION_MODES } from "../approval/policy.js";
import type { BridgeConfig, PermissionMode } from "../config/types.js";
import { saveConfig } from "../config/load.js";
import { BridgeError } from "../errors.js";
import { which } from "../harness/path.js";
import { listHarnesses } from "../harness/registry.js";
import { getLogLevel, log, recentLogs } from "../log/diagnostics.js";
import { SessionManager, SandboxError, type PhoneCancelFilter } from "../session/manager.js";
import { assertAllowedRealPath } from "../approval/sandbox.js";
import { getGitDiff, getGitStatus } from "../git/status.js";
import {
  cancelRequestFrame,
  cancelledPhoneResult,
  isCancelRequest,
  readCancelRequestId,
  mapDeleteByRpcId,
  mapGetByRpcId,
} from "../acp/cancel.js";
import { ACP_PROTOCOL_VERSION, negotiateProtocolVersion } from "../acp/protocol.js";
import { wireIdString } from "../acp/wire-id.js";
import { tlsDiagnostics } from "../auth/cert.js";
import { formatListenUrl } from "../net/bind.js";
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
  method: string;
  /** Warm-login owner, so cancelling one authenticate does not cancel another. */
  owner?: string;
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

  const cancelPhoneRequests = (filter: PhoneCancelFilter): void => {
    for (const [id, pending] of pendingPhone) {
      if (!pendingMatches(pending, filter)) continue;
      clearTimeout(pending.timer);
      pendingPhone.delete(id);
      fanout(cancelRequestFrame(id), false);
      pending.resolve({ result: cancelledPhoneResult(pending.method), requestId: id });
    }
  };

  const requestPhone = (
    method: string,
    params: unknown,
    ctx?: { signal?: AbortSignal; owner?: string },
  ): Promise<{ result?: unknown; error?: unknown; requestId: string | number }> => {
    const requestId = phoneReqId++;
    const frame = { jsonrpc: "2.0", id: requestId, method, params };
    if (ctx?.signal?.aborted) {
      return Promise.resolve({ result: cancelledPhoneResult(method), requestId });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingPhone.delete(requestId);
        ctx?.signal?.removeEventListener("abort", onAbort);
        reject(new Error(`phone did not answer ${method}`));
      }, 300_000);
      const onAbort = (): void => {
        if (!pendingPhone.has(requestId)) return;
        clearTimeout(timer);
        pendingPhone.delete(requestId);
        fanout(cancelRequestFrame(requestId), false);
        resolve({ result: cancelledPhoneResult(method), requestId });
      };
      pendingPhone.set(requestId, {
        resolve,
        reject,
        timer,
        frame,
        params,
        method,
        owner: ctx?.owner,
      });
      if (ctx?.signal) ctx.signal.addEventListener("abort", onAbort, { once: true });
      // Keep the request if every phone is briefly gone so a reconnect can answer.
      if (clients.size > 0) fanout(frame, false);
    });
  };

  const phoneCalls = new Map<string | number, () => void>();

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
      void handleMessage(sock, raw.toString(), opts, pendingPhone, phoneCalls);
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
  const url = formatListenUrl(scheme, opts.host, boundPort);

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
  phoneCalls: Map<string | number, () => void>,
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
    await routeMessage(ws, msg, opts, pendingPhone, phoneCalls);
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
  phoneCalls: Map<string | number, () => void>,
): Promise<void> {

  // Phone answering a bridge→phone request (permission)
  if (
    msg.id != null &&
    msg.method === undefined &&
    (msg.result !== undefined || msg.error !== undefined)
  ) {
    const pending = mapGetByRpcId(pendingPhone, msg.id);
    if (pending) {
      clearTimeout(pending.timer);
      mapDeleteByRpcId(pendingPhone, msg.id);
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
      await dispatchNotification(msg.method, msg.params, opts, phoneCalls);
    } catch {
      /* notifications don't get errors */
    }
    return;
  }

  const release = trackPhoneCall(phoneCalls, msg.id, () => {
    cancelInflightPhoneCall(msg.method!, msg.params, opts);
  });
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
  } finally {
    release();
  }
}

async function dispatchNotification(
  method: string,
  params: unknown,
  opts: WsServerOptions,
  phoneCalls: Map<string | number, () => void>,
): Promise<void> {
  const p = (params ?? {}) as Record<string, unknown>;
  if (method === "session/cancel") {
    opts.sessions.cancel(phoneSessionId(p.sessionId));
    return;
  }
  if (isCancelRequest(method)) {
    const requestId = readCancelRequestId(p);
    if (requestId != null) mapGetByRpcId(phoneCalls, requestId)?.();
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
      const negotiated = negotiateProtocolVersion(p.protocolVersion);
      if (negotiated.downgraded) {
        log(
          "warn",
          `phone requested protocolVersion ${String(p.protocolVersion)}; bridge speaks ACP ${ACP_PROTOCOL_VERSION}`,
        );
      }
      const harnesses = listHarnesses(opts.config).map(
        ({ id, name, available, readiness, detail, notice, commandPath }) => ({
          id,
          name,
          available,
          readiness,
          detail,
          ...(notice ? { notice } : {}),
          ...(commandPath ? { commandPath } : {}),
        }),
      );
      return {
        protocolVersion: negotiated.version,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          sessionCapabilities: {
            list: {},
            close: {},
            resume: {},
            delete: {},
            additionalDirectories: {},
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
      const tls = tlsDiagnostics(opts.tls?.certPem);
      return {
        version: opts.version,
        permissionMode: opts.config.defaultPermissionMode,
        logLevel: getLogLevel(),
        npx: Boolean(which("npx")),
        openssl: Boolean(which("openssl")),
        harnesses: listHarnesses(opts.config),
        sessions: opts.sessions.list().length,
        log: recentLogs(),
        tls: tls.tls,
        ...(tls.certFingerprint ? { certFingerprint: tls.certFingerprint } : {}),
        ...(tls.certSan ? { certSan: tls.certSan } : {}),
      };
    }
    case "bridge/setPermissionMode": {
      const sessionId = phoneSessionId(p.sessionId);
      const modeId = wireIdString(p.permissionMode ?? p.modeId) ?? "";
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
      return listDirectory(allowed);
    }
    case "bridge/listSessions": {
      const sessions = opts.sessions.list({
        limit: typeof p.limit === "number" ? p.limit : undefined,
        before: typeof p.before === "string" ? p.before : undefined,
      });
      return { sessions };
    }
    case "bridge/closeSession": {
      const sessionId = phoneSessionId(p.sessionId);
      await opts.sessions.closeSession(sessionId, { missing: "ignore" });
      return {};
    }
    case "session/list":
      return opts.sessions.listForProtocol({
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        cursor: wireIdString(p.cursor),
      });
    case "session/close": {
      const sessionId = phoneSessionId(p.sessionId);
      await opts.sessions.closeSession(sessionId, { missing: "error" });
      return {};
    }
    case "session/delete": {
      const sessionId = phoneSessionId(p.sessionId);
      await opts.sessions.deleteSession(sessionId);
      return {};
    }
    case "session/resume": {
      const sessionId = phoneSessionId(p.sessionId);
      return opts.sessions.resume(sessionId, {
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        mcpServers: Array.isArray(p.mcpServers) ? p.mcpServers : [],
        additionalDirectories: directoryList(p.additionalDirectories),
      });
    }
    case "session/set_config_option": {
      const sessionId = phoneSessionId(p.sessionId);
      return opts.sessions.setConfigOption(sessionId, p);
    }
    case "bridge/diff": {
      const sessionId = phoneSessionId(p.sessionId);
      const filePath = String(p.path ?? "");
      const rec = requireListedSession(opts.sessions, sessionId);
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
      const sessionId = phoneSessionId(p.sessionId);
      const rec = requireListedSession(opts.sessions, sessionId);
      const cwd = assertAllowedRealPath(rec.cwd, opts.config.allowedRoots);
      const status = await getGitStatus(cwd);
      if (status.branch) opts.sessions.noteBranch(sessionId, status.branch);
      return status;
    }

    case "session/new": {
      const meta = (p._meta ?? {}) as Record<string, unknown>;
      // Digit-string harness / permissionMode may arrive as JSON numbers or "5.0".
      const harnessId =
        phoneHarnessId(meta.harness) ?? opts.config.harnesses[0]?.id ?? "";
      const modeRaw =
        phoneHarnessId(meta.permissionMode) ??
        opts.config.defaultPermissionMode ??
        "ask";
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
        // GradatiON sends digit-string model ids as JSON numbers (or "5.0").
        model: wireIdString(meta.model),
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
          ...(rec.authMethods?.length ? { authMethods: rec.authMethods } : {}),
          ...(rec.logoutSupported ? { logout: true } : {}),
        },
      };
    }

    case "session/prompt": {
      const sessionId = phoneSessionId(p.sessionId);
      return opts.sessions.prompt(sessionId, p);
    }

    case "session/load": {
      const sessionId = phoneSessionId(p.sessionId);
      const meta = (p._meta ?? {}) as Record<string, unknown>;
      const afterSeq = coerceAfterSeq(meta.afterSeq);
      return opts.sessions.load(sessionId, {
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        afterSeq: Number.isFinite(afterSeq) ? afterSeq : 0,
        mcpServers: Array.isArray(p.mcpServers) ? p.mcpServers : [],
        additionalDirectories: directoryList(p.additionalDirectories),
        send: (frame) => sendImportant(ws, frame),
      });
    }

    case "authenticate":
    case "auth/login": {
      const meta = (p._meta ?? {}) as Record<string, unknown>;
      return opts.sessions.authenticate({
        methodId: wireIdString(p.methodId) ?? "",
        sessionId: wireIdString(p.sessionId),
        harnessId: phoneHarnessId(meta.harness),
        cwd:
          typeof p.cwd === "string" ? p.cwd : typeof meta.cwd === "string" ? meta.cwd : undefined,
      });
    }
    case "logout":
    case "auth/logout": {
      const meta = (p._meta ?? {}) as Record<string, unknown>;
      return opts.sessions.logout({
        sessionId: wireIdString(p.sessionId),
        harnessId: phoneHarnessId(meta.harness),
        cwd:
          typeof p.cwd === "string" ? p.cwd : typeof meta.cwd === "string" ? meta.cwd : undefined,
      });
    }
    case "session/cancel": {
      opts.sessions.cancel(phoneSessionId(p.sessionId));
      return {};
    }

    case "session/set_mode": {
      const sessionId = phoneSessionId(p.sessionId);
      const modeId = wireIdString(p.modeId) ?? "";
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

function pendingMatches(pending: PendingPhone, filter: PhoneCancelFilter): boolean {
  if (filter.method && pending.method !== filter.method) return false;
  if (filter.owner) return pending.owner === filter.owner;
  if (!filter.sessionId) return false;
  const params = pending.params as { sessionId?: string } | null;
  return Boolean(params && typeof params === "object" && params.sessionId === filter.sessionId);
}

function trackPhoneCall(
  phoneCalls: Map<string | number, () => void>,
  id: string | number,
  cancel: () => void,
): () => void {
  phoneCalls.set(id, cancel);
  return () => {
    if (phoneCalls.get(id) === cancel) phoneCalls.delete(id);
  };
}

function cancelInflightPhoneCall(method: string, params: unknown, opts: WsServerOptions): void {
  const p = (params ?? {}) as Record<string, unknown>;
  const meta = (p._meta ?? {}) as Record<string, unknown>;
  if (method === "session/prompt" || method === "session/load" || method === "session/resume") {
    opts.sessions.cancel(phoneSessionId(p.sessionId));
    return;
  }
  if (
    method === "authenticate" ||
    method === "auth/login" ||
    method === "logout" ||
    method === "auth/logout"
  ) {
    opts.sessions.cancelAuth({
      sessionId: wireIdString(p.sessionId),
      harnessId: phoneHarnessId(meta.harness),
      cwd: typeof p.cwd === "string" ? p.cwd : typeof meta.cwd === "string" ? meta.cwd : undefined,
    });
  }
}


/** Phone sessionId may arrive as a JSON number or `"5.0"` for digit-string ids. */
function phoneSessionId(value: unknown): string {
  return wireIdString(value) ?? "";
}

/** Harness id: same digit-string canonicalization as sessionId / model. */
function phoneHarnessId(value: unknown): string | undefined {
  return wireIdString(value) ?? (typeof value === "string" ? value : undefined);
}

/** Sessions that `session/list` hides are unknown to the rest of the protocol. */
function requireListedSession(sessions: SessionManager, sessionId: string) {
  const rec = sessions.get(sessionId);
  if (!rec || rec.status === "closed") {
    const err = new Error(`unknown session: ${sessionId}`) as Error & { code?: number };
    err.code = -32002;
    throw err;
  }
  return rec;
}

function directoryList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw as string[];
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

/** `_meta.afterSeq` may arrive as a number, `"42"`, or `"42.0"`. */
function coerceAfterSeq(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
