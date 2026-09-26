import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAllowedPath,
  assertAllowedRealPath,
  assertAllowedWorkspace,
  isInsideRoot,
  isPathAllowed,
  normalizePath,
  resolveRealPath,
  SandboxError,
} from "../src/approval/sandbox.js";

describe("sandbox", () => {
  const root = "/home/user/project";
  const other = "/home/user/other";

  it("normalizes relative paths against cwd", () => {
    expect(normalizePath("src/a.ts", root)).toBe(`${root}/src/a.ts`);
  });

  it("treats the root itself as inside", () => {
    expect(isInsideRoot(root, root)).toBe(true);
  });

  it("allows children of the root", () => {
    expect(isInsideRoot(`${root}/src/main.ts`, root)).toBe(true);
    expect(isInsideRoot(`${root}/../project/x`, root)).toBe(true);
  });

  it("rejects siblings and escapes", () => {
    expect(isInsideRoot(`${other}/file.ts`, root)).toBe(false);
    expect(isInsideRoot("/etc/passwd", root)).toBe(false);
    // path that only shares a prefix string must fail
    expect(isInsideRoot("/home/user/project-evil/x", root)).toBe(false);
  });

  it("isPathAllowed requires at least one matching root", () => {
    expect(isPathAllowed(`${root}/a.ts`, [root, other])).toBe(true);
    expect(isPathAllowed(`${other}/a.ts`, [root])).toBe(false);
    expect(isPathAllowed(`${root}/a.ts`, [])).toBe(false);
  });

  it("assertAllowedPath returns the normalized path or throws", () => {
    expect(assertAllowedPath(`${root}/x`, [root])).toBe(`${root}/x`);
    expect(() => assertAllowedPath("/tmp/x", [root])).toThrow(SandboxError);
  });

  it("blocks .. traversal out of the root", () => {
    expect(isPathAllowed("../secrets", [root], root)).toBe(false);
    expect(isPathAllowed("src/../../other/x", [root], root)).toBe(false);
  });
});

describe("sandbox realpath / symlink hardening", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("resolveRealPath follows symlinks for existing paths", () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-sb-"));
    const allowed = join(tmp, "allowed");
    const outside = join(tmp, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "nope\n");
    symlinkSync(outside, join(allowed, "escape"));

    const real = resolveRealPath(join(allowed, "escape", "secret.txt"));
    expect(real).toBe(join(outside, "secret.txt"));
  });

  it("assertAllowedRealPath denies symlink escape from allowed root", () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-sb-"));
    const allowed = join(tmp, "allowed");
    const outside = join(tmp, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "nope\n");
    symlinkSync(outside, join(allowed, "escape"));

    // Lexical check would allow the path under allowed/...
    expect(assertAllowedPath(join(allowed, "escape", "secret.txt"), [allowed])).toContain(
      "escape",
    );

    expect(() =>
      assertAllowedRealPath(join(allowed, "escape", "secret.txt"), [allowed]),
    ).toThrow(SandboxError);

    expect(() => assertAllowedRealPath(join(allowed, "escape"), [allowed])).toThrow(
      SandboxError,
    );
  });

  it("assertAllowedRealPath allows real paths inside the root", () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-sb-"));
    const allowed = join(tmp, "allowed");
    mkdirSync(join(allowed, "src"), { recursive: true });
    writeFileSync(join(allowed, "src", "a.ts"), "x\n");
    const real = assertAllowedRealPath(join(allowed, "src", "a.ts"), [allowed]);
    expect(real).toBe(join(allowed, "src", "a.ts"));
  });

  it("assertAllowedWorkspace denies cwd that is a symlink outside", () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-sb-"));
    const allowed = join(tmp, "allowed");
    const outside = join(tmp, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    const linkCwd = join(allowed, "ws-link");
    symlinkSync(outside, linkCwd);
    expect(() => assertAllowedWorkspace(linkCwd, [allowed])).toThrow(SandboxError);
  });

  it("assertAllowedRealPath resolves non-existent child under real parent", () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-sb-"));
    const allowed = join(tmp, "allowed");
    mkdirSync(allowed);
    const target = assertAllowedRealPath(join(allowed, "new-file.txt"), [allowed]);
    expect(target).toBe(join(allowed, "new-file.txt"));
  });
});
