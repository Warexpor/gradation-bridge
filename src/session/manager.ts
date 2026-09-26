import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawn as spawnProc } from "node:child_process";
import type { BridgeConfig, PermissionMode } from "../config/types.js";
import { findHarness } from "../harness/registry.js";
import { AcpStdioClient, type AcpJsonRpcRequest } from "../acp/client.js";
import {
  optionKindById,
  pathFromToolCall,
  pickOptionId,
  policyKindFromToolCall,
  type PermissionOption,
  type RequestPermissionParams,
} from "../acp/permissions.js";
import { decidePermission, requiresMachineWarning } from "../approval/policy.js";
import { assertAllowedRealPath, assertAllowedWorkspace, SandboxError } from "../approval/sandbox.js";
import { SessionLog } from "./log.js";

export type SessionStatus = "idle" | "running" | "needs_approval" | "error" | "closed";

export interface SessionRecord {
  sessionId: string;
  harness: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
  branch?: string;
  status: SessionStatus;
  permissionMode: PermissionMode;
  lastSeq: number;
  log: SessionLog;
  client: AcpStdioClient | null;
  agentSessionId: string;
}

export type SessionSummary = Omit<SessionRecord, "log" | "client" | "agentSessionId">;

export type BridgeEmitter = (msg: unknown) => void;

export interface SessionManagerOptions {
  config: BridgeConfig;
  /** Broadcast a JSON-RPC message to all connected phones. */
  broadcast?: BridgeEmitter;
  /** Send a JSON-RPC request to phones; first response wins. */
  requestPhone?: (
    method: string,
    params: unknown,
  ) => Promise<{ result?: unknown; error?: unknown; requestId: string | number }>;
  version?: string;
}

/**
 * Owns session lifetime: one ACP agent process per session, JSONL event log
 * with monotonic seq, approval policy, and phone fan-out.
 */
