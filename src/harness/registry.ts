import { createRequire } from "node:module";
import {
  CURSOR_HARNESS_ALIAS,
  CURSOR_HARNESS_ID,
  type BridgeConfig,
  type HarnessConfig,
} from "../config/types.js";
import { resolveHarnessLaunch, type HarnessLaunch, type HarnessReadiness } from "./catalog.js";
import { which } from "./path.js";

export interface HarnessInfo {
  id: string;
  name: string;
  available: boolean;
  command: string;
  /** Display args (secrets redacted). */
  args: string[];
  readiness: HarnessReadiness;
  detail: string;
  install: string;
  docs?: string;
  authHint?: string;
  notice?: string;
  /** Absolute file that will be spawned, when it is already on PATH. */
  commandPath?: string;
}

const ALIASES: Record<string, string> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  // Cursor Agent. The listed id stays whatever config stored (`cursor-cli` by default).
  [CURSOR_HARNESS_ALIAS]: CURSOR_HARNESS_ID,
  [CURSOR_HARNESS_ID]: CURSOR_HARNESS_ID,
};

export function toPublicHarness(launch: HarnessLaunch): HarnessInfo {
  return {
    id: launch.id,
    name: launch.name,
    available: launch.available,
    command: launch.command,
    args: launch.displayArgs,
    readiness: launch.readiness,
    detail: launch.detail,
    install: launch.install,
    ...(launch.docs ? { docs: launch.docs } : {}),
    ...(launch.authHint ? { authHint: launch.authHint } : {}),
    ...(launch.notice ? { notice: launch.notice } : {}),
    ...(launch.commandPath ? { commandPath: launch.commandPath } : {}),
  };
}

/**
 * Detect / list configured harnesses.
 * `available` is true for ready binaries and for npx on-demand launches.
 * `readiness` says which of those it is. `missing` is not available.
 */
export function listHarnesses(config: BridgeConfig): HarnessInfo[] {
  return config.harnesses.filter((h) => h.enabled !== false).map((h) => describeHarness(h));
}

export function describeHarness(h: HarnessConfig): HarnessInfo {
  return toPublicHarness(resolveHarnessLaunch(h));
}

export function findHarness(config: BridgeConfig, id: string): HarnessConfig | undefined {
  const normalized = ALIASES[id] ?? id;
  return config.harnesses.find(
    (h) => h.enabled !== false && (h.id === id || h.id === normalized || ALIASES[h.id] === normalized),
  );
}

export { which };

const require = createRequire(import.meta.url);

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
