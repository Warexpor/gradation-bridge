/**
 * ACP stdio client — the bridge is the ACP *client*: it launches a harness over
 * stdio and speaks Agent Client Protocol JSON-RPC (newline-delimited).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HarnessConfig } from "../config/types.js";
import { log } from "../log/diagnostics.js";
import { redactSecrets } from "../log/redact.js";
import { killProcessTree, signalProcessGroup } from "../proc/tree.js";
import { isCancelRequest, readCancelRequestId, REQUEST_CANCELLED } from "./cancel.js";
import { ACP_PROTOCOL_VERSION } from "./protocol.js";

export interface AcpJsonRpcRequest {
  jsonrpc?: string;
  id: number | string;
  method: string;
  params?: unknown;
  /** Aborted when the harness sends `$/cancel_request` for this id. */
  signal?: AbortSignal;
}

export interface AcpJsonRpcNotification {
  jsonrpc?: string;
  method: string;
  params?: unknown;
}

export type AcpInboundHandler = (
  msg: AcpJsonRpcRequest,
) => Promise<unknown> | unknown;

export interface AcpClientOptions {
  harness: HarnessConfig;
  cwd: string;
  env?: Record<string, string>;
  /** Agent → client requests (permission, fs, terminal, …). */
  onRequest?: AcpInboundHandler;
  /** Agent → client notifications (session/update, …). */
  onNotification?: (msg: AcpJsonRpcNotification) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onStderr?: (line: string) => void;
}

const STDIN_BACKLOG_LIMIT = 1024;

export class AcpStdioClient {
  readonly harness: HarnessConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly opts: AcpClientOptions;
  private stderrBuf = "";
  private readonly stderrLines: string[] = [];
  private lastLaunchError: Error | null = null;
  private readonly outbound: string[] = [];
  private stdinPaused = false;
  private settled = false;
  /** Process-group leader. Survives `child` being cleared so a crash can still reap grandchildren. */
  private groupPid: number | undefined;
  private groupReaped = false;
  private readonly outboundMethods = new Map<number | string, string>();
  private readonly inboundCancels = new Map<number | string, () => void>();
  private requestHandler?: AcpInboundHandler;
  private notificationHandler?: (msg: AcpJsonRpcNotification) => void;
  private exitHandler?: (code: number | null, signal: NodeJS.Signals | null) => void;
  private stderrHandler?: (line: string) => void;

  constructor(opts: AcpClientOptions) {
    this.opts = opts;
    this.harness = opts.harness;
    this.setCallbacks(opts);
  }

  /** Replace agent→bridge handlers. Used when a warm auth process becomes a session. */
  setCallbacks(next: Partial<AcpClientOptions>): void {
    if (next.onRequest) this.requestHandler = next.onRequest;
    if (next.onNotification) this.notificationHandler = next.onNotification;
    if (next.onExit) this.exitHandler = next.onExit;
    if (next.onStderr) this.stderrHandler = next.onStderr;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child != null && this.child.exitCode === null && !this.child.killed;
  }

  /** Last stderr lines, already redacted. */
  stderrTail(): string {
    return this.stderrLines.join("\n");
  }

  start(): void {
    if (this.child) throw new Error("ACP client already started");
    if (this.settled) throw new Error("ACP client already exited");
    const env = {
      ...process.env,
      ...this.opts.env,
      ...this.harness.env,
    };
    this.child = spawn(this.harness.command, this.harness.args ?? [], {
      cwd: this.opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group so kill() reaps npx/node grandchildren.
      detached: process.platform !== "win32",
    });
    this.groupPid = this.child.pid;

    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.onLine(line));

    this.child.stderr.on("data", (buf: Buffer) => {
      this.stderrBuf += buf.toString("utf8");
      let idx: number;
      while ((idx = this.stderrBuf.indexOf("\n")) >= 0) {
        const line = this.stderrBuf.slice(0, idx);
        this.stderrBuf = this.stderrBuf.slice(idx + 1);
        this.pushStderr(line);
      }
    });

    this.child.stdin.on("error", (err) => {
      this.settle(null, null, err instanceof Error ? err : new Error(String(err)));
    });

    this.child.on("exit", (code, signal) => {
      this.settle(code, signal);
    });

    this.child.on("error", (err) => {
      const nodeErr = err as NodeJS.ErrnoException;
      const message =
        nodeErr.code === "ENOENT"
          ? `command not found: ${this.harness.command}`
          : err instanceof Error
            ? err.message
            : String(err);
      this.settle(null, null, new Error(`ACP process error: ${message}`));
    });

