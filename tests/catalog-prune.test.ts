import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../src/config/load.js";
import { pruneSessionCatalog, sessionsRoot, writeSessionMeta, type SessionMeta } from "../src/session/persist.js";

const roots: string[] = [];
const prevConfig = process.env.XDG_CONFIG_HOME;
const prevData = process.env.XDG_DATA_HOME;

afterEach(() => {
  if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevConfig;
  if (prevData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevData;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function useDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "gb-prune-"));
  roots.push(root);
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
  ensureDirs();
  return root;
}

function meta(id: string, status: SessionMeta["status"], updatedAt: string): SessionMeta {
  return {
    version: 1,
    sessionId: id,
    harness: "fake",
    cwd: "/tmp/ws",
    title: id,
    createdAt: updatedAt,
    updatedAt,
    preview: "",
    status,
    permissionMode: "ask",
    agentSessionId: id,
    mcpServers: [],
    grants: [],
    additionalDirectories: [],
  };
}

describe("pruneSessionCatalog", () => {
  it("drops the oldest closed session and keeps an open one", () => {
    useDataDir();
    const dir = sessionsRoot();
    writeSessionMeta(join(dir, "old"), meta("old", "closed", "2026-01-01T00:00:00.000Z"));
    writeSessionMeta(join(dir, "new"), meta("new", "closed", "2026-06-01T00:00:00.000Z"));
    writeSessionMeta(join(dir, "open"), meta("open", "idle", "2026-01-01T00:00:00.000Z"));

    const removed = pruneSessionCatalog({
      protectIds: new Set(["open"]),
      maxClosed: 1,
      maxBytes: 256 * 1024 * 1024,
    });
    expect(removed).toEqual(["old"]);
    expect(existsSync(join(dir, "old"))).toBe(false);
    expect(existsSync(join(dir, "new", "meta.json"))).toBe(true);
    expect(existsSync(join(dir, "open", "meta.json"))).toBe(true);
  });

  it("does not delete an open session to satisfy the byte cap", () => {
    useDataDir();
    const dir = sessionsRoot();
    writeSessionMeta(join(dir, "live"), meta("live", "idle", "2026-01-01T00:00:00.000Z"));
    writeFileSync(join(dir, "live", "events.jsonl"), "x".repeat(50_000));
    writeSessionMeta(join(dir, "done"), meta("done", "closed", "2026-01-02T00:00:00.000Z"));

    const removed = pruneSessionCatalog({
      protectIds: new Set(["live"]),
      maxClosed: 40,
      maxBytes: 1000,
    });
    expect(removed).toEqual(["done"]);
    expect(existsSync(join(dir, "live", "events.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "done"))).toBe(false);
  });
});
