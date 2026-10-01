import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWritableContent,
  MAX_TEXT_FILE_BYTES,
  readTextFileWindow,
  trimIncompleteUtf8,
} from "../src/acp/text-file.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readTextFileWindow", () => {
  it("slices by line and refuses a directory or an oversized file", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-fs-"));
    dirs.push(root);
    const file = join(root, "notes.txt");
    writeFileSync(file, "one\ntwo\nthree\n");
    expect(readTextFileWindow(file, { line: 2, limit: 1 })).toBe("two");
    expect(readTextFileWindow(file)).toBe("one\ntwo\nthree\n");
    expect(() => readTextFileWindow(root)).toThrow(/not a file/);

    const big = join(root, "big.txt");
    writeFileSync(big, Buffer.concat([Buffer.from("hello\n"), Buffer.alloc(MAX_TEXT_FILE_BYTES, 0x62)]));
    expect(() => readTextFileWindow(big)).toThrow(/read limit/);
    expect(readTextFileWindow(big, { line: 1, limit: 1 })).toBe("hello");
  });

  it("rejects writes over the cap and keeps a complete UTF-8 prefix", () => {
    expect(() => assertWritableContent("x".repeat(MAX_TEXT_FILE_BYTES + 1))).toThrow(/write limit/);
    const bytes = Buffer.from("é", "utf8");
    expect(trimIncompleteUtf8(bytes, bytes.length)).toBe(bytes.length);
    expect(trimIncompleteUtf8(bytes, 1)).toBe(0);
  });
});
