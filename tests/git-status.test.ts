import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  getGitDiff,
  getGitStatus,
  gitChildEnv,
  guardedGitArgs,
  parsePorcelainStatus,
  partitionFilterKeys,
} from "../src/git/status.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
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
      expect.arrayContaining([
        "--no-pager",
        "-c",
        "core.fsmonitor=",
        "-c",
        "alias.status=",
        "-c",
        "alias.diff=",
        "diff",
        "--no-ext-diff",
      ]),
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

  it("drops helper env and refuses an unsafe filter name", () => {
    expect(
      partitionFilterKeys([
        "filter.lfs.clean",
        "filter.lfs.clean",
        "filter.lfs.process",
        "user.name",
        "filter.evil name.clean",
      ]),
    ).toEqual({
      disable: ["filter.lfs.clean", "filter.lfs.process"],
      unsafe: true,
    });
    const env = gitChildEnv({
      PATH: "/usr/bin",
      GIT_EXTERNAL_DIFF: "/tmp/evil",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "filter.evil.clean",
      GIT_CONFIG_VALUE_0: "/tmp/evil",
      GIT_PAGER: "less",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(env.GIT_PAGER).toBe("");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(guardedGitArgs(["status"], ["filter.lfs.clean"])).toEqual(
      expect.arrayContaining(["-c", "filter.lfs.clean="]),
    );
  });

  it("does not run textconv, clean filters, or status/diff aliases", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-helper-"));
    const marker = join(tmp, "marker");
    const script = join(tmp, "helper.sh");
    writeFileSync(
      script,
      `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\ncat "$1" 2>/dev/null || cat\n`,
    );
    chmodSync(script, 0o755);
    git(tmp, ["init"]);
    git(tmp, ["config", "user.email", "test@example.com"]);
    git(tmp, ["config", "user.name", "Test"]);
    writeFileSync(join(tmp, "a.txt"), "one\n");
    git(tmp, ["add", "a.txt"]);
    git(tmp, ["commit", "-m", "init"]);
    writeFileSync(join(tmp, "a.txt"), "two\n");
    git(tmp, ["config", "diff.evil.textconv", script]);
    git(tmp, ["config", "filter.evil.clean", script]);
    git(tmp, ["config", "alias.status", `!${script}`]);
    git(tmp, ["config", "alias.diff", `!${script}`]);
    writeFileSync(join(tmp, ".gitattributes"), "* diff=evil filter=evil\n");

    rmSync(marker, { force: true });
    const st = await getGitStatus(tmp);
    expect(st.files.some((f) => f.path === "a.txt")).toBe(true);
    expect(existsSync(marker)).toBe(false);

    const diff = await getGitDiff(tmp, "a.txt");
    expect(diff.unified).toContain("+two");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not run a filter injected through the environment", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-env-"));
    const marker = join(tmp, "marker");
    const script = join(tmp, "helper.sh");
    writeFileSync(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\ncat\n`);
    chmodSync(script, 0o755);
    git(tmp, ["init"]);
    git(tmp, ["config", "user.email", "test@example.com"]);
    git(tmp, ["config", "user.name", "Test"]);
    writeFileSync(join(tmp, "a.txt"), "one\n");
    git(tmp, ["add", "a.txt"]);
    git(tmp, ["commit", "-m", "init"]);
    writeFileSync(join(tmp, "a.txt"), "two\n");
    writeFileSync(join(tmp, ".gitattributes"), "* filter=evil\n");
    const prev = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
      external: process.env.GIT_EXTERNAL_DIFF,
    };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "filter.evil.clean";
    process.env.GIT_CONFIG_VALUE_0 = script;
    process.env.GIT_EXTERNAL_DIFF = script;
    try {
      rmSync(marker, { force: true });
      const diff = await getGitDiff(tmp, "a.txt");
      expect(diff.unified).toContain("+two");
      expect(existsSync(marker)).toBe(false);
      const st = await getGitStatus(tmp);
      expect(st.files.some((f) => f.path === "a.txt")).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      restoreEnv("GIT_CONFIG_COUNT", prev.count);
      restoreEnv("GIT_CONFIG_KEY_0", prev.key);
      restoreEnv("GIT_CONFIG_VALUE_0", prev.value);
      restoreEnv("GIT_EXTERNAL_DIFF", prev.external);
    }
  });

  it("returns no diff when a filter name cannot be disabled safely", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-unsafe-"));
    const marker = join(tmp, "marker");
    const script = join(tmp, "helper.sh");
    writeFileSync(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\ncat\n`);
    chmodSync(script, 0o755);
    git(tmp, ["init"]);
    git(tmp, ["config", "user.email", "test@example.com"]);
    git(tmp, ["config", "user.name", "Test"]);
    writeFileSync(join(tmp, "a.txt"), "one\n");
    git(tmp, ["add", "a.txt"]);
    git(tmp, ["commit", "-m", "init"]);
    writeFileSync(join(tmp, "a.txt"), "two\n");
    git(tmp, ["config", "filter.evil name.clean", script]);
    writeFileSync(join(tmp, ".gitattributes"), '* filter="evil name"\n');
    rmSync(marker, { force: true });
    const diff = await getGitDiff(tmp, "a.txt");
    expect(diff.unified).toBe("");
    expect(existsSync(marker)).toBe(false);
    const st = await getGitStatus(tmp);
    expect(st.files).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it("returns empty status outside a git repo", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-nogit-"));
    mkdirSync(join(tmp, "sub"));
    const st = await getGitStatus(join(tmp, "sub"));
    expect(st).toEqual({ branch: "", ahead: 0, behind: 0, files: [] });
  });
});
