import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BridgeConfig, PermissionMode } from "../config/types.js";
import { BridgeError } from "../errors.js";
import { resolveExecutable } from "../harness/path.js";
import { findHarness } from "../harness/registry.js";
import { launchErrorData, resolveHarnessLaunch, type HarnessLaunch } from "../harness/catalog.js";
import {
  assertAgentAuthMethod,
  publicAuthMethods,
  readAgentInitialize,
  type PublicAuthMethod,
} from "../acp/auth-method.js";
import { REQUEST_CANCELLED } from "../acp/cancel.js";
import { AcpStdioClient, isMethodNotFound, type AcpJsonRpcRequest } from "../acp/client.js";
import {
  bindElicitationSession,
  elicitationLogLabel,
  elicitationSupportFromInitialize,
  ElicitationRejected,
  mergeInitializeElicitation,
  relayElicitationParams,
  sanitizeElicitationResponse,
} from "../acp/elicitation.js";
import { assertSupportedPrompt, firstPromptText } from "../acp/prompt.js";
import { assertNotDirectory, assertWritableContent, readTextFileWindow, writeTextNoFollow } from "../acp/text-file.js";
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
import { redactSecrets } from "../log/redact.js";
import { compareRecentSession, isSafeSessionId } from "./ids.js";
import { SessionLog, type LoggedEvent } from "./log.js";
import {
  deletePersistedSession,
  loadPersistedMetas,
  removeSessionStorage,
  sealPersistedClosed,
  writeSessionMeta,
  type SessionMeta,
} from "./persist.js";
import { assertTerminalCreateParams, isEnvName, TerminalTable } from "./terminals.js";

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
  authMethods?: PublicAuthMethod[];
  /** Agent advertised `agentCapabilities.auth.logout`. */
  logoutSupported: boolean;
  mcpServers: unknown[];
  /** Extra workspace roots, already realpath-checked against allowedRoots. */
  additionalDirectories: string[];
  /** ACP session/new `configOptions`, when the agent returned them. */
  configOptions?: unknown;
  /** Bumped each time a new agent process is bound so a late exit is ignored. */
  clientGeneration: number;
  promptInFlight: boolean;
  cancelRequested: boolean;
  /** Set while session/close is in progress so an agent exit is not stored as an error. */
  closing: boolean;
}

export type SessionSummary = Omit<
  SessionRecord,
  | "log"
  | "client"
  | "agentSessionId"
  | "grants"
  | "sessionModes"
  | "agentInfo"
  | "authMethods"
  | "logoutSupported"
  | "mcpServers"
  | "configOptions"
  | "clientGeneration"
  | "promptInFlight"
  | "cancelRequested"
  | "closing"
> & {
  /** Public harness login methods. Terminal env is already stripped. */
  authMethods?: PublicAuthMethod[];
  /** Present when the harness advertised logout. */
  logout?: boolean;
};

export type BridgeEmitter = (
  msg: unknown,
  opts?: { droppable?: boolean },
) => void | boolean | Promise<void | boolean>;

/** Which in-flight phone prompts to abort. */
export interface PhoneCancelFilter {
  sessionId?: string;
  /** Pre-session login owner (`warm:<harness>\\0<cwd>`). */
  owner?: string;
  method?: string;
}

export interface PhoneRequestContext {
  signal?: AbortSignal;
  owner?: string;
}

export interface SessionManagerOptions {
  config: BridgeConfig;
  /** Broadcast a JSON-RPC message to all connected phones. */
  broadcast?: BridgeEmitter;
  /** Send a JSON-RPC request to phones; first response wins. */
  requestPhone?: (
    method: string,
    params: unknown,
    ctx?: PhoneRequestContext,
  ) => Promise<{ result?: unknown; error?: unknown; requestId: string | number }>;
  /** Abort in-flight phone requests (session cancel, or one warm login). */
  cancelPhoneRequests?: (filter: PhoneCancelFilter) => void;
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
  private stopping = false;
  private phoneInitialize: Record<string, unknown> | undefined;
  private terminals = new TerminalTable();
  /** Authenticated harness kept until the next session/new for the same cwd. */
  private warm = new Map<string, WarmAuth>();
  /** Pre-session authenticate calls. A second call for the same key is refused. */
  private warmInflight = new Map<string, Promise<unknown>>();
  /** Process started for a login that has not been stored in `warm` yet. */
  private warmLive = new Map<string, AcpStdioClient>();
  /** Bumped when a warm login is cancelled so a late success cannot install itself. */
  private warmEpoch = new Map<string, number>();
  /** Set when the phone cancels the in-flight authenticate (`$/cancel_request`). */
  private warmAbort = new Set<string>();
  /** Bumped when a session authenticate is cancelled. Captured at the start of the call. */
  private sessionAuthEpoch = new Map<string, number>();
  /** Bumped when the permission mode changes so an in-flight approval cannot outlive it. */
  private permissionEpoch = new Map<string, number>();
  /** Resolves when the in-flight prompt's finally runs, including after the agent dies. */
  private promptGates = new Map<string, Promise<void>>();
  /** One respawn per session so two phones cannot start two harnesses. */
  private respawnInflight = new Map<string, Promise<unknown>>();

  constructor(opts?: SessionManagerOptions) {
    this.opts = opts ?? {
      config: { allowedRoots: [], defaultPermissionMode: "ask", harnesses: [] },
    };
    this.restorePersisted();
  }

  setHooks(
    hooks: Pick<SessionManagerOptions, "broadcast" | "requestPhone" | "cancelPhoneRequests">,
  ): void {
    if (hooks.broadcast) this.opts.broadcast = hooks.broadcast;
    if (hooks.requestPhone) this.opts.requestPhone = hooks.requestPhone;
    if (hooks.cancelPhoneRequests) this.opts.cancelPhoneRequests = hooks.cancelPhoneRequests;
  }

  updateConfig(config: BridgeConfig): void {
    this.opts.config = config;
  }

