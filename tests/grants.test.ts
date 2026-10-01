import { describe, expect, it } from "vitest";
import { consumeGrant, grantFromOption, type ToolGrant } from "../src/approval/grants.js";

describe("approval grants", () => {
  it("records allow_once and allow_always, ignores rejects", () => {
    expect(grantFromOption("allow_once", "write", "/tmp/a")?.always).toBe(false);
    expect(grantFromOption("allow_always", "exec", undefined)?.always).toBe(true);
    expect(grantFromOption("reject_once", "write", "/tmp/a")).toBeUndefined();
    expect(grantFromOption("allow_once", undefined, "/tmp/a")).toBeUndefined();
  });

  it("consumes a single allow_once and keeps allow_always", () => {
    const grants: ToolGrant[] = [
      { family: "write", path: "/tmp/proj/README.md", always: false },
      { family: "write", always: true },
    ];
    expect(consumeGrant(grants, "write", "/tmp/proj/README.md")).toBe(true);
    expect(grants).toHaveLength(2);
    expect(consumeGrant(grants, "exec")).toBe(false);
    expect(consumeGrant(grants, "write", "/tmp/proj/other.ts")).toBe(true);
    expect(grants.some((g) => g.always)).toBe(true);
  });

  it("does not let a write grant authorize a different file", () => {
    const grants: ToolGrant[] = [{ family: "write", path: "/tmp/proj/README.md", always: false }];
    expect(consumeGrant(grants, "write", "/tmp/proj/secret.env")).toBe(false);
    expect(grants).toHaveLength(1);
  });

  it("does not let a file grant authorize its parent, and a directory grant covers children", () => {
    const file: ToolGrant[] = [{ family: "write", path: "/tmp/proj/README.md", always: true }];
    expect(consumeGrant(file, "write", "/tmp/proj")).toBe(false);
    expect(consumeGrant(file, "write", "/tmp")).toBe(false);
    expect(consumeGrant(file, "write", "/tmp/proj/README.md.bak")).toBe(false);
    expect(consumeGrant(file, "write", "/tmp/proj/README.md")).toBe(true);

    const dir: ToolGrant[] = [{ family: "write", path: "/tmp/proj", always: true }];
    expect(consumeGrant(dir, "write", "/tmp/proj/src/a.ts")).toBe(true);
    expect(consumeGrant(dir, "write", "/tmp/proj")).toBe(true);
  });
});
