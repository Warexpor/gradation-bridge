import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listDirectory } from "../src/fs/browse.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("listDirectory", () => {
  it("caps the listing and still reports a symlinked directory", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-browse-"));
    dirs.push(root);
    const nested = join(root, "nested");
    mkdirSync(nested);
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "b.txt"), "b");
    writeFileSync(join(root, "c.txt"), "c");
    symlinkSync(nested, join(root, "link"));

    const listed = listDirectory(root, 2);
    expect(listed.truncated).toBe(true);
    expect(listed.entries).toHaveLength(2);

    const full = listDirectory(root, 20);
    expect(full.truncated).toBe(false);
    expect(full.entries.find((entry) => entry.name === "link")?.dir).toBe(true);
    expect(full.entries.find((entry) => entry.name === "nested")?.dir).toBe(true);
    expect(full.entries.find((entry) => entry.name === "a.txt")?.dir).toBe(false);
  });

  it("stops after the cap instead of materializing every name", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-browse-cap-"));
    dirs.push(root);
    for (let i = 0; i < 2500; i++) {
      writeFileSync(join(root, `f-${String(i).padStart(4, "0")}.txt`), "");
    }
    const listed = listDirectory(root, 100);
    expect(listed.truncated).toBe(true);
    expect(listed.entries).toHaveLength(100);
    const empty = listDirectory(root, 0);
    expect(empty.truncated).toBe(true);
    expect(empty.entries).toHaveLength(0);
  });
});
