import type { ChildProcess } from "node:child_process";

/**
 * Signal a child and, on Unix, its process group.
 * Harnesses are spawned detached so `npx` grandchildren die with the agent
 * instead of being reparented when only the direct child is killed.
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  const pid = child.pid;
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Not a process-group leader (or already reaped). Fall through.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}
