import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { configDir, ensureDirs } from "../config/load.js";
import { readPrivateNoFollow, writePrivateNoFollow } from "../fs/atomic-write.js";

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

type DevicesRead =
  | { ok: true; file: DevicesFile }
  | { ok: false; path: string; symlink: boolean };

function readDevices(): DevicesRead {
  const path = devicesPath();
  try {
    ensureDirs();
  } catch (e) {
    // Fail closed on the upgrade path. A symlinked config directory must not throw.
    if (e instanceof Error && /symlink/i.test(e.message)) {
      return { ok: false, path, symlink: true };
    }
    throw e;
  }
  let text: string;
  try {
    text = readPrivateNoFollow(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, file: { devices: [] } };
    const symlink = e instanceof Error && /symlink/i.test(e.message);
    return { ok: false, path, symlink };
  }
  try {
    const parsed = JSON.parse(text) as DevicesFile;
    if (!parsed || !Array.isArray(parsed.devices)) return { ok: false, path, symlink: false };
    return { ok: true, file: parsed };
  } catch {
    return { ok: false, path, symlink: false };
  }
}

function refuseDevices(read: { path: string; symlink: boolean }, fallback: string): never {
  if (read.symlink) throw new Error(`refusing to use a symlinked devices file (${read.path})`);
  throw new Error(`devices.json is corrupt (${read.path}); ${fallback}`);
}

/** SHA-256 then constant-time compare so token length is not a timing oracle. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function saveDevices(file: DevicesFile): void {
  ensureDirs();
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writePrivateNoFollow(devicesPath(), JSON.stringify(file, null, 2) + "\n");
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
  const read = readDevices();
  if (!read.ok) refuseDevices(read, "refusing to mint a replacement token");
  const file = read.file;
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
  const read = readDevices();
  if (!read.ok) refuseDevices(read, "refusing to continue");
  return read.file.devices;
}

export function revokeDevice(id: string): boolean {
  const read = readDevices();
  if (!read.ok) refuseDevices(read, "refusing to continue");
  const file = read.file;
  const d = file.devices.find((x) => x.id === id);
  if (!d || d.revokedAt) return false;
  d.revokedAt = new Date().toISOString();
  saveDevices(file);
  return true;
}

/** Constant-time check against any non-revoked device token. */
export function verifyBearerToken(presented: string | undefined): boolean {
  if (!presented || presented.length === 0) return false;
  const read = readDevices();
  // Fail closed. Never throw on the upgrade path — a bad devices file must
  // not take down the listener, and must not be overwritten with a new token.
  if (!read.ok) return false;
  const active = read.file.devices.filter((d) => !d.revokedAt);
  for (const d of active) {
    if (tokenMatches(presented, d.token)) return true;
  }
  return false;
}

export function parseAuthorizationHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}
