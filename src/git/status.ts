/**
 * Sandboxed git status / diff helpers for bridge/gitStatus and bridge/diff.
 * Callers must already ensure `cwd` (and any file path) lie under allowedRoots.
 */

import { execFile } from "node:child_process";
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
 * Repo-local config can name a program (`core.fsmonitor`, `diff.external`).
 * Status and diff are phone-triggered and do not go through approval, so those
 * hooks must not run. `-c` overrides the repo config for this invocation.
 * `diff.external` is disabled with `--no-ext-diff` on the diff command: setting
 * the key to an empty string suppresses the built-in diff as well.
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
];

export function guardedGitArgs(args: string[]): string[] {
  return [...GIT_GUARD, ...args];
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", guardedGitArgs(args), {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      },
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
      ? ["diff", "--no-ext-diff", "HEAD", "--", rel]
      : ["diff", "--no-ext-diff", "HEAD"];
  const { stdout, code } = await git(cwd, args);
  if (code !== 0 && !stdout) return { unified: "" };
  return { unified: stdout };
}
