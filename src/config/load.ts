import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BridgeConfig, defaultConfig } from "./types.js";

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

export function ensureDirs(): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir(), "certs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir(), "sessions"), { recursive: true, mode: 0o700 });
}

export function loadConfig(): BridgeConfig {
  ensureDirs();
  const path = configPath();
  if (!existsSync(path)) {
    const cfg = defaultConfig();
    writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    return cfg;
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeConfig>;
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
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}
