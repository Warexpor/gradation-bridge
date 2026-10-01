import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

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
