import { resolve, normalize, sep, isAbsolute } from "node:path";

/**
 * Workspace sandboxing: refuse paths outside allowed roots.
 * Resolves symlinks are NOT followed here (MVP); callers that touch the
 * filesystem should re-check after realpath.
 */

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

function trailingSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

/** Normalize to an absolute, cleaned path (no .. segments). */
export function normalizePath(path: string, cwd = process.cwd()): string {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  return normalize(abs);
}

/**
 * True if `path` is equal to or strictly inside `root`.
 * Both should already be absolute/normalized.
 */
export function isInsideRoot(path: string, root: string): boolean {
  const p = trailingSep(normalize(path));
  const r = trailingSep(normalize(root));
  // Exact root match: treat root itself as inside.
  if (normalize(path) === normalize(root)) return true;
  return p.startsWith(r);
}

/** True if path is inside at least one allowed root. Empty roots → deny all. */
export function isPathAllowed(path: string, allowedRoots: string[], cwd?: string): boolean {
  if (!allowedRoots || allowedRoots.length === 0) return false;
  const target = normalizePath(path, cwd);
  return allowedRoots.some((root) => isInsideRoot(target, normalizePath(root, cwd)));
}

/**
 * Resolve `path` against `cwd` and assert it lies inside `allowedRoots`.
 * Throws SandboxError otherwise.
 */
export function assertAllowedPath(path: string, allowedRoots: string[], cwd?: string): string {
  const target = normalizePath(path, cwd);
  if (!isPathAllowed(target, allowedRoots, cwd)) {
    throw new SandboxError(`path outside allowed workspace roots: ${target}`);
  }
  return target;
}

/**
 * Assert a session cwd is itself an allowed root (or inside one).
 */
export function assertAllowedWorkspace(cwd: string, allowedRoots: string[]): string {
  return assertAllowedPath(cwd, allowedRoots);
}
