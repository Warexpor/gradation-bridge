import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHarnessLaunch } from "../src/harness/catalog.js";
import { resolveExecutable } from "../src/harness/path.js";
import { describeHarness } from "../src/harness/registry.js";
import { DEFAULT_HARNESSES } from "../src/config/types.js";

const dirs: string[] = [];
const prevPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = prevPath;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function binDir(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "gb-bin-"));
  dirs.push(dir);
  for (const name of names) {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  process.env.PATH = dir;
  return dir;
}

describe("harness launch resolution", () => {
  it("marks npx adapters on-demand and keeps them selectable", () => {
    binDir();
    const claude = DEFAULT_HARNESSES.find((h) => h.id === "claude-code")!;
    const launch = resolveHarnessLaunch(claude);
    expect(launch.command).toBe("npx");
    expect(launch.args).toContain("@agentclientprotocol/claude-agent-acp");
    expect(launch.readiness).toBe("on-demand");
    expect(launch.available).toBe(true);
    expect(launch.authHint).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("notices legacy Zed package names without rewriting them", () => {
    binDir();
    const launch = resolveHarnessLaunch({
      id: "codex",
      name: "Codex CLI",
      command: "npx",
      args: ["-y", "@zed-industries/codex-acp"],
    });
    expect(launch.args).toContain("@zed-industries/codex-acp");
    expect(launch.notice).toMatch(/@agentclientprotocol\/codex-acp/);
  });

  it("prefers cursor-agent when both agent and cursor-agent exist", () => {
    binDir("agent", "cursor-agent");
    const launch = resolveHarnessLaunch({
      id: "cursor-cli",
      name: "Cursor CLI",
      command: "agent",
      args: ["acp"],
    });
    expect(launch.command).toBe("cursor-agent");
    expect(launch.args).toEqual(["acp"]);
    expect(launch.readiness).toBe("ready");
    expect(launch.notice).toMatch(/Grok/);
  });

  it("does not treat a directory named cursor-agent as the CLI", () => {
    const dir = binDir("agent");
    mkdirSync(join(dir, "cursor-agent"));
    const launch = resolveHarnessLaunch({
      id: "cursor-cli",
      name: "Cursor CLI",
      command: "cursor-agent",
      args: ["acp"],
    });
    expect(launch.command).toBe("agent");
    expect(launch.readiness).toBe("ready");
  });

  it("falls back to agent and warns when cursor-agent is absent", () => {
    binDir("agent");
    const launch = resolveHarnessLaunch({
      id: "cursor-cli",
      name: "Cursor CLI",
      command: "cursor-agent",
      args: ["acp"],
    });
    expect(launch.command).toBe("agent");
    expect(launch.detail).toMatch(/may not be Cursor/);
  });

  it("reports cursor missing when neither binary exists", () => {
    binDir();
    const launch = resolveHarnessLaunch({
      id: "cursor-cli",
      name: "Cursor CLI",
      command: "cursor-agent",
      args: ["acp"],
    });
    expect(launch.available).toBe(false);
    expect(launch.readiness).toBe("missing");
    expect(launch.install).toMatch(/cursor.com/);
  });

  it("uses grok on PATH and otherwise npx", () => {
    binDir();
    const missing = resolveHarnessLaunch({
      id: "grok-build",
      name: "Grok Build",
      command: "grok",
      args: ["agent", "stdio"],
    });
    expect(missing.readiness).toBe("on-demand");
    expect(missing.command).toBe("npx");
    expect(missing.args).toContain("@xai-official/grok");

    binDir("grok");
    const ready = resolveHarnessLaunch({
      id: "grok-build",
      name: "Grok Build",
      command: "npx",
      args: ["-y", "@xai-official/grok", "agent", "stdio"],
    });
    expect(ready.command).toBe("grok");
    expect(ready.args).toEqual(["agent", "stdio"]);
    expect(ready.readiness).toBe("ready");
  });

  it("falls OpenCode and Pi back to npx when the binary is absent", () => {
    binDir();
    const opencode = resolveHarnessLaunch({
      id: "opencode",
      name: "OpenCode",
      command: "opencode",
      args: ["acp"],
    });
    expect(opencode.command).toBe("npx");
    expect(opencode.args).toEqual(["-y", "opencode-ai", "acp"]);
    const pi = resolveHarnessLaunch({
      id: "pi",
      name: "Pi",
      command: "pi-acp",
    });
    expect(pi.command).toBe("npx");
    expect(pi.args).toEqual(["-y", "pi-acp"]);
    expect(pi.available).toBe(true);
  });

  it("does not swap a custom missing command for npx", () => {
    binDir();
    const launch = resolveHarnessLaunch({
      id: "opencode",
      name: "OpenCode",
      command: "/opt/opencode",
      args: ["acp"],
    });
    expect(launch.available).toBe(false);
    expect(launch.command).toBe("/opt/opencode");
  });

  it("resolves a bare name on the bridge PATH ahead of an extra PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-resolve-"));
    dirs.push(root);
    const bridge = join(root, "bridge");
    const shadow = join(root, "shadow");
    mkdirSync(bridge);
    mkdirSync(shadow);
    const real = join(bridge, "gb-tool");
    writeFileSync(real, "#!/bin/sh\nexit 0\n");
    chmodSync(real, 0o755);
    writeFileSync(join(shadow, "gb-tool"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(shadow, "gb-tool"), 0o755);
    process.env.PATH = bridge;
    expect(resolveExecutable("gb-tool", root, shadow)).toBe(real);
  });

  it("finds a name that exists only on the extra PATH, against cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-extra-"));
    dirs.push(root);
    const cwd = join(root, "ws");
    const bin = join(cwd, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const tool = join(bin, "gb-only");
    writeFileSync(tool, "#!/bin/sh\nexit 0\n");
    chmodSync(tool, 0o755);
    process.env.PATH = join(root, "empty");
    mkdirSync(process.env.PATH);
    expect(resolveExecutable("gb-only", cwd, "node_modules/.bin")).toBe(tool);
    expect(resolveExecutable("./node_modules/.bin/gb-only", cwd)).toBe(tool);
    expect(resolveExecutable("gb-missing", cwd, "node_modules/.bin")).toBeUndefined();
  });

  it("redacts secrets in the harness description sent to the phone", () => {
    binDir("cursor-agent");
    const info = describeHarness({
      id: "custom",
      name: "Custom",
      command: "cursor-agent",
      args: ["--api-key", "sk-supersecretvalue", "acp"],
      env: { ANTHROPIC_API_KEY: "should-not-leak" },
    });
    expect(info.args).toEqual(["--api-key", "[redacted]", "acp"]);
    expect(JSON.stringify(info)).not.toContain("sk-supersecretvalue");
    expect(JSON.stringify(info)).not.toContain("should-not-leak");
  });
});
