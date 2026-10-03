import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { dataDir, ensureDirs, refuseSymlinkedDir } from "../config/load.js";
import { writePrivateNoFollow } from "../fs/atomic-write.js";
import { harnessChildEnv } from "../session/terminals.js";

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

/** Subject alternative names, or undefined when the PEM is not a certificate. */
export function certSubjectAltName(certPem: string): string | undefined {
  try {
    const name = new X509Certificate(certPem).subjectAltName;
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** What `doctor` and `bridge/diagnostics` may say about TLS. Never includes a token. */
export function tlsDiagnostics(certPem: string | undefined): {
  tls: boolean;
  certFingerprint?: string;
  /** Hosts this cert can serve. A reconnect to any other host fails TLS. */
  certSan?: string;
} {
  if (!certPem || !certPem.includes("BEGIN CERTIFICATE")) return { tls: false };
  const certSan = certSubjectAltName(certPem);
  return {
    tls: true,
    certFingerprint: fingerprintOfPem(certPem),
    ...(certSan ? { certSan } : {}),
  };
}

function tlsSymlinkError(): Error {
  return new Error("refusing to use a symlinked TLS file");
}

function lstatOrMissing(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Data and certs directories are not followed. Missing paths are fine. */
function assertTlsStorage(): void {
  const data = dataDir();
  refuseSymlinkedDir(data, "data directory");
  refuseSymlinkedDir(join(data, "certs"), "certs directory");
}

/**
 * Missing is fine. A symlink or any non-regular file (a FIFO would block
 * the read) on `server.key` or `server.crt` is refused.
 */
function assertTlsPath(path: string): ReturnType<typeof lstatSync> | undefined {
  const info = lstatOrMissing(path);
  if (!info) return undefined;
  if (info.isSymbolicLink()) throw tlsSymlinkError();
  if (!info.isFile()) throw new Error("refusing to use a non-regular TLS file");
  return info;
}

/** Read a freshly minted key or cert. A symlink or non-file is a failed mint. */
function readMintedNoFollow(path: string): string | undefined {
  const info = lstatOrMissing(path);
  if (!info || info.isSymbolicLink() || !info.isFile()) return undefined;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    return readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * A private key other users can read is not safe to keep serving.
 * The certificate may be world-readable. Group and other bits on the key are not.
 */
function assertOwnerOnlyKey(path: string): void {
  const info = lstatOrMissing(path);
  if (!info || info.isSymbolicLink() || !info.isFile()) return;
  if ((Number(info.mode) & 0o077) !== 0) {
    throw new Error(
      `TLS private key is readable by other users (${path}). chmod 600 the file. Refusing to start with a key other accounts can read.`,
    );
  }
}

/** Read a TLS file without following a final-component symlink. */
function readTlsFile(path: string): string {
  if (!assertTlsPath(path)) {
    const err = new Error(`ENOENT: no such file, open '${path}'`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw tlsSymlinkError();
    throw e;
  }
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the on-disk cert without minting a new one.
 * `stub` means the openssl fallback marker, which must not be pinned.
 * A symlink on either path is refused instead of followed.
 */
export function inspectTlsFiles(): {
  certPath: string;
  state: "missing" | "stub" | "incomplete" | "invalid" | "ready";
  fingerprintSha256?: string;
  /** Present when the cert parses. Doctor prints this so a reconnect host can be checked. */
  subjectAltName?: string;
  detail?: string;
} {
  assertTlsStorage();
  const { keyPath, certPath } = certPaths();
  // Check both paths first. A symlinked key must not be ignored just because
  // the certificate file is missing or still the openssl stub.
  assertTlsPath(keyPath);
  if (!assertTlsPath(certPath)) return { certPath, state: "missing" };
  const certPem = readTlsFile(certPath);
  const diag = tlsDiagnostics(certPem);
  if (!diag.tls || !diag.certFingerprint) return { certPath, state: "stub" };
  if (!assertTlsPath(keyPath)) {
    return { certPath, state: "incomplete", detail: "certificate without a private key" };
  }
  assertOwnerOnlyKey(keyPath);
  const problem = tlsPairProblem(readTlsFile(keyPath), certPem);
  if (problem) return { certPath, state: "invalid", detail: problem, ...(diag.certSan ? { subjectAltName: diag.certSan } : {}) };
  return {
    certPath,
    state: "ready",
    fingerprintSha256: diag.certFingerprint,
    ...(diag.certSan ? { subjectAltName: diag.certSan } : {}),
  };
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

/**
 * SHA-256 of the leaf certificate DER, lowercase hex.
 * A PEM chain is more than one certificate. Hashing every block together
 * does not match the leaf the phone sees on the TLS handshake.
 */
export function fingerprintOfPem(certPem: string): string {
  try {
    const fp = new X509Certificate(certPem).fingerprint256;
    if (fp) return fp.replace(/:/g, "").toLowerCase();
  } catch {
    // Not a certificate Node can parse. Callers treat an empty fingerprint
    // as "no pin" only when the PEM has no certificate block at all.
  }
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(certPem);
  if (!match?.[1]) return "";
  const der = Buffer.from(match[1], "base64");
  if (der.length === 0) return "";
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

/** `chmod` follows a symlink. Only a regular file opened with `O_NOFOLLOW` is changed. */
function chmodRegularNoFollow(path: string): void {
  const info = lstatOrMissing(path);
  if (!info || info.isSymbolicLink() || !info.isFile()) return;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return;
  }
  try {
    fchmodSync(fd, 0o600);
  } catch {
    // best effort
  } finally {
    closeSync(fd);
  }
}

function tryOpensslSelfSigned(keyPath: string, certPath: string, sans: string[]): boolean {
  // `openssl -keyout` follows a symlink. Do not start it when one is already there.
  if (lstatOrMissing(keyPath)?.isSymbolicLink() || lstatOrMissing(certPath)?.isSymbolicLink()) {
    return false;
  }
  const attempts = [opensslArgs(keyPath, certPath, sans), opensslArgs(keyPath, certPath)];
  for (const args of attempts) {
    try {
      // Same scrub as harness children. OPENSSL_CONF can load a provider .so
      // during `openssl req`, and LD_PRELOAD would see the new private key.
      execFileSync("openssl", args, { stdio: "pipe", env: harnessChildEnv() });
      chmodRegularNoFollow(keyPath);
      chmodRegularNoFollow(certPath);
      return true;
    } catch {
      // retry without SAN; some openssl builds reject -addext
    }
  }
  return false;
}

/**
 * Mint into a private directory. `openssl -keyout` / `-out` follow a symlink,
 * so those flags never receive `server.key` or `server.crt`.
 */
function mintOpensslMaterial(sans: string[]): { keyPem: string; certPem: string } | undefined {
  assertTlsStorage();
  const scratch = mkdtempSync(join(dataDir(), "certs", ".mint-"));
  try {
    const scratchInfo = lstatSync(scratch);
    if (scratchInfo.isSymbolicLink() || !scratchInfo.isDirectory()) throw tlsSymlinkError();
    const dirFd = openSync(scratch, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
    try {
      fchmodSync(dirFd, 0o700);
    } finally {
      closeSync(dirFd);
    }
    const keyOut = join(scratch, "server.key");
    const certOut = join(scratch, "server.crt");
    if (!tryOpensslSelfSigned(keyOut, certOut, sans)) return undefined;
    const keyPem = readMintedNoFollow(keyOut);
    const certPem = readMintedNoFollow(certOut);
    if (!keyPem || !certPem) return undefined;
    return { keyPem, certPem };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Install key and cert. `O_NOFOLLOW` refuses a symlink on either path. */
function installTlsMaterial(keyPath: string, certPath: string, keyPem: string, certPem: string): void {
  assertTlsStorage();
  assertTlsPath(keyPath);
  assertTlsPath(certPath);
  writePrivateNoFollow(keyPath, keyPem);
  writePrivateNoFollow(certPath, certPem);
}

/**
 * Ensure TLS key+cert exist under the data dir. Prefers openssl for a real
 * self-signed cert (no extra npm deps). Falls back to writing an RSA key and
 * leaving a stub cert marker if openssl is missing.
 */
export function ensureTlsMaterial(opts?: { bindHost?: string }): TlsMaterial {
  ensureDirs();
  assertTlsStorage();
  const { keyPath, certPath } = certPaths();
  const sans = tlsSubjectAltNames(opts?.bindHost);
  const existingCert = assertTlsPath(certPath);
  assertTlsPath(keyPath);

  if (existingCert) {
    const certPem = readTlsFile(certPath);
    if (certPem.includes("BEGIN CERTIFICATE")) {
      if (!assertTlsPath(keyPath)) {
        throw new Error(
          `TLS certificate has no private key (${certPath}). Delete server.crt to mint a new pair. Refusing to replace a cert a phone may already have pinned.`,
        );
      }
      assertOwnerOnlyKey(keyPath);
      const keyPem = readTlsFile(keyPath);
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

  const minted = mintOpensslMaterial(sans);
  if (minted) {
    installTlsMaterial(keyPath, certPath, minted.keyPem, minted.certPem);
    const sanWarning = opts?.bindHost && !bindHostCoveredByCert(minted.certPem, opts.bindHost)
      ? `Cert has no SAN for ${opts.bindHost}. Phones may reject TLS. The pinned cert was left in place.`
      : undefined;
    return {
      keyPath,
      certPath,
      keyPem: minted.keyPem,
      certPem: minted.certPem,
      fingerprintSha256: fingerprintOfPem(minted.certPem),
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
  const stub =
    "# openssl not found; install openssl and delete this file to mint a self-signed cert\n";
  installTlsMaterial(keyPath, certPath, privateKey, stub);
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
