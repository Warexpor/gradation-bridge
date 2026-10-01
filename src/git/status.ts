/**
 * Sandboxed git status / diff helpers for bridge/gitStatus and bridge/diff.
 * Callers must already ensure `cwd` (and any file path) lie under allowedRoots.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { relative, isAbsolute } from "node:path";

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
];

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
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
]);

/** Child env for git. Drops variables that can name a program or inject config. */
export function gitChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (STRIPPED_GIT_ENV.has(key)) continue;
    if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_PAGER = "";
  return env;
}

function localFilterKeys(cwd: string): { disable: string[]; unsafe: boolean } {
  let text = "";
  try {
    text = execFileSync(
      "git",
      ["--no-pager", "-c", "core.fsmonitor=", "-c", "alias.config=", "config", "--local", "--name-only", "--list"],
      {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: gitChildEnv(),
      },
    );
  } catch (err) {
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
): Promise<{ stdout: string; stderr: string; code: number }> {
  const filters = localFilterKeys(cwd);
  if (filters.unsafe) {
    return { stdout: "", stderr: "", code: 1 };
  }
  try {
    const { stdout, stderr } = await execFileAsync("git", guardedGitArgs(args, filters.disable), {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      encoding: "utf8",
      env: gitChildEnv(),
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (e) {
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
      if (rest.startsWith("HEAD ")) {
        branch = "HEAD";
      } else {
        const tracking = rest.match(
          /^([^\s.]+)(?:\.\.\.(\S+))?(?:\s+\[([^\]]+)\])?/,
        );
        if (tracking) {
          branch = tracking[1] ?? "";
          const bracket = tracking[3] ?? "";
          const aheadM = bracket.match(/ahead\s+(\d+)/);
          const behindM = bracket.match(/behind\s+(\d+)/);
          if (aheadM) ahead = Number(aheadM[1]);
          if (behindM) behind = Number(behindM[1]);
        } else {
          branch = rest.split(/\s/)[0] ?? "";
        }
      }
      continue;
    }
    // XY PATH or XY ORIG -> PATH
    if (line.length < 3) continue;
    const status = line.slice(0, 2);
    let pathPart = line.slice(3);
    if (pathPart.includes(" -> ")) {
      pathPart = pathPart.split(" -> ").pop() ?? pathPart;
    }
    // Unquoted paths; strip surrounding quotes if present
    if (pathPart.startsWith('"') && pathPart.endsWith('"')) {
      pathPart = pathPart.slice(1, -1);
    }
    files.push({ path: pathPart, status });
  }

  return { branch, ahead, behind, files };
}

export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  const { stdout, code } = await git(cwd, ["status", "--porcelain=v1", "-b"]);
  if (code !== 0 && !stdout) {
    return { branch: "", ahead: 0, behind: 0, files: [] };
  }
  return parsePorcelainStatus(stdout);
}

/**
 * Unified diff for one path (working tree + index vs HEAD).
 * `filePath` may be absolute or relative to `cwd`.
 */
export async function getGitDiff(cwd: string, filePath: string): Promise<GitDiffResult> {
  const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
  if (rel.startsWith("..") || rel === "") {
    // Outside cwd or empty — refuse by returning empty (caller should sandbox first)
    if (rel.startsWith("..")) return { unified: "" };
  }
  const args =
    rel && !rel.startsWith("..")
      ? ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", rel]
      : ["diff", "--no-ext-diff", "--no-textconv", "HEAD"];
  const { stdout, code } = await git(cwd, args);
  if (code !== 0 && !stdout) return { unified: "" };
  return { unified: stdout };
}
