/**
 * ACP terminal/* for one bridge process.
 *
 * `outputByteLimit` keeps the newest bytes (the spec truncates from the start)
 * and never splits a UTF-8 character. `terminal/kill` leaves the id usable;
 * `terminal/release` frees it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { killProcessTree } from "../proc/tree.js";

export const MAX_TERMINAL_OUTPUT_BYTES = 1024 * 1024;
export const MAX_TERMINALS_PER_SESSION = 32;
const MAX_TOTAL = 128;

export interface TerminalOutputState {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
  limit: number;
}

interface TerminalRecord extends TerminalOutputState {
  sessionId: string;
  child: ChildProcess;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  waiters: Array<(status: { exitCode: number | null; signal: NodeJS.Signals | null }) => void>;
}

export function resolveOutputByteLimit(requested: unknown): number {
  if (requested == null) return MAX_TERMINAL_OUTPUT_BYTES;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0) {
    throw Object.assign(new Error("outputByteLimit must be a number >= 0"), { code: -32602 });
  }
  return Math.min(Math.floor(requested), MAX_TERMINAL_OUTPUT_BYTES);
}

/** Drop bytes from the front until `state` fits in `limit`, on a UTF-8 boundary. */
export function appendTerminalOutput(state: TerminalOutputState, chunk: Buffer): void {
  if (chunk.length === 0) return;
  if (state.limit <= 0) {
    state.truncated = true;
    return;
  }
  state.chunks.push(chunk);
  state.bytes += chunk.length;
  if (state.bytes <= state.limit) return;
  state.truncated = true;
  let overflow = state.bytes - state.limit;
  while (overflow > 0 && state.chunks.length > 0) {
    const head = state.chunks[0]!;
    if (head.length <= overflow) {
      state.chunks.shift();
      state.bytes -= head.length;
      overflow -= head.length;
    } else {
      state.chunks[0] = head.subarray(overflow);
      state.bytes -= overflow;
      overflow = 0;
    }
  }
  while (state.chunks.length > 0) {
    const head = state.chunks[0]!;
    let drop = 0;
    while (drop < head.length && (head[drop]! & 0xc0) === 0x80) drop++;
    if (drop === 0) break;
    state.bytes -= drop;
    if (drop >= head.length) state.chunks.shift();
    else state.chunks[0] = head.subarray(drop);
  }
}

export function terminalOutputText(state: TerminalOutputState): string {
  if (state.chunks.length === 0) return "";
  return Buffer.concat(state.chunks).toString("utf8");
}

export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Reject a terminal/create the bridge cannot start. Does not spawn anything. */
export function assertTerminalCreateParams(opts: {
  command: unknown;
  args: unknown;
  env?: unknown;
  outputByteLimit?: unknown;
}): { command: string; args: string[]; outputByteLimit: number } {
  if (typeof opts.command !== "string" || !opts.command || opts.command.includes("\0")) {
    throw Object.assign(new Error("command required"), { code: -32602 });
  }
  if (opts.args != null && !Array.isArray(opts.args)) {
    throw Object.assign(new Error("terminal args must be an array"), { code: -32602 });
  }
  const args = (opts.args as unknown[] | undefined) ?? [];
  if (args.some((arg) => typeof arg !== "string" || (arg as string).includes("\0"))) {
    throw Object.assign(new Error("terminal args must be strings"), { code: -32602 });
  }
  if (opts.env != null && !Array.isArray(opts.env)) {
    throw Object.assign(new Error("terminal env must be an array"), { code: -32602 });
  }
  return {
    command: opts.command,
    args: args as string[],
    outputByteLimit: resolveOutputByteLimit(opts.outputByteLimit),
  };
}

export class TerminalTable {
  private readonly terminals = new Map<string, TerminalRecord>();

  /**
   * True when a new command can start. Exited terminals do not count: they
   * are dropped later, only if the retained-id cap is full.
   */
  hasRoom(sessionId: string): boolean {
    let liveSession = 0;
    let liveTotal = 0;
    for (const term of this.terminals.values()) {
      if (term.exited) continue;
      liveTotal++;
      if (term.sessionId === sessionId) liveSession++;
    }
    return liveSession < MAX_TERMINALS_PER_SESSION && liveTotal < MAX_TOTAL;
  }

