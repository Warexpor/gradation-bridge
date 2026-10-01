/**
 * In-memory diagnostic ring plus stderr. GRADATION_LOG or config.logLevel
 * selects the threshold. Messages are redacted before they are stored.
 */

import { redactSecrets } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LogEntry {
  ts: string;
  level: Exclude<LogLevel, "silent">;
  message: string;
}

const buffer: LogEntry[] = [];
const MAX_ENTRIES = 200;
let current: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error" || v === "silent") {
    return v;
  }
  return undefined;
}

export function log(level: Exclude<LogLevel, "silent">, message: string): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    message: redactSecrets(message),
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  if (RANK[level] < RANK[current]) return;
  const line = `${entry.ts} ${level} ${entry.message}\n`;
  process.stderr.write(line);
}

export function recentLogs(): LogEntry[] {
  return buffer.slice();
}

/** Test helper. */
export function resetLogsForTests(): void {
  buffer.length = 0;
}
