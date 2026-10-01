/**
 * Bounded line splitting for harness stdio and session transcripts.
 * A peer that never sends a newline must not be able to grow memory without a cap.
 */

import { closeSync, constants, openSync, readSync } from "node:fs";

export class ByteLineSplitter {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private skipping = false;
  skipped = 0;

  constructor(private readonly maxLine: number) {}

  get bufferedBytes(): number {
    return this.bytes;
  }

  /** Complete lines, without the newline. Oversized lines are counted and dropped. */
  push(buf: Buffer): string[] {
    const lines: string[] = [];
    let offset = 0;
    while (offset < buf.length) {
      if (this.skipping) {
        const nl = buf.indexOf(0x0a, offset);
        if (nl < 0) return lines;
        this.skipping = false;
        offset = nl + 1;
        continue;
      }
      const nl = buf.indexOf(0x0a, offset);
      const end = nl < 0 ? buf.length : nl;
      const pieceLen = end - offset;
      if (this.bytes + pieceLen > this.maxLine) {
        this.chunks = [];
        this.bytes = 0;
        this.skipped += 1;
        this.skipping = true;
        if (nl < 0) return lines;
        this.skipping = false;
        offset = nl + 1;
        continue;
      }
      if (pieceLen > 0) {
        // Copy: callers reuse the underlying buffer after push returns.
        this.chunks.push(Buffer.from(buf.subarray(offset, end)));
        this.bytes += pieceLen;
        if (this.chunks.length >= 32) {
          this.chunks = [Buffer.concat(this.chunks, this.bytes)];
        }
      }
      if (nl < 0) return lines;
      lines.push(this.emit());
      offset = nl + 1;
    }
    return lines;
  }

  /** A trailing partial line at EOF. An oversized partial line is dropped. */
  end(): string | undefined {
    if (this.skipping) {
      this.skipping = false;
      this.chunks = [];
      this.bytes = 0;
      return undefined;
    }
    if (this.bytes === 0) return undefined;
    return this.emit();
  }

  private emit(): string {
    const line = Buffer.concat(this.chunks, this.bytes).toString("utf8").replace(/\r$/, "");
    this.chunks = [];
    this.bytes = 0;
    return line;
  }
}

/** Read a regular file line by line. Lines over `maxLine` bytes are omitted. */
export function* readFileLines(path: string, maxLine: number): Generator<string> {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const splitter = new ByteLineSplitter(maxLine);
  const buf = Buffer.alloc(64 * 1024);
  try {
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      for (const line of splitter.push(buf.subarray(0, n))) yield line;
    }
    const tail = splitter.end();
    if (tail !== undefined) yield tail;
  } finally {
    closeSync(fd);
  }
}

/**
 * Stderr capture that keeps complete lines and refuses to hold an unbounded
 * pending line. The first overflow contributes one short sample; the rest of
 * that line is discarded through the next newline.
 */
export class PendingText {
  private pending = "";
  private skipping = false;
  drops = 0;

  constructor(private readonly maxPending: number) {}

  get pendingLength(): number {
    return this.pending.length;
  }

  pushBuffer(buf: Buffer): string[] {
    const lines: string[] = [];
    const step = 8 * 1024;
    for (let offset = 0; offset < buf.length; offset += step) {
      const end = Math.min(buf.length, offset + step);
      this.pushString(buf.toString("utf8", offset, end), lines);
    }
    return lines;
  }

  /** Emit a trailing partial line that stayed under the cap. */
  flush(): string | undefined {
    if (this.skipping || this.pending.length === 0) {
      this.skipping = false;
      this.pending = "";
      return undefined;
    }
    const tail = stripCr(this.pending);
    this.pending = "";
    return tail;
  }

  private pushString(text: string, lines: string[]): void {
    let rest = text;
    while (rest.length > 0) {
      if (this.skipping) {
        const nl = rest.indexOf("\n");
        if (nl < 0) return;
        this.skipping = false;
        rest = rest.slice(nl + 1);
        continue;
      }
      const nl = rest.indexOf("\n");
      const piece = nl < 0 ? rest : rest.slice(0, nl);
      const room = this.maxPending - this.pending.length;
      if (piece.length > room) {
        if (this.drops === 0) {
          const sample = (this.pending + piece).slice(0, 500);
          if (sample) lines.push(sample);
        }
        this.pending = "";
        this.drops += 1;
        this.skipping = true;
        if (nl < 0) return;
        this.skipping = false;
        rest = rest.slice(nl + 1);
        continue;
      }
      this.pending += piece;
      if (nl < 0) return;
      lines.push(stripCr(this.pending));
      this.pending = "";
      rest = rest.slice(nl + 1);
    }
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
