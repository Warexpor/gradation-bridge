import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, ensureDirs } from "../config/load.js";

export interface DeviceRecord {
  id: string;
  /** Hex-encoded 32-byte bearer token. */
  token: string;
  label?: string;
  createdAt: string;
  revokedAt?: string;
}

interface DevicesFile {
  devices: DeviceRecord[];
}

function devicesPath(): string {
  return join(configDir(), "devices.json");
}

function loadDevices(): DevicesFile {
  ensureDirs();
  const path = devicesPath();
  if (!existsSync(path)) return { devices: [] };
  return JSON.parse(readFileSync(path, "utf8")) as DevicesFile;
}

function saveDevices(file: DevicesFile): void {
  ensureDirs();
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(devicesPath(), JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

/** Generate a 32-byte token as lowercase hex (64 chars). */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Ensure at least one active device token exists. On first run creates one
 * and returns `{ token, created: true }`.
 */
export function ensurePrimaryToken(): { token: string; deviceId: string; created: boolean } {
  const file = loadDevices();
  const active = file.devices.find((d) => !d.revokedAt);
  if (active) {
    return { token: active.token, deviceId: active.id, created: false };
  }
  const token = generateToken();
  const device: DeviceRecord = {
    id: randomBytes(8).toString("hex"),
    token,
    label: "primary",
    createdAt: new Date().toISOString(),
  };
  file.devices.push(device);
  saveDevices(file);
  return { token, deviceId: device.id, created: true };
}

export function listDevices(): DeviceRecord[] {
  return loadDevices().devices;
}

export function revokeDevice(id: string): boolean {
  const file = loadDevices();
  const d = file.devices.find((x) => x.id === id);
  if (!d || d.revokedAt) return false;
  d.revokedAt = new Date().toISOString();
  saveDevices(file);
  return true;
}

/** Constant-time check against any non-revoked device token. */
export function verifyBearerToken(presented: string | undefined): boolean {
  if (!presented || presented.length === 0) return false;
  const file = loadDevices();
  const active = file.devices.filter((d) => !d.revokedAt);
  const presentedBuf = Buffer.from(presented, "utf8");
  for (const d of active) {
    const expected = Buffer.from(d.token, "utf8");
    if (expected.length !== presentedBuf.length) continue;
    if (timingSafeEqual(expected, presentedBuf)) return true;
  }
  return false;
}

export function parseAuthorizationHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}
