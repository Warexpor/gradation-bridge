/**
 * Sandboxed git status / diff helpers for bridge/gitStatus and bridge/diff.
 * Callers must already ensure `cwd` (and any file path) lie under allowedRoots.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, isAbsolute } from "node:path";
import { isNpmConfigEnv } from "../proc/npm-config-env.js";

const execFileAsync = promisify(execFile);

export interface GitFileStatus {
  path: string;
  status: string;
}

export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface GitDiffResult {
  unified: string;
}

/**
 * Repo-local config can name a program (`core.fsmonitor`, `diff.external`,
 * `diff.*.textconv`, `filter.*.clean`). Status and diff are phone-triggered
 * and do not go through approval, so those helpers must not run.
 * `-c` overrides the repo config for this invocation.
 * `diff.external` is disabled with `--no-ext-diff`: setting that key to an
 * empty string suppresses the built-in diff as well. Textconv is disabled
 * with `--no-textconv` (it still runs under `--no-ext-diff` alone).
 * Clean/smudge/process filters are blanked per key. A filter name that cannot
 * be passed safely as `-c` fails the whole command closed.
 * `alias.status` and `alias.diff` are blanked so a shell alias cannot replace
 * the builtin. `--no-pager` skips `pager.diff` and `core.pager`.
 * `-c` is inherited by submodule git processes. A parent `diff.submodule=diff`
 * otherwise runs the submodule's `diff.external` even when the parent command
 * passed `--no-ext-diff`. Recurse and submodule summary stay off.
 * `include.path` is not visible in `git config --local --list` without
 * `--includes`. Per-worktree config (`extensions.worktreeConfig`,
 * `.git/config.worktree`, including a linked worktree) is not visible with
 * `--local` at all, and those clean filters still run on status and diff.
 * The listing uses `--includes` with no scope so local and worktree keys are
 * both blanked. `GIT_CONFIG` is removed from the child environment first.
 * With it set, `git config --local` errors and an unscoped `git config --list`
 * reads that other file, hiding the repo filters that status and diff still run.
 * `GIT_TRACE*` is removed so a phone-triggered status or diff cannot write
 * (or, on some builds, pipe) through an inherited trace sink.
 * `GIT_NO_LAZY_FETCH` is forced on. A partial clone whose promisor remote is
 * `ext::` (or another helper) and whose repo config sets `protocol.ext.allow`
 * otherwise runs that helper while status or diff reads a missing object.
 * `protocol.allow=never` does not override a more specific `protocol.ext.allow`.
 */
const GIT_GUARD = [
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=",
  "-c",
  "core.sshCommand=",
  "-c",
  "core.pager=",
  "-c",
  "alias.status=",
  "-c",
  "alias.diff=",
  "-c",
  "submodule.recurse=false",
  "-c",
  "status.submoduleSummary=false",
  "-c",
  "diff.submodule=short",
  "-c",
  "diff.ignoreSubmodules=all",
  "-c",
  "fetch.recurseSubmodules=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
];

/** Phone-triggered status and diff must not wait on a stuck index or helper. */
export const GIT_HELPER_TIMEOUT_MS = 20_000;
const MAX_GIT_ACTIVE = 2;
const MAX_GIT_WAITING = 4;

/** `filter.<name>.(clean|smudge|process)` with a token we can pass to `-c`. */
const SAFE_FILTER_KEY = /^filter\.[A-Za-z0-9][A-Za-z0-9.-]*\.(clean|smudge|process)$/;
const FILTER_DRIVER = /^filter\..+\.(clean|smudge|process)$/;

export function partitionFilterKeys(keys: string[]): { disable: string[]; unsafe: boolean } {
  const disable: string[] = [];
  const seen = new Set<string>();
  let unsafe = false;
  for (const raw of keys) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!FILTER_DRIVER.test(key)) continue;
    if (!SAFE_FILTER_KEY.test(key)) {
      unsafe = true;
      continue;
    }
    disable.push(key);
  }
  return { disable, unsafe };
}

