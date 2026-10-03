import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("keeps dots in branch names and unborn headers", () => {
    const dotted = parsePorcelainStatus("## feature.2...main [ahead 1]\n");
    expect(dotted.branch).toBe("feature.2");
    expect(dotted.ahead).toBe(1);
    expect(dotted.behind).toBe(0);

    const release = parsePorcelainStatus("## release/1.2.3\n M a.txt\n");
    expect(release.branch).toBe("release/1.2.3");
    expect(release.files).toEqual([{ path: "a.txt", status: " M" }]);

    const unborn = parsePorcelainStatus("## No commits yet on release/1.2\n");
    expect(unborn.branch).toBe("release/1.2");
    expect(parsePorcelainStatus("## Initial commit on master\n").branch).toBe("master");
    expect(parsePorcelainStatus("## HEAD (no branch)\n").branch).toBe("HEAD");

    const both = parsePorcelainStatus(
      "## feature.1...origin/feature.1 [ahead 2, behind 3]\n",
    );
    expect(both.branch).toBe("feature.1");
    expect(both.ahead).toBe(2);
    expect(both.behind).toBe(3);
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
      GIT_DIR: "/tmp/other-repo",
      GIT_WORK_TREE: "/tmp/other-work",
      GIT_EDITOR: "/tmp/editor",
      EDITOR: "/tmp/editor",
      GIT_CONFIG: "/tmp/other.cfg",
      GIT_ASKPASS: "/tmp/askpass",
      SSH_ASKPASS: "/tmp/askpass",
      SSH_ASKPASS_REQUIRE: "force",
      GIT_PROXY_COMMAND: "/tmp/proxy",
      GIT_ALLOW_PROTOCOL: "ext",
      GIT_TRACE: "/tmp/trace",
      GIT_TRACE2_EVENT: "/tmp/trace2",
      GIT_TRACE_PACKFILE: "/tmp/pack",
      LD_PRELOAD: "/tmp/evil.so",
      JAVA_TOOL_OPTIONS: "-javaagent:/tmp/x.jar",
      SSLKEYLOGFILE: "/tmp/keys",
      OPENSSL_CONF: "/tmp/openssl.cnf",
      NODE_OPTIONS: "--require /tmp/x.js",
      NODE_PATH: "/tmp/node_modules",
      DOTNET_STARTUP_HOOKS: "/tmp/hook",
      PYTHONSTARTUP: "/tmp/sitecustomize.py",
      PYTHONPATH: "/tmp/evil-py",
      PERL5OPT: "-Mevil",
      PERL5LIB: "/tmp/evil-perl",
      RUBYOPT: "-r/tmp/evil",
      RUBYLIB: "/tmp/evil-ruby",
      BASH_ENV: "/tmp/evil.bashrc",
      ENV: "/tmp/evil.sh",
      SHELLOPTS: "xtrace",
      BASHOPTS: "extdebug",
      GCONV_PATH: "/tmp/gconv",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(env.GIT_TRACE).toBeUndefined();
    expect(env.GIT_TRACE2_EVENT).toBeUndefined();
    expect(env.GIT_TRACE_PACKFILE).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_EDITOR).toBeUndefined();
    expect(env.EDITOR).toBeUndefined();
    expect(env.GIT_CONFIG).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS_REQUIRE).toBeUndefined();
    expect(env.GIT_PROXY_COMMAND).toBeUndefined();
    expect(env.GIT_ALLOW_PROTOCOL).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.JAVA_TOOL_OPTIONS).toBeUndefined();
    expect(env.SSLKEYLOGFILE).toBeUndefined();
    expect(env.OPENSSL_CONF).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.DOTNET_STARTUP_HOOKS).toBeUndefined();
    expect(env.PYTHONSTARTUP).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.PERL5OPT).toBeUndefined();
    expect(env.PERL5LIB).toBeUndefined();
    expect(env.RUBYOPT).toBeUndefined();
    expect(env.RUBYLIB).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.ENV).toBeUndefined();
    expect(env.SHELLOPTS).toBeUndefined();
    expect(env.BASHOPTS).toBeUndefined();
    expect(env.GCONV_PATH).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(env.GIT_PAGER).toBe("");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(gitChildEnv({ GIT_NO_LAZY_FETCH: "0", PATH: "/usr/bin" }).GIT_NO_LAZY_FETCH).toBe("1");
    expect(guardedGitArgs(["status"], ["filter.lfs.clean"])).toEqual(
      expect.arrayContaining(["-c", "filter.lfs.clean="]),
    );
  });

  it("does not lazy-fetch a promisor ext:: remote", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-promisor-"));
    const origin = join(tmp, "origin");
    const clone = join(tmp, "clone");
    const marker = join(tmp, "ran");
    const script = join(tmp, "ext.sh");
    mkdirSync(origin);
    writeFileSync(script, `#!/bin/sh\necho RAN >> ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(script, 0o755);
    git(origin, ["init", "-b", "main"]);
    git(origin, ["config", "user.email", "test@example.com"]);
    git(origin, ["config", "user.name", "Test"]);
    writeFileSync(join(origin, "a.txt"), "hello\n");
    git(origin, ["add", "a.txt"]);
    git(origin, ["commit", "-m", "init"]);
    execFileSync("git", ["clone", "--no-local", origin, clone], { cwd: tmp, stdio: "ignore" });
    const blob = execFileSync("git", ["rev-parse", "HEAD:a.txt"], { cwd: clone, encoding: "utf8" }).trim();
    const packDir = execFileSync("git", ["rev-parse", "--git-path", "objects/pack"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const packAbs = packDir.startsWith("/") ? packDir : join(clone, packDir);
    for (const name of readdirSync(packAbs).filter((entry) => entry.endsWith(".pack"))) {
      execFileSync("git", ["unpack-objects"], { cwd: clone, input: readFileSync(join(packAbs, name)) });
    }
    for (const name of readdirSync(packAbs)) rmSync(join(packAbs, name));
    rmSync(join(clone, ".git", "objects", blob.slice(0, 2), blob.slice(2)), { force: true });
    git(clone, ["config", "remote.origin.promisor", "true"]);
    git(clone, ["config", "extensions.partialclone", "origin"]);
    git(clone, ["remote", "set-url", "origin", `ext::${script}`]);
    git(clone, ["config", "protocol.ext.allow", "always"]);

    await getGitStatus(clone);
    await getGitDiff(clone, "a.txt");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not write through an inherited GIT_TRACE sink", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-trace-"));
    const sink = join(tmp, "trace.out");
    git(tmp, ["init"]);
    git(tmp, ["config", "user.email", "test@example.com"]);
    git(tmp, ["config", "user.name", "Test"]);
    writeFileSync(join(tmp, "a.txt"), "one\n");
    git(tmp, ["add", "a.txt"]);
    git(tmp, ["commit", "-m", "init"]);
    writeFileSync(join(tmp, "a.txt"), "two\n");
    const prev = process.env.GIT_TRACE;
    const prevEvent = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE = sink;
    process.env.GIT_TRACE2_EVENT = sink + ".event";
    try {
      await getGitStatus(tmp);
      await getGitDiff(tmp, "a.txt");
    } finally {
      restoreEnv("GIT_TRACE", prev);
      restoreEnv("GIT_TRACE2_EVENT", prevEvent);
    }
    expect(existsSync(sink)).toBe(false);
    expect(existsSync(sink + ".event")).toBe(false);
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

  it("does not run a submodule diff.external helper", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-sub-"));
    const remote = join(tmp, "remote");
    const parent = join(tmp, "parent");
    mkdirSync(remote);
    mkdirSync(parent);
    const marker = join(tmp, "marker");
    const script = join(tmp, "hook.sh");
    writeFileSync(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 0\n`);
    chmodSync(script, 0o755);
    git(remote, ["init"]);
    git(remote, ["config", "user.email", "test@example.com"]);
    git(remote, ["config", "user.name", "Test"]);
    writeFileSync(join(remote, "file.txt"), "sub\n");
    git(remote, ["add", "file.txt"]);
    git(remote, ["commit", "-m", "init"]);
    git(parent, ["init"]);
    git(parent, ["config", "user.email", "test@example.com"]);
    git(parent, ["config", "user.name", "Test"]);
    git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", remote, "child"]);
    git(parent, ["commit", "-m", "add"]);
    git(parent, ["config", "diff.submodule", "diff"]);
    git(join(parent, "child"), ["config", "diff.external", script]);
    writeFileSync(join(parent, "top.txt"), "one\n");
    git(parent, ["add", "top.txt"]);
    git(parent, ["commit", "-m", "top"]);
    writeFileSync(join(parent, "top.txt"), "two\n");
    writeFileSync(join(parent, "child", "file.txt"), "changed\n");
    rmSync(marker, { force: true });

    const diff = await getGitDiff(parent, "top.txt");
    expect(diff.unified).toContain("+two");
    expect(existsSync(marker)).toBe(false);
    const st = await getGitStatus(parent);
    expect(st.files.some((f) => f.path === "top.txt")).toBe(true);
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it("kills a git helper that ignores the deadline", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-hang-"));
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    const fake = join(bin, "git");
    writeFileSync(
      fake,
      "#!/bin/sh\nfor a in \"$@\"; do\n  if [ \"$a\" = config ]; then exit 0; fi\n  if [ \"$a\" = status ] || [ \"$a\" = diff ]; then /bin/sleep 30; fi\ndone\nexit 0\n",
    );
    chmodSync(fake, 0o755);
    const prev = process.env.PATH;
    process.env.PATH = bin;
    try {
      await expect(getGitStatus(tmp, { timeoutMs: 400 })).rejects.toMatchObject({
        code: -32012,
        message: "git timed out",
      });
    } finally {
      if (prev === undefined) delete process.env.PATH;
      else process.env.PATH = prev;
    }
  });

  it("does not run a clean filter from per-worktree config", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-wt-"));
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const marker = join(tmp, "marker");
    const script = join(tmp, "helper.sh");
    const inc = join(tmp, "inc.cfg");
    writeFileSync(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\ncat "$1" 2>/dev/null || cat\n`);
    chmodSync(script, 0o755);
    writeFileSync(inc, `[filter "evil"]\n\tclean = ${script}\n`);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-m", "init"]);
    writeFileSync(join(repo, "a.txt"), "two\n");
    // Same file a linked worktree uses. --local does not list it.
    git(repo, ["config", "extensions.worktreeConfig", "true"]);
    git(repo, ["config", "--worktree", "include.path", inc]);
    writeFileSync(join(repo, ".gitattributes"), "* filter=evil\n");

    rmSync(marker, { force: true });
    const diff = await getGitDiff(repo, "a.txt");
    expect(diff.unified).toContain("+two");
    expect(existsSync(marker)).toBe(false);
    const st = await getGitStatus(repo);
    expect(st.files.some((f) => f.path === "a.txt")).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not let GIT_CONFIG hide a repo clean filter", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-config-env-"));
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const marker = join(tmp, "marker");
    const script = join(tmp, "helper.sh");
    const other = join(tmp, "other.cfg");
    writeFileSync(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\ncat "$1" 2>/dev/null || cat\n`);
    chmodSync(script, 0o755);
    writeFileSync(other, "# not the repo config\n");
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-m", "init"]);
    writeFileSync(join(repo, "a.txt"), "two\n");
    git(repo, ["config", "filter.evil.clean", script]);
    writeFileSync(join(repo, ".gitattributes"), "* filter=evil\n");
    const prev = process.env.GIT_CONFIG;
    process.env.GIT_CONFIG = other;
    try {
      rmSync(marker, { force: true });
      const diff = await getGitDiff(repo, "a.txt");
      expect(diff.unified).toContain("+two");
      expect(existsSync(marker)).toBe(false);
      const st = await getGitStatus(repo);
      expect(st.files.some((f) => f.path === "a.txt")).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      restoreEnv("GIT_CONFIG", prev);
    }
  });

  it("does not run a clean filter pulled in by include.path", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-include-"));
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const marker = join(tmp, "marker");
    const script = join(tmp, "helper.sh");
    const inc = join(tmp, "inc.cfg");
    writeFileSync(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\ncat "$1" 2>/dev/null || cat\n`);
    chmodSync(script, 0o755);
    writeFileSync(inc, `[filter "evil"]\n\tclean = ${script}\n`);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-m", "init"]);
    writeFileSync(join(repo, "a.txt"), "two\n");
    git(repo, ["config", "include.path", inc]);
    writeFileSync(join(repo, ".gitattributes"), "* filter=evil\n");

    rmSync(marker, { force: true });
    const diff = await getGitDiff(repo, "a.txt");
    expect(diff.unified).toContain("+two");
    expect(existsSync(marker)).toBe(false);
    const st = await getGitStatus(repo);
    expect(st.files.some((f) => f.path === "a.txt")).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("ignores GIT_DIR and reports the workspace repo", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-git-dir-"));
    const workspace = join(tmp, "workspace");
    const other = join(tmp, "other");
    mkdirSync(workspace);
    mkdirSync(other);
    for (const dir of [workspace, other]) {
      git(dir, ["init"]);
      git(dir, ["config", "user.email", "test@example.com"]);
      git(dir, ["config", "user.name", "Test"]);
    }
    writeFileSync(join(workspace, "tracked.txt"), "one\n");
    git(workspace, ["add", "tracked.txt"]);
    git(workspace, ["commit", "-m", "init"]);
    writeFileSync(join(workspace, "tracked.txt"), "two\n");
    writeFileSync(join(other, "secret.txt"), "nope\n");
    git(other, ["add", "secret.txt"]);
    git(other, ["commit", "-m", "init"]);
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, ".git");
    try {
      const st = await getGitStatus(workspace);
      expect(st.files.some((f) => f.path === "tracked.txt")).toBe(true);
      expect(st.files.some((f) => f.path === "secret.txt")).toBe(false);
    } finally {
      restoreEnv("GIT_DIR", prev);
    }
  });

  it("returns empty status outside a git repo", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gb-nogit-"));
    mkdirSync(join(tmp, "sub"));
    const st = await getGitStatus(join(tmp, "sub"));
    expect(st).toEqual({ branch: "", ahead: 0, behind: 0, files: [] });
  });
});
