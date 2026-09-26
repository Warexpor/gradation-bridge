/**
 * Pairing QR / deep-link payload for GradatiON.
 * Format: gradation://pair?url=wss://…&token=…&fp=<sha256 cert>
 */

export interface PairingInfo {
  url: string;
  token: string;
  fingerprintSha256: string;
}

export function buildPairingPayload(info: PairingInfo): string {
  const params = new URLSearchParams({
    url: info.url,
    token: info.token,
    fp: info.fingerprintSha256,
  });
  return `gradation://pair?${params.toString()}`;
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
  ];
  if (info.created) {
    lines.push("  (token + TLS cert were generated on this first run)");
    lines.push("");
  }
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push("");
  process.stdout.write(lines.join("\n"));
}
