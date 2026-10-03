import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindHostCoveredByCert, ensureTlsMaterial, inspectTlsFiles, tlsSubjectAltNames } from "../src/auth/cert.js";

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
    expect(lstatSync(tls.keyPath).isFile()).toBe(true);
    expect(lstatSync(tls.certPath).isFile()).toBe(true);
    expect(lstatSync(tls.keyPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(tls.certPath).isSymbolicLink()).toBe(false);
    const text = execFileSync(
      "openssl",
      ["x509", "-in", tls.certPath, "-noout", "-ext", "subjectAltName"],
      { encoding: "utf8" },
    );
    expect(text).toContain("DNS:localhost");
    expect(text).toContain("IP Address:127.0.0.1");
    expect(text).toContain("IP Address:10.9.8.7");
  });

  it("mints a certificate when OPENSSL_CONF names a missing file", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-cert-conf-"));
    const prevConfig = process.env.XDG_CONFIG_HOME;
    const prevData = process.env.XDG_DATA_HOME;
    const prevOpenssl = process.env.OPENSSL_CONF;
    const prevModules = process.env.OPENSSL_MODULES;
    const prevEngines = process.env.OPENSSL_ENGINES;
    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.OPENSSL_CONF = join(root, "missing.cnf");
    process.env.OPENSSL_MODULES = join(root, "modules");
    process.env.OPENSSL_ENGINES = join(root, "engines");
    mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
    mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
    restores.push(() => {
      if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevConfig;
      if (prevData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevData;
      if (prevOpenssl === undefined) delete process.env.OPENSSL_CONF;
      else process.env.OPENSSL_CONF = prevOpenssl;
      if (prevModules === undefined) delete process.env.OPENSSL_MODULES;
      else process.env.OPENSSL_MODULES = prevModules;
      if (prevEngines === undefined) delete process.env.OPENSSL_ENGINES;
      else process.env.OPENSSL_ENGINES = prevEngines;
    });

    const tls = ensureTlsMaterial({ bindHost: "127.0.0.1" });
    expect(tls.usable).toBe(true);
    expect(tls.certPem).toContain("BEGIN CERTIFICATE");
    expect(tls.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
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

  it("refuses a symlink on server.key or server.crt and does not write through it", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-cert-link-"));
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

    const certDir = join(process.env.XDG_DATA_HOME, "gradation-bridge", "certs");
    mkdirSync(certDir, { recursive: true });
    const keyLeak = join(root, "key-leak.pem");
    const certLeak = join(root, "cert-leak.pem");
    writeFileSync(keyLeak, "SENTINEL-KEY\n");
    writeFileSync(certLeak, "SENTINEL-CERT\n");
    symlinkSync(keyLeak, join(certDir, "server.key"));
    expect(() => ensureTlsMaterial()).toThrow(/symlink/);
    expect(() => inspectTlsFiles()).toThrow(/symlink/);
    expect(readFileSync(keyLeak, "utf8")).toBe("SENTINEL-KEY\n");

    unlinkSync(join(certDir, "server.key"));
    symlinkSync(certLeak, join(certDir, "server.crt"));
    expect(() => ensureTlsMaterial()).toThrow(/symlink/);
    expect(() => inspectTlsFiles()).toThrow(/symlink/);
    expect(readFileSync(certLeak, "utf8")).toBe("SENTINEL-CERT\n");
    expect(readFileSync(keyLeak, "utf8")).toBe("SENTINEL-KEY\n");
  });

  it("refuses a symlink when re-reading an existing key or cert", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-cert-reread-"));
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
    const swappedKey = join(root, "swapped.key");
    writeFileSync(swappedKey, "SWAPPED-KEY\n");
    unlinkSync(tls.keyPath);
    symlinkSync(swappedKey, tls.keyPath);
    expect(() => ensureTlsMaterial()).toThrow(/symlink/);
    expect(() => inspectTlsFiles()).toThrow(/symlink/);
    expect(readFileSync(swappedKey, "utf8")).toBe("SWAPPED-KEY\n");
    expect(readFileSync(tls.certPath, "utf8")).toBe(tls.certPem);

    unlinkSync(tls.keyPath);
    writeFileSync(tls.keyPath, tls.keyPem, { mode: 0o600 });
    const swappedCert = join(root, "swapped.crt");
    writeFileSync(swappedCert, "SWAPPED-CERT\n");
    unlinkSync(tls.certPath);
    symlinkSync(swappedCert, tls.certPath);
    expect(() => ensureTlsMaterial()).toThrow(/symlink/);
    expect(() => inspectTlsFiles()).toThrow(/symlink/);
    expect(readFileSync(swappedCert, "utf8")).toBe("SWAPPED-CERT\n");
    expect(readFileSync(tls.keyPath, "utf8")).toBe(tls.keyPem);
  });

  it("refuses a symlinked certs or data directory and does not write the key there", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-cert-dirlink-"));
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

    const outsideCerts = join(root, "outside-certs");
    mkdirSync(outsideCerts);
    writeFileSync(join(outsideCerts, "server.key"), "SENTINEL-KEY\n");
    writeFileSync(join(outsideCerts, "server.crt"), "SENTINEL-CERT\n");
    const dataRoot = join(process.env.XDG_DATA_HOME, "gradation-bridge");
    mkdirSync(dataRoot, { recursive: true });
    symlinkSync(outsideCerts, join(dataRoot, "certs"));
    expect(() => ensureTlsMaterial()).toThrow(/symlink/);
    expect(() => inspectTlsFiles()).toThrow(/symlink/);
    expect(readFileSync(join(outsideCerts, "server.key"), "utf8")).toBe("SENTINEL-KEY\n");
    expect(readFileSync(join(outsideCerts, "server.crt"), "utf8")).toBe("SENTINEL-CERT\n");
    expect(readdirSync(outsideCerts).sort()).toEqual(["server.crt", "server.key"]);

    unlinkSync(join(dataRoot, "certs"));
    rmSync(dataRoot, { recursive: true, force: true });
    const outsideData = join(root, "outside-data");
    mkdirSync(join(outsideData, "certs"), { recursive: true });
    writeFileSync(join(outsideData, "certs", "server.key"), "DATA-KEY\n");
    symlinkSync(outsideData, dataRoot);
    expect(() => ensureTlsMaterial()).toThrow(/symlink/);
    expect(() => inspectTlsFiles()).toThrow(/symlink/);
    expect(readFileSync(join(outsideData, "certs", "server.key"), "utf8")).toBe("DATA-KEY\n");
    expect(readdirSync(join(outsideData, "certs"))).toEqual(["server.key"]);
  });

  it("refuses a FIFO TLS file instead of blocking on the read", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-cert-fifo-"));
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
    const certDir = join(process.env.XDG_DATA_HOME, "gradation-bridge", "certs");
    mkdirSync(certDir, { recursive: true });
    execFileSync("mkfifo", [join(certDir, "server.crt")]);
    expect(() => inspectTlsFiles()).toThrow(/non-regular/);
    expect(() => ensureTlsMaterial()).toThrow(/non-regular/);
  });
});
