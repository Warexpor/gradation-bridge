/**
 * On-disk session catalog. The JSONL transcript already survives a crash;
 * meta.json is what lets a restarted bridge list the session and respawn the harness.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ToolGrant } from "../approval/grants.js";
import { dataDir } from "../config/load.js";
import { log } from "../log/diagnostics.js";
import { isSafeSessionId } from "./ids.js";

const MAX_RESTORED = 200;

const MetaSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  harness: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  preview: z.string(),
  branch: z.string().optional(),
  status: z.enum(["idle", "running", "needs_approval", "error", "closed"]),
  permissionMode: z.enum(["ask", "auto-edit", "plan", "full-auto"]),
  agentSessionId: z.string().min(1),
  mcpServers: z.array(z.unknown()).optional(),
  sessionModes: z.unknown().optional(),
  configOptions: z.unknown().optional(),
  agentInfo: z
    .object({
      name: z.string(),
      version: z.string().optional(),
    })
    .optional(),
  authMethods: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  grants: z
    .array(
      z.object({
        family: z.enum(["write", "exec"]),
        path: z.string().optional(),
        always: z.boolean(),
      }),
    )
    .optional(),
  additionalDirectories: z.array(z.string()).optional(),
});

export type SessionMeta = z.infer<typeof MetaSchema> & { grants: ToolGrant[] };

export function sessionsRoot(): string {
  return join(dataDir(), "sessions");
}

export function writeSessionMeta(dir: string, meta: SessionMeta): void {
  if (!isSafeSessionId(meta.sessionId)) {
    throw new Error("refusing to persist an unsafe session id");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, "meta.json");
  const tmp = join(dir, `.meta.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(meta) + "\n", { mode: 0o600 });
  renameSync(tmp, dest);
}

/** Newest first. Closed sessions and corrupt files are skipped. */
export function loadPersistedMetas(): SessionMeta[] {
  const root = sessionsRoot();
  if (!existsSync(root)) return [];
  const found: SessionMeta[] = [];
  let skipped = 0;
  for (const name of readdirSync(root)) {
    if (!isSafeSessionId(name)) continue;
    const metaPath = join(root, name, "meta.json");
    if (!existsSync(metaPath)) continue;
    let parsed: z.SafeParseReturnType<unknown, z.infer<typeof MetaSchema>>;
    try {
      parsed = MetaSchema.safeParse(JSON.parse(readFileSync(metaPath, "utf8")));
    } catch {
      skipped++;
      log("warn", `skipping session ${name}: meta.json is not valid JSON`);
      continue;
    }
    if (!parsed.success) {
      skipped++;
      log("warn", `skipping session ${name}: meta.json does not match the session catalog`);
      continue;
    }
    if (parsed.data.sessionId !== name) {
      skipped++;
      log("warn", `skipping session ${name}: meta sessionId does not match the directory`);
      continue;
    }
    if (parsed.data.status === "closed") continue;
    found.push({
      ...parsed.data,
      grants: (parsed.data.grants ?? []) as ToolGrant[],
    });
  }
  found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (found.length > MAX_RESTORED) {
    log("warn", `restoring ${MAX_RESTORED} of ${found.length} persisted sessions`);
  }
  if (skipped > 0) {
    log("info", `skipped ${skipped} unreadable session catalog entries`);
  }
  return found.slice(0, MAX_RESTORED);
}

export function removeSessionStorage(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) return;
  rmSync(join(sessionsRoot(), sessionId), { recursive: true, force: true });
}
