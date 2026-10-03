import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readPrivateNoFollow, writePrivateNoFollow } from "../fs/atomic-write.js";
import { type BridgeConfig, defaultConfig } from "./types.js";

const HarnessSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const ConfigSchema = z
  .object({
    allowedRoots: z.array(z.string()).optional(),
    workspaces: z.array(z.string()).optional(),
    defaultPermissionMode: z.enum(["ask", "auto-edit", "plan", "full-auto"]).optional(),
    harnesses: z.array(HarnessSchema).optional(),
    env: z.record(z.string()).optional(),
    port: z.number().int().positive().max(65535).optional(),
    hostName: z.string().min(1).optional(),
    logLevel: z.enum(["debug", "info", "warn", "error", "silent"]).optional(),
  })
  .strict();

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "gradation-bridge");
  return join(homedir(), ".config", "gradation-bridge");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "gradation-bridge");
  return join(homedir(), ".local", "share", "gradation-bridge");
}

/**
 * Missing is fine. A symlink is refused so `mkdir` and later file IO do not
 * follow a planted config, data, certs, or sessions directory.
 */
export function refuseSymlinkedDir(path: string, label: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`refusing to use a symlinked ${label}`);
  }
}

function mkdirRealDir(path: string, label: string): void {
  const parent = dirname(path);
  if (parent !== path) mkdirSync(parent, { recursive: true, mode: 0o700 });
  refuseSymlinkedDir(path, label);
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function ensureDirs(): void {
  const config = configDir();
  const data = dataDir();
  mkdirRealDir(config, "config directory");
  mkdirRealDir(data, "data directory");
  const certs = join(data, "certs");
  const sessions = join(data, "sessions");
  refuseSymlinkedDir(certs, "certs directory");
  mkdirSync(certs, { recursive: true, mode: 0o700 });
  refuseSymlinkedDir(sessions, "sessions directory");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
}

export function loadConfig(): BridgeConfig {
  ensureDirs();
  const path = configPath();
  let text: string;
  try {
    text = readPrivateNoFollow(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      const cfg = defaultConfig();
      writePrivateNoFollow(path, JSON.stringify(cfg, null, 2) + "\n");
      return cfg;
    }
    throw e;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON in ${path}: ${detail}`);
  }
  const parsed = ConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid config ${path}: ${detail}`);
  }
  const raw = parsed.data;
  const base = defaultConfig();
  return {
    ...base,
    ...raw,
    harnesses: raw.harnesses ?? base.harnesses,
    allowedRoots: raw.allowedRoots ?? base.allowedRoots,
    defaultPermissionMode: raw.defaultPermissionMode ?? base.defaultPermissionMode,
  };
}

export function saveConfig(cfg: BridgeConfig): void {
  ensureDirs();
  writePrivateNoFollow(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}
