import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

function pathExtensions(): string[] {
  if (process.platform !== "win32") return [""];
  const raw = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const exts = raw.split(";").map((s) => s.trim()).filter(Boolean);
  return ["", ...exts];
}

function canExec(file: string): boolean {
  try {
    // Directories are executable on Unix. A directory named like the CLI
    // must not be reported as the harness binary.
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a command on PATH. Absolute paths are returned when executable. */
export function which(command: string): string | undefined {
  if (!command) return undefined;
  if (command.includes("/") || command.includes("\\")) {
    return canExec(command) ? command : undefined;
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of pathExtensions()) {
      const candidate = join(dir, ext ? command + ext : command);
      if (canExec(candidate)) return candidate;
    }
  }
  return undefined;
}

export function commandExists(command: string): boolean {
  if (command === "npx" || command === "node") return true;
  return which(command) !== undefined;
}

function lookupInPath(command: string, pathEnv: string, cwd: string): string | undefined {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const base = isAbsolute(dir) ? dir : resolve(cwd, dir);
    for (const ext of pathExtensions()) {
      const candidate = join(base, ext ? command + ext : command);
      if (canExec(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Absolute path of the file the bridge will execute.
 * A relative path is resolved against `cwd`. A bare name is resolved on this
 * process's PATH first, so a caller-supplied PATH cannot shadow `git` or `npx`.
 * `extraPath` is searched only when the name is not already on the bridge PATH
 * (a project `node_modules/.bin`, for example).
 */
export function resolveExecutable(
  command: string,
  cwd: string,
  extraPath?: string,
): string | undefined {
  if (!command || command.includes("\0")) return undefined;
  if (command.includes("/") || command.includes("\\")) {
    const abs = isAbsolute(command) ? command : resolve(cwd, command);
    return canExec(abs) ? abs : undefined;
  }
  const trusted = which(command);
  if (trusted) return trusted;
  if (extraPath == null || extraPath === (process.env.PATH ?? "")) return undefined;
  return lookupInPath(command, extraPath, cwd);
}
