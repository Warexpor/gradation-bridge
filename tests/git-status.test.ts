import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { getGitDiff, getGitStatus, parsePorcelainStatus } from "../src/git/status.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("parsePorcelainStatus", () => {
  it("parses branch, ahead/behind, and file rows", () => {
    const text = [
      "## main...origin/main [ahead 2, behind 1]",
      " M src/a.ts",
      "?? new.txt",
      "R  old.ts -> renamed.ts",
    ].join("\n");
    const r = parsePorcelainStatus(text);
    expect(r.branch).toBe("main");
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(1);
    expect(r.files).toEqual([
      { path: "src/a.ts", status: " M" },
      { path: "new.txt", status: "??" },
      { path: "renamed.ts", status: "R " },
    ]);
  });

  it("handles branch with no upstream", () => {
    const r = parsePorcelainStatus("## feature\n");
    expect(r.branch).toBe("feature");
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(0);
    expect(r.files).toEqual([]);
  });
});

describe("getGitStatus / getGitDiff", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("reports modified and untracked files", () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-"));
    git(tmp, ["init"]);
    git(tmp, ["config", "user.email", "test@example.com"]);
    git(tmp, ["config", "user.name", "Test"]);
    writeFileSync(join(tmp, "tracked.txt"), "v1\n");
    git(tmp, ["add", "tracked.txt"]);
    git(tmp, ["commit", "-m", "init"]);
    writeFileSync(join(tmp, "tracked.txt"), "v2\n");
    writeFileSync(join(tmp, "untracked.txt"), "u\n");

    return getGitStatus(tmp).then((st) => {
      expect(st.branch).toMatch(/^(master|main)$/);
      expect(st.files.some((f) => f.path === "tracked.txt")).toBe(true);
      expect(st.files.some((f) => f.path === "untracked.txt" && f.status === "??")).toBe(true);
    });
  });

  it("returns unified diff for a changed file", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-"));
    git(tmp, ["init"]);
    git(tmp, ["config", "user.email", "test@example.com"]);
    git(tmp, ["config", "user.name", "Test"]);
    writeFileSync(join(tmp, "a.txt"), "one\n");
    git(tmp, ["add", "a.txt"]);
    git(tmp, ["commit", "-m", "init"]);
    writeFileSync(join(tmp, "a.txt"), "two\n");

    const diff = await getGitDiff(tmp, "a.txt");
    expect(diff.unified).toContain("-one");
    expect(diff.unified).toContain("+two");
  });

  it("returns empty status outside a git repo", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-nogit-"));
    mkdirSync(join(tmp, "sub"));
    const st = await getGitStatus(join(tmp, "sub"));
    expect(st).toEqual({ branch: "", ahead: 0, behind: 0, files: [] });
  });
});
