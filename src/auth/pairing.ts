/**
 * Pairing QR / deep-link payload for GradatiON.
 * Format: gradation://pair?url=wss://…&token=…&fp=<sha256 cert>
 */

export interface PairingInfo {
  url: string;
  token: string;
  /** Omitted when TLS is not actually serving a certificate. */
  fingerprintSha256?: string;
  /** Machine label shown by GradatiON. Optional; ignored by older apps. */
  name?: string;
  /** Non-secret warning, for example a bind address missing from the cert SAN. */
  tlsWarning?: string;
}

function pairingLabel(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
}

export function buildPairingPayload(info: PairingInfo): string {
  const params = new URLSearchParams({
    url: info.url,
    token: info.token,
  });
  if (info.fingerprintSha256) params.set("fp", info.fingerprintSha256);
  if (info.name) {
    const label = pairingLabel(info.name);
    if (label) params.set("name", label);
  }
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
    ...(info.fingerprintSha256 ? [`  Cert fp : ${info.fingerprintSha256}`] : []),
    "",
    "  Scan / paste this pairing link in GradatiON:",
    `  ${payload}`,
    "",
    ...pairingSafetyLines(info.host),
    ...(info.fingerprintSha256
      ? []
      : ["  TLS is off, so this link has no cert fingerprint. Install openssl and restart to pin one."]),
    ...(info.tlsWarning ? [`  ${info.tlsWarning}`] : []),
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
