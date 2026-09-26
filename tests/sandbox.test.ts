import { describe, expect, it } from "vitest";
import {
  assertAllowedPath,
  isInsideRoot,
  isPathAllowed,
  normalizePath,
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