  /** Remember the phone's initialize params so the next agent sees its capabilities. */
  notePhoneInitialize(params: unknown): void {
    if (params && typeof params === "object" && !Array.isArray(params)) {
      this.phoneInitialize = mergeInitializeElicitation(this.phoneInitialize, params);
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
      .sort(compareRecentSession);
    if (opts?.before) items = items.filter((s) => s.updatedAt < opts.before!);
    if (opts?.limit != null && Number.isFinite(opts.limit)) {
      items = items.slice(0, Math.max(0, Math.floor(opts.limit)));
    }
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
      additionalDirectories: s.additionalDirectories,
      ...(s.authMethods?.length ? { authMethods: s.authMethods } : {}),
      ...(s.logoutSupported ? { logout: true } : {}),
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
    const rec = this.requireSession(sessionId);
    if (rec.permissionMode !== mode) {
      rec.grants = [];
      rec.permissionMode = mode;
      this.permissionEpoch.set(sessionId, (this.permissionEpoch.get(sessionId) ?? 0) + 1);
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
      throw new BridgeError(-32004, `session agent not running: ${sessionId}`, { sessionId });
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
    if (!rec || rec.status === "closed") return false;
    rec.closing = true;
    rec.clientGeneration += 1;
    rec.status = "closed";
    rec.promptInFlight = false;
    rec.cancelRequested = true;
    this.opts.cancelPhoneRequests?.({ sessionId });
    rec.client?.kill();
    rec.client = null;
    this.terminals.closeSession(sessionId);
    rec.log.close();
    this.emitSessionStatus(rec);
    return true;
  }

  /**
   * Process shutdown. Kill harnesses but leave sessions resumable:
   * meta stays `idle` (or `error`) so the next process can list and load them.
   */
  async closeAll(): Promise<void> {
    this.stopping = true;
    const keys = new Set([...this.warm.keys(), ...this.warmInflight.keys()]);
    for (const key of keys) this.bumpWarm(key);
    for (const id of [...this.sessions.keys()]) this.detachForShutdown(id);
    this.terminals.closeSession();
  }

  /**
   * ACP session/close. Tells the harness when it is still up, then tears down locally.
   * `missing: "ignore"` matches bridge/closeSession (unknown id is a no-op).
   */
  async closeSession(
    sessionId: string,
    opts?: { missing?: "error" | "ignore" },
  ): Promise<Record<string, never>> {
    const rec = this.sessions.get(sessionId);
    if (!rec) {
      // Closed sessions and rows past the restore cap are not in memory.
      // Close still applies so a retry after restart does not look unknown.
      if (sealPersistedClosed(sessionId) || opts?.missing !== "error") return {};
      throw new BridgeError(-32002, `unknown session: ${sessionId}`, { sessionId });
    }
    if (rec.status === "closed") return {};
    rec.closing = true;
    rec.cancelRequested = true;
    this.opts.cancelPhoneRequests?.({ sessionId });
    if (rec.client?.running) {
      try {
        await rec.client.closeSession(rec.agentSessionId);
      } catch {
        // The process is killed below either way.
      }
    }
    this.close(sessionId);
    return {};
  }

  /** ACP session/delete. Closes the session and removes its on-disk catalog. */
  async deleteSession(sessionId: string): Promise<Record<string, never>> {
    const rec = this.sessions.get(sessionId);
    if (!rec) {
      if (!deletePersistedSession(sessionId)) {
        throw new BridgeError(-32002, `unknown session: ${sessionId}`, { sessionId });
      }
      return {};
    }
    if (rec.status !== "closed") await this.closeSession(sessionId, { missing: "error" });
    this.sessions.delete(sessionId);
    this.permissionEpoch.delete(sessionId);
    this.promptGates.delete(sessionId);
    this.respawnInflight.delete(sessionId);
    try {
      rec.log.discard();
    } catch {
      removeSessionStorage(sessionId);
    }
    return {};
  }

  /**
   * ACP session/list. `cwd` is sandboxed. Cursor is the last sessionId of the previous page.
   */
  listForProtocol(opts?: { cwd?: string; cursor?: string }): {
    sessions: Array<Record<string, unknown>>;
    nextCursor?: string;
  } {
    const pageSize = 50;
    let items = this.list();
    if (opts?.cwd) {
      const want = assertAllowedRealPath(opts.cwd, this.opts.config.allowedRoots);
      items = items.filter((s) => s.cwd === want);
    }
    if (opts?.cursor) {
      const idx = items.findIndex((s) => s.sessionId === opts.cursor);
      // An empty page means "end". An unknown cursor must not look like the end.
      if (idx < 0) {
        throw new BridgeError(-32602, "invalid session cursor", {
          cursor: opts.cursor.slice(0, 200),
        });
      }
      items = items.slice(idx + 1);
    }
    const page = items.slice(0, pageSize);
    const next = items.length > pageSize ? page[page.length - 1]?.sessionId : undefined;
    return {
      sessions: page.map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title,
        updatedAt: s.updatedAt,
        ...(s.additionalDirectories.length ? { additionalDirectories: s.additionalDirectories } : {}),
        _meta: {
          harness: s.harness,
          permissionMode: s.permissionMode,
          status: s.status,
          preview: s.preview,
          lastSeq: s.lastSeq,
          ...(s.branch ? { branch: s.branch } : {}),
          ...(s.authMethods?.length ? { authMethods: s.authMethods } : {}),
          ...(s.logout ? { logout: true } : {}),
        },
      })),
      ...(next ? { nextCursor: next } : {}),
    };
  }

  noteBranch(sessionId: string, branch: string): void {
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.branch === branch) return;
    rec.branch = branch;
    rec.updatedAt = new Date().toISOString();
    this.persist(rec);
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
    additionalDirectories?: string[];
    model?: string;
    title?: string;
  }): Promise<SessionRecord> {
    const config = this.opts.config;
    const cwd = assertAllowedWorkspace(params.cwd, config.allowedRoots);
    const additionalDirectories = sandboxAdditionalDirectories(
      params.additionalDirectories,
      config.allowedRoots,
    );
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
      mcpServers: params.mcpServers ?? [],
      additionalDirectories,
      clientGeneration: 0,
      promptInFlight: false,
      cancelRequested: false,
      logoutSupported: false,
      closing: false,
    };
    this.sessions.set(tempId, rec);

    let client: AcpStdioClient | undefined;
    try {
      const warmKeyForLaunch = warmKey(harness.id, cwd);
    const pendingAuth = this.warmInflight.get(warmKeyForLaunch);
    if (pendingAuth) {
      try {
        await pendingAuth;
      } catch {
        // A failed or cancelled login does not block a fresh session process.
      }
    }
    const warm = this.takeMatchingWarm(harness.id, cwd, launch, overlayEnv(config.env, harness.env));
      if (warm) {
        client = warm.client;
        this.wireClient(rec, client, harness.id);
        rec.agentInfo = warm.agentInfo;
        rec.authMethods = warm.authMethods;
        rec.logoutSupported = warm.logoutSupported;
      } else {
        client = this.openClient(rec, launch);
        client.start();
        const initialized = await client.initialize(this.agentClientInfo());
        this.applyInit(rec, readAgentInitialize(initialized));
      }
      const created = await client.newSession({
        cwd,
        mcpServers: rec.mcpServers,
        additionalDirectories,
        _meta: {
          harness: harness.id,
          permissionMode,
          ...(params.model ? { model: params.model } : {}),
        },
      });
      const agentSessionId = created.sessionId;
      this.adoptAgentSession(rec, tempId, agentSessionId);
      this.captureSessionPayload(rec, created);
      this.setStatus(rec.sessionId, "idle");
      return rec;
    } catch (e) {
      const stderr = client?.stderrTail().slice(-2000) ?? "";
      rec.clientGeneration += 1;
      rec.status = "closed";
      client?.kill();
      rec.client = null;
      this.sessions.delete(tempId);
      this.sessions.delete(rec.sessionId);
      try {
        rec.log.discard();
      } catch {
        // The directory may already be gone.
      }
      if (e instanceof BridgeError) throw e;
      const message = publicErrorMessage(e);
      const agentCode =
        e && typeof e === "object" && typeof (e as { code?: unknown }).code === "number"
          ? (e as { code: number }).code
          : undefined;
      const extra: Record<string, unknown> = {
        ...(stderr ? { stderr } : {}),
        ...(rec.authMethods?.length ? { authMethods: rec.authMethods } : {}),
        ...(agentCode !== undefined ? { agentCode } : {}),
      };
      const authish = /auth_required|authentication required|not authenticated/i.test(message);
      log("error", `harness ${harness.id} failed to start: ${message}`);
      if (authish && rec.authMethods?.length) {
        throw new BridgeError(
          -32011,
          `harness ${harness.id} requires authentication: ${message}`,
          launchErrorData(launch, extra),
        );
      }
      throw new BridgeError(
        -32010,
        `harness ${harness.id} failed to start: ${message}`,
        launchErrorData(launch, extra),
      );
    }
  }

  async prompt(sessionId: string, params: unknown): Promise<unknown> {
    const rec = this.requireSession(sessionId);
    if (rec.promptInFlight) {
      throw new BridgeError(-32005, "prompt already in progress", { sessionId });
    }
    assertSupportedPrompt(params);
    this.assertSessionWorkspace(rec);
    const client = rec.client;
    if (!client?.running) {
      throw new BridgeError(-32004, `session agent not running: ${sessionId}`, { sessionId });
    }
    rec.promptInFlight = true;
    rec.cancelRequested = false;
    let releaseGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    this.promptGates.set(sessionId, gate);
    this.maybeTitle(rec, params);
    this.setStatus(sessionId, "running");
    const body =
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
    try {
      const result = await client.prompt({ ...body, sessionId: rec.agentSessionId });
      this.emitPromptResult(rec, { result });
      if (rec.status === "running" || rec.status === "needs_approval") {
        this.setStatus(sessionId, "idle");
      }
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!this.stopping) this.emitPromptResult(rec, { error: { message } });
      if (!this.stopping && rec.status !== "closed") {
        this.setStatus(sessionId, "error", { preview: message });
      }
      throw e;
    } finally {
      rec.promptInFlight = false;
      releaseGate();
      if (this.promptGates.get(sessionId) === gate) this.promptGates.delete(sessionId);
    }
  }

  cancel(sessionId: string): void {
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.status === "closed") return;
    rec.cancelRequested = true;
    // Unblock an agent waiting on session/request_permission, elicitation/create,
    // or terminal/wait_for_exit. A command that ignores SIGTERM is SIGKILLed.
    this.terminals.interruptSession(sessionId);
    this.opts.cancelPhoneRequests?.({ sessionId });
    if (rec.client?.running) rec.client.cancel(rec.agentSessionId);
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
      additionalDirectories?: string[];
    },
  ): Promise<Record<string, unknown>> {
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.status === "closed") {
      throw new BridgeError(-32002, `unknown session: ${sessionId}`, { sessionId });
    }
    const rawAfter = opts.afterSeq ?? 0;
    const afterSeq = Number.isFinite(rawAfter) ? Math.max(0, Math.floor(rawAfter)) : 0;
    if (opts.cwd) this.assertSameSessionCwd(rec, opts.cwd);
    this.applyAdditionalDirectories(rec, opts.additionalDirectories);
    if (opts.mcpServers && opts.mcpServers.length > 0) {
      rec.mcpServers = opts.mcpServers;
    }
    let replayed = 0;
    for (const entry of rec.log.replay(afterSeq)) {
      try {
        const sent = await opts.send(entry.event);
        if (sent === false) break;
      } catch {
        break;
      }
      replayed++;
    }

    if (!rec.client?.running) {
      const gate = this.promptGates.get(sessionId);
      if (gate) await gate;
    }
    if ((rec.status as SessionStatus) === "closed") {
      throw new BridgeError(-32002, `unknown session: ${sessionId}`, { sessionId });
    }

    let agentAlive = Boolean(rec.client?.running);
    let agentResult: unknown = {};
    let warning: string | undefined;
    if (!agentAlive && !rec.promptInFlight) {
      this.assertSessionWorkspace(rec);
      try {
        agentResult = await this.respawnAgent(rec, "load");
        agentAlive = Boolean(rec.client?.running);
      } catch (e) {
        agentAlive = false;
        warning = e instanceof Error ? e.message : String(e);
        log("warn", `session/load ${sessionId}: ${warning}`);
      }
    } else if (agentAlive && rec.client && !rec.promptInFlight) {
      try {
        agentResult = await rec.client.loadSession({
          sessionId: rec.agentSessionId,
          cwd: rec.cwd,
          mcpServers: rec.mcpServers,
          additionalDirectories: rec.additionalDirectories,
        });
      } catch (e) {
        warning = e instanceof Error ? e.message : String(e);
        log("info", `session/load ${sessionId} agent load failed: ${warning}`);
      }
    }
    this.captureSessionPayload(rec, agentResult);
    const replayMeta = {
      sessionId: rec.sessionId,
      replayed,
      agentAlive,
      lastSeq: rec.log.lastSeq,
      status: rec.status,
      ...(warning ? { warning } : {}),
    };
    if (agentResult && typeof agentResult === "object") {
      return { ...(agentResult as Record<string, unknown>), ...replayMeta };
    }
    return replayMeta;
  }

  /**
   * ACP session/resume. Does not replay the JSONL transcript.
   * If the harness has no `session/resume`, fall back to `session/load` on the agent.
   */
  async resume(
    sessionId: string,
    opts?: { cwd?: string; mcpServers?: unknown[]; additionalDirectories?: string[] },
  ): Promise<Record<string, unknown>> {
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.status === "closed") {
      throw new BridgeError(-32002, `unknown session: ${sessionId}`, { sessionId });
    }
    this.assertSessionWorkspace(rec);
    if (opts?.cwd) this.assertSameSessionCwd(rec, opts.cwd);
    this.applyAdditionalDirectories(rec, opts?.additionalDirectories);
    if (opts?.mcpServers && opts.mcpServers.length > 0) rec.mcpServers = opts.mcpServers;
    if (!rec.client?.running) {
      const gate = this.promptGates.get(sessionId);
      if (gate) await gate;
    }
    if ((rec.status as SessionStatus) === "closed") {
      throw new BridgeError(-32002, `unknown session: ${sessionId}`, { sessionId });
    }
    if (rec.promptInFlight) {
      throw new BridgeError(-32005, "prompt already in progress", { sessionId });
    }
    let agentResult: unknown = {};
    let warning: string | undefined;
    try {
      if (!rec.client?.running) {
        agentResult = await this.respawnAgent(rec, "resume");
      } else {
        agentResult = await this.attachExisting(rec, "resume");
      }
    } catch (e) {
      warning = e instanceof Error ? e.message : String(e);
      log("warn", `session/resume ${sessionId}: ${warning}`);
    }
    this.captureSessionPayload(rec, agentResult);
    const body: Record<string, unknown> = {
      sessionId: rec.sessionId,
      agentAlive: Boolean(rec.client?.running),
      status: rec.status,
      ...(warning ? { warning } : {}),
    };
    if (agentResult && typeof agentResult === "object") {
      return { ...(agentResult as Record<string, unknown>), ...body };
    }
    return body;
  }

  async setConfigOption(sessionId: string, params: Record<string, unknown>): Promise<unknown> {
    const rec = this.requireSession(sessionId);
    this.assertSessionWorkspace(rec);
    const client = rec.client;
    if (!client?.running) {
      throw new BridgeError(-32004, `session agent not running: ${sessionId}`, { sessionId });
    }
    const configId = params.configId;
    if (typeof configId !== "string" || !configId) {
      throw new BridgeError(-32602, "configId required");
    }
    const result = await client.setConfigOption({
      ...params,
      sessionId: rec.agentSessionId,
      configId,
    });
    this.captureSessionPayload(rec, result);
    this.persist(rec);
    return result;
  }

  /**
   * Relay ACP `authenticate` / `auth/login` to a harness.
   * A successful login with no sessionId keeps that process warm for the next
   * `session/new` of the same harness and cwd. Terminal methods are refused.
   */
  async authenticate(input: {
    methodId: string;
    sessionId?: string;
    harnessId?: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const methodId = input.methodId.trim();
    if (!methodId || methodId.length > 120 || /[\u0000-\u001f]/.test(methodId)) {
      throw new BridgeError(-32602, "methodId required");
    }
    if (input.sessionId) return this.authenticateSession(input.sessionId, methodId);
    const prepared = this.prepareWarm(input);
    const replay = this.peekWarm(prepared, methodId);
    if (replay) {
      return this.authResult(
        replay.harnessId,
        replay.cwd,
        replay.authMethods,
        replay.logoutSupported,
      );
    }
    if (this.warmInflight.has(prepared.key)) {
      throw new BridgeError(-32005, "authentication already in progress", {
        harnessId: prepared.harness.id,
      });
    }
    const run = this.finishWarm(prepared, methodId);
    this.warmInflight.set(prepared.key, run);
    try {
      return await run;
    } finally {
      if (this.warmInflight.get(prepared.key) === run) this.warmInflight.delete(prepared.key);
    }
  }

  private async authenticateSession(sessionId: string, methodId: string): Promise<Record<string, unknown>> {
    const rec = this.requireSession(sessionId);
    const client = rec.client;
    if (!client?.running) {
      throw new BridgeError(-32004, `session agent not running: ${sessionId}`, { sessionId });
    }
    if (rec.authMethods) assertAgentAuthMethod(rec.authMethods, methodId);
    const epoch = this.sessionAuthEpoch.get(sessionId) ?? 0;
    try {
      await client.authenticate(methodId);
    } catch (e) {
      if ((this.sessionAuthEpoch.get(sessionId) ?? 0) !== epoch) {
        throw new BridgeError(REQUEST_CANCELLED, "request cancelled", { sessionId });
      }
      if (e instanceof BridgeError) throw e;
      const failure = agentFailure(e);
      throw new BridgeError(failure.code, failure.message, { sessionId });
    }
    if ((this.sessionAuthEpoch.get(sessionId) ?? 0) !== epoch) {
      throw new BridgeError(REQUEST_CANCELLED, "request cancelled", { sessionId });
    }
    return this.authResult(rec.harness, rec.cwd, rec.authMethods ?? [], rec.logoutSupported, rec.sessionId);
  }

  /**
   * Phone `$/cancel_request` for an in-flight `authenticate` / `logout`.
   * Session login cancels that call and any elicitation it opened.
   * A pre-session login drops the process so a retry does not keep a half-finished agent.
   */
  cancelAuth(input: { sessionId?: string; harnessId?: string; cwd?: string }): void {
    if (input.sessionId) {
      const rec = this.sessions.get(input.sessionId);
      if (!rec || rec.status === "closed") return;
      this.sessionAuthEpoch.set(input.sessionId, (this.sessionAuthEpoch.get(input.sessionId) ?? 0) + 1);
      this.opts.cancelPhoneRequests?.({ sessionId: input.sessionId, method: "elicitation/create" });
      rec.client?.cancelOutbound(["authenticate", "auth/login", "logout", "auth/logout"]);
      return;
    }
    if (!input.harnessId || !input.cwd) return;
    let cwd = input.cwd;
    try {
      cwd = assertAllowedWorkspace(input.cwd, this.opts.config.allowedRoots);
    } catch {
      return;
    }
    const key = warmKey(input.harnessId, cwd);
    this.warmAbort.add(key);
    this.bumpWarm(key);
    this.opts.cancelPhoneRequests?.({ owner: `warm:${key}` });
  }

  private prepareWarm(input: { harnessId?: string; cwd?: string }): {
    key: string;
    cwd: string;
    harness: NonNullable<ReturnType<typeof findHarness>>;
    launch: HarnessLaunch;
    env: Record<string, string>;
  } {
    if (!input.harnessId) throw new BridgeError(-32602, "harness required");
    if (!input.cwd) throw new BridgeError(-32602, "cwd required");
    const cwd = assertAllowedWorkspace(input.cwd, this.opts.config.allowedRoots);
    const harness = findHarness(this.opts.config, input.harnessId);
    if (!harness) {
      throw new BridgeError(-32602, `unknown harness: ${input.harnessId}`, { harnessId: input.harnessId });
    }
    const launch = resolveHarnessLaunch(harness);
    if (!launch.available) {
      throw new BridgeError(
        -32010,
        `harness ${harness.id} is not available: ${launch.detail}`,
        launchErrorData(launch),
      );
    }
    return {
      key: warmKey(harness.id, cwd),
      cwd,
      harness,
      launch,
      env: overlayEnv(this.opts.config.env, harness.env),
    };
  }

  private async finishWarm(
    prepared: ReturnType<SessionManager["prepareWarm"]>,
    methodId: string,
  ): Promise<Record<string, unknown>> {
    const { key, cwd, harness, launch, env } = prepared;
    const epoch = this.bumpWarm(key);
    const client = new AcpStdioClient({
      harness: { ...harness, command: launch.command, args: launch.args },
      cwd,
      env: this.opts.config.env,
      onRequest: (req) => {
        if (req.method === "elicitation/create") {
          return this.relayElicitation(req.params, undefined, {
            signal: req.signal,
            owner: `warm:${key}`,
          });
        }
        const err = new Error(`Method not found: ${req.method}`) as Error & { code?: number };
        err.code = -32601;
        throw err;
      },
      onNotification: (msg) => {
        if (msg.method === "elicitation/complete") this.forwardElicitationComplete(msg.params);
      },
      onStderr: (line) => log("debug", `harness ${harness.id} stderr: ${line}`),
      onExit: () => {
        const current = this.warm.get(key);
        if (current?.client === client) {
          clearTimeout(current.timer);
          this.warm.delete(key);
        }
      },
    });
    client.start();
    this.warmLive.set(key, client);
    try {
      const initialized = await client.initialize(this.agentClientInfo());
      const info = readAgentInitialize(initialized);
      assertAgentAuthMethod(info.authMethods, methodId);
      await client.authenticate(methodId);
      if (this.authSuperseded(key, epoch)) {
        client.kill();
        throw this.authSupersededError(key, harness.id);
      }
      const timer = setTimeout(() => {
        const current = this.warm.get(key);
        if (current?.client === client) this.dropWarm(key);
      }, 10 * 60 * 1000);
      timer.unref?.();
      this.warm.set(key, {
        key,
        harnessId: harness.id,
        cwd,
        command: launch.command,
        args: launch.args ?? [],
        env,
        client,
        authMethods: info.authMethods,
        logoutSupported: info.logoutSupported,
        agentInfo: info.agentInfo,
        methodId,
        timer,
      });
      return this.authResult(harness.id, cwd, info.authMethods, info.logoutSupported);
    } catch (e) {
      client.kill();
      if (e instanceof BridgeError) throw e;
      if (this.authSuperseded(key, epoch)) throw this.authSupersededError(key, harness.id);
      const failure = agentFailure(e);
      throw new BridgeError(failure.code, failure.message, { harnessId: harness.id });
    } finally {
      if (this.warmLive.get(key) === client) this.warmLive.delete(key);
    }
  }

  /** Relay ACP `logout` / `auth/logout`. A warm pre-session process is dropped. */
  async logout(input: {
    sessionId?: string;
    harnessId?: string;
    cwd?: string;
  }): Promise<Record<string, never>> {
    if (input.sessionId) {
      const rec = this.requireSession(input.sessionId);
      if (!rec.client?.running) {
        throw new BridgeError(-32004, `session agent not running: ${input.sessionId}`, {
          sessionId: input.sessionId,
        });
      }
      if (!rec.logoutSupported) {
        throw new BridgeError(-32601, "agent does not support logout", { sessionId: rec.sessionId });
      }
      await rec.client.logout();
      return {};
    }
    if (!input.harnessId || !input.cwd) {
      throw new BridgeError(-32602, "sessionId or harness and cwd required");
    }
    const cwd = assertAllowedWorkspace(input.cwd, this.opts.config.allowedRoots);
    const key = warmKey(input.harnessId, cwd);
    const warm = this.warm.get(key);
    if (!warm?.client.running) {
      throw new BridgeError(-32004, "no authenticated harness connection", { harnessId: input.harnessId });
    }
    if (!warm.logoutSupported) {
      throw new BridgeError(-32601, "agent does not support logout", { harnessId: input.harnessId });
    }
    try {
      await warm.client.logout();
    } finally {
      this.dropWarm(key);
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
    if (rec.cancelRequested || rec.closing || rec.status === "closed") {
      throw new BridgeError(-32003, "session cancelled", {
        sessionId: rec.sessionId,
        permissionMode: rec.permissionMode,
        kind: family,
      });
    }
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
    if (!rec || rec.status === "closed") {
      throw new BridgeError(-32002, `unknown session: ${sessionId}`, { sessionId });
    }
    return rec;
  }

  private openClient(rec: SessionRecord, launch?: HarnessLaunch): AcpStdioClient {
    const harness = findHarness(this.opts.config, rec.harness);
    if (!harness) {
      throw new BridgeError(-32602, `unknown harness: ${rec.harness}`, { harnessId: rec.harness });
    }
    const resolved = launch ?? resolveHarnessLaunch(harness);
    if (!resolved.available) {
      throw new BridgeError(
        -32010,
        `harness ${harness.id} is not available: ${resolved.detail}`,
        launchErrorData(resolved),
      );
    }
    const client = new AcpStdioClient({
      harness: { ...harness, command: resolved.command, args: resolved.args },
      cwd: rec.cwd,
      env: this.opts.config.env,
    });
    this.wireClient(rec, client, harness.id);
    return client;
  }

  private wireClient(rec: SessionRecord, client: AcpStdioClient, harnessId: string): void {
    const gen = ++rec.clientGeneration;
    const self = this;
    client.setCallbacks({
      onNotification: (msg) => {
        if (rec.clientGeneration !== gen || rec.client !== client) return;
        const current = self.sessions.get(rec.sessionId) ?? rec;
        self.onAgentNotification(current, msg.method, msg.params);
      },
      onRequest: (req) => {
        if (rec.clientGeneration !== gen || rec.client !== client) {
          const err = new Error("session agent replaced") as Error & { code?: number };
          err.code = -32603;
          throw err;
        }
        const current = self.sessions.get(rec.sessionId) ?? rec;
        return self.onAgentRequest(current, req);
      },
      onStderr: (line) => {
        log("debug", `harness ${harnessId} stderr: ${line}`);
      },
      onExit: (code, signal) => {
        if (rec.clientGeneration !== gen) return;
        if (rec.status === "closed" || rec.closing) return;
        rec.status = "error";
        const tail = client.stderrTail().split("\n").filter(Boolean).slice(-1)[0];
        rec.preview = tail
          ? `agent exited (code=${code}, signal=${signal}): ${tail}`
          : `agent exited (code=${code}, signal=${signal})`;
        rec.updatedAt = new Date().toISOString();
        log(
          "warn",
          `harness ${harnessId} exited code=${code} signal=${signal} session=${rec.sessionId}`,
        );
        self.emitSessionStatus(rec);
      },
    });
    rec.client = client;
  }

  /** Start a fresh harness and ask it to load or resume `rec.sessionId`. */
  private respawnAgent(rec: SessionRecord, mode: "load" | "resume"): Promise<unknown> {
    const existing = this.respawnInflight.get(rec.sessionId);
    if (existing) return existing;
    const run = this.respawnAgentOnce(rec, mode).finally(() => {
      if (this.respawnInflight.get(rec.sessionId) === run) this.respawnInflight.delete(rec.sessionId);
    });
    this.respawnInflight.set(rec.sessionId, run);
    return run;
  }

  private async respawnAgentOnce(rec: SessionRecord, mode: "load" | "resume"): Promise<unknown> {
    const previous = rec.client;
    const client = this.openClient(rec);
    previous?.kill();
    try {
      client.start();
      const initialized = await client.initialize(this.agentClientInfo());
      this.applyInit(rec, readAgentInitialize(initialized));
      const result = await this.attachExisting(rec, mode);
      if (rec.status === "error" || rec.status === "idle") {
        this.setStatus(rec.sessionId, "idle");
      }
      return result;
    } catch (e) {
      rec.clientGeneration += 1;
      client.kill();
      if (rec.client === client) rec.client = null;
      throw e;
    }
  }

  private async attachExisting(rec: SessionRecord, mode: "load" | "resume"): Promise<unknown> {
    const client = rec.client;
    if (!client) throw new Error("session agent not running");
    const params = {
      sessionId: rec.agentSessionId,
      cwd: rec.cwd,
      mcpServers: rec.mcpServers,
      additionalDirectories: rec.additionalDirectories,
    };
    if (mode === "load") return client.loadSession(params);
    try {
      return await client.resumeSession(params);
    } catch (e) {
      if (!isMethodNotFound(e)) throw e;
      log("info", `harness ${rec.harness} has no session/resume; using session/load`);
      return client.loadSession(params);
    }
  }

  private onAgentNotification(rec: SessionRecord, method: string, params: unknown): void {
    if (method.startsWith("$/")) return;
    if (method === "elicitation/complete") {
      this.forwardElicitationComplete(params);
      return;
    }
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
      const info = update as { sessionUpdate?: string; title?: unknown } | undefined;
      if (
        (info?.sessionUpdate === "session_info_update" || info?.sessionUpdate === "session_info") &&
        typeof info.title === "string" &&
        info.title.trim()
      ) {
        rec.title = info.title.trim().slice(0, 120);
        rec.updatedAt = new Date().toISOString();
        this.persist(rec);
      }
      return;
    }
    this.broadcastLogged(rec, { jsonrpc: "2.0", method, params });
  }

  private async onAgentRequest(rec: SessionRecord, req: AcpJsonRpcRequest): Promise<unknown> {
    switch (req.method) {
      case "session/request_permission":
        return this.handlePermission(rec, (req.params ?? {}) as RequestPermissionParams, req.signal);
      case "elicitation/create":
        return this.relayElicitation(req.params, rec.sessionId, {
          signal: req.signal,
          owner: `session:${rec.sessionId}`,
        });
      case "fs/read_text_file":
        return this.handleReadTextFile(rec, req.params);
      case "fs/write_text_file":
        return this.handleWriteTextFile(rec, req.params);
      case "terminal/create":
        return this.handleTerminalCreate(rec, req.params);
      case "terminal/output":
        return this.handleTerminalOutput(rec, req.params);
      case "terminal/kill":
        return this.handleTerminalKill(rec, req.params);
      case "terminal/release":
        return this.handleTerminalRelease(rec, req.params);
      case "terminal/wait_for_exit":
        return this.handleTerminalWait(rec, req.params);
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
    reqSignal?: AbortSignal,
  ): Promise<unknown> {
    if (reqSignal?.aborted || rec.cancelRequested || rec.closing) {
      return { outcome: { outcome: "cancelled" } };
    }
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
    const epoch = this.permissionEpoch.get(rec.sessionId) ?? 0;
    const generation = rec.clientGeneration;
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

    if (reqSignal?.aborted || rec.cancelRequested || rec.closing) {
      this.notePermissionResolved(rec, undefined, "cancelled");
      if (rec.status === "needs_approval") this.setStatus(rec.sessionId, "idle");
      return { outcome: { outcome: "cancelled" } };
    }

    if (!this.opts.requestPhone) {
      if (rec.status === "needs_approval") this.setStatus(rec.sessionId, "idle");
      return { outcome: { outcome: "cancelled" } };
    }

    const resumeAfterAsk = (): void => {
      if (rec.status !== "needs_approval") return;
      this.setStatus(rec.sessionId, rec.promptInFlight ? "running" : "idle");
    };

    try {
      const { result, requestId } = await this.opts.requestPhone(
        "session/request_permission",
        phoneParams,
        { signal: reqSignal, owner: `session:${rec.sessionId}` },
      );
      const outcome = (result as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
      const optionId = outcome?.optionId;
      const optionKind = optionKindById(options, optionId);
      const aborted = Boolean(
        reqSignal?.aborted ||
          rec.cancelRequested ||
          rec.closing ||
          (this.permissionEpoch.get(rec.sessionId) ?? 0) !== epoch ||
          rec.clientGeneration !== generation,
      );
      if (!aborted && outcome?.outcome === "selected") {
        const grant = grantFromOption(
          optionKind,
          grantFamilyForKind(kind),
          resolveGrantPath(path, rec.cwd),
        );
        if (grant) {
          rec.grants.push(grant);
          this.persist(rec);
        }
      }
      const resolvedKind = aborted
        ? "cancelled"
        : (optionKind ?? outcome?.outcome ?? "cancelled");
      this.notePermissionResolved(rec, requestId, resolvedKind);
      resumeAfterAsk();
      if (aborted) return { outcome: { outcome: "cancelled" } };
      return result ?? { outcome: { outcome: "cancelled" } };
    } catch {
      this.notePermissionResolved(rec, undefined, "cancelled");
      resumeAfterAsk();
      return { outcome: { outcome: "cancelled" } };
    }
  }

  private handleReadTextFile(rec: SessionRecord, params: unknown): { content: string } {
    const p = (params ?? {}) as { path?: string; line?: number; limit?: number };
    if (!p.path) throw Object.assign(new Error("path required"), { code: -32602 });
    const path = assertAllowedRealPath(p.path, this.opts.config.allowedRoots, rec.cwd);
    const content = readTextFileWindow(path, {
      line: typeof p.line === "number" ? p.line : undefined,
      limit: typeof p.limit === "number" ? p.limit : undefined,
    });
    return { content };
  }

  private handleWriteTextFile(rec: SessionRecord, params: unknown): Record<string, never> {
    const p = (params ?? {}) as { path?: string; content?: string };
    if (!p.path) throw Object.assign(new Error("path required"), { code: -32602 });
    const content = p.content ?? "";
    assertWritableContent(content);
    const path = assertAllowedRealPath(p.path, this.opts.config.allowedRoots, rec.cwd);
    this.assertMutatingTool(rec, "write", path);
    assertNotDirectory(path);
    mkdirSync(dirname(path), { recursive: true });
    writeTextNoFollow(path, content);
    return {};
  }

  private handleTerminalCreate(
    rec: SessionRecord,
    params: unknown,
  ): { terminalId: string } {
    const p = (params ?? {}) as {
      command?: unknown;
      args?: unknown;
      cwd?: unknown;
      env?: unknown;
      outputByteLimit?: unknown;
    };
    if (p.cwd != null && typeof p.cwd !== "string") {
      throw Object.assign(new Error("terminal cwd must be a string"), { code: -32602 });
    }
    // Reject bad params before an allow_once grant is spent on a command that cannot start.
    const checked = assertTerminalCreateParams({
      command: p.command,
      args: p.args,
      env: p.env,
      outputByteLimit: p.outputByteLimit,
    });
    const cwd = p.cwd
      ? assertAllowedRealPath(p.cwd, this.opts.config.allowedRoots, rec.cwd)
      : rec.cwd;
    const env: NodeJS.ProcessEnv = { ...process.env };
    const entries = Array.isArray(p.env) ? p.env : [];
    for (const entry of entries) {
      const row = entry as { name?: unknown; value?: unknown } | null;
      if (!row || typeof row.name !== "string" || typeof row.value !== "string") {
        throw Object.assign(new Error("terminal env entries must be strings"), { code: -32602 });
      }
      if (!isEnvName(row.name) || row.value.includes("\0")) {
        throw Object.assign(new Error(`invalid env var: ${row.name}`), { code: -32602 });
      }
      env[row.name] = row.value;
    }
    // Resolve before the grant is spent. Bridge PATH wins so an agent PATH
    // cannot swap `git`; a name that exists only on the agent PATH still runs.
    const executable = resolveExecutable(
      checked.command,
      cwd,
      typeof env.PATH === "string" ? env.PATH : undefined,
    );
    if (!executable) {
      throw Object.assign(new Error(`command not found: ${checked.command}`), { code: -32602 });
    }
    if (!this.terminals.hasRoom(rec.sessionId)) {
      throw Object.assign(new Error("too many terminals"), { code: -32003 });
    }
    this.assertMutatingTool(rec, "exec");
    return this.terminals.create({
      sessionId: rec.sessionId,
      command: executable,
      args: checked.args,
      cwd,
      env,
      outputByteLimit: checked.outputByteLimit,
    });
  }

  private handleTerminalOutput(rec: SessionRecord, params: unknown): {
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode: number | null; signal: NodeJS.Signals | null };
  } {
    const p = (params ?? {}) as { terminalId?: string };
    if (!p.terminalId) throw Object.assign(new Error("terminalId required"), { code: -32602 });
    return this.terminals.output(rec.sessionId, p.terminalId);
  }

  private handleTerminalKill(rec: SessionRecord, params: unknown): Record<string, never> {
    this.terminals.kill(rec.sessionId, requireTerminalId(params));
    return {};
  }

  private handleTerminalRelease(rec: SessionRecord, params: unknown): Record<string, never> {
    this.terminals.release(rec.sessionId, requireTerminalId(params));
    return {};
  }

  private handleTerminalWait(
    rec: SessionRecord,
    params: unknown,
  ): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
    const p = (params ?? {}) as { terminalId?: string };
    if (!p.terminalId) {
      return Promise.reject(Object.assign(new Error("terminalId required"), { code: -32602 }));
    }
    return this.terminals.wait(rec.sessionId, p.terminalId);
  }

  private broadcastLogged(
    rec: SessionRecord,
    frame: { jsonrpc: string; method: string; params: unknown },
  ): number {
    const entry = rec.log.append(frame);
    rec.lastSeq = entry.seq;
    rec.updatedAt = entry.ts;
    const droppable = frame.method === "session/update";
    void this.opts.broadcast?.(entry.event, { droppable });
    return entry.seq;
  }

  private emitPromptResult(
    rec: SessionRecord,
    body: { result?: unknown; error?: { message: string } },
  ): void {
    if (!this.sessions.has(rec.sessionId)) return;
    this.broadcastLogged(rec, {
      jsonrpc: "2.0",
      method: "bridge/promptResult",
      params: { sessionId: rec.sessionId, ...body },
    });
  }

  private notePermissionResolved(
    rec: SessionRecord,
    requestId: string | number | undefined,
    optionKind: string,
  ): void {
    if (!this.sessions.has(rec.sessionId)) return;
    this.broadcastLogged(rec, {
      jsonrpc: "2.0",
      method: "bridge/permissionResolved",
      params: {
        sessionId: rec.sessionId,
        requestId,
        optionKind,
      },
    });
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
    this.persist(rec);
    this.opts.broadcast?.(entry.event);
  }

  private detachForShutdown(sessionId: string): void {
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.status === "closed") return;
    rec.closing = true;
    rec.cancelRequested = true;
    this.opts.cancelPhoneRequests?.({ sessionId });
    rec.clientGeneration += 1;
    rec.promptInFlight = false;
    rec.client?.kill();
    rec.client = null;
    this.terminals.closeSession(sessionId);
    if (rec.status === "running" || rec.status === "needs_approval") rec.status = "idle";
    rec.updatedAt = new Date().toISOString();
    this.persist(rec);
  }

  private restorePersisted(): void {
    let metas: SessionMeta[];
    try {
      metas = loadPersistedMetas();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log("warn", `could not read persisted sessions: ${message}`);
      return;
    }
    for (const meta of metas) {
      if (this.sessions.has(meta.sessionId)) continue;
      let sessionLog: SessionLog;
      try {
        sessionLog = new SessionLog(meta.sessionId);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log("warn", `skipping session ${meta.sessionId}: ${message}`);
        continue;
      }
      const authMethods = storedAuthMethods(meta.authMethods);
      const authDirty = JSON.stringify(meta.authMethods ?? []) !== JSON.stringify(authMethods ?? []);
      const stale = meta.status === "running" || meta.status === "needs_approval";
      let preview = meta.preview;
      if (meta.status === "running" || meta.status === "needs_approval") {
        const sealed = sealInterruptedSession(sessionLog, meta.status);
        if (sealed === "prompt") preview = "bridge restarted before the prompt finished";
      }
      let workspaceOk = true;
      try {
        assertAllowedWorkspace(meta.cwd, this.opts.config.allowedRoots);
        for (const extra of meta.additionalDirectories ?? []) {
          assertAllowedRealPath(extra, this.opts.config.allowedRoots);
        }
      } catch {
        workspaceOk = false;
      }
      const rec: SessionRecord = {
        sessionId: meta.sessionId,
        harness: meta.harness,
        cwd: meta.cwd,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        preview: workspaceOk ? preview : "workspace is outside allowed roots",
        branch: meta.branch,
        status: workspaceOk ? (stale ? "idle" : meta.status) : "error",
        permissionMode: meta.permissionMode,
        lastSeq: sessionLog.lastSeq,
        log: sessionLog,
        client: null,
        agentSessionId: meta.agentSessionId,
        grants: meta.grants.map((g) => ({ ...g })),
        sessionModes: meta.sessionModes,
        agentInfo: meta.agentInfo,
        authMethods,
        mcpServers: meta.mcpServers ?? [],
        additionalDirectories: meta.additionalDirectories ?? [],
        configOptions: meta.configOptions,
        clientGeneration: 0,
        promptInFlight: false,
        cancelRequested: false,
        logoutSupported: meta.logoutSupported === true,
        closing: false,
      };
      this.sessions.set(rec.sessionId, rec);
      if (!workspaceOk || stale || authDirty) this.persist(rec);
    }
  }

  private persist(rec: SessionRecord): void {
    if (!isSafeSessionId(rec.sessionId)) return;
    try {
      writeSessionMeta(dirname(rec.log.path), this.toMeta(rec));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log("warn", `could not persist session ${rec.sessionId}: ${message}`);
    }
  }

  private toMeta(rec: SessionRecord): SessionMeta {
    return {
      version: 1,
      sessionId: rec.sessionId,
      harness: rec.harness,
      cwd: rec.cwd,
      title: rec.title,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      preview: rec.preview,
      ...(rec.branch ? { branch: rec.branch } : {}),
      status: rec.status,
      permissionMode: rec.permissionMode,
      agentSessionId: rec.agentSessionId,
      mcpServers: rec.mcpServers,
      ...(rec.sessionModes !== undefined ? { sessionModes: rec.sessionModes } : {}),
      ...(rec.configOptions !== undefined ? { configOptions: rec.configOptions } : {}),
      ...(rec.agentInfo ? { agentInfo: rec.agentInfo } : {}),
      ...(rec.authMethods?.length ? { authMethods: rec.authMethods } : {}),
      ...(rec.logoutSupported ? { logoutSupported: true } : {}),
      grants: rec.grants.map((g) => ({ ...g })),
      additionalDirectories: rec.additionalDirectories,
    };
  }

  private maybeTitle(rec: SessionRecord, params: unknown): void {
    if (rec.title !== "New session") return;
    const text = firstPromptText(params).slice(0, 80);
    if (!text) return;
    rec.title = text;
  }

  private assertSessionWorkspace(rec: SessionRecord): void {
    assertAllowedWorkspace(rec.cwd, this.opts.config.allowedRoots);
    for (const extra of rec.additionalDirectories) {
      assertAllowedRealPath(extra, this.opts.config.allowedRoots);
    }
  }

  private adoptAgentSession(rec: SessionRecord, tempId: string, agentSessionId: string): void {
    if (!isSafeSessionId(agentSessionId)) {
      throw new BridgeError(-32602, "invalid session id from harness", { harness: rec.harness });
    }
    if (agentSessionId === tempId) {
      rec.agentSessionId = agentSessionId;
      return;
    }
    if (this.sessions.has(agentSessionId)) {
      throw new BridgeError(-32002, `session id already in use: ${agentSessionId}`, {
        sessionId: agentSessionId,
      });
    }
    rec.log.relocate(agentSessionId);
    this.sessions.delete(tempId);
    rec.sessionId = agentSessionId;
    rec.agentSessionId = agentSessionId;
    this.sessions.set(agentSessionId, rec);
  }

  private captureSessionPayload(rec: SessionRecord, result: unknown): void {
    if (!result || typeof result !== "object") return;
    const obj = result as Record<string, unknown>;
    if (obj.modes && typeof obj.modes === "object") rec.sessionModes = obj.modes;
    if ("configOptions" in obj && obj.configOptions != null) rec.configOptions = obj.configOptions;
  }

  private applyInit(rec: SessionRecord, info: ReturnType<typeof readAgentInitialize>): void {
    rec.agentInfo = info.agentInfo;
    rec.authMethods = info.authMethods;
    rec.logoutSupported = info.logoutSupported;
  }

  private agentClientInfo(): { clientInfo: { name: string; version: string }; clientCapabilities?: Record<string, unknown> } {
    return {
      clientInfo: {
        name: "gradation-bridge",
        version: this.opts.version ?? "0.1.0",
      },
      clientCapabilities: this.phoneCapabilities(),
    };
  }

  private peekWarm(
    prepared: ReturnType<SessionManager["prepareWarm"]>,
    methodId: string,
  ): WarmAuth | undefined {
    const warm = this.warm.get(prepared.key);
    if (!warm?.client.running || warm.methodId !== methodId) return undefined;
    if (!this.launchMatches(warm, prepared.launch, prepared.env)) return undefined;
    return warm;
  }

  private launchMatches(warm: WarmAuth, launch: HarnessLaunch, env: Record<string, string>): boolean {
    return (
      warm.command === launch.command &&
      sameArgs(warm.args, launch.args ?? []) &&
      sameEnv(warm.env, env)
    );
  }

  private authSuperseded(key: string, epoch: number): boolean {
    return this.stopping || this.warmEpoch.get(key) !== epoch || this.warmAbort.has(key);
  }

  private authSupersededError(key: string, harnessId: string): BridgeError {
    const aborted = this.warmAbort.delete(key);
    return new BridgeError(
      aborted ? REQUEST_CANCELLED : -32010,
      aborted ? "request cancelled" : "authentication was cancelled",
      { harnessId },
    );
  }

  private applyAdditionalDirectories(rec: SessionRecord, raw: string[] | undefined): void {
    if (raw === undefined) return;
    rec.additionalDirectories = sandboxAdditionalDirectories(raw, this.opts.config.allowedRoots);
    this.persist(rec);
  }

  private assertSameSessionCwd(rec: SessionRecord, cwd: string): void {
    const resolved = assertAllowedRealPath(cwd, this.opts.config.allowedRoots, rec.cwd);
    if (resolved !== rec.cwd) {
      throw new BridgeError(-32602, "cwd does not match the session", {
        sessionId: rec.sessionId,
        cwd: resolved,
      });
    }
  }

  private takeMatchingWarm(
    harnessId: string,
    cwd: string,
    launch: HarnessLaunch,
    env: Record<string, string>,
  ): WarmAuth | undefined {
    const key = warmKey(harnessId, cwd);
    const warm = this.warm.get(key);
    if (!warm) return undefined;
    this.warm.delete(key);
    clearTimeout(warm.timer);
    const sameLaunch = this.launchMatches(warm, launch, env);
    if (!warm.client.running || !sameLaunch) {
      warm.client.kill();
      return undefined;
    }
    return warm;
  }

  private dropWarm(key: string): void {
    const warm = this.warm.get(key);
    if (!warm) return;
    this.warm.delete(key);
    clearTimeout(warm.timer);
    warm.client.kill();
  }

  /** Invalidate an in-flight login and drop any process already stored for `key`. */
  private bumpWarm(key: string): number {
    const next = (this.warmEpoch.get(key) ?? 0) + 1;
    this.warmEpoch.set(key, next);
    this.warmLive.get(key)?.kill();
    this.dropWarm(key);
    return next;
  }

  private async relayElicitation(
    params: unknown,
    sessionId?: string,
    ctx?: PhoneRequestContext,
  ): Promise<unknown> {
    if (ctx?.signal?.aborted || this.elicitationSuppressed(sessionId)) return { action: "cancel" };
    const support = elicitationSupportFromInitialize(this.phoneInitialize);
    params = bindElicitationSession(params, sessionId);
    let relay: Record<string, unknown>;
    try {
      relay = relayElicitationParams(params, support);
    } catch (e) {
      if (e instanceof ElicitationRejected) {
        log("info", `elicitation rejected: ${e.message}`);
      }
      throw e;
    }
    log("info", `elicitation ${elicitationLogLabel(relay)}`);
    if (!this.opts.requestPhone) return { action: "cancel" };
    try {
      const answered = await this.opts.requestPhone("elicitation/create", relay, {
        signal: ctx?.signal,
        owner: ctx?.owner ?? (sessionId ? `session:${sessionId}` : undefined),
      });
      if (ctx?.signal?.aborted || this.elicitationSuppressed(sessionId) || answered.error) {
        return { action: "cancel" };
      }
      return sanitizeElicitationResponse(answered.result);
    } catch (e) {
      const message = e instanceof Error ? e.message : "no answer";
      log("info", `elicitation cancelled: ${message}`);
      return { action: "cancel" };
    }
  }

  /** A cancelled or closing session must not accept a late elicitation answer. */
  private elicitationSuppressed(sessionId?: string): boolean {
    if (!sessionId) return false;
    const rec = this.sessions.get(sessionId);
    if (!rec) return true;
    return rec.cancelRequested || rec.closing || rec.status === "closed";
  }

  private forwardElicitationComplete(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const id = (params as { elicitationId?: unknown }).elicitationId;
    if (typeof id !== "string" || !id || id.length > 200) return;
    this.opts.broadcast?.({
      jsonrpc: "2.0",
      method: "elicitation/complete",
      params: { elicitationId: id },
    });
  }

  private authResult(
    harness: string,
    cwd: string,
    authMethods: PublicAuthMethod[],
    logoutSupported: boolean,
    sessionId?: string,
  ): Record<string, unknown> {
    return {
      _meta: {
        harness,
        cwd,
        authenticated: true,
        authMethods,
        logout: logoutSupported,
        ...(sessionId ? { sessionId } : {}),
      },
    };
  }
}

