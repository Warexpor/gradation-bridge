import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ByteLineSplitter, PendingText, readFileLines } from "../src/io/lines.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ByteLineSplitter", () => {
  it("joins chunks and strips a carriage return", () => {
    const splitter = new ByteLineSplitter(100);
    expect(splitter.push(Buffer.from("hel"))).toEqual([]);
    expect(splitter.push(Buffer.from("lo\r\nworld\n"))).toEqual(["hello", "world"]);
  });

  it("copies retained bytes so the caller can reuse the buffer", () => {
    const splitter = new ByteLineSplitter(100);
    const buf = Buffer.alloc(16);
    Buffer.from("hello ").copy(buf);
    expect(splitter.push(buf.subarray(0, 6))).toEqual([]);
    buf.fill(0);
    Buffer.from("world\n").copy(buf);
    expect(splitter.push(buf.subarray(0, 6))).toEqual(["hello world"]);
  });

  it("drops an oversized line without retaining it, then parses the next", () => {
    const splitter = new ByteLineSplitter(32);
    const big = Buffer.alloc(1024 * 1024, 0x61);
    expect(splitter.push(big)).toEqual([]);
    expect(splitter.bufferedBytes).toBe(0);
    expect(splitter.skipped).toBe(1);
    expect(splitter.end()).toBeUndefined();
    expect(splitter.push(Buffer.from("ok\n"))).toEqual(["ok"]);
  });

  it("drops an oversized line in the same buffer as the following line", () => {
    const splitter = new ByteLineSplitter(8);
    const buf = Buffer.concat([Buffer.alloc(20, 0x62), Buffer.from("\nkept\n")]);
    expect(splitter.push(buf)).toEqual(["kept"]);
    expect(splitter.skipped).toBe(1);
    expect(splitter.bufferedBytes).toBe(0);
  });
});

describe("PendingText", () => {
  it("caps a newline-less stderr flood and keeps the next line", () => {
    const pending = new PendingText(100);
    const lines = pending.pushBuffer(Buffer.from(`${"A".repeat(5000)}\nTOKEN=secret\n`));
    expect(pending.pendingLength).toBe(0);
    expect(pending.drops).toBe(1);
    expect(lines[0]?.length).toBeLessThanOrEqual(500);
    expect(lines).toContain("TOKEN=secret");
    expect((lines.join("").match(/A/g) ?? []).length).toBeLessThanOrEqual(500);
  });
});

describe("readFileLines", () => {
  it("omits a line over the cap and yields the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-lines-"));
    dirs.push(dir);
    const path = join(dir, "events.jsonl");
    writeFileSync(path, `{"seq":1}\n${"x".repeat(500)}\n{"seq":2}\n`);
    expect([...readFileLines(path, 100)]).toEqual(['{"seq":1}', '{"seq":2}']);
  });

  it("keeps a line that spans read chunks", () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-lines-"));
    dirs.push(dir);
    const path = join(dir, "events.jsonl");
    const body = "a".repeat(70_000);
    writeFileSync(path, `${body}\nnext\n`);
    expect([...readFileLines(path, 80_000)]).toEqual([body, "next"]);
  });
});
