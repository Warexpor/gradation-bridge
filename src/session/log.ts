import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dataDir, ensureDirs } from "../config/load.js";
import { readFileLines } from "../io/lines.js";
import { log } from "../log/diagnostics.js";
import { isSafeSessionId } from "./ids.js";

export interface LoggedEvent {
  seq: number;
  ts: string;
  /** JSON-RPC notification / update payload as sent to the phone. */
  event: unknown;
}

/** On-disk transcript cap. Older lines are dropped once a session passes this. */
export const DEFAULT_MAX_SESSION_LOG_BYTES = 16 * 1024 * 1024;
/** One stored event. Larger updates are replaced with a short truncation notice. */
export const DEFAULT_MAX_SESSION_EVENT_BYTES = 512 * 1024;
const MIN_EVENT_BYTES = 1024;

export interface SessionLogLimits {
  maxBytes?: number;
  maxEventBytes?: number;
}

/**
 * Append-only JSONL event log with a monotonically increasing `seq` per session.
 * A reconnecting phone can replay from its last seen seq.
 *
 * When `event` looks like a JSON-RPC notification/request with `params`,
 * `_meta.seq` is injected before the line is written so replay matches live frames.
 */
export class SessionLog {
  sessionId: string;
  path: string;
  private seq = 0;
  private readonly maxBytes: number;
  private readonly maxEventBytes: number;

  constructor(sessionId: string, baseDir?: string, limits?: SessionLogLimits) {
    this.sessionId = sessionId;
    this.maxEventBytes = atLeast(
      limits?.maxEventBytes,
      DEFAULT_MAX_SESSION_EVENT_BYTES,
      MIN_EVENT_BYTES,
    );
    this.maxBytes = atLeast(
      limits?.maxBytes,
      DEFAULT_MAX_SESSION_LOG_BYTES,
      this.maxEventBytes,
    );
    ensureDirs();
    const dir = baseDir ?? join(dataDir(), "sessions", sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, "events.jsonl");
    assertRegularLog(this.path);
    if (existsSync(this.path)) {
      this.seq = recoverLastSeq(this.path, this.maxEventBytes);
    }
  }

  get lastSeq(): number {
    return this.seq;
  }

  append(event: unknown): LoggedEvent {
    this.seq += 1;
    assertRegularLog(this.path);
    const entry = fitEvent(event, this.seq, this.maxEventBytes);
    const line = JSON.stringify(entry);
    try {
      this.makeRoom(Buffer.byteLength(line) + 1);
      appendRegular(this.path, line + "\n");
    } catch (e) {
      this.seq -= 1;
      throw e;
    }
    return entry;
  }

  /**
   * Yield events with seq > afterSeq. Corrupt lines and lines over the event
   * cap are skipped. The file is not loaded into one string.
   */
  *replay(afterSeq = 0): Generator<LoggedEvent> {
    if (!existsSync(this.path)) return;
    assertRegularLog(this.path);
    for (const line of readFileLines(this.path, this.maxEventBytes)) {
      if (!line.trim()) continue;
      const entry = parseEntry(line);
      if (!entry || entry.seq <= afterSeq) continue;
      yield entry;
    }
  }

