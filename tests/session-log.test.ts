import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
