import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindHostCoveredByCert, ensureTlsMaterial, tlsSubjectAltNames } from "../src/auth/cert.js";

const restores: Array<() => void> = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

describe("tls subject alt names", () => {
  it("includes loopback and the bind host", () => {
    expect(tlsSubjectAltNames("127.0.0.1")).toEqual([
      "DNS:localhost",
      "DNS:gradation-bridge",
      "IP:127.0.0.1",
      "IP:::1",
    ]);
    expect(tlsSubjectAltNames("10.1.2.3")).toContain("IP:10.1.2.3");
    expect(tlsSubjectAltNames("bridge.local")).toContain("DNS:bridge.local");
    expect(tlsSubjectAltNames("[fd7a:115c:a1e0::32]")).toContain("IP:fd7a:115c:a1e0::32");
    const injected = tlsSubjectAltNames("ok.example,DNS:evil.example");
    expect(injected.join(",")).not.toContain("evil.example");
  });

  it("mints a certificate whose SAN covers the bind address", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-cert-"));
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

    const tls = ensureTlsMaterial({ bindHost: "10.9.8.7" });
    expect(tls.usable).toBe(true);
    expect(tls.sanWarning).toBeUndefined();
    expect(tls.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(tls.certPem).toContain("BEGIN CERTIFICATE");
    expect(bindHostCoveredByCert(tls.certPem, "10.9.8.7")).toBe(true);
    expect(bindHostCoveredByCert(tls.certPem, "10.9.8.8")).toBe(false);
    const again = ensureTlsMaterial({ bindHost: "10.9.8.8" });
    expect(again.created).toBe(false);
    expect(again.fingerprintSha256).toBe(tls.fingerprintSha256);
    expect(again.sanWarning).toMatch(/10\.9\.8\.8/);
    expect(readFileSync(tls.certPath, "utf8")).toBe(tls.certPem);
    const text = execFileSync(
      "openssl",
      ["x509", "-in", tls.certPath, "-noout", "-ext", "subjectAltName"],
      { encoding: "utf8" },
    );
    expect(text).toContain("DNS:localhost");
    expect(text).toContain("IP Address:127.0.0.1");
    expect(text).toContain("IP Address:10.9.8.7");
  });

  it("refuses a private key that does not match the certificate", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-cert-mismatch-"));
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
    const tls = ensureTlsMaterial({ bindHost: "127.0.0.1" });
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    writeFileSync(tls.keyPath, privateKey);
    expect(() => ensureTlsMaterial()).toThrow(/does not match/);
    expect(readFileSync(tls.certPath, "utf8")).toBe(tls.certPem);
  });
});
