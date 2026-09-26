import { existsSync, realpathSync } from "node:fs";
import { resolve, normalize, sep, isAbsolute, dirname, basename, join } from "node:path";

/**
 * Workspace sandboxing: refuse paths outside allowed roots.
 * Use {@link assertAllowedRealPath} for browse/fs ops so symlink escapes are denied.
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
 * Resolve symlinks for an absolute path. If the path does not exist,
 * realpath the nearest existing ancestor and rejoin the remaining segments.
 */
export function resolveRealPath(path: string, cwd = process.cwd()): string {
  const abs = normalizePath(path, cwd);
  if (existsSync(abs)) {
    return realpathSync(abs);
  }
  const missing: string[] = [];
  let cur = abs;
  while (true) {
    missing.unshift(basename(cur));
    const parent = dirname(cur);
    if (parent === cur) {
      // Hit filesystem root without finding an existing ancestor.
      return abs;
    }
    if (existsSync(parent)) {
      return join(realpathSync(parent), ...missing);
    }
    cur = parent;
  }
}

/**
 * Resolve `path` against `cwd` and assert it lies inside `allowedRoots` (lexical).
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
 * Like {@link assertAllowedPath}, but resolves symlinks via realpath so a link
 * inside an allowed root cannot escape to a target outside.
 * Returns the real (symlink-resolved) absolute path.
 */
export function assertAllowedRealPath(
  path: string,
  allowedRoots: string[],
  cwd?: string,
): string {
  if (!allowedRoots || allowedRoots.length === 0) {
    const target = resolveRealPath(path, cwd);
    throw new SandboxError(`path outside allowed workspace roots: ${target}`);
  }
  const target = resolveRealPath(path, cwd);
  const ok = allowedRoots.some((root) => {
    let realRoot: string;
    try {
      realRoot = resolveRealPath(root, cwd);
    } catch {
      realRoot = normalizePath(root, cwd);
    }
    return isInsideRoot(target, realRoot);
  });
  if (!ok) {
    throw new SandboxError(`path outside allowed workspace roots: ${target}`);
  }
  return target;
}

/**
 * Assert a session cwd is itself an allowed root (or inside one).
 * Uses realpath so a workspace symlink cannot escape allowedRoots.
 */
export function assertAllowedWorkspace(cwd: string, allowedRoots: string[]): string {
  return assertAllowedRealPath(cwd, allowedRoots);
}
