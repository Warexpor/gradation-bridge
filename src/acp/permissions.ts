/**
 * Helpers for ACP session/request_permission: extract policy inputs and
 * pick an optionId when the bridge auto-allows / auto-denies.
 */

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind: string;
}

export interface ToolCallLike {
  toolCallId?: string;
  title?: string | null;
  kind?: string | null;
  locations?: Array<{ path?: string }> | null;
  content?: unknown;
  rawInput?: unknown;
}

export interface RequestPermissionParams {
  sessionId?: string;
  toolCall?: ToolCallLike;
  options?: PermissionOption[];
  title?: string;
  [k: string]: unknown;
}

/** Map ACP ToolKind onto approval-policy kinds (write/edit/exec/read/…). */
export function policyKindFromToolCall(toolCall: ToolCallLike | undefined): string {
  const k = String(toolCall?.kind ?? "other").toLowerCase();
  if (k === "delete" || k === "move") return "write";
  if (k === "execute") return "execute";
  return k;
}

export function pathFromToolCall(toolCall: ToolCallLike | undefined): string | undefined {
  const loc = toolCall?.locations?.find((l) => l?.path);
  if (loc?.path) return loc.path;
  const raw = toolCall?.rawInput;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["path", "file", "filePath", "filename"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
  }
  return undefined;
}

export function pickOptionId(
  options: PermissionOption[] | undefined,
  prefer: "allow" | "reject",
): string | undefined {
  if (!options || options.length === 0) return undefined;
  const order =
    prefer === "allow"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
  for (const kind of order) {
    const hit = options.find((o) => o.kind === kind);
    if (hit) return hit.optionId;
  }
  const needle = prefer === "allow" ? "allow" : "reject";
  const soft = options.find((o) => o.kind.toLowerCase().includes(needle));
  if (soft) return soft.optionId;
  // A deny must not fall through to an allow option. Cancel instead.
  if (prefer === "reject") return undefined;
  return options[0]?.optionId;
}

export function optionKindById(
  options: PermissionOption[] | undefined,
  optionId: string | undefined,
): string | undefined {
  if (!options || optionId == null) return undefined;
  return options.find((o) => o.optionId === optionId)?.kind;
}