export function guardedGitArgs(args: string[], disabledKeys: string[] = []): string[] {
  const disabled: string[] = [];
  for (const key of disabledKeys) {
    disabled.push("-c", `${key}=`);
  }
  return ["--no-pager", ...GIT_GUARD, ...disabled, ...args];
}

const STRIPPED_GIT_ENV = new Set([
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "PAGER",
  "EDITOR",
  "VISUAL",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "GIT_PROXY_COMMAND",
  "GIT_ALLOW_PROTOCOL",
  "GIT_EXEC_PATH",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  // Trace sinks can write (or, on some builds, pipe) to an attacker-chosen path.
  "GIT_TRACE",
  "GIT_TRACE2",
  "GIT_TRACE2_EVENT",
  "GIT_TRACE2_PERF",
  "GIT_TRACE_PACKFILE",
  "GIT_TRACE_PERFORMANCE",
  "GIT_TRACE_SETUP",
  "GIT_TRACE_PACKET",
  "GIT_TRACE_SHALLOW",
  "GIT_TRACE_REFS",
  "GIT_CURL_VERBOSE",
  // Loader / runtime hooks — same class as harness/terminal scrub. Phone-triggered
  // git must not inherit a bridge-process LD_PRELOAD or SSL key log path.
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_PROFILE",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "DOTNET_STARTUP_HOOKS",
  "SSLKEYLOGFILE",
  "OPENSSL_CONF",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  // Interpreter / shell startup hooks — same class as harness/terminal scrub.
  // A phone-triggered git helper must not inherit bridge-process PYTHON*/PERL*/…
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONHOME",
  // site.ENABLE_USER_SITE loads usercustomize.py from this directory.
  "PYTHONUSERBASE",
  "PERL5OPT",
  "PERL5LIB",
  // Older Perl path, same class as PERL5LIB. Not covered by the PERL5* names.
  "PERLLIB",
  "RUBYOPT",
  "RUBYLIB",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  // zsh reads startup files from here instead of $HOME.
  "ZDOTDIR",
  "GCONV_PATH",
]);

/** Child env for git. Drops variables that can name a program or inject config. */
export function gitChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (STRIPPED_GIT_ENV.has(key)) continue;
    if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) continue;
    if (key.startsWith("GIT_TRACE")) continue;
    // Exported bash functions (`BASH_FUNC_foo%%`) are imported by any bash
    // git starts. Terminals already drop this prefix; git must too.
    if (key.startsWith("BASH_FUNC_")) continue;
    // npm_config_* is case-insensitive. A helper must not inherit script-shell.
    if (isNpmConfigEnv(key)) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_PAGER = "";
  // Overrides a host value of 0. Status and diff must not contact a promisor.
  env.GIT_NO_LAZY_FETCH = "1";
  return env;
}

export interface GitHelperOptions {
  timeoutMs?: number;
}

let gitActive = 0;
const gitWaiters: Array<() => void> = [];

function gitResourceError(message: string, reason: string): Error {
  return Object.assign(new Error(message), { code: -32012, data: { reason } });
}

function isGitTimeout(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { killed?: boolean; signal?: string | null; code?: unknown };
  if (e.code === "ETIMEDOUT") return true;
  return e.killed === true && (e.signal === "SIGKILL" || e.signal === "SIGTERM");
}

function acquireGit(): Promise<void> {
  if (gitActive < MAX_GIT_ACTIVE) {
    gitActive += 1;
    return Promise.resolve();
  }
  if (gitWaiters.length >= MAX_GIT_WAITING) {
    return Promise.reject(gitResourceError("git is busy", "git-busy"));
  }
  return new Promise((resolve) => {
    gitWaiters.push(() => {
      gitActive += 1;
      resolve();
    });
  });
}