  /**
   * Throw when this session cannot start another command.
   * Exited terminals are dropped only once the cap is hit, so a killed id
   * stays readable until the session actually needs the slot.
   */
  assertRoom(sessionId: string): void {
    if (!this.overCap(sessionId)) return;
    this.dropExited(sessionId);
    if (!this.overCap(sessionId)) return;
    this.dropExited();
    if (this.overCap(sessionId)) {
      throw Object.assign(new Error("too many terminals"), { code: -32003 });
    }
  }

  create(opts: {
    sessionId: string;
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    outputByteLimit?: unknown;
  }): { terminalId: string } {
    const checked = assertTerminalCreateParams({
      command: opts.command,
      args: opts.args,
      outputByteLimit: opts.outputByteLimit,
    });
    this.assertRoom(opts.sessionId);
    const limit = checked.outputByteLimit;
    const terminalId = randomBytes(8).toString("hex");
    const child = spawn(checked.command, checked.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const term: TerminalRecord = {
      sessionId: opts.sessionId,
      child,
      chunks: [],
      bytes: 0,
      truncated: false,
      limit,
      exited: false,
      exitCode: null,
      signal: null,
      waiters: [],
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (term.exited) return;
      term.exited = true;
      term.exitCode = code;
      term.signal = signal;
      const waiters = term.waiters;
      term.waiters = [];
      for (const waiter of waiters) waiter({ exitCode: code, signal });
    };
    child.on("error", () => {
      // 'close' follows once stdio ends. Waiting for that keeps the last output chunk.
    });
    child.on("close", (code, signal) => finish(code, signal));
    const push = (buf: Buffer): void => appendTerminalOutput(term, buf);
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    this.terminals.set(terminalId, term);
    return { terminalId };
  }

  output(
    sessionId: string,
    terminalId: string,
  ): {
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode: number | null; signal: NodeJS.Signals | null };
  } {
    const term = this.require(sessionId, terminalId);
    return {
      output: terminalOutputText(term),
      truncated: term.truncated,
      ...(term.exited
        ? { exitStatus: { exitCode: term.exitCode, signal: term.signal } }
        : {}),
    };
  }

  /** Stop the command and keep the id so a later `terminal/output` still works. */
  kill(sessionId: string, terminalId: string): void {
    const term = this.require(sessionId, terminalId);
    killProcessTree(term.child, "SIGTERM");
  }

  /** Stop the command and invalidate the id. */
  release(sessionId: string, terminalId: string): void {
    const term = this.require(sessionId, terminalId);
    this.terminals.delete(terminalId);
    killProcessTree(term.child, "SIGTERM");
  }

  wait(
    sessionId: string,
    terminalId: string,
  ): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
    const term = this.require(sessionId, terminalId);
    if (term.exited) return Promise.resolve({ exitCode: term.exitCode, signal: term.signal });
    return new Promise((resolve) => {
      term.waiters.push(resolve);
    });
  }

  closeSession(sessionId?: string): void {
    for (const [id, term] of this.terminals) {
      if (sessionId && term.sessionId !== sessionId) continue;
      this.terminals.delete(id);
      killProcessTree(term.child, "SIGTERM");
    }
  }

  private overCap(sessionId: string): boolean {
    let forSession = 0;
    for (const term of this.terminals.values()) {
      if (term.sessionId === sessionId) forSession++;
    }
    return forSession >= MAX_TERMINALS_PER_SESSION || this.terminals.size >= MAX_TOTAL;
  }

  private dropExited(sessionId?: string): void {
    for (const [id, term] of this.terminals) {
      if (sessionId && term.sessionId !== sessionId) continue;
      if (!term.exited) continue;
      this.terminals.delete(id);
    }
  }

  private require(sessionId: string, terminalId: string): TerminalRecord {
    const term = this.terminals.get(terminalId);
    if (!term || term.sessionId !== sessionId) {
      throw Object.assign(new Error("unknown terminal"), { code: -32002 });
    }
    return term;
  }
}