export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  private opts: SessionManagerOptions;
  private fullAutoWarned = false;
  private terminals = new Map<
    string,
    { child: ReturnType<typeof spawnProc>; sessionId: string; chunks: Buffer[] }
  >();

  constructor(opts?: SessionManagerOptions) {
    this.opts = opts ?? {
      config: { allowedRoots: [], defaultPermissionMode: "ask", harnesses: [] },
    };
  }

  setHooks(hooks: Pick<SessionManagerOptions, "broadcast" | "requestPhone">): void {
    if (hooks.broadcast) this.opts.broadcast = hooks.broadcast;
    if (hooks.requestPhone) this.opts.requestPhone = hooks.requestPhone;
  }

  updateConfig(config: BridgeConfig): void {
    this.opts.config = config;
  }

  get config(): BridgeConfig {
    return this.opts.config;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  list(opts?: { limit?: number; before?: string }): SessionSummary[] {
    let items = [...this.sessions.values()]
      .filter((s) => s.status !== "closed")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (opts?.before) items = items.filter((s) => s.updatedAt < opts.before!);
    if (opts?.limit != null) items = items.slice(0, opts.limit);
    return items.map((s) => this.toSummary(s));
  }

  private toSummary(s: SessionRecord): SessionSummary {
    return {
      sessionId: s.sessionId,
      harness: s.harness,
      cwd: s.cwd,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      preview: s.preview,
      branch: s.branch,
      status: s.status,
      permissionMode: s.permissionMode,
      lastSeq: s.log.lastSeq,
    };
  }

  appendEvent(sessionId: string, event: unknown): { seq: number } {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session: ${sessionId}`);
    const entry = rec.log.append(event);
    rec.lastSeq = entry.seq;
    rec.updatedAt = entry.ts;
    return { seq: entry.seq };
  }

  setStatus(
    sessionId: string,
    status: SessionStatus,
    patch?: Partial<Pick<SessionRecord, "title" | "preview" | "branch">>,
  ): void {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session: ${sessionId}`);
    rec.status = status;
    rec.updatedAt = new Date().toISOString();
    if (patch?.title != null) rec.title = patch.title;
    if (patch?.preview != null) rec.preview = patch.preview;
    if (patch?.branch != null) rec.branch = patch.branch;
    this.emitSessionStatus(rec);
  }

  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session: ${sessionId}`);
    rec.permissionMode = mode;
    rec.updatedAt = new Date().toISOString();
    this.warnFullAuto(mode);
  }

  private warnFullAuto(mode: PermissionMode): void {
    if (requiresMachineWarning(mode) && !this.fullAutoWarned) {
      this.fullAutoWarned = true;
      process.stderr.write(
        "warning: permission mode full-auto allows all tool calls without prompting\n",
      );
    }
  }

  close(sessionId: string): boolean {
    const rec = this.sessions.get(sessionId);
    if (!rec) return false;
    rec.status = "closed";
    rec.client?.kill();
    rec.client = null;
    rec.log.close();
    this.emitSessionStatus(rec);
    return true;
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.close(id);
    for (const [tid, t] of this.terminals) {
      try {
        t.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.terminals.delete(tid);
    }
  }

  /**
   * Start a harness process, initialize ACP, create a session.
   * Phone-facing sessionId equals the agent sessionId.
   */
  async startSession(params: {
    harnessId: string;
    cwd: string;
    permissionMode?: PermissionMode;
    mcpServers?: unknown[];
    model?: string;
    title?: string;
  }): Promise<SessionRecord> {
    const config = this.opts.config;
    const cwd = assertAllowedWorkspace(params.cwd, config.allowedRoots);
    const harness = findHarness(config, params.harnessId);
    if (!harness) {
      const err = new Error(`unknown harness: ${params.harnessId}`) as Error & { code?: number };
      err.code = -32602;
      throw err;
    }
    const permissionMode = params.permissionMode ?? config.defaultPermissionMode ?? "ask";
    this.warnFullAuto(permissionMode);

    const tempId = randomBytes(12).toString("hex");
    const now = new Date().toISOString();
    const log = new SessionLog(tempId);
    const rec: SessionRecord = {
      sessionId: tempId,
      harness: harness.id,
      cwd,
      title: params.title ?? "New session",
      createdAt: now,
      updatedAt: now,
      preview: "",
      status: "idle",
      permissionMode,
      lastSeq: 0,
      log,
      client: null,
      agentSessionId: tempId,
    };
    this.sessions.set(tempId, rec);

    // Capture session id by reference so handlers see re-keying.
    const self = this;
    const client = new AcpStdioClient({
      harness,
      cwd,
      env: config.env,
      onNotification: (msg) => {
        const current = self.sessions.get(rec.sessionId) ?? rec;
        self.onAgentNotification(current, msg.method, msg.params);
      },
      onRequest: (req) => {
        const current = self.sessions.get(rec.sessionId) ?? rec;
        return self.onAgentRequest(current, req);
      },
      onExit: (code, signal) => {
        if (rec.status !== "closed") {
          rec.status = "error";
          rec.preview = `agent exited (code=${code}, signal=${signal})`;
          rec.updatedAt = new Date().toISOString();
          self.emitSessionStatus(rec);
        }
      },
    });
    rec.client = client;

    try {
      client.start();
      await client.initialize({
        name: "gradation-bridge",
        version: this.opts.version ?? "0.1.0",
      });
      const created = await client.newSession({
        cwd,
        mcpServers: params.mcpServers ?? [],
        _meta: {
          harness: harness.id,
          permissionMode,
          ...(params.model ? { model: params.model } : {}),
        },
      });
      const agentSessionId = created.sessionId;
      if (agentSessionId !== tempId) {
        this.sessions.delete(tempId);
        rec.sessionId = agentSessionId;
        rec.agentSessionId = agentSessionId;
        this.sessions.set(agentSessionId, rec);
      }
      this.setStatus(rec.sessionId, "idle");
      return rec;
    } catch (e) {
      rec.status = "error";
      client.kill();
      rec.client = null;
      this.sessions.delete(rec.sessionId);
      throw e;
    }
  }

  async prompt(sessionId: string, prompt: unknown): Promise<unknown> {
    const rec = this.requireSession(sessionId);
    if (!rec.client?.running) throw new Error(`session agent not running: ${sessionId}`);
    this.setStatus(sessionId, "running");
    try {
      const result = await rec.client.prompt(sessionId, prompt);
      if (rec.status === "running" || rec.status === "needs_approval") {
        this.setStatus(sessionId, "idle");
      }
      return result;
    } catch (e) {
      this.setStatus(sessionId, "error", {
        preview: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  cancel(sessionId: string): void {
    const rec = this.sessions.get(sessionId);
    if (!rec?.client?.running) return;
    rec.client.cancel(sessionId);
  }

  /**
   * Replay logged notifications with seq > afterSeq to one phone, then try agent load.
   */
  async load(
    sessionId: string,
    opts: {
      cwd?: string;
      afterSeq?: number;
      send: BridgeEmitter;
      mcpServers?: unknown[];
    },
  ): Promise<Record<string, unknown>> {
    const rec = this.sessions.get(sessionId);
    if (!rec) {
      const err = new Error(`unknown session: ${sessionId}`) as Error & { code?: number };
      err.code = -32002;
      throw err;
    }
    const afterSeq = opts.afterSeq ?? 0;
    for (const entry of rec.log.replay(afterSeq)) {
      opts.send(entry.event);
    }
    if (rec.client?.running) {
      try {
        await rec.client.loadSession({
          sessionId,
          cwd: opts.cwd ?? rec.cwd,
          mcpServers: opts.mcpServers ?? [],
        });
      } catch {
        /* replay alone is enough */
      }
    }
    return {};
  }

  private requireSession(sessionId: string): SessionRecord {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session: ${sessionId}`);
    return rec;
  }

  private onAgentNotification(rec: SessionRecord, method: string, params: unknown): void {
    if (method === "session/update") {
      const p = (params ?? {}) as Record<string, unknown>;
      const updateParams: Record<string, unknown> = { ...p, sessionId: rec.sessionId };
      this.broadcastLogged(rec, {
        jsonrpc: "2.0",
        method: "session/update",
        params: updateParams,
      });
      const update = updateParams.update as
        | { sessionUpdate?: string; content?: { text?: string } }
        | undefined;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) {
        rec.preview = update.content.text.slice(0, 160);
        rec.updatedAt = new Date().toISOString();
      }
      return;
    }
    this.broadcastLogged(rec, { jsonrpc: "2.0", method, params });
  }

  private async onAgentRequest(rec: SessionRecord, req: AcpJsonRpcRequest): Promise<unknown> {
    switch (req.method) {
      case "session/request_permission":
        return this.handlePermission(rec, (req.params ?? {}) as RequestPermissionParams);
      case "fs/read_text_file":
        return this.handleReadTextFile(rec, req.params);
      case "fs/write_text_file":
        return this.handleWriteTextFile(rec, req.params);
      case "terminal/create":
        return this.handleTerminalCreate(rec, req.params);
      case "terminal/output":
        return this.handleTerminalOutput(req.params);
      case "terminal/release":
      case "terminal/kill":
        return this.handleTerminalKill(req.params);
      case "terminal/wait_for_exit":
        return this.handleTerminalWait(req.params);
      default: {
        const err = new Error(`Method not found: ${req.method}`) as Error & { code?: number };
        err.code = -32601;
        throw err;
      }
    }
  }

  private async handlePermission(
    rec: SessionRecord,
    params: RequestPermissionParams,
  ): Promise<unknown> {
    const toolCall = params.toolCall;
    const kind = policyKindFromToolCall(toolCall);
    const path = pathFromToolCall(toolCall);
    const decision = decidePermission(rec.permissionMode, {
      kind,
      path,
      workspaceRoot: rec.cwd,
      allowedRoots: this.opts.config.allowedRoots,
    });
    const options = (params.options ?? []) as PermissionOption[];

    if (decision.action === "allow") {
      const optionId = pickOptionId(options, "allow");
      if (!optionId) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId } };
    }
    if (decision.action === "deny") {
      const optionId = pickOptionId(options, "reject");
      if (!optionId) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId } };
    }

    this.setStatus(rec.sessionId, "needs_approval");
    // Log + stamp seq, then send the stamped params to phones
    const entry = rec.log.append({
      jsonrpc: "2.0",
      method: "session/request_permission",
      params: {
        sessionId: rec.sessionId,
        toolCall,
        options,
      },
    });
    rec.lastSeq = entry.seq;
    const phoneParams = (entry.event as { params: Record<string, unknown> }).params;

    if (!this.opts.requestPhone) {
      if (rec.status === "needs_approval") this.setStatus(rec.sessionId, "idle");
      return { outcome: { outcome: "cancelled" } };
    }

    try {
      const { result, requestId } = await this.opts.requestPhone(
        "session/request_permission",
        phoneParams,
      );
      const outcome = (result as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
      const optionId = outcome?.optionId;
      const optionKind = optionKindById(options, optionId);
      this.opts.broadcast?.({
        jsonrpc: "2.0",
        method: "bridge/permissionResolved",
        params: {
          sessionId: rec.sessionId,
          requestId,
          optionKind: optionKind ?? outcome?.outcome ?? "cancelled",
          _meta: { seq: rec.log.lastSeq },
        },
      });
      if (rec.status === "needs_approval") this.setStatus(rec.sessionId, "running");
      return result ?? { outcome: { outcome: "cancelled" } };
    } catch {
      if (rec.status === "needs_approval") this.setStatus(rec.sessionId, "idle");
      return { outcome: { outcome: "cancelled" } };
    }
  }

  private handleReadTextFile(rec: SessionRecord, params: unknown): { content: string } {
    const p = (params ?? {}) as { path?: string; line?: number; limit?: number };
    if (!p.path) throw Object.assign(new Error("path required"), { code: -32602 });
    const path = assertAllowedRealPath(p.path, this.opts.config.allowedRoots, rec.cwd);
    let content = readFileSync(path, "utf8");
    if (p.line != null || p.limit != null) {
      const lines = content.split("\n");
      const start = Math.max(0, (p.line ?? 1) - 1);
      const end = p.limit != null ? start + p.limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }
    return { content };
  }

  private handleWriteTextFile(rec: SessionRecord, params: unknown): Record<string, never> {
    const p = (params ?? {}) as { path?: string; content?: string };
    if (!p.path) throw Object.assign(new Error("path required"), { code: -32602 });
    const path = assertAllowedRealPath(p.path, this.opts.config.allowedRoots, rec.cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, p.content ?? "", "utf8");
    return {};
  }

  private handleTerminalCreate(
    rec: SessionRecord,
    params: unknown,
  ): { terminalId: string } {
    const p = (params ?? {}) as {
      command?: string;
      args?: string[];
      cwd?: string;
      env?: Array<{ name: string; value: string }>;
    };
    if (!p.command) throw Object.assign(new Error("command required"), { code: -32602 });
    const cwd = p.cwd
      ? assertAllowedRealPath(p.cwd, this.opts.config.allowedRoots, rec.cwd)
      : rec.cwd;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const e of p.env ?? []) env[e.name] = e.value;
    const terminalId = randomBytes(8).toString("hex");
    const chunks: Buffer[] = [];
    const child = spawnProc(p.command, p.args ?? [], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (b: Buffer) => chunks.push(b));
    child.stderr?.on("data", (b: Buffer) => chunks.push(b));
    this.terminals.set(terminalId, { child, sessionId: rec.sessionId, chunks });
    return { terminalId };
  }

  private handleTerminalOutput(params: unknown): {
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode: number | null; signal: string | null };
  } {
    const p = (params ?? {}) as { terminalId?: string };
    const t = p.terminalId ? this.terminals.get(p.terminalId) : undefined;
    if (!t) throw Object.assign(new Error("unknown terminal"), { code: -32002 });
    const output = Buffer.concat(t.chunks).toString("utf8");
    const exited = t.child.exitCode !== null;
    return {
      output,
      truncated: false,
      ...(exited
        ? { exitStatus: { exitCode: t.child.exitCode, signal: t.child.signalCode } }
        : {}),
    };
  }

  private handleTerminalKill(params: unknown): Record<string, never> {
    const p = (params ?? {}) as { terminalId?: string };
    const t = p.terminalId ? this.terminals.get(p.terminalId) : undefined;
    if (t) {
      try {
        t.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.terminals.delete(p.terminalId!);
    }
    return {};
  }

  private handleTerminalWait(params: unknown): Promise<{
    exitCode: number | null;
    signal: string | null;
  }> {
    const p = (params ?? {}) as { terminalId?: string };
    const t = p.terminalId ? this.terminals.get(p.terminalId) : undefined;
    if (!t) {
      return Promise.reject(Object.assign(new Error("unknown terminal"), { code: -32002 }));
    }
    return new Promise((resolve) => {
      if (t.child.exitCode !== null || t.child.signalCode) {
        resolve({ exitCode: t.child.exitCode, signal: t.child.signalCode });
        return;
      }
      t.child.once("exit", (code, signal) => {
        resolve({ exitCode: code, signal });
      });
    });
  }

  private broadcastLogged(
    rec: SessionRecord,
    frame: { jsonrpc: string; method: string; params: unknown },
  ): number {
    const entry = rec.log.append(frame);
    rec.lastSeq = entry.seq;
    rec.updatedAt = entry.ts;
    this.opts.broadcast?.(entry.event);
    return entry.seq;
  }

  private emitSessionStatus(rec: SessionRecord): void {
    const entry = rec.log.append({
      jsonrpc: "2.0",
      method: "bridge/sessionStatus",
      params: {
        sessionId: rec.sessionId,
        status: rec.status,
        title: rec.title,
        preview: rec.preview,
        branch: rec.branch,
      },
    });
    rec.lastSeq = entry.seq;
    this.opts.broadcast?.(entry.event);
  }
}

export { SandboxError };