function releaseGit(): void {
  gitActive = Math.max(0, gitActive - 1);
  const next = gitWaiters.shift();
  if (next) next();
}

async function localFilterKeys(
  cwd: string,
  timeoutMs: number,
): Promise<{ disable: string[]; unsafe: boolean }> {
  let text = "";
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "--no-pager",
        "-c",
        "core.fsmonitor=",
        "-c",
        "alias.config=",
        "config",
        "--includes",
        "--name-only",
        "--list",
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        env: gitChildEnv(),
      },
    );
    text = String(stdout);
  } catch (err) {
    if (isGitTimeout(err)) throw gitResourceError("git timed out", "git-timeout");
    const code = (err as NodeJS.ErrnoException).code;
    const stderr = (err as { stderr?: unknown }).stderr;
    const message = typeof stderr === "string" ? stderr : "";
    if (code === "ENOENT" || /not a git repository/i.test(message)) {
      return { disable: [], unsafe: false };
    }
    // A failed listing must not fall through to a diff that still runs filters.
    return { disable: [], unsafe: true };
  }
  return partitionFilterKeys(text.split("\n"));
}

async function git(
  cwd: string,
  args: string[],
  opts?: GitHelperOptions,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs =
    opts?.timeoutMs != null && opts.timeoutMs > 0 ? opts.timeoutMs : GIT_HELPER_TIMEOUT_MS;
  await acquireGit();
  try {
    const filters = await localFilterKeys(cwd, timeoutMs);
    if (filters.unsafe) {
      return { stdout: "", stderr: "", code: 1 };
    }
    try {
      const { stdout, stderr } = await execFileAsync("git", guardedGitArgs(args, filters.disable), {
        cwd,
        maxBuffer: 20 * 1024 * 1024,
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        env: gitChildEnv(),
      });
      return { stdout: String(stdout), stderr: String(stderr), code: 0 };
    } catch (e) {
      if (isGitTimeout(e)) throw gitResourceError("git timed out", "git-timeout");
      const err = e as {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      return {
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? ""),
        code: typeof err.code === "number" ? err.code : 1,
      };
    }
  } finally {
    releaseGit();
  }
}


const C_QUOTE_SIMPLE: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  '"': 0x22,
};

/**
 * One porcelain path field. Quoted fields follow git's C quoting (octal
 * bytes and simple escapes). The rename separator ` -> ` is only recognized
 * outside quotes, so a name like `foo -> bar.txt` stays intact.
 */
function readPorcelainPath(field: string): { path: string; rest: string } {
  if (field.startsWith('"')) {
    const quoted = readQuotedGitPath(field);
    if (quoted) return quoted;
  }
  const sep = field.indexOf(" -> ");
  if (sep >= 0) return { path: field.slice(0, sep), rest: field.slice(sep) };
  return { path: field, rest: "" };
}

function readQuotedGitPath(field: string): { path: string; rest: string } | undefined {
  const bytes: number[] = [];
  let i = 1;
  while (i < field.length) {
    const ch = field[i]!;
    if (ch === '"') {
      return { path: Buffer.from(bytes).toString("utf8"), rest: field.slice(i + 1) };
    }
    if (ch === "\\" && i + 1 < field.length) {
      const esc = field[i + 1]!;
      const simple = C_QUOTE_SIMPLE[esc];
      if (simple !== undefined) {
        bytes.push(simple);
        i += 2;
        continue;
      }
      if (esc >= "0" && esc <= "7") {
        let val = esc.charCodeAt(0) - 48;
        let consumed = 1;
        while (consumed < 3 && i + 1 + consumed < field.length) {
          const digit = field[i + 1 + consumed]!;
          if (digit < "0" || digit > "7") break;
          val = (val << 3) + (digit.charCodeAt(0) - 48);
          consumed += 1;
        }
        bytes.push(val & 0xff);
        i += 1 + consumed;
        continue;
      }
      bytes.push(esc.charCodeAt(0) & 0xff);
      i += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code <= 0xff) bytes.push(code);
    else for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
    i += 1;
  }
  return undefined;
}

