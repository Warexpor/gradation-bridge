/**
 * Approval policy enforced on the bridge (never trust the phone alone).
 *
 * ask       — forward every permission request to the phone
 * auto-edit — auto-allow `edit` kind inside the workspace; otherwise ask
 * plan      — reject all writes / exec
 * full-auto — allow all (caller should warn on the machine the first time)
 *
 * See GradatiON docs/code-mode-plan.md §3.1.5
 */

import { isPathAllowed } from "./sandbox.js";

export type PermissionMode = "ask" | "auto-edit" | "plan" | "full-auto";

/** Descriptions returned by initialize so the phone can label bridge policy. */
export const PERMISSION_MODES: Array<{ id: PermissionMode; name: string; description: string }> = [
  {
    id: "ask",
    name: "Ask",
    description: "Forward each tool approval to the phone. Writes and commands need that approval.",
  },
  {
    id: "auto-edit",
    name: "Auto-edit",
    description: "Allow edits inside the workspace. Commands still need approval.",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Reject writes and commands on the bridge. Reads stay allowed.",
  },
  {
    id: "full-auto",
    name: "Full auto",
    description: "Allow every tool. The machine logs a warning the first time.",
  },
];

/** ACP tool-call / permission kinds we care about for policy. */
export type PermissionKind =
  | "edit"
  | "write"
  | "execute"
  | "exec"
  | "read"
  | "fetch"
  | "other"
  | string;

export type PolicyDecision =
  | { action: "allow"; reason: string }
  | { action: "deny"; reason: string }
  | { action: "ask"; reason: string };

export interface PermissionRequest {
  kind: PermissionKind;
  /** Absolute or session-relative path the tool wants to touch, if any. */
  path?: string;
  /** Session workspace root. */
  workspaceRoot: string;
  /** Configured allowed roots (sandbox). */
  allowedRoots: string[];
}

const WRITE_KINDS = new Set(["edit", "write"]);
const EXEC_KINDS = new Set(["execute", "exec"]);

function normalizeKind(kind: PermissionKind): string {
  return String(kind).toLowerCase();
}

function isWriteKind(kind: string): boolean {
  return WRITE_KINDS.has(kind);
}

function isExecKind(kind: string): boolean {
  return EXEC_KINDS.has(kind);
}

function pathOk(req: PermissionRequest): boolean {
  if (!req.path) {
    // No path: still must have a workspace; treat as "inside" for read-ish,
    // but writes without a path are not auto-allowed.
    return true;
  }
  const roots =
    req.allowedRoots.length > 0 ? req.allowedRoots : [req.workspaceRoot];
  return isPathAllowed(req.path, roots, req.workspaceRoot);
}

/**
 * Decide how to handle a permission request under the given mode.
 */
export function decidePermission(
  mode: PermissionMode,
  req: PermissionRequest,
): PolicyDecision {
  const kind = normalizeKind(req.kind);

  // Sandbox always wins: anything outside allowed roots is denied.
  if (req.path && !pathOk(req)) {
    return { action: "deny", reason: "path outside allowed workspace roots" };
  }

  switch (mode) {
    case "ask":
      return { action: "ask", reason: "ask mode forwards every request" };

    case "auto-edit": {
      if (isWriteKind(kind)) {
        if (!req.path) {
          return { action: "ask", reason: "auto-edit requires a path for edits" };
        }
        if (!pathOk(req)) {
          return { action: "deny", reason: "edit outside workspace" };
        }
        return { action: "allow", reason: "auto-edit allows in-workspace edits" };
      }
      if (isExecKind(kind)) {
        return { action: "ask", reason: "auto-edit still asks for commands" };
      }
      // reads / other: ask to be safe in MVP
      return { action: "ask", reason: "auto-edit asks for non-edit tools" };
    }

    case "plan": {
      if (isWriteKind(kind) || isExecKind(kind)) {
        return { action: "deny", reason: "plan mode rejects writes and exec" };
      }
      // reads are fine without prompting in plan mode
      if (kind === "read") {
        return { action: "allow", reason: "plan mode allows reads" };
      }
      return { action: "ask", reason: "plan mode asks for non-write tools" };
    }

    case "full-auto":
      return { action: "allow", reason: "full-auto allows all" };

    default: {
      const _exhaustive: never = mode;
      void _exhaustive;
      return { action: "ask", reason: "unknown mode; defaulting to ask" };
    }
  }
}

/** Whether the machine should show a one-time warning for this mode. */
export function requiresMachineWarning(mode: PermissionMode): boolean {
  return mode === "full-auto";
}
