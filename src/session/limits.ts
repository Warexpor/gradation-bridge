/**
 * Caps for one bridge process. A phone with the pairing token can already
 * start agents; these stop a reconnect loop or a noisy client from filling
 * the disk or the process table.
 */

export const MAX_OPEN_SESSIONS = 32;
export const MAX_LIVE_AGENTS = 8;
export const MAX_CLOSED_SESSIONS = 40;
export const MAX_CATALOG_BYTES = 256 * 1024 * 1024;

export interface SessionLimits {
  maxOpenSessions?: number;
  maxLiveAgents?: number;
  maxClosedSessions?: number;
  maxCatalogBytes?: number;
}

/** Use `fallback` when `value` is missing or below `floor`. */
export function resolveLimit(value: number | undefined, fallback: number, floor = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < floor) return fallback;
  return n;
}