export { SandboxError };

const PERMISSION_MODE_IDS = new Set<PermissionMode>(["ask", "auto-edit", "plan", "full-auto"]);

/**
 * A crash leaves `running` or `needs_approval` on disk with no terminal event.
 * Append one so the next load does not replay an open prompt or permission.
 * Returns which event was added.
 */
function sealInterruptedSession(
  sessionLog: SessionLog,
  status: "running" | "needs_approval",
): "prompt" | "permission" | undefined {
  const events = [...sessionLog.replay(0)];
  if (status === "running") {
    if (eventMethod(events[events.length - 1]) === "bridge/promptResult") return undefined;
    sessionLog.append({
      jsonrpc: "2.0",
      method: "bridge/promptResult",
      params: {
        sessionId: sessionLog.sessionId,
        error: { message: "bridge restarted before the prompt finished" },
      },
    });
    return "prompt";
  }
  let open = false;
  for (const entry of events) {
    const method = eventMethod(entry);
    if (method === "session/request_permission") open = true;
    else if (method === "bridge/permissionResolved") open = false;
  }
  if (!open) return undefined;
  sessionLog.append({
    jsonrpc: "2.0",
    method: "bridge/permissionResolved",
    params: { sessionId: sessionLog.sessionId, optionKind: "cancelled" },
  });
  return "permission";
}

