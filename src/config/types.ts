/**
 * Config stored at ~/.config/gradation-bridge/config.json
 * See GradatiON docs/code-mode-plan.md §3.1
 */

import { homedir } from "node:os";

export type PermissionMode = "ask" | "auto-edit" | "plan" | "full-auto";

export interface HarnessConfig {
  /** Stable id, e.g. "claude-code", "codex", "opencode", "grok-build", "cursor-cli", "pi", or custom. */
  id: string;
  name: string;
  /** argv[0]; looked up on PATH unless absolute. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** When false, skip auto-detection / listing. Default true. */
  enabled?: boolean;
}

export interface BridgeConfig {
  /** Allowed workspace roots; paths outside these are refused. */
  allowedRoots: string[];
  /** Recent / favourite workspaces surfaced by bridge/listWorkspaces. */
  workspaces?: string[];
  defaultPermissionMode: PermissionMode;
  harnesses: HarnessConfig[];
  /** Extra env merged into every harness process. */
  env?: Record<string, string>;
  /** TCP port; default 8787. */
  port?: number;
  hostName?: string;
}

export const DEFAULT_HARNESSES: HarnessConfig[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "npx",
    args: ["-y", "@zed-industries/claude-code-acp"],
  },
  {
    id: "codex",
    name: "Codex CLI",
    command: "npx",
    args: ["-y", "@zed-industries/codex-acp"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
  },
  {
    id: "grok-build",
    name: "Grok Build",
    command: "npx",
    args: ["-y", "@xai-official/grok", "agent", "stdio"],
  },
  {
    id: "cursor-cli",
    name: "Cursor CLI",
    command: "agent",
    args: ["acp"],
  },
  {
    id: "pi",
    name: "Pi",
    command: "npx",
    args: ["-y", "pi-acp"],
  },
];

export function defaultConfig(): BridgeConfig {
  const home = homedir();
  return {
    allowedRoots: [home],
    workspaces: [],
    defaultPermissionMode: "ask",
    harnesses: DEFAULT_HARNESSES.map((h) => ({ ...h })),
    port: 8787,
  };
}
