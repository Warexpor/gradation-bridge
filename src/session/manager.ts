import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawn as spawnProc } from "node:child_process";
import type { BridgeConfig, PermissionMode } from "../config/types.js";
import { BridgeError } from "../errors.js";
import { findHarness } from "../harness/registry.js";
import { launchErrorData, resolveHarnessLaunch } from "../harness/catalog.js";
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
import {
  consumeGrant,
  grantFamilyForKind,
  grantFromOption,
  resolveGrantPath,
  type GrantFamily,
  type ToolGrant,
} from "../approval/grants.js";
import { assertAllowedRealPath, assertAllowedWorkspace, SandboxError } from "../approval/sandbox.js";
import { log } from "../log/diagnostics.js";
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
  /** Approvals the phone already gave. Not sent to the phone. */
  grants: ToolGrant[];
  /** ACP session/new `modes`, when the agent returned them. */
  sessionModes?: unknown;
  agentInfo?: { name: string; version?: string };
  authMethods?: Array<{ id: string; name?: string; description?: string }>;
}

export type SessionSummary = Omit<
  SessionRecord,
  "log" | "client" | "agentSessionId" | "grants" | "sessionModes" | "agentInfo" | "authMethods"
>;

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
  private phoneInitialize: Record<string, unknown> | undefined;
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

  /** Remember the phone's initialize params so the next agent sees its capabilities. */
  notePhoneInitialize(params: unknown): void {
    if (params && typeof params === "object" && !Array.isArray(params)) {
      this.phoneInitialize = params as Record<string, unknown>;
    }
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
    if (!rec) throw new BridgeError(-32002, `unknown session: ${sessionId}`, { sessionId });
    if (rec.permissionMode !== mode) {
      rec.grants = [];
      rec.permissionMode = mode;
    }
    rec.updatedAt = new Date().toISOString();
    this.warnFullAuto(mode);
    log("info", `permission mode ${mode} session=${sessionId}`);
  }

  /**
   * ACP session/set_mode. Bridge permission ids also update local policy so
   * existing GradatiON clients keep working. Other ids (Cursor's `agent`, …)
   * are forwarded to the harness only.
   */
  async applyMode(sessionId: string, modeId: string): Promise<Record<string, unknown>> {
    const rec = this.requireSession(sessionId);
    const isPermission = isPermissionMode(modeId);
    if (isPermission) this.setPermissionMode(sessionId, modeId);
    let forwarded = false;
    let warning: string | undefined;
    if (rec.client?.running) {
      try {
        await rec.client.setMode(rec.agentSessionId, modeId);
        forwarded = true;
      } catch (e) {
        warning = e instanceof Error ? e.message : String(e);
        log("info", `session/set_mode ${modeId} rejected by agent: ${warning}`);
        if (!isPermission) {
          throw new BridgeError(-32602, warning, { modeId, sessionId });
        }
      }
    } else if (!isPermission) {
      throw new BridgeError(-32002, `session agent not running: ${sessionId}`, { sessionId });
    }
    return {
      ...(isPermission ? { permissionMode: rec.permissionMode } : {}),
      forwarded,
      ...(warning ? { warning } : {}),
    };
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
      throw new BridgeError(-32602, `unknown harness: ${params.harnessId}`, {
        harnessId: params.harnessId,
      });
    }
    const launch = resolveHarnessLaunch(harness);
    if (!launch.available) {
      log("error", `harness ${harness.id} missing: ${launch.detail}`);
      throw new BridgeError(
        -32010,
        `harness ${harness.id} is not available: ${launch.detail}`,
        launchErrorData(launch),
      );
    }
    const permissionMode = params.permissionMode ?? config.defaultPermissionMode ?? "ask";
    this.warnFullAuto(permissionMode);
    log(
      "info",
      `starting harness ${harness.id} (${launch.readiness}) ${launch.command} ${launch.displayArgs.join(" ")}`.trim(),
    );

    const tempId = randomBytes(12).toString("hex");
    const now = new Date().toISOString();
    const sessionLog = new SessionLog(tempId);
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
      log: sessionLog,
      client: null,
      agentSessionId: tempId,
      grants: [],
    };
    this.sessions.set(tempId, rec);

    // Capture session id by reference so handlers see re-keying.
    const self = this;
    const client = new AcpStdioClient({
      harness: { ...harness, command: launch.command, args: launch.args },
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
      onStderr: (line) => {
        log("debug", `harness ${harness.id} stderr: ${line}`);
      },
      onExit: (code, signal) => {
        if (rec.status !== "closed") {
          rec.status = "error";
          const tail = client.stderrTail().split("\n").filter(Boolean).slice(-1)[0];
          rec.preview = tail
            ? `agent exited (code=${code}, signal=${signal}): ${tail}`
            : `agent exited (code=${code}, signal=${signal})`;
          rec.updatedAt = new Date().toISOString();
          log(
            "warn",
            `harness ${harness.id} exited code=${code} signal=${signal} session=${rec.sessionId}`,
          );
          self.emitSessionStatus(rec);
        }
      },
    });
    rec.client = client;

    try {
      client.start();
      const phoneCaps = this.phoneCapabilities();
      const initialized = await client.initialize({
        clientInfo: {
          name: "gradation-bridge",
          version: this.opts.version ?? "0.1.0",
        },
        clientCapabilities: phoneCaps,
      });
      const agentInit = readAgentInitialize(initialized);
      rec.agentInfo = agentInit.agentInfo;
      rec.authMethods = agentInit.authMethods;
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
      if (created.modes && typeof created.modes === "object") {
        rec.sessionModes = created.modes;
      }
      if (agentSessionId !== tempId) {
        this.sessions.delete(tempId);
        rec.sessionId = agentSessionId;
        rec.agentSessionId = agentSessionId;
        this.sessions.set(agentSessionId, rec);
      }
      this.setStatus(rec.sessionId, "idle");
      return rec;
    } catch (e) {
      const stderr = client.stderrTail().slice(-2000);
      rec.status = "error";
      client.kill();
      rec.client = null;
      this.sessions.delete(rec.sessionId);
      if (e instanceof BridgeError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      log("error", `harness ${harness.id} failed to start: ${message}`);
      throw new BridgeError(
        -32010,
        `harness ${harness.id} failed to start: ${message}`,
        launchErrorData(launch, stderr ? { stderr } : {}),
      );
    }
  }

  async prompt(sessionId: string, params: unknown): Promise<unknown> {
    const rec = this.requireSession(sessionId);
    if (!rec.client?.running) throw new Error(`session agent not running: ${sessionId}`);
    this.setStatus(sessionId, "running");
    const body =
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
    try {
      const result = await rec.client.prompt({ ...body, sessionId: rec.agentSessionId });
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
    let agentResult: unknown = {};
    if (rec.client?.running) {
      try {
        agentResult = await rec.client.loadSession({
          sessionId,
          cwd: opts.cwd ?? rec.cwd,
          mcpServers: opts.mcpServers ?? [],
        });
      } catch {
        /* replay alone is enough */
      }
    }
    if (agentResult && typeof agentResult === "object") {
      return agentResult as Record<string, unknown>;
    }
    return {};
  }

  private phoneCapabilities(): Record<string, unknown> | undefined {
    const caps = this.phoneInitialize?.clientCapabilities;
    if (caps && typeof caps === "object" && !Array.isArray(caps)) {
      return caps as Record<string, unknown>;
    }
    return undefined;
  }

  private assertMutatingTool(rec: SessionRecord, family: GrantFamily, path?: string): void {
    const decision = decidePermission(rec.permissionMode, {
      kind: family === "write" ? "write" : "execute",
      path,
      workspaceRoot: rec.cwd,
      allowedRoots: this.opts.config.allowedRoots,
    });
    if (decision.action === "deny") {
      log(
        "warn",
        `blocked ${family} session=${rec.sessionId} mode=${rec.permissionMode}: ${decision.reason}`,
      );
      throw new BridgeError(-32003, decision.reason, {
        sessionId: rec.sessionId,
        permissionMode: rec.permissionMode,
        kind: family,
      });
    }
    if (decision.action === "ask" && !consumeGrant(rec.grants, family, path)) {
      const message =
        family === "write"
          ? "write requires approval before the agent can change files"
          : "command requires approval before the agent can run a terminal";
      log("warn", `blocked ${family} session=${rec.sessionId}: ${message}`);
      throw new BridgeError(-32003, message, {
        sessionId: rec.sessionId,
        permissionMode: rec.permissionMode,
        kind: family,
      });
    }
  }

  private requireSession(sessionId: string): SessionRecord {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new BridgeError(-32002, `unknown session: ${sessionId}`, { sessionId });
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

    log(
      "info",
      `permission ${decision.action} session=${rec.sessionId} mode=${rec.permissionMode} kind=${kind}: ${decision.reason}`,
    );

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
      if (outcome?.outcome === "selected") {
        const grant = grantFromOption(
          optionKind,
          grantFamilyForKind(kind),
          resolveGrantPath(path, rec.cwd),
        );
        if (grant) rec.grants.push(grant);
      }
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
    this.assertMutatingTool(rec, "write", path);
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
    this.assertMutatingTool(rec, "exec");
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

const PERMISSION_MODE_IDS = new Set<PermissionMode>(["ask", "auto-edit", "plan", "full-auto"]);

function isPermissionMode(modeId: string): modeId is PermissionMode {
  return PERMISSION_MODE_IDS.has(modeId as PermissionMode);
}

function readAgentInitialize(result: unknown): {
  agentInfo?: { name: string; version?: string };
  authMethods?: Array<{ id: string; name?: string; description?: string }>;
} {
  if (!result || typeof result !== "object") return {};
  const obj = result as Record<string, unknown>;
  let agentInfo: { name: string; version?: string } | undefined;
  const info = obj.agentInfo;
  if (info && typeof info === "object") {
    const rec = info as Record<string, unknown>;
    if (typeof rec.name === "string") {
      agentInfo = {
        name: rec.name,
        ...(typeof rec.version === "string" ? { version: rec.version } : {}),
      };
    }
  }
  const methods = Array.isArray(obj.authMethods) ? obj.authMethods : [];
  const authMethods = methods.flatMap((m) => {
    if (!m || typeof m !== "object") return [];
    const rec = m as Record<string, unknown>;
    if (typeof rec.id !== "string") return [];
    return [
      {
        id: rec.id,
        ...(typeof rec.name === "string" ? { name: rec.name } : {}),
        ...(typeof rec.description === "string" ? { description: rec.description.slice(0, 240) } : {}),
      },
    ];
  });
  return {
    agentInfo,
    ...(authMethods.length ? { authMethods } : {}),
  };
}
