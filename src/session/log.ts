import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dataDir, ensureDirs } from "../config/load.js";
import { isSafeSessionId } from "./ids.js";

export interface LoggedEvent {
  seq: number;
  ts: string;
  /** JSON-RPC notification / update payload as sent to the phone. */
  event: unknown;
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

  constructor(sessionId: string, baseDir?: string) {
    this.sessionId = sessionId;
    ensureDirs();
    const dir = baseDir ?? join(dataDir(), "sessions", sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, "events.jsonl");
    assertRegularLog(this.path);
    if (existsSync(this.path)) {
      this.seq = recoverLastSeq(this.path);
    }
  }

  get lastSeq(): number {
    return this.seq;
  }

  append(event: unknown): LoggedEvent {
    this.seq += 1;
    assertRegularLog(this.path);
    const stamped = injectSeq(event, this.seq);
    const entry: LoggedEvent = {
      seq: this.seq,
      ts: new Date().toISOString(),
      event: stamped,
    };
    try {
      appendRegular(this.path, JSON.stringify(entry) + "\n");
    } catch (e) {
      this.seq -= 1;
      throw e;
    }
    return entry;
  }

  /** Yield events with seq > afterSeq. Corrupt lines are skipped. */
  *replay(afterSeq = 0): Generator<LoggedEvent> {
    if (!existsSync(this.path)) return;
    assertRegularLog(this.path);
    const text = readRegular(this.path);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: LoggedEvent;
      try {
        entry = JSON.parse(line) as LoggedEvent;
      } catch {
        continue;
      }
      if (!entry || typeof entry.seq !== "number" || entry.event == null) continue;
      if (entry.seq > afterSeq) yield entry;
    }
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

function readRegular(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

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

function recoverLastSeq(path: string): number {
  const text = readRegular(path);
  let last = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as LoggedEvent;
      if (typeof entry.seq === "number" && entry.seq > last) last = entry.seq;
    } catch {
      // skip corrupt lines
    }
  }
  return last;
}
