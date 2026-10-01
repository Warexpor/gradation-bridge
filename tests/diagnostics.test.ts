import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatDoctorReport } from "../src/cli/doctor.js";
import { ensurePrimaryToken } from "../src/auth/token.js";
import { log, recentLogs, resetLogsForTests, setLogLevel } from "../src/log/diagnostics.js";
import { buildPairingPayload, pairingSafetyLines } from "../src/auth/pairing.js";

const dirs: string[] = [];
const prevConfig = process.env.XDG_CONFIG_HOME;
const prevData = process.env.XDG_DATA_HOME;

afterEach(() => {
  resetLogsForTests();
  setLogLevel("info");
  if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevConfig;
  if (prevData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevData;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("diagnostics and pairing safety", () => {
  it("redacts tokens and API keys in the log ring", () => {
    setLogLevel("silent");
    log(
      "info",
      "auth failed Bearer abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 TOKEN=sk-abcdefghijklmnopqrstuvwxyz",
    );
    const message = recentLogs()[0]?.message ?? "";
    expect(message).toContain("Bearer [redacted]");
    expect(message).toContain("TOKEN=[redacted]");
    expect(message).not.toContain("sk-abc");
    expect(message).not.toMatch(/[0-9a-f]{64}/i);
  });

  it("doctor output omits device tokens and harness secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-doc-"));
    dirs.push(root);
    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.XDG_DATA_HOME = join(root, "data");
    mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
    mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
    const token = ensurePrimaryToken().token;
    const report = formatDoctorReport({
      allowedRoots: ["/tmp/project"],
      defaultPermissionMode: "ask",
      harnesses: [
        {
          id: "custom",
          name: "Custom",
          command: "my-agent",
          args: ["--api-key", "sk-supersecretvalue"],
        },
      ],
    });
    expect(report).toContain("tokens are not printed");
    expect(report).toContain("[redacted]");
    expect(report).not.toContain(token);
    expect(report).not.toContain("sk-supersecretvalue");
    expect(report).toMatch(/prefer Tailscale/);
  });

  it("pairing payload labels the machine and warns on non-loopback binds", () => {
    const payload = buildPairingPayload({
      url: "wss://100.1.2.3:8787/v1",
      token: "abc",
      fingerprintSha256: "ff",
      name: "dev-box",
    });
    const url = new URL(payload);
    expect(url.protocol).toBe("gradation:");
    expect(url.searchParams.get("name")).toBe("dev-box");
    expect(url.searchParams.get("fp")).toBe("ff");
    expect(pairingSafetyLines("127.0.0.1").join("\n")).not.toMatch(/loopback/);
    expect(pairingSafetyLines("192.168.1.9").join("\n")).toMatch(/beyond loopback/);
  });
});
