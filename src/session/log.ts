import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, ensureDirs } from "../config/load.js";

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
  readonly sessionId: string;
  readonly path: string;
  private seq = 0;

  constructor(sessionId: string, baseDir?: string) {
    this.sessionId = sessionId;
    ensureDirs();
    const dir = baseDir ?? join(dataDir(), "sessions", sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, "events.jsonl");
    if (existsSync(this.path)) {
      this.seq = recoverLastSeq(this.path);
    }
  }

  get lastSeq(): number {
    return this.seq;
  }

  append(event: unknown): LoggedEvent {
    this.seq += 1;
    const stamped = injectSeq(event, this.seq);
    const entry: LoggedEvent = {
      seq: this.seq,
      ts: new Date().toISOString(),
      event: stamped,
    };
    appendFileSync(this.path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    return entry;
  }

  /** Yield events with seq > afterSeq. Corrupt lines are skipped. */
  *replay(afterSeq = 0): Generator<LoggedEvent> {
    if (!existsSync(this.path)) return;
    const text = readFileSync(this.path, "utf8");
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

  close(): void {
    // sync writer — nothing to flush
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
  const text = readFileSync(path, "utf8");
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