  /**
   * Drop the oldest lines once `extra` bytes would pass the cap.
   * Sequence numbers on the lines that remain stay as written.
   */
  private makeRoom(extra: number): void {
    let size = 0;
    try {
      const info = lstatSync(this.path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("refusing to follow a symlinked session log");
      }
      size = info.size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (size + extra <= this.maxBytes) return;
    const lines: string[] = [];
    let total = 0;
    for (const line of readFileLines(this.path, this.maxEventBytes)) {
      if (!line) continue;
      lines.push(line);
      total += Buffer.byteLength(line) + 1;
    }
    const budget = Math.max(this.maxEventBytes, Math.floor(this.maxBytes * 0.75));
    let start = 0;
    while (start < lines.length && total + extra > budget) {
      total -= Buffer.byteLength(lines[start]!) + 1;
      start += 1;
    }
    const kept = lines.slice(start);
    const body = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    replaceRegularFile(this.path, body);
    log(
      "warn",
      `session ${this.sessionId} transcript exceeded ${this.maxBytes} bytes; dropped older lines`,
    );
  }

  /**
   * Move this session's directory so the folder name matches the agent session id.
   * `events.jsonl` and `meta.json` move together.
   */
  relocate(newSessionId: string): void {
    if (!isSafeSessionId(newSessionId)) {
      throw new Error("invalid session id");
    }
    if (newSessionId === this.sessionId) return;
    const destDir = join(dirname(dirname(this.path)), newSessionId);
    if (existsSync(destDir)) {
      throw new Error(`session directory already exists: ${newSessionId}`);
    }
    renameSync(dirname(this.path), destDir);
    this.sessionId = newSessionId;
    this.path = join(destDir, "events.jsonl");
  }

  /** Delete the session directory after a failed start. */
  discard(): void {
    rmSync(dirname(this.path), { recursive: true, force: true });
  }

  close(): void {
    // sync writer — nothing to flush
  }
}

function assertRegularLog(path: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (info.isSymbolicLink()) {
    throw new Error("refusing to follow a symlinked session log");
  }
  if (!info.isFile()) {
    throw new Error("refusing to use a session log that is not a regular file");
  }
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function appendRegular(path: string, line: string): void {
  const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | NOFOLLOW, 0o600);
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

function injectSeq(event: unknown, seq: number): unknown {
  if (!event || typeof event !== "object" || Array.isArray(event)) return event;
  const obj = event as Record<string, unknown>;
  if (!("params" in obj)) return event;
  const params = obj.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {
      ...obj,
      params: { value: params, _meta: { seq } },
    };
  }
  const p = params as Record<string, unknown>;
  const meta =
    p._meta && typeof p._meta === "object" && !Array.isArray(p._meta)
      ? { ...(p._meta as Record<string, unknown>), seq }
      : { seq };
  return { ...obj, params: { ...p, _meta: meta } };
}

function recoverLastSeq(path: string, maxLine: number): number {
  let last = 0;
  for (const line of readFileLines(path, maxLine)) {
    const entry = parseEntry(line);
    if (entry && entry.seq > last) last = entry.seq;
  }
  return last;
}

function parseEntry(line: string): LoggedEvent | undefined {
  try {
    const entry = JSON.parse(line) as LoggedEvent;
    if (!entry || typeof entry.seq !== "number" || entry.event == null) return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

function fitEvent(event: unknown, seq: number, maxEventBytes: number): LoggedEvent {
  const ts = new Date().toISOString();
  let stamped = injectSeq(event, seq);
  let entry: LoggedEvent = { seq, ts, event: stamped };
  if (Buffer.byteLength(JSON.stringify(entry)) <= maxEventBytes) return entry;
  stamped = injectSeq(truncatedEvent(event), seq);
  entry = { seq, ts, event: stamped };
  if (Buffer.byteLength(JSON.stringify(entry)) <= maxEventBytes) return entry;
  return {
    seq,
    ts,
    event: {
      jsonrpc: "2.0",
      method: "session/update",
      params: { truncated: true, _meta: { seq } },
    },
  };
}

function truncatedEvent(event: unknown): Record<string, unknown> {
  const obj =
    event && typeof event === "object" && !Array.isArray(event)
      ? (event as Record<string, unknown>)
      : {};
  const method = typeof obj.method === "string" && obj.method ? obj.method.slice(0, 80) : "session/update";
  const params =
    obj.params && typeof obj.params === "object" && !Array.isArray(obj.params)
      ? (obj.params as Record<string, unknown>)
      : {};
  const sessionId = typeof params.sessionId === "string" ? params.sessionId.slice(0, 200) : undefined;
  const nextParams: Record<string, unknown> = { truncated: true };
  if (sessionId) nextParams.sessionId = sessionId;
  if (method === "session/update") {
    nextParams.update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "[oversized update omitted]" },
    };
  }
  return { jsonrpc: "2.0", method, params: nextParams };
}

function atLeast(value: number | undefined, fallback: number, floor: number): number {
  if (value == null) return Math.max(floor, fallback);
  if (!Number.isFinite(value)) return Math.max(floor, fallback);
  return Math.max(floor, Math.floor(value));
}

function replaceRegularFile(path: string, body: string): void {
  const tmp = `${path}.tmp`;
  try {
    const info = lstatSync(tmp);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("refusing to rewrite a session log through a symlink");
    }
    unlinkSync(tmp);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