    this.flushStdin();
  }

  private settle(
    code: number | null,
    signal: NodeJS.Signals | null,
    err?: Error,
  ): void {
    if (this.settled) return;
    this.settled = true;
    this.reapGroup();
    this.flushStderr();
    this.child = null;
    this.outbound.length = 0;
    const base = err ?? new Error(`ACP process exited (code=${code}, signal=${signal})`);
    this.failPending(this.withStderr(base));
    this.exitHandler?.(code, signal);
  }

  private withStderr(err: Error): Error {
    const suffix = this.stderrSuffix();
    if (!suffix || err.message.includes("\nstderr:")) return err;
    return new Error(`${err.message}${suffix}`);
  }

  private pushStderr(line: string): void {
    const clean = redactSecrets(line).slice(0, 500);
    this.stderrLines.push(clean);
    if (this.stderrLines.length > 40) this.stderrLines.shift();
    this.stderrHandler?.(clean);
  }

  private flushStderr(): void {
    if (!this.stderrBuf) return;
    this.pushStderr(this.stderrBuf);
    this.stderrBuf = "";
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail();
    if (!tail) return "";
    return `\nstderr: ${tail.slice(-1500)}`;
  }

  private failPending(err: Error): void {
    this.lastLaunchError = err;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private onLine(line: string): void {
    if (line.length > 8 * 1024 * 1024) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      if (line.trim()) {
        log("debug", `harness stdout was not JSON: ${line.slice(0, 200)}`);
      }
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    const obj = msg as {
      id?: number | string | null;
      method?: string;
      result?: unknown;
      error?: unknown;
      params?: unknown;
    };

    // Response to one of our requests
    if (
      obj.id != null &&
      obj.method === undefined &&
      (obj.result !== undefined || obj.error !== undefined)
    ) {
      const pending = this.pending.get(obj.id);
      if (pending) {
        this.pending.delete(obj.id);
        if (obj.error) {
          const errObj = obj.error as { message?: string; code?: number };
          const err = new Error(errObj.message ?? JSON.stringify(obj.error)) as Error & {
            code?: number;
            data?: unknown;
          };
          err.code = errObj.code;
          err.data = obj.error;
          pending.reject(err);
        } else {
          pending.resolve(obj.result);
        }
      }
      return;
    }

    // Request from agent → client (has id + method)
    if (obj.method && obj.id != null) {
      void this.handleAgentRequest({
        jsonrpc: "2.0",
        id: obj.id,
        method: obj.method,
        params: obj.params,
      });
      return;
    }

    // Notification (method, no id). `$/cancel_request` stays on this process:
    // the harness id is not a phone request id, so it must not be forwarded.
    if (obj.method && isCancelRequest(obj.method)) {
      const requestId = readCancelRequestId(obj.params);
      if (requestId != null) this.cancelInbound(requestId);
      return;
    }
    if (obj.method?.startsWith("$/")) return;
    if (obj.method) {
      this.notificationHandler?.({
        method: obj.method,
        params: obj.params,
      });
    }
  }

  private async handleAgentRequest(req: AcpJsonRpcRequest): Promise<void> {
    const ac = new AbortController();
    this.inboundCancels.set(req.id, () => ac.abort());
    try {
      const handler = this.requestHandler;
      if (!handler) {
        this.respondError(req.id, -32601, `Method not found: ${req.method}`);
        return;
      }
      const result = await handler({ ...req, signal: ac.signal });
      if (ac.signal.aborted && (result == null || result === undefined)) {
        this.respondError(req.id, REQUEST_CANCELLED, "request cancelled");
        return;
      }
      this.respondResult(req.id, result ?? {});
    } catch (e) {
      if (ac.signal.aborted) {
        this.respondError(req.id, REQUEST_CANCELLED, "request cancelled");
        return;
      }
      const err = e as Error & { code?: number };
      this.respondError(req.id, err.code ?? -32603, err.message || "Internal error");
    } finally {
      this.inboundCancels.delete(req.id);
    }
  }

  /** Stop an in-flight harness→bridge request. The handler returns a cancellation result. */
  cancelInbound(requestId: number | string): void {
    this.inboundCancels.get(requestId)?.();
  }

  /** Ask the harness to stop outbound calls such as `authenticate`. */
  cancelOutbound(methods: string[]): void {
    for (const [id, method] of this.outboundMethods) {
      if (!methods.includes(method)) continue;
      this.notify("$/cancel_request", { requestId: id });
    }
  }

  private respondResult(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private write(obj: unknown): void {
    if (this.settled) return;
    if (this.outbound.length >= STDIN_BACKLOG_LIMIT) {
      const err = new Error("ACP stdin backlog exceeded");
      this.kill();
      this.settle(null, null, err);
      return;
    }
    this.outbound.push(JSON.stringify(obj) + "\n");
    this.flushStdin();
  }

  private flushStdin(): void {
    if (this.stdinPaused) return;
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable) return;
    while (this.outbound.length > 0) {
      const line = this.outbound[0]!;
      let ok = true;
      try {
        ok = stdin.write(line);
      } catch {
        return;
      }
      this.outbound.shift();
      if (!ok) {
        this.stdinPaused = true;
        stdin.once("drain", () => {
          this.stdinPaused = false;
          this.flushStdin();
        });
        return;
      }
    }
  }

  /** Send a JSON-RPC request; returns a promise for the result. */
  request(method: string, params?: unknown, timeoutMs = 600_000): Promise<unknown> {
    if (!this.child?.stdin || this.settled) {
      return Promise.reject(
        this.lastLaunchError ?? new Error(`ACP client not running${this.stderrSuffix()}`),
      );
    }
    const id = this.nextId++;
    this.outboundMethods.set(id, method);
    const forget = (): void => {
      this.outboundMethods.delete(id);
    };
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              forget();
              reject(new Error(`ACP request timeout: ${method}`));
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          forget();
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          forget();
          reject(e);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async initialize(opts?: {
    clientInfo?: { name: string; version: string };
    /** Phone capabilities. fs and terminal stay enabled because the bridge implements them. */
    clientCapabilities?: Record<string, unknown>;
  }): Promise<unknown> {
    const phone = opts?.clientCapabilities ?? {};
    return this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: capabilitiesForAgent(phone),
      clientInfo: opts?.clientInfo ?? { name: "gradation-bridge", version: "0.1.0" },
    });
  }

  async authenticate(methodId: string): Promise<unknown> {
    return this.callWithAuthAlias("authenticate", "auth/login", { methodId });
  }

  async logout(): Promise<unknown> {
    return this.callWithAuthAlias("logout", "auth/logout", {});
  }

  private async callWithAuthAlias(
    primary: string,
    fallback: string,
    params: unknown,
  ): Promise<unknown> {
    try {
      return await this.request(primary, params, 300_000);
    } catch (err) {
      if (!isMethodNotFound(err)) throw err;
      return this.request(fallback, params, 300_000);
    }
  }

  async newSession(params: {
    cwd: string;
    mcpServers?: unknown[];
    additionalDirectories?: string[];
    _meta?: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { sessionId: string }> {
    const result = (await this.request("session/new", {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      ...extraRoots(params.additionalDirectories),
      ...(params._meta ? { _meta: params._meta } : {}),
    })) as { sessionId?: unknown };
    if (!result || typeof result.sessionId !== "string" || !result.sessionId) {
      throw new Error("session/new did not return sessionId");
    }
    return result as Record<string, unknown> & { sessionId: string };
  }

  async prompt(params: Record<string, unknown>): Promise<unknown> {
    return this.request("session/prompt", params);
  }

  async setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.request("session/set_mode", { sessionId, modeId }, 30_000);
  }

  async setConfigOption(params: Record<string, unknown>): Promise<unknown> {
    return this.request("session/set_config_option", params, 30_000);
  }

  async resumeSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: unknown[];
    additionalDirectories?: string[];
  }): Promise<unknown> {
    return this.request("session/resume", {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      ...extraRoots(params.additionalDirectories),
    });
  }

  async closeSession(sessionId: string): Promise<unknown> {
    return this.request("session/close", { sessionId }, 2_000);
  }

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  async loadSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: unknown[];
    additionalDirectories?: string[];
  }): Promise<unknown> {
    return this.request("session/load", {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      ...extraRoots(params.additionalDirectories),
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    const child = this.child;
    if (child) {
      this.child = null;
      this.groupPid = child.pid ?? this.groupPid;
      killProcessTree(child, signal);
    }
    this.reapGroup();
  }

  /**
   * SIGTERM the process group now and SIGKILL it shortly after.
   * Safe to call twice. A crashed leader does not take grandchildren with it;
   * this does, including when `kill` runs after `child` was already cleared.
   */
  private reapGroup(): void {
    const pid = this.groupPid;
    if (!pid || this.groupReaped) return;
    this.groupReaped = true;
    signalProcessGroup(pid, "SIGTERM");
    const timer = setTimeout(() => signalProcessGroup(pid, "SIGKILL"), 2000);
    timer.unref?.();
  }
}

export const ACP_SDK_PACKAGE = "@agentclientprotocol/sdk";

function capabilitiesForAgent(phone: Record<string, unknown>): Record<string, unknown> {
  const auth = phone.auth;
  const authObj =
    auth && typeof auth === "object" && !Array.isArray(auth)
      ? { ...(auth as Record<string, unknown>) }
      : {};
  // The bridge cannot present an interactive TTY, so terminal auth stays off
  // even if the phone asked for it. fs and terminal methods are ours.
  return {
    ...phone,
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    auth: { ...authObj, terminal: false },
  };
}

function extraRoots(dirs: string[] | undefined): { additionalDirectories?: string[] } {
  if (!dirs || dirs.length === 0) return {};
  return { additionalDirectories: dirs };
}

export function isMethodNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: number }).code === -32601);
}
