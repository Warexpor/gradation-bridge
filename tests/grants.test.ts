import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { consumeGrant, grantFromOption, type ToolGrant } from "../src/approval/grants.js";

function writeExe(path: string, body = "#!/bin/sh\nexit 0\n"): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

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

  it("limits an allow_once exec grant to the approved command", () => {
    expect(grantFromOption("allow_once", "exec", undefined, ["npm", "test"])?.argv).toEqual([
      "npm",
      "test",
    ]);
    expect(grantFromOption("allow_always", "exec", undefined, ["npm", "test"])?.argv).toBeUndefined();
    expect(grantFromOption("allow_once", "write", "/tmp/a", ["npm"])?.argv).toBeUndefined();

    const once: ToolGrant[] = [{ family: "exec", argv: ["npm", "test"], always: false }];
    expect(consumeGrant(once, "exec", undefined, ["curl", "evil.example"])).toBe(false);
    expect(once).toHaveLength(1);
    expect(consumeGrant(once, "exec", undefined, ["npm", "test"])).toBe(true);
    expect(once).toHaveLength(0);

    const always: ToolGrant[] = [{ family: "exec", argv: ["npm", "test"], always: true }];
    expect(consumeGrant(always, "exec", undefined, ["curl"])).toBe(true);
    expect(always).toHaveLength(1);
  });

  it("does not treat a different binary with the same name as the approved command", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gb-grant-"));
    const bin = join(tmp, "bin");
    const evilDir = join(tmp, "evil");
    const linkDir = join(tmp, "link");
    mkdirSync(bin);
    mkdirSync(evilDir);
    mkdirSync(linkDir);
    const trusted = join(bin, "npm");
    writeExe(trusted);
    writeExe(join(evilDir, "npm"), "#!/bin/sh\necho evil\n");
    symlinkSync(trusted, join(linkDir, "npm"));
    const prev = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${prev ?? ""}`;
    try {
      const evil = join(evilDir, "npm");
      const once: ToolGrant[] = [{ family: "exec", argv: ["npm", "test"], always: false }];
      expect(consumeGrant(once, "exec", undefined, [evil, "test"], tmp)).toBe(false);
      expect(consumeGrant(once, "exec", undefined, ["evil/npm", "test"], tmp)).toBe(false);
      expect(once).toHaveLength(1);
      expect(consumeGrant(once, "exec", undefined, [trusted, "test"], tmp)).toBe(true);
      expect(once).toHaveLength(0);

      const viaLink: ToolGrant[] = [{ family: "exec", argv: ["npm", "test"], always: false }];
      expect(consumeGrant(viaLink, "exec", undefined, [join(linkDir, "npm"), "test"], tmp)).toBe(true);

      const fromPath: ToolGrant[] = [{ family: "exec", argv: [trusted, "test"], always: false }];
      expect(consumeGrant(fromPath, "exec", undefined, ["npm", "test"], tmp)).toBe(true);

      const text: ToolGrant[] = [{ family: "exec", argv: ["npm test"], always: false }];
      expect(consumeGrant(text, "exec", undefined, [evil, "test"], tmp)).toBe(false);
      expect(text).toHaveLength(1);
      expect(consumeGrant(text, "exec", undefined, [trusted, "test"], tmp)).toBe(true);

      const exact: ToolGrant[] = [{ family: "exec", argv: [evil, "test"], always: false }];
      expect(consumeGrant(exact, "exec", undefined, [evil, "test"], tmp)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PATH;
      else process.env.PATH = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
