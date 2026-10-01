/**
 * Launch metadata for the built-in harnesses.
 *
 * Defaults follow current ACP adapters. Existing configs that still name the
 * old Zed packages are left alone (spawn uses the configured argv) and get a
 * notice. Cursor prefers `cursor-agent` when both it and `agent` are on PATH:
 * installing Grok can point the bare `agent` name at Grok.
 */

import type { HarnessConfig } from "../config/types.js";
import { redactArgs } from "../log/redact.js";
import { commandExists, which } from "./path.js";

export type HarnessReadiness = "ready" | "missing" | "on-demand";

export interface HarnessLaunch {
  id: string;
  name: string;
  /** argv used to spawn. */
  command: string;
  args: string[];
  /** Args safe to show the phone and `doctor` (secrets removed). */
  displayArgs: string[];
  available: boolean;
  readiness: HarnessReadiness;
  detail: string;
  install: string;
  docs?: string;
  authHint?: string;
  notice?: string;
}

interface Profile {
  install: string;
  docs?: string;
  authHint: string;
}

const PROFILES: Record<string, Profile> = {
  "claude-code": {
    install: "npx -y @agentclientprotocol/claude-agent-acp",
    docs: "https://github.com/agentclientprotocol/claude-agent-acp",
    authHint:
      "Sign in with the Claude CLI, or set ANTHROPIC_API_KEY for the bridge process.",
  },
  codex: {
    install: "npx -y @agentclientprotocol/codex-acp",
    docs: "https://github.com/agentclientprotocol/codex-acp",
    authHint: "Sign in with `codex login`, or set CODEX_API_KEY / OPENAI_API_KEY.",
  },
  opencode: {
    install: "opencode acp  (or npx -y opencode-ai acp)",
    docs: "https://opencode.ai",
    authHint: "Sign in to the providers you use with the OpenCode CLI.",
  },
  "grok-build": {
    install: "grok agent stdio  (or npx -y @xai-official/grok agent stdio)",
    authHint: "Sign in with the Grok CLI, or set XAI_API_KEY.",
  },
  "cursor-cli": {
    install: "Cursor CLI from https://cursor.com/docs/cli/acp (`cursor-agent` or `agent`)",
    docs: "https://cursor.com/docs/cli/acp",
    authHint:
      "Run `cursor-agent login` (or `agent login`). Do not put API keys in harness args; the phone can see those args.",
  },
  pi: {
    install: "npx -y pi-acp",
    docs: "https://github.com/badlogic/pi-mono",
    authHint: "Pi uses the credentials configured for the Pi coding agent.",
  },
};

function sameArgs(actual: string[] | undefined, expected: string[]): boolean {
  const args = actual ?? [];
  return args.length === expected.length && args.every((v, i) => v === expected[i]);
}

function finish(
  h: HarnessConfig,
  partial: Omit<HarnessLaunch, "id" | "name" | "displayArgs" | "install" | "docs" | "authHint"> & {
    install?: string;
    docs?: string;
    authHint?: string;
    notice?: string;
  },
): HarnessLaunch {
  const profile = PROFILES[h.id];
  const notice = partial.notice ?? legacyNotice(h);
  const displayArgs = redactArgs(partial.args);
  return {
    id: h.id,
    name: h.name,
    command: partial.command,
    args: partial.args,
    displayArgs,
    available: partial.available,
    readiness: partial.readiness,
    detail: partial.detail,
    install:
      partial.install ??
      profile?.install ??
      `${partial.command} ${displayArgs.join(" ")}`.trim(),
    docs: partial.docs ?? profile?.docs,
    authHint: partial.authHint ?? profile?.authHint,
    ...(notice ? { notice } : {}),
  };
}

function legacyNotice(h: HarnessConfig): string | undefined {
  const args = h.args ?? [];
  if (h.id === "claude-code" && args.includes("@zed-industries/claude-code-acp")) {
    return "Config still uses @zed-industries/claude-code-acp. The maintained adapter is @agentclientprotocol/claude-agent-acp.";
  }
  if (h.id === "claude-code" && args.includes("@zed-industries/claude-agent-acp")) {
    return "Config uses @zed-industries/claude-agent-acp. The maintained package name is @agentclientprotocol/claude-agent-acp.";
  }
  if (h.id === "codex" && args.includes("@zed-industries/codex-acp")) {
    return "Config still uses @zed-industries/codex-acp. Upstream moved to @agentclientprotocol/codex-acp.";
  }
  return undefined;
}

function isCursorDefault(h: HarnessConfig): boolean {
  if (h.command !== "agent" && h.command !== "cursor-agent") return false;
  const args = h.args ?? [];
  return args.length === 0 || sameArgs(args, ["acp"]);
}

function isGrokDefault(h: HarnessConfig): boolean {
  if (h.command === "grok") {
    const args = h.args ?? [];
    return args.length === 0 || sameArgs(args, ["agent", "stdio"]);
  }
  if (h.command !== "npx") return false;
  const args = h.args ?? [];
  return args.includes("@xai-official/grok") && args.includes("agent") && args.includes("stdio");
}