function eventMethod(entry: LoggedEvent | undefined): string | undefined {
  const event = entry?.event;
  if (!event || typeof event !== "object") return undefined;
  const method = (event as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function requireTerminalId(params: unknown): string {
  const id = (params as { terminalId?: unknown } | null)?.terminalId;
  if (typeof id !== "string" || !id) {
    throw Object.assign(new Error("terminalId required"), { code: -32602 });
  }
  return id;
}

function isPermissionMode(modeId: string): modeId is PermissionMode {
  return PERMISSION_MODE_IDS.has(modeId as PermissionMode);
}

function sandboxAdditionalDirectories(raw: string[] | undefined, allowedRoots: string[]): string[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new BridgeError(-32602, "additionalDirectories entries must be paths");
    }
    const real = assertAllowedRealPath(entry, allowedRoots);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(real);
  }
  return out;
}

interface WarmAuth {
  key: string;
  harnessId: string;
  cwd: string;
  command: string;
  args: string[];
  /** Harness and config env overlay captured at login. Not the process environment. */
  env: Record<string, string>;
  client: AcpStdioClient;
  authMethods: PublicAuthMethod[];
  logoutSupported: boolean;
  agentInfo?: { name: string; version?: string };
  methodId: string;
  timer: NodeJS.Timeout;
}

function warmKey(harnessId: string, cwd: string): string {
  return `${harnessId}\0${cwd}`;
}

function sameArgs(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((arg, i) => arg === right[i]);
}

function overlayEnv(
  config: Record<string, string> | undefined,
  harness: Record<string, string> | undefined,
): Record<string, string> {
  return { ...(config ?? {}), ...(harness ?? {}) };
}

function sameEnv(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => right[key] === left[key]);
}

function storedAuthMethods(methods: SessionMeta["authMethods"]): PublicAuthMethod[] | undefined {
  const clean = publicAuthMethods(methods);
  return clean.length ? clean : undefined;
}

function publicErrorMessage(e: unknown): string {
  return agentFailure(e).message;
}

function agentFailure(e: unknown, fallback = -32010): { code: number; message: string } {
  const message = redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 2000);
  const code =
    e && typeof e === "object" && typeof (e as { code?: unknown }).code === "number"
      ? (e as { code: number }).code
      : fallback;
  return { code, message };
}
