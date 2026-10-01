/**
 * One-shot / session grants recorded when the phone approves a tool.
 * fs/write and terminal/create consume these when the mode would otherwise ask,
 * so an agent cannot skip session/request_permission.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { resolveExecutable } from "../harness/path.js";
import { resolveRealPath } from "./sandbox.js";

export type GrantFamily = "write" | "exec";

export interface ToolGrant {
  family: GrantFamily;
  /** Absolute path the approval was for, when the tool named one. */
  path?: string;
  /**
   * For an allow_once exec grant, the command the phone approved.
   * A later terminal call must use that argv. A path matches only when it
   * is the same executable the bridge would run. allow_always is not limited.
   */
  argv?: string[];
  always: boolean;
}

export function grantFamilyForKind(kind: string): GrantFamily | undefined {
  const k = kind.toLowerCase();
  if (k === "edit" || k === "write" || k === "delete" || k === "move") return "write";
  if (k === "execute" || k === "exec") return "exec";
  return undefined;
}

export function resolveGrantPath(path: string | undefined, cwd: string): string | undefined {
  if (!path) return undefined;
  try {
    return resolveRealPath(path, cwd);
  } catch {
    return normalize(isAbsolute(path) ? path : resolve(cwd, path));
  }
}

/**
 * ACP option kinds are allow_once / allow_always / reject_once / reject_always.
 * Any selected kind that names an allow becomes a grant. Rejects do not.
 */
export function grantFromOption(
  optionKind: string | undefined,
  family: GrantFamily | undefined,
  path: string | undefined,
  argv?: string[],
): ToolGrant | undefined {
  if (!optionKind || !family) return undefined;
  const kind = optionKind.toLowerCase();
  if (!kind.includes("allow")) return undefined;
  const always = kind.includes("always");
  const command = family === "exec" && !always ? capArgv(argv) : undefined;
  return {
    family,
    path,
    always,
    ...(command ? { argv: command } : {}),
  };
}

function capArgv(argv: string[] | undefined): string[] | undefined {
  if (!argv || argv.length === 0) return undefined;
  return argv.slice(0, 32).map((arg) => arg.slice(0, 2000));
}

/**
 * A grant with no path covers the family (an allow_always that named no file).
 * A grant with a path covers that path and descendants only. Approving
 * `/proj/a.ts` must not authorize a write of `/proj`.
 */
function samePath(grantPath: string | undefined, opPath: string | undefined): boolean {
  if (!grantPath || !opPath) return true;
  const g = normalize(grantPath);
  const o = normalize(opPath);
  if (g === o) return true;
  const root = g.endsWith(sep) ? g : g + sep;
  const child = o.endsWith(sep) ? o : o + sep;
  return child.startsWith(root);
}

/**
 * Prefer an always-grant so a later allow_once is kept for a different call.
 * Returns true when the operation may proceed.
 */
export function consumeGrant(
  grants: ToolGrant[],
  family: GrantFamily,
  path?: string,
  argv?: string[],
  cwd?: string,
): boolean {
  const root = cwd && cwd.length > 0 ? cwd : process.cwd();
  const matches = (g: ToolGrant, always: boolean) =>
    g.family === family &&
    g.always === always &&
    samePath(g.path, path) &&
    sameArgv(g.argv, argv, always, root);
  if (grants.some((g) => matches(g, true))) return true;
  const idx = grants.findIndex((g) => matches(g, false));
  if (idx < 0) return false;
  grants.splice(idx, 1);
  return true;
}

/**
 * An allow_once that named a command only covers that command.
 * A grant with no argv stays a single blank check for the family.
 * allow_always is not filtered here.
 * `cwd` resolves a relative path the agent passed to terminal/create.
 */
function sameArgv(
  grantArgv: string[] | undefined,
  opArgv: string[] | undefined,
  always: boolean,
  cwd: string,
): boolean {
  if (always || !grantArgv || grantArgv.length === 0) return true;
  if (!opArgv || opArgv.length === 0) return false;
  if (grantArgv.length === opArgv.length && grantArgv.every((arg, i) => arg === opArgv[i])) {
    return true;
  }
  if (
    grantArgv.length === opArgv.length &&
    grantArgv.slice(1).every((arg, i) => arg === opArgv[i + 1]) &&
    commandNamesMatch(grantArgv[0]!, opArgv[0]!, cwd)
  ) {
    return true;
  }
  if (grantArgv.length === 1 && commandTextMatches(grantArgv[0]!, opArgv, cwd)) return true;
  return false;
}

/**
 * The phone may have been shown "npm test" as one string. That still covers
 * argv `["npm", "test"]`, and a path only when it is that same executable.
 */
function commandTextMatches(text: string, opArgv: string[], cwd: string): boolean {
  if (text === opArgv.join(" ")) return true;
  const parts = text.split(" ");
  return (
    parts.length === opArgv.length &&
    parts.slice(1).every((arg, i) => arg === opArgv[i + 1]) &&
    commandNamesMatch(parts[0]!, opArgv[0]!, cwd)
  );
}

/**
 * Bare names with the same spelling are one PATH lookup.
 * A path is that command only when it is the file the bridge would execute.
 */
function commandNamesMatch(grant: string, op: string, cwd: string): boolean {
  if (grant === op) return true;
  const left = basenameOf(grant);
  const right = basenameOf(op);
  if (!left || left !== right) return false;
  if (!hasDirSep(grant) && !hasDirSep(op)) return true;
  const grantFile = resolveExecutable(grant, cwd);
  const opFile = resolveExecutable(op, cwd);
  if (!grantFile || !opFile) return false;
  return sameExecutable(grantFile, opFile);
}

function hasDirSep(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function sameExecutable(a: string, b: string): boolean {
  try {
    const left = realpathSync(a);
    const right = realpathSync(b);
    if (left === right) return true;
    const sa = statSync(left);
    const sb = statSync(right);
    return sa.isFile() && sb.isFile() && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

function basenameOf(command: string): string {
  const parts = command.split(/[/\\]/);
  return parts[parts.length - 1] ?? command;
}
