import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, ensureDirs } from "../config/load.js";

export interface TlsMaterial {
  keyPath: string;
  certPath: string;
  keyPem: string;
  certPem: string;
  /** SHA-256 fingerprint of the DER cert, lowercase hex (no colons). */
  fingerprintSha256: string;
  created: boolean;
}

function certPaths(): { keyPath: string; certPath: string } {
  const dir = join(dataDir(), "certs");
  return {
    keyPath: join(dir, "server.key"),
    certPath: join(dir, "server.crt"),
  };
}

export function fingerprintOfPem(certPem: string): string {
  const b64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  const der = Buffer.from(b64, "base64");
  return createHash("sha256").update(der).digest("hex");
}

/**
 * SANs for a newly minted self-signed cert. Existing certs are left alone so
 * a paired phone's pinned fingerprint does not change.
 */
export function tlsSubjectAltNames(bindHost?: string): string[] {
  const sans = ["DNS:localhost", "DNS:gradation-bridge", "IP:127.0.0.1", "IP:::1"];
  if (!bindHost || bindHost === "127.0.0.1" || bindHost === "localhost" || bindHost === "::1") {
    return sans;
  }
  if (bindHost.includes(":")) {
    const bare = bindHost.replace(/^\[|\]$/g, "");
    sans.push(`IP:${bare}`);
  } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bindHost)) {
    sans.push(`IP:${bindHost}`);
  } else {
    sans.push(`DNS:${bindHost}`);
  }
  return sans;
}

function opensslArgs(keyPath: string, certPath: string, sans?: string[]): string[] {
  const args = [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "3650",
    "-nodes",
    "-subj",
    "/CN=gradation-bridge",
  ];
  if (sans && sans.length > 0) {
    args.push("-addext", `subjectAltName=${sans.join(",")}`);
  }
  return args;
}

function tryOpensslSelfSigned(keyPath: string, certPath: string, sans: string[]): boolean {
  const attempts = [opensslArgs(keyPath, certPath, sans), opensslArgs(keyPath, certPath)];
  for (const args of attempts) {
    try {
      execFileSync("openssl", args, { stdio: "pipe" });
      try {
        chmodSync(keyPath, 0o600);
        chmodSync(certPath, 0o600);
      } catch {
        // best effort
      }
      return true;
    } catch {
      // retry without SAN; some openssl builds reject -addext
    }
  }
  return false;
}

/**
 * Ensure TLS key+cert exist under the data dir. Prefers openssl for a real
 * self-signed cert (no extra npm deps). Falls back to writing an RSA key and
 * leaving a stub cert marker if openssl is missing.
 */
export function ensureTlsMaterial(opts?: { bindHost?: string }): TlsMaterial {
  ensureDirs();
  const { keyPath, certPath } = certPaths();
  const sans = tlsSubjectAltNames(opts?.bindHost);

  if (existsSync(keyPath) && existsSync(certPath)) {
    const keyPem = readFileSync(keyPath, "utf8");
    const certPem = readFileSync(certPath, "utf8");
    if (certPem.includes("BEGIN CERTIFICATE")) {
      return {
        keyPath,
        certPath,
        keyPem,
        certPem,
        fingerprintSha256: fingerprintOfPem(certPem),
        created: false,
      };
    }
  }

  if (tryOpensslSelfSigned(keyPath, certPath, sans)) {
    const keyPem = readFileSync(keyPath, "utf8");
    const certPem = readFileSync(certPath, "utf8");
    return {
      keyPath,
      certPath,
      keyPem,
      certPem,
      fingerprintSha256: fingerprintOfPem(certPem),
      created: true,
    };
  }

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  const stub =
    "# openssl not found; install openssl and delete this file to mint a self-signed cert\n";
  writeFileSync(certPath, stub, { mode: 0o600 });
  return {
    keyPath,
    certPath,
    keyPem: privateKey,
    certPem: stub,
    fingerprintSha256: createHash("sha256").update(stub).digest("hex"),
    created: true,
  };
}
