/**
 * Pairing QR / deep-link payload for GradatiON.
 * Format: gradation://pair?url=wss://…&token=…&fp=<sha256 cert>
 */

export interface PairingInfo {
  url: string;
  token: string;
  fingerprintSha256: string;
  /** Machine label shown by GradatiON. Optional; ignored by older apps. */
  name?: string;
}

export function buildPairingPayload(info: PairingInfo): string {
  const params = new URLSearchParams({
    url: info.url,
    token: info.token,
    fp: info.fingerprintSha256,
  });
  if (info.name) params.set("name", info.name);
  return `gradation://pair?${params.toString()}`;
}

/** Lines printed under the pairing link. Host is the bind address. */
export function pairingSafetyLines(host: string): string[] {
  const lines = [
    "  This link is a secret. Anyone with it can run code on this machine.",
    "  In GradatiON, confirm the cert fingerprint before trusting the connection.",
  ];
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    lines.push("  Listening beyond loopback. Prefer --tailscale over a raw LAN bind.");
  }
  return lines;
}

export function printPairingBanner(info: PairingInfo & { host: string; port: number; created: boolean }): void {
  const payload = buildPairingPayload(info);
  const lines = [
    "",
    "══════════════════════════════════════════════════════════════",
    "  gradation-bridge ready",
    "══════════════════════════════════════════════════════════════",
    `  Address : ${info.url}`,
    `  Bind    : ${info.host}:${info.port}`,
    `  Token   : ${info.token}`,
    `  Cert fp : ${info.fingerprintSha256}`,
    "",
    "  Scan / paste this pairing link in GradatiON:",
    `  ${payload}`,
    "",
    ...pairingSafetyLines(info.host),
    "",
  ];
  if (info.created) {
    lines.push("  (token + TLS cert were generated on this first run)");
    lines.push("");
  }
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push("");
  process.stdout.write(lines.join("\n"));
}
