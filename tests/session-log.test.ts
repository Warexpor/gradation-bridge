import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionLog } from "../src/session/log.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("SessionLog", () => {
  it("assigns monotonic seq and injects _meta.seq", () => {
    const base = mkdtempSync(join(tmpdir(), "gb-log-"));
    dirs.push(base);
    const log = new SessionLog("s1", base);
    const a = log.append({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } },
    });
    const b = log.append({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } },
    });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect((a.event as { params: { _meta: { seq: number } } }).params._meta.seq).toBe(1);
    expect((b.event as { params: { _meta: { seq: number } } }).params._meta.seq).toBe(2);

    const replayed = [...log.replay(1)];
    expect(replayed).toHaveLength(1);
    expect(replayed[0].seq).toBe(2);
  });

  it("skips corrupt lines while replaying", () => {
    const base = mkdtempSync(join(tmpdir(), "gb-log-"));
    dirs.push(base);
    const log = new SessionLog("s2", base);
    log.append({ jsonrpc: "2.0", method: "session/update", params: { n: 1 } });
    appendFileSync(log.path, "{this is not json\n");
    appendFileSync(log.path, "\n");
    log.append({ jsonrpc: "2.0", method: "session/update", params: { n: 2 } });
    const replayed = [...log.replay(0)];
    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("moves the directory when the agent assigns a session id", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-log-"));
    dirs.push(root);
    const dir = join(root, "sessions", "tempid");
    const log = new SessionLog("tempid", dir);
    log.append({ jsonrpc: "2.0", method: "session/update", params: { n: 1 } });
    log.relocate("fake-1");
    expect(log.sessionId).toBe("fake-1");
    expect(log.path).toBe(join(root, "sessions", "fake-1", "events.jsonl"));
    const again = new SessionLog("fake-1", join(root, "sessions", "fake-1"));
    expect(again.lastSeq).toBe(1);
    expect([...again.replay(0)]).toHaveLength(1);
  });

  it("stores a short notice instead of an oversized update", () => {
    const base = mkdtempSync(join(tmpdir(), "gb-log-"));
    dirs.push(base);
    const log = new SessionLog("big", base, { maxEventBytes: 1024, maxBytes: 16_000 });
    const pad = "z".repeat(4000);
    const entry = log.append({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "big", text: pad },
    });
    const raw = readFileSync(log.path, "utf8");
    expect(raw).not.toContain(pad);
    expect(raw).toContain("[oversized update omitted]");
    const params = (entry.event as { params: { truncated?: boolean; sessionId?: string } }).params;
    expect(params.truncated).toBe(true);
    expect(params.sessionId).toBe("big");
    expect([...log.replay(0)]).toHaveLength(1);
  });

  it("skips an oversized line and keeps the sequence counter", () => {
    const base = mkdtempSync(join(tmpdir(), "gb-log-"));
    dirs.push(base);
    const limits = { maxEventBytes: 1024, maxBytes: 64_000 };
    const log = new SessionLog("gap", base, limits);
    log.append({ jsonrpc: "2.0", method: "session/update", params: { n: 1 } });
    appendFileSync(log.path, `${"x".repeat(8000)}\n`);
    log.append({ jsonrpc: "2.0", method: "session/update", params: { n: 2 } });
    const again = new SessionLog("gap", base, limits);
    expect(again.lastSeq).toBe(2);
    expect([...again.replay(0)].map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("drops the oldest lines once the transcript cap is reached", () => {
    const base = mkdtempSync(join(tmpdir(), "gb-log-"));
    dirs.push(base);
    const limits = { maxEventBytes: 1024, maxBytes: 4096 };
    const log = new SessionLog("cap", base, limits);
    const pad = "y".repeat(180);
    const count = 40;
    for (let i = 0; i < count; i++) {
      log.append({
        jsonrpc: "2.0",
        method: "session/update",
        params: { n: i, pad },
      });
    }
    expect(statSync(log.path).size).toBeLessThanOrEqual(limits.maxBytes);
    const replayed = [...log.replay(0)];
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.length).toBeLessThan(count);
    expect(replayed[replayed.length - 1]?.seq).toBe(count);
    expect(log.lastSeq).toBe(count);
    const next = log.append({
      jsonrpc: "2.0",
      method: "bridge/promptResult",
      params: { sessionId: "cap", stopReason: "end_turn" },
    });
    expect(next.seq).toBe(count + 1);
    expect(statSync(log.path).size).toBeLessThanOrEqual(limits.maxBytes);
    expect([...log.replay(count)].map((entry) => entry.seq)).toEqual([count + 1]);
  });

  it("refuses a symlinked events.jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-log-"));
    dirs.push(root);
    const dir = join(root, "sess");
    mkdirSync(dir);
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, "LEAK\n");
    symlinkSync(outside, join(dir, "events.jsonl"));
    expect(() => new SessionLog("s3", dir)).toThrow(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe("LEAK\n");
  });
});
