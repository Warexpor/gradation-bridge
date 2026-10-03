import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
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
  | { ok: false; path: string; symlink: boolean; loose: boolean };

/**
 * A pairing record the bridge can check. Anything else (a null entry, a
 * numeric token from a hand edit) must fail closed. `verifyBearerToken`
 * cannot throw: the ping timer has no try/catch, and a throw takes the
 * process down.
 */
function parseDevice(value: unknown): DeviceRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) return undefined;
  if (typeof row.token !== "string" || row.token.length === 0) return undefined;
  if (row.createdAt != null && typeof row.createdAt !== "string") return undefined;
  if (row.revokedAt != null && typeof row.revokedAt !== "string") return undefined;
  if (row.label != null && typeof row.label !== "string") return undefined;
  const device: DeviceRecord = {
    id: row.id,
    token: row.token,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
  };
  if (typeof row.label === "string") device.label = row.label;
  if (typeof row.revokedAt === "string") device.revokedAt = row.revokedAt;
  return device;
}

function readDevices(): DevicesRead {
  const path = devicesPath();
  try {
    ensureDirs();
  } catch (e) {
    // Fail closed on the upgrade path. A symlinked config directory must not throw.
    if (e instanceof Error && /symlink/i.test(e.message)) {
      return { ok: false, path, symlink: true, loose: false };
    }
    throw e;
  }
  let text: string;
  try {
    text = readPrivateNoFollow(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, file: { devices: [] } };
    const symlink = e instanceof Error && /symlink/i.test(e.message);
    return { ok: false, path, symlink, loose: false };
  }
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    return { ok: false, path, symlink: false, loose: false };
  }
  // Other users who can read this file already have the pairing token.
  if (info.isFile() && (Number(info.mode) & 0o077) !== 0) {
    return { ok: false, path, symlink: false, loose: true };
  }
  try {
    const parsed = JSON.parse(text) as DevicesFile;
    if (!parsed || !Array.isArray(parsed.devices)) return { ok: false, path, symlink: false, loose: false };
    const devices: DeviceRecord[] = [];
    for (const entry of parsed.devices) {
      const device = parseDevice(entry);
      if (!device) return { ok: false, path, symlink: false, loose: false };
      devices.push(device);
    }
    return { ok: true, file: { devices } };
  } catch {
    return { ok: false, path, symlink: false, loose: false };
  }
}

function refuseDevices(read: { path: string; symlink: boolean; loose: boolean }, fallback: string): never {
  if (read.symlink) throw new Error(`refusing to use a symlinked devices file (${read.path})`);
  if (read.loose) {
    throw new Error(
      `devices.json is readable by other users (${read.path}); chmod 600 the file. Refusing to use the pairing token.`,
    );
  }
  throw new Error(`devices.json is corrupt (${read.path}); ${fallback}`);
}

/** SHA-256 then constant-time compare so token length is not a timing oracle. */
function tokenMatches(presented: string, expected: string): boolean {
  if (typeof expected !== "string") return false;
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
