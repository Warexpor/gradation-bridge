import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { getGitDiff, getGitStatus, guardedGitArgs, parsePorcelainStatus } from "../src/git/status.js";

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

  it("does not run repo fsmonitor or diff.external helpers", async () => {
    expect(guardedGitArgs(["diff", "--no-ext-diff"])).toEqual(
      expect.arrayContaining(["-c", "core.fsmonitor=", "diff", "--no-ext-diff"]),
    );
    tmp = mkdtempSync(join(tmpdir(), "gb-git-hook-"));
    const marker = join(tmp, "hook-ran");
    const script = join(tmp, "hook.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(script, 0o755);
    git(tmp, ["init"]);
    git(tmp, ["config", "user.email", "test@example.com"]);
    git(tmp, ["config", "user.name", "Test"]);
    writeFileSync(join(tmp, "a.txt"), "one\n");
    git(tmp, ["add", "a.txt"]);
    git(tmp, ["commit", "-m", "init"]);
    git(tmp, ["config", "core.fsmonitor", script]);
    git(tmp, ["config", "diff.external", script]);
    writeFileSync(join(tmp, "a.txt"), "two\n");

    rmSync(marker, { force: true });
    const st = await getGitStatus(tmp);
    expect(st.files.some((f) => f.path === "a.txt")).toBe(true);
    expect(existsSync(marker)).toBe(false);

    const diff = await getGitDiff(tmp, "a.txt");
    expect(diff.unified).toContain("+two");
    expect(existsSync(marker)).toBe(false);

    try {
      execFileSync("git", ["status", "--porcelain=v1", "-b"], { cwd: tmp, stdio: "ignore" });
    } catch {
      // A stub fsmonitor can fail status after the script has started.
    }
    expect(existsSync(marker)).toBe(true);
  });

  it("returns empty status outside a git repo", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-nogit-"));
    mkdirSync(join(tmp, "sub"));
    const st = await getGitStatus(join(tmp, "sub"));
    expect(st).toEqual({ branch: "", ahead: 0, behind: 0, files: [] });
  });
});
