/**
 * ACP stdio client — the bridge is the ACP *client*: it launches a harness over
 * stdio and speaks Agent Client Protocol JSON-RPC (newline-delimited).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HarnessConfig } from "../config/types.js";

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

  start(): void {
    if (this.child) throw new Error("ACP client already started");
    const env = {
      ...process.env,
      ...this.opts.env,
      ...this.harness.env,
    };
    this.child = spawn(this.harness.command, this.harness.args ?? [], {
      cwd: this.opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.onLine(line));

    this.child.stderr.on("data", (buf: Buffer) => {
      this.stderrBuf += buf.toString("utf8");
      let idx: number;
      while ((idx = this.stderrBuf.indexOf("\n")) >= 0) {
        const line = this.stderrBuf.slice(0, idx);
        this.stderrBuf = this.stderrBuf.slice(idx + 1);
        this.opts.onStderr?.(line);
      }
    });

    this.child.on("exit", (code, signal) => {
      this.child = null;
      for (const [, p] of this.pending) {
        p.reject(new Error(`ACP process exited (code=${code}, signal=${signal})`));
      }
      this.pending.clear();
      this.opts.onExit?.(code, signal);
    });

    this.child.on("error", (err) => {
      for (const [, p] of this.pending) {
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.pending.clear();
    });
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
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
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Send a JSON-RPC request; returns a promise for the result. */
  request(method: string, params?: unknown, timeoutMs = 600_000): Promise<unknown> {
    if (!this.child?.stdin) return Promise.reject(new Error("ACP client not running"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
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
      this.child!.stdin.write(payload, (err) => {
        if (err) {
          if (timer) clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async initialize(clientInfo?: { name: string; version: string }): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: clientInfo ?? { name: "gradation-bridge", version: "0.1.0" },
    });
  }

  async newSession(params: {
    cwd: string;
    mcpServers?: unknown[];
    _meta?: Record<string, unknown>;
  }): Promise<{ sessionId: string; [k: string]: unknown }> {
    const result = (await this.request("session/new", {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      ...(params._meta ? { _meta: params._meta } : {}),
    })) as { sessionId?: string };
    if (!result?.sessionId) throw new Error("session/new did not return sessionId");
    return result as { sessionId: string };
  }

  async prompt(sessionId: string, prompt: unknown): Promise<unknown> {
    return this.request("session/prompt", { sessionId, prompt });
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
    if (!this.child) return;
    try {
      this.child.kill(signal);
    } catch {
      // ignore
    }
    // Force-kill after grace period
    const child = this.child;
    setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 2000).unref?.();
    this.child = null;
  }
}

export const ACP_SDK_PACKAGE = "@agentclientprotocol/sdk";
