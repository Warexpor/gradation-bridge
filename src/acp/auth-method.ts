/**
 * Public view of an agent's authMethods.
 * Terminal `env` is never copied: those values can be secrets, and the phone
 * must not receive them. Terminal methods are also not executed here.
 */

import { BridgeError } from "../errors.js";
import { redactArgs } from "../log/redact.js";
import { wireIdString, wireIdsEqual } from "./wire-id.js";

export interface PublicAuthMethod {
  id: string;
  name: string;
  description?: string;
  type: "agent" | "terminal";
  /** Extra argv for a terminal method. No env. */
  args?: string[];
}

export interface AgentInitInfo {
  agentInfo?: { name: string; version?: string };
  authMethods: PublicAuthMethod[];
  logoutSupported: boolean;
}

const MAX_METHODS = 20;
const MAX_ARGS = 32;

export function readAgentInitialize(result: unknown): AgentInitInfo {
  if (!result || typeof result !== "object") {
    return { authMethods: [], logoutSupported: false };
  }
  const obj = result as Record<string, unknown>;
  return {
    agentInfo: readAgentInfo(obj.agentInfo),
    authMethods: publicAuthMethods(obj.authMethods),
    logoutSupported: readLogout(obj.agentCapabilities),
  };
}

export function assertAgentAuthMethod(methods: PublicAuthMethod[], methodId: string): void {
  const want = wireIdString(methodId) ?? methodId;
  const method = methods.find((entry) => wireIdsEqual(entry.id, want));
  if (!method) {
    throw new BridgeError(-32602, `unknown auth method: ${want}`, { authMethods: methods });
  }
  if (method.type === "terminal") {
    throw new BridgeError(
      -32602,
      "terminal authentication must be completed in a terminal on this machine (see doctor auth hints; the bridge cannot present an interactive TTY)",
      { methodId, type: "terminal", authMethods: methods },
    );
  }
}

function readAgentInfo(info: unknown): { name: string; version?: string } | undefined {
  if (!info || typeof info !== "object") return undefined;
  const rec = info as Record<string, unknown>;
  if (typeof rec.name !== "string" || !rec.name) return undefined;
  return {
    name: rec.name.slice(0, 120),
    ...(typeof rec.version === "string" ? { version: rec.version.slice(0, 40) } : {}),
  };
}

function readLogout(caps: unknown): boolean {
  if (!caps || typeof caps !== "object") return false;
  const auth = (caps as Record<string, unknown>).auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
  const logout = (auth as Record<string, unknown>).logout;
  return logout != null && typeof logout === "object" && !Array.isArray(logout);
}

/** Phone-safe auth methods. Drops env, redacts secret args, and keeps the first id. */
export function publicAuthMethods(raw: unknown): PublicAuthMethod[] {
  if (!Array.isArray(raw)) return [];
  const out: PublicAuthMethod[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_METHODS) break;
    const method = readOneMethod(entry);
    if (!method || seen.has(method.id)) continue;
    seen.add(method.id);
    out.push(method);
  }
  return out;
}

function readOneMethod(entry: unknown): PublicAuthMethod | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const rec = entry as Record<string, unknown>;
  const id = wireIdString(rec.id);
  if (!id || id.length > 120) return undefined;
  const name = typeof rec.name === "string" && rec.name ? rec.name.slice(0, 120) : id;
  const description =
    typeof rec.description === "string" ? rec.description.slice(0, 240) : undefined;
  const base = {
    id,
    name,
    ...(description ? { description } : {}),
  };
  if (rec.type === "terminal") {
    const args = redactArgs(
      (Array.isArray(rec.args) ? rec.args : [])
        .filter((arg): arg is string => typeof arg === "string")
        .slice(0, MAX_ARGS)
        .map((arg) => arg.slice(0, 200)),
    );
    return { ...base, type: "terminal", ...(args.length ? { args } : {}) };
  }
  if (rec.type != null && rec.type !== "agent") return undefined;
  return { ...base, type: "agent" };
}