function isOpenCodeDefault(h: HarnessConfig): boolean {
  if (h.command !== "opencode") return false;
  const args = h.args ?? [];
  return args.length === 0 || sameArgs(args, ["acp"]);
}

function isPiDefault(h: HarnessConfig): boolean {
  if (h.command === "pi-acp") return (h.args ?? []).length === 0;
  return h.command === "npx" && sameArgs(h.args, ["-y", "pi-acp"]);
}

function literal(h: HarnessConfig): HarnessLaunch {
  const args = h.args ?? [];
  if (h.command === "npx" || h.command === "npm") {
    return finish(h, {
      command: h.command,
      args,
      available: true,
      readiness: "on-demand",
      detail: "Launched with npx. The first session downloads the package.",
    });
  }
  if (commandExists(h.command)) {
    return finish(h, {
      command: h.command,
      args,
      available: true,
      readiness: "ready",
      detail: `${h.command} is on PATH.`,
    });
  }
  return finish(h, {
    command: h.command,
    args,
    available: false,
    readiness: "missing",
    detail: `Command not found on PATH: ${h.command}`,
  });
}

function resolveCursor(h: HarnessConfig): HarnessLaunch {
  const cursorAgent = which("cursor-agent");
  const agent = which("agent");
  if (cursorAgent) {
    const ambiguous = Boolean(agent) && h.command === "agent";
    return finish(h, {
      command: "cursor-agent",
      args: ["acp"],
      available: true,
      readiness: "ready",
      detail: ambiguous
        ? "Using cursor-agent. The bare `agent` command can be Grok when both CLIs are installed."
        : "cursor-agent is on PATH.",
      notice: ambiguous
        ? "Preferred cursor-agent over `agent` so a Grok install cannot capture this harness."
        : undefined,
    });
  }
  if (agent) {
    return finish(h, {
      command: "agent",
      args: ["acp"],
      available: true,
      readiness: "ready",
      detail:
        "Found `agent` but not `cursor-agent`. If Grok is installed, `agent` may not be Cursor.",
      notice: "Install the current Cursor CLI so the binary is `cursor-agent`, or set command to an absolute path.",
    });
  }
  return finish(h, {
    command: h.command,
    args: ["acp"],
    available: false,
    readiness: "missing",
    detail: "Neither cursor-agent nor agent is on PATH.",
  });
}

function resolveGrok(h: HarnessConfig): HarnessLaunch {
  if (which("grok")) {
    return finish(h, {
      command: "grok",
      args: ["agent", "stdio"],
      available: true,
      readiness: "ready",
      detail: "grok is on PATH.",
    });
  }
  return finish(h, {
    command: "npx",
    args: ["-y", "@xai-official/grok", "agent", "stdio"],
    available: true,
    readiness: "on-demand",
    detail: "grok is not on PATH. The first session runs npx @xai-official/grok.",
  });
}

function resolveOpenCode(h: HarnessConfig): HarnessLaunch {
  if (which("opencode")) {
    return finish(h, {
      command: "opencode",
      args: ["acp"],
      available: true,
      readiness: "ready",
      detail: "opencode is on PATH.",
    });
  }
  return finish(h, {
    command: "npx",
    args: ["-y", "opencode-ai", "acp"],
    available: true,
    readiness: "on-demand",
    detail: "opencode is not on PATH. The first session runs npx opencode-ai.",
  });
}

function resolvePi(h: HarnessConfig): HarnessLaunch {
  if (which("pi-acp")) {
    return finish(h, {
      command: "pi-acp",
      args: [],
      available: true,
      readiness: "ready",
      detail: "pi-acp is on PATH.",
    });
  }
  return finish(h, {
    command: "npx",
    args: ["-y", "pi-acp"],
    available: true,
    readiness: "on-demand",
    detail: "pi-acp is not on PATH. The first session runs npx pi-acp.",
  });
}

export function resolveHarnessLaunch(h: HarnessConfig): HarnessLaunch {
  if (h.id === "cursor-cli" && isCursorDefault(h)) return resolveCursor(h);
  if (h.id === "grok-build" && isGrokDefault(h)) return resolveGrok(h);
  if (h.id === "opencode" && isOpenCodeDefault(h)) return resolveOpenCode(h);
  if (h.id === "pi" && isPiDefault(h)) return resolvePi(h);
  return literal(h);
}

/** Fields safe to put in a JSON-RPC error `data` object. */
export function launchErrorData(
  launch: HarnessLaunch,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    harnessId: launch.id,
    command: launch.command,
    args: launch.displayArgs,
    readiness: launch.readiness,
    detail: launch.detail,
    install: launch.install,
    ...(launch.docs ? { docs: launch.docs } : {}),
    ...(launch.authHint ? { authHint: launch.authHint } : {}),
    ...(launch.notice ? { notice: launch.notice } : {}),
    ...extra,
  };
}
