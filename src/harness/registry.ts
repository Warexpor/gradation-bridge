import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import type { BridgeConfig, HarnessConfig } from "../config/types.js";

export interface HarnessInfo {
  id: string;
  name: string;
  available: boolean;
  command: string;
  args: string[];
  models?: string[];
}

const ALIASES: Record<string, string> = {
  claude: "claude-code",
  "claude-code": "claude-code",
};

const require = createRequire(import.meta.url);

function commandExists(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // continue
    }
  }
  // npx ships with npm; available whenever we can run under node.
  if (command === "npx" || command === "node") return true;
  return false;
}

/**
 * Detect / list configured harnesses. MVP: check command on PATH;
 * does not probe whether the ACP subcommand actually works.
 */
export function listHarnesses(config: BridgeConfig): HarnessInfo[] {
  return config.harnesses.filter((h) => h.enabled !== false).map((h) => describeHarness(h));
}

export function describeHarness(h: HarnessConfig): HarnessInfo {
  const args = h.args ?? [];
  const available = commandExists(h.command);
  return {
    id: h.id,
    name: h.name,
    available,
    command: h.command,
    args,
  };
}

export function findHarness(config: BridgeConfig, id: string): HarnessConfig | undefined {
  const normalized = ALIASES[id] ?? id;
  return config.harnesses.find(
    (h) => h.enabled !== false && (h.id === id || h.id === normalized || ALIASES[h.id] === normalized),
  );
}

export function which(command: string): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    return commandExists(command) ? command : undefined;
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return undefined;
}

/** Build a HarnessConfig that launches the in-repo fake ACP agent via tsx. */
export function fakeHarnessConfig(agentScriptPath: string): HarnessConfig {
  // Absolute tsx loader so the child can run with any session cwd.
  let tsxLoader = "tsx";
  try {
    tsxLoader = require.resolve("tsx/esm");
  } catch {
    try {
      tsxLoader = require.resolve("tsx");
    } catch {
      /* bare specifier fallback */
    }
  }
  return {
    id: "fake",
    name: "Fake ACP Agent",
    command: process.execPath,
    args: ["--import", tsxLoader, agentScriptPath],
  };
}
