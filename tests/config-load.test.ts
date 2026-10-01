import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";

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
    expect(cursor?.command).toBe("cursor-agent");
    expect(cfg.harnesses.map((h) => h.id)).not.toContain("gemini");
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
});
