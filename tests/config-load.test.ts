import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../src/config/load.js";
import { defaultConfig } from "../src/config/types.js";
import { privateWriteTempPath } from "../src/fs/atomic-write.js";

const dirs: string[] = [];
const prevConfig = process.env.XDG_CONFIG_HOME;
const prevData = process.env.XDG_DATA_HOME;

afterEach(() => {
  if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevConfig;
  if (prevData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevData;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function useEnv(): string {
  const root = mkdtempSync(join(tmpdir(), "gb-cfg-"));
  dirs.push(root);
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  return join(process.env.XDG_CONFIG_HOME, "gradation-bridge", "config.json");
}

describe("loadConfig", () => {
  it("writes defaults that name current adapters", () => {
    useEnv();
    const cfg = loadConfig();
    const claude = cfg.harnesses.find((h) => h.id === "claude-code");
    const cursor = cfg.harnesses.find((h) => h.id === "cursor-cli");
    expect(claude?.args).toContain("@agentclientprotocol/claude-agent-acp");
    expect(cursor?.name).toBe("Cursor Agent");
    expect(cursor?.command).toBe("cursor-agent");
    expect(cursor?.args).toEqual(["acp"]);
    const ids = cfg.harnesses.map((h) => h.id);
    expect(ids).toContain("cursor-cli");
    expect(ids).not.toContain("cursor-agent");
    expect(ids).not.toContain("gemini");
  });

  it("rejects an unknown permission mode without replacing the file", () => {
    const path = useEnv();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ defaultPermissionMode: "yolo" }));
    expect(() => loadConfig()).toThrow(/defaultPermissionMode/);
  });

  it("rejects invalid JSON with the config path", () => {
    const path = useEnv();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{");
    expect(() => loadConfig()).toThrow(/Invalid JSON/);
  });

  it("refuses to load a symlinked config.json", () => {
    const path = useEnv();
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true });
    const outside = join(dir, "..", "evil-config.json");
    writeFileSync(outside, JSON.stringify({ port: 9, allowedRoots: ["/"] }));
    symlinkSync(outside, path);
    expect(() => loadConfig()).toThrow(/symlink/);
    expect(JSON.parse(readFileSync(outside, "utf8")).port).toBe(9);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it("refuses a symlink on config.json or its temp file", () => {
    const path = useEnv();
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true });
    const outside = join(dir, "..", "outside-config.json");
    writeFileSync(outside, "KEEP\n");
    symlinkSync(outside, path);
    expect(() => saveConfig(defaultConfig())).toThrow(/symlink/);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("KEEP\n");

    const fresh = useEnv();
    mkdirSync(join(fresh, ".."), { recursive: true });
    const leaked = join(fresh, "..", "..", "leaked-config.json");
    writeFileSync(leaked, "KEEP\n");
    const tempLink = privateWriteTempPath(fresh);
    symlinkSync(leaked, tempLink);
    expect(() => loadConfig()).toThrow(/symlink/);
    expect(lstatSync(tempLink).isSymbolicLink()).toBe(true);
    expect(readFileSync(leaked, "utf8")).toBe("KEEP\n");
  });

  it("refuses a symlinked config directory and does not write through it", () => {
    const path = useEnv();
    const outside = join(path, "..", "..", "outside-bridge-config");
    mkdirSync(outside);
    writeFileSync(join(outside, "config.json"), JSON.stringify({ port: 9, allowedRoots: ["/"] }));
    symlinkSync(outside, dirname(path));
    expect(() => loadConfig()).toThrow(/symlink/);
    expect(() => saveConfig(defaultConfig())).toThrow(/symlink/);
    expect(JSON.parse(readFileSync(join(outside, "config.json"), "utf8")).port).toBe(9);
    expect(lstatSync(dirname(path)).isSymbolicLink()).toBe(true);

    const fresh = useEnv();
    const empty = join(fresh, "..", "..", "empty-bridge-config");
    mkdirSync(empty);
    symlinkSync(empty, dirname(fresh));
    expect(() => loadConfig()).toThrow(/symlink/);
    expect(existsSync(join(empty, "config.json"))).toBe(false);
  });
});
