/**
 * ACP stdio client stub.
 *
 * The bridge is the ACP *client*: it launches a harness over stdio and speaks
 * Agent Client Protocol JSON-RPC. Full product will use @agentclientprotocol/sdk
 * Client + ndjson stream over the child process.
 *
 * Package: @agentclientprotocol/sdk (confirmed on npm, peer: zod)
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HarnessConfig } from "../config/types.js";

export interface AcpClientOptions {
  harness: HarnessConfig;
  cwd: string;
  env?: Record<string, string>;
  onNotification?: (msg: unknown) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * Minimal stdio ACP transport stub. Does not yet drive initialize/session/new;
 * exists so the rest of the daemon can wire process lifetime.
 */
export class AcpStdioClient {
  readonly harness: HarnessConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly opts: AcpClientOptions;

  constructor(opts: AcpClientOptions) {
    this.opts = opts;
    this.harness = opts.harness;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child != null && !this.child.killed;
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
      // Harness logs; surface later via bridge diagnostics.
      void buf;
    });

    this.child.on("exit", (code, signal) => {
      this.child = null;
      for (const [, p] of this.pending) {
        p.reject(new Error("ACP process exited"));
      }
      this.pending.clear();
      this.opts.onExit?.(code, signal);
    });
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const obj = msg as { id?: number | string; method?: string; result?: unknown; error?: unknown };
    if (obj.id != null && (obj.result !== undefined || obj.error !== undefined)) {
      const pending = this.pending.get(obj.id);
      if (pending) {
        this.pending.delete(obj.id);
        if (obj.error) pending.reject(new Error(JSON.stringify(obj.error)));
        else pending.resolve(obj.result);
      }
      return;
    }
    // notification or request from agent → client
    this.opts.onNotification?.(msg);
  }

  /** Send a JSON-RPC request; returns a promise for the result. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.child?.stdin) return Promise.reject(new Error("ACP client not running"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.child?.stdin) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.child.stdin.write(payload);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child?.kill(signal);
    this.child = null;
  }
}

/** Re-export a note that the official SDK is a dependency. */
export const ACP_SDK_PACKAGE = "@agentclientprotocol/sdk";
