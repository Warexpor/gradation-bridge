import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePrimaryToken,
  revokeDevice,
  verifyBearerToken,
} from "../src/auth/token.js";

const restores: Array<() => void> = [];

function withEnv(): string {
  const root = mkdtempSync(join(tmpdir(), "gb-token-"));
  const prevConfig = process.env.XDG_CONFIG_HOME;
  const prevData = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
  restores.push(() => {
    if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevConfig;
    if (prevData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevData;
  });
  return root;
}

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

describe("bearer tokens", () => {
  it("accepts the minted token and rejects a revoked one", () => {
    withEnv();
    const { token, deviceId } = ensurePrimaryToken();
    expect(verifyBearerToken(token)).toBe(true);
    expect(verifyBearerToken(token.slice(0, -1))).toBe(false);
    expect(verifyBearerToken("")).toBe(false);
    expect(revokeDevice(deviceId)).toBe(true);
    expect(verifyBearerToken(token)).toBe(false);
  });

  it("fails closed on a corrupt devices file without replacing it", () => {
    const root = withEnv();
    const path = join(root, "config", "gradation-bridge", "devices.json");
    mkdirSync(join(root, "config", "gradation-bridge"), { recursive: true });
    writeFileSync(path, "{not-json");
    expect(() => ensurePrimaryToken()).toThrow(/corrupt/);
    expect(readFileSync(path, "utf8")).toBe("{not-json");
    expect(verifyBearerToken("anything")).toBe(false);
  });
});
