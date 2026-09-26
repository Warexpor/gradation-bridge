import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
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
 */
export class SessionLog {
  readonly sessionId: string;
  readonly path: string;
  private seq = 0;
  private stream: WriteStream | null = null;

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
    const entry: LoggedEvent = {
      seq: this.seq,
      ts: new Date().toISOString(),
      event,
    };
    if (!this.stream) {
      this.stream = createWriteStream(this.path, { flags: "a", mode: 0o600 });
    }
    this.stream.write(JSON.stringify(entry) + "\n");
    return entry;
  }

  /** Yield events with seq > afterSeq (inclusive bound exclusive start). */
  *replay(afterSeq = 0): Generator<LoggedEvent> {
    if (!existsSync(this.path)) return;
    // Flush pending writes before reading.
    // For MVP we read the whole file; fine for scaffold size.
    const text = readFileSync(this.path, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as LoggedEvent;
      if (entry.seq > afterSeq) yield entry;
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
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
