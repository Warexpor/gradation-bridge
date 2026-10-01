import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { dataDir, ensureDirs } from "../config/load.js";

export interface TlsMaterial {
  keyPath: string;
  certPath: string;
  keyPem: string;
  certPem: string;
  /** SHA-256 fingerprint of the DER cert, lowercase hex (no colons). Empty when unusable. */
  fingerprintSha256: string;
  /** False for the openssl stub. A mismatched pair throws instead of returning. */
  usable: boolean;
  /** Set when a real cert's SAN does not include the bind host. The cert is not replaced. */
  sanWarning?: string;
  created: boolean;
}

function certPaths(): { keyPath: string; certPath: string } {
  const dir = join(dataDir(), "certs");
  return {
    keyPath: join(dir, "server.key"),
    certPath: join(dir, "server.crt"),
  };
}

/** What `doctor` and `bridge/diagnostics` may say about TLS. Never includes a token. */
export function tlsDiagnostics(certPem: string | undefined): {
  tls: boolean;
  certFingerprint?: string;
} {
  if (!certPem || !certPem.includes("BEGIN CERTIFICATE")) return { tls: false };
  return { tls: true, certFingerprint: fingerprintOfPem(certPem) };
}

/**
 * Read the on-disk cert without minting a new one.
 * `stub` means the openssl fallback marker, which must not be pinned.
 */
export function inspectTlsFiles(): {
  certPath: string;
  state: "missing" | "stub" | "incomplete" | "invalid" | "ready";
  fingerprintSha256?: string;
  detail?: string;
} {
  const { keyPath, certPath } = certPaths();
  if (!existsSync(certPath)) return { certPath, state: "missing" };
  const certPem = readFileSync(certPath, "utf8");
  const diag = tlsDiagnostics(certPem);
  if (!diag.tls || !diag.certFingerprint) return { certPath, state: "stub" };
  if (!existsSync(keyPath)) {
    return { certPath, state: "incomplete", detail: "certificate without a private key" };
  }
  const problem = tlsPairProblem(readFileSync(keyPath, "utf8"), certPem);
  if (problem) return { certPath, state: "invalid", detail: problem };
  return { certPath, state: "ready", fingerprintSha256: diag.certFingerprint };
}

/** Why this key cannot serve this cert, or undefined when the pair matches. */
export function tlsPairProblem(keyPem: string, certPem: string): string | undefined {
  try {
    const cert = new X509Certificate(certPem);
    const key = createPrivateKey(keyPem);
    if (!cert.checkPrivateKey(key)) return "private key does not match the certificate";
    return undefined;
  } catch {
    return "certificate or private key is unreadable";
  }
}

/** True when the cert's SAN matches an IP or DNS bind host. Does not remint. */
export function bindHostCoveredByCert(certPem: string, bindHost: string): boolean {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    return false;
  }
  const bare = bindHost.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return cert.checkIP(bare) != null;
  return cert.checkHost(bare) != null;
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
  if (!bindHost) return sans;
  const bare = bindHost.replace(/^\[|\]$/g, "");
  if (!bare || bare === "127.0.0.1" || bare === "localhost" || bare === "::1") return sans;
  // Only a real IP or a single DNS label list. Commas would inject extra SANs into openssl -addext.
  if (isIP(bare)) {
    sans.push(`IP:${bare}`);
    return sans;
  }
  if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(bare)) {
    sans.push(`DNS:${bare}`);
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

  if (existsSync(certPath)) {
    const certPem = readFileSync(certPath, "utf8");
    if (certPem.includes("BEGIN CERTIFICATE")) {
      if (!existsSync(keyPath)) {
        throw new Error(
          `TLS certificate has no private key (${certPath}). Delete server.crt to mint a new pair. Refusing to replace a cert a phone may already have pinned.`,
        );
      }
      const keyPem = readFileSync(keyPath, "utf8");
      const problem = tlsPairProblem(keyPem, certPem);
      if (problem) {
        throw new Error(
          `TLS ${problem} (${certPath}). Delete server.key and server.crt to mint a new pair. Refusing to start with a cert the phone cannot use.`,
        );
      }
      const sanWarning = opts?.bindHost && !bindHostCoveredByCert(certPem, opts.bindHost)
        ? `Cert has no SAN for ${opts.bindHost}. Phones may reject TLS. The pinned cert was left in place.`
        : undefined;
      return {
        keyPath,
        certPath,
        keyPem,
        certPem,
        fingerprintSha256: fingerprintOfPem(certPem),
        usable: true,
        ...(sanWarning ? { sanWarning } : {}),
        created: false,
      };
    }
  }

  if (tryOpensslSelfSigned(keyPath, certPath, sans)) {
    const keyPem = readFileSync(keyPath, "utf8");
    const certPem = readFileSync(certPath, "utf8");
    const sanWarning = opts?.bindHost && !bindHostCoveredByCert(certPem, opts.bindHost)
      ? `Cert has no SAN for ${opts.bindHost}. Phones may reject TLS. The pinned cert was left in place.`
      : undefined;
    return {
      keyPath,
      certPath,
      keyPem,
      certPem,
      fingerprintSha256: fingerprintOfPem(certPem),
      usable: true,
      ...(sanWarning ? { sanWarning } : {}),
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
    fingerprintSha256: "",
    usable: false,
    created: true,
  };
}
