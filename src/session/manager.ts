import { randomBytes } from "node:crypto";
import type { PermissionMode } from "../config/types.js";
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
}

export type SessionSummary = Omit<SessionRecord, "log">;

/**
 * Owns session lifetime. MVP stub: in-memory registry + JSONL logs.
 * Full product will spawn ACP agent processes per session.
 */
export class SessionManager {
  private sessions = new Map<string, SessionRecord>();

  create(opts: {
    harness: string;
    cwd: string;
    permissionMode: PermissionMode;
    title?: string;
  }): SessionRecord {
    const sessionId = randomBytes(12).toString("hex");
    const now = new Date().toISOString();
    const log = new SessionLog(sessionId);
    const rec: SessionRecord = {
      sessionId,
      harness: opts.harness,
      cwd: opts.cwd,
      title: opts.title ?? "New session",
      createdAt: now,
      updatedAt: now,
      preview: "",
      status: "idle",
      permissionMode: opts.permissionMode,
      lastSeq: 0,
      log,
    };
    this.sessions.set(sessionId, rec);
    return rec;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  list(opts?: { limit?: number; before?: string }): SessionSummary[] {
    let items = [...this.sessions.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    if (opts?.before) {
      items = items.filter((s) => s.updatedAt < opts.before!);
    }
    if (opts?.limit != null) {
      items = items.slice(0, opts.limit);
    }
    return items.map((s) => ({
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
    }));
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
  }

  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`unknown session: ${sessionId}`);
    rec.permissionMode = mode;
    rec.updatedAt = new Date().toISOString();
  }

  close(sessionId: string): boolean {
    const rec = this.sessions.get(sessionId);
    if (!rec) return false;
    rec.status = "closed";
    rec.log.close();
    return true;
  }
}
