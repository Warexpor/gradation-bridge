/**
 * ACP stdio client — the bridge is the ACP *client*: it launches a harness over
 * stdio and speaks Agent Client Protocol JSON-RPC (newline-delimited).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HarnessConfig } from "../config/types.js";
import { log } from "../log/diagnostics.js";
import { redactSecrets } from "../log/redact.js";
import { killProcessTree } from "../proc/tree.js";

export interface AcpJsonRpcRequest {
  jsonrpc?: string;
  id: number | string;
  method: string;
  params?: unknown;
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

  constructor(opts: AcpClientOptions) {
    this.opts = opts;
    this.harness = opts.harness;
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
    this.flushStderr();
    this.child = null;
    this.outbound.length = 0;
    const base = err ?? new Error(`ACP process exited (code=${code}, signal=${signal})`);
    this.failPending(this.withStderr(base));
    this.opts.onExit?.(code, signal);
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
    this.opts.onStderr?.(clean);
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

    // Notification (method, no id)
    if (obj.method) {
      this.opts.onNotification?.({
        method: obj.method,
        params: obj.params,
      });
    }
  }

  private async handleAgentRequest(req: AcpJsonRpcRequest): Promise<void> {
    try {
      const handler = this.opts.onRequest;
      if (!handler) {
        this.respondError(req.id, -32601, `Method not found: ${req.method}`);
        return;
      }
      const result = await handler(req);
      this.respondResult(req.id, result ?? {});
    } catch (e) {
      const err = e as Error & { code?: number };
      this.respondError(req.id, err.code ?? -32603, err.message || "Internal error");
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
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`ACP request timeout: ${method}`));
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
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
      protocolVersion: 1,
      clientCapabilities: {
        ...phone,
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: opts?.clientInfo ?? { name: "gradation-bridge", version: "0.1.0" },
    });
  }

  async newSession(params: {
    cwd: string;
    mcpServers?: unknown[];
    _meta?: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { sessionId: string }> {
    const result = (await this.request("session/new", {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
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

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  async loadSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: unknown[];
  }): Promise<unknown> {
    return this.request("session/load", {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    killProcessTree(child, signal);
    const timer = setTimeout(() => {
      try {
        if (child.exitCode === null) killProcessTree(child, "SIGKILL");
      } catch {
        // ignore
      }
    }, 2000);
    timer.unref?.();
  }
}

export const ACP_SDK_PACKAGE = "@agentclientprotocol/sdk";
