/**
 * One-shot / session grants recorded when the phone approves a tool.
 * fs/write and terminal/create consume these when the mode would otherwise ask,
 * so an agent cannot skip session/request_permission.
 */

import { isAbsolute, normalize, resolve } from "node:path";
import { resolveRealPath } from "./sandbox.js";

export type GrantFamily = "write" | "exec";

export interface ToolGrant {
  family: GrantFamily;
  /** Absolute path the approval was for, when the tool named one. */
  path?: string;
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
): ToolGrant | undefined {
  if (!optionKind || !family) return undefined;
  const kind = optionKind.toLowerCase();
  if (!kind.includes("allow")) return undefined;
  return {
    family,
    path,
    always: kind.includes("always"),
  };
}

function samePath(grantPath: string | undefined, opPath: string | undefined): boolean {
  if (!grantPath || !opPath) return true;
  const g = normalize(grantPath);
  const o = normalize(opPath);
  if (g === o) return true;
  const root = g.endsWith("/") ? g : g + "/";
  const child = o.endsWith("/") ? o : o + "/";
  return child.startsWith(root) || root.startsWith(child);
}

/**
 * Prefer an always-grant so a later allow_once is kept for a different call.
 * Returns true when the operation may proceed.
 */
export function consumeGrant(
  grants: ToolGrant[],
  family: GrantFamily,
  path?: string,
): boolean {
  const matches = (g: ToolGrant, always: boolean) =>
    g.family === family && g.always === always && samePath(g.path, path);
  if (grants.some((g) => matches(g, true))) return true;
  const idx = grants.findIndex((g) => matches(g, false));
  if (idx < 0) return false;
  grants.splice(idx, 1);
  return true;
}