/** Destination path of a rename/copy, or the only path on any other row. */
function porcelainFilePath(field: string): string {
  const first = readPorcelainPath(field);
  if (!first.rest.startsWith(" -> ")) return first.path;
  return readPorcelainPath(first.rest.slice(4)).path;
}

/**
 * Parse `git status --porcelain=v1 -b` output.
 */
export function parsePorcelainStatus(text: string): GitStatusResult {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  let branch = "";
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const rest = line.slice(3);
      // ## HEAD (no branch)
      if (rest === "HEAD" || rest.startsWith("HEAD ")) {
        branch = "HEAD";
        continue;
      }
      // Unborn HEAD. The branch name may contain dots (`release/1.2`).
      const unborn = /^(?:No commits yet on|Initial commit on)\s+(\S+)$/.exec(rest);
      if (unborn) {
        branch = unborn[1] ?? "";
        continue;
      }
      // `branch`, `branch...upstream`, optionally ` [ahead N, behind M]`.
      // Branch names cannot contain `..` or spaces, but they can contain `.`
      // (`feature.2`, `release/1.2.3`). A character class that stops at `.`
      // truncates those and drops the ahead/behind counts.
      let head = rest;
      let bracket = "";
      const bracketAt = rest.lastIndexOf(" [");
      if (bracketAt >= 0 && rest.endsWith("]")) {
        head = rest.slice(0, bracketAt);
        bracket = rest.slice(bracketAt + 2, -1);
      }
      const dots = head.indexOf("...");
      branch = (dots >= 0 ? head.slice(0, dots) : head).trim();
      const aheadM = bracket.match(/ahead\s+(\d+)/);
      const behindM = bracket.match(/behind\s+(\d+)/);
      if (aheadM) ahead = Number(aheadM[1]);
      if (behindM) behind = Number(behindM[1]);
      continue;
    }
    // XY PATH or XY ORIG -> PATH. Paths with spaces, quotes, non-ASCII, or
    // the rename separator are C-quoted (`"foo -> bar.txt"`, `\303\251`).
    // Splitting on ` -> ` before unquoting turns the destination into a
    // fragment such as `bar.txt"`.
    if (line.length < 3) continue;
    const status = line.slice(0, 2);
    const pathPart = porcelainFilePath(line.slice(3));
    if (!pathPart) continue;
    files.push({ path: pathPart, status });
  }

  return { branch, ahead, behind, files };
}

export async function getGitStatus(cwd: string, opts?: GitHelperOptions): Promise<GitStatusResult> {
  // Force quoting so a repo `core.quotePath=false` cannot put a raw newline
  // (or an unquoted ` -> `) into the porcelain stream we parse below.
  const { stdout, code } = await git(
    cwd,
    ["-c", "core.quotePath=true", "status", "--porcelain=v1", "-b", "--ignore-submodules=all"],
    opts,
  );
  if (code !== 0 && !stdout) {
    return { branch: "", ahead: 0, behind: 0, files: [] };
  }
  return parsePorcelainStatus(stdout);
}

/**
 * Unified diff for one path (working tree + index vs HEAD).
 * `filePath` may be absolute or relative to `cwd`.
 */
export async function getGitDiff(
  cwd: string,
  filePath: string,
  opts?: GitHelperOptions,
): Promise<GitDiffResult> {
  const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
  if (rel.startsWith("..") || rel === "") {
    // Outside cwd or empty — refuse by returning empty (caller should sandbox first)
    if (rel.startsWith("..")) return { unified: "" };
  }
  const args =
    rel && !rel.startsWith("..")
      ? ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "HEAD", "--", rel]
      : ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "HEAD"];
  const { stdout, code } = await git(cwd, args, opts);
  if (code !== 0 && !stdout) return { unified: "" };
  return { unified: stdout };
}
