/**
 * `gradation-bridge doctor` — harness readiness, TLS prerequisites, and
 * pairing safety. Never prints device tokens.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { listDevices } from "../auth/token.js";
import { configPath, dataDir } from "../config/load.js";
import type { BridgeConfig } from "../config/types.js";
import { listHarnesses } from "../harness/registry.js";
import { which } from "../harness/path.js";

export function formatDoctorReport(config: BridgeConfig): string {
  const devices = listDevices();
  const active = devices.filter((d) => !d.revokedAt).length;
  const revoked = devices.length - active;
  const certPath = join(dataDir(), "certs", "server.crt");
  const lines: string[] = [
    "gradation-bridge doctor",
    `config:  ${configPath()}`,
    `data:    ${dataDir()}`,
    `openssl: ${which("openssl") ? "on PATH" : "missing — needed to mint the self-signed cert"}`,
    `tls:     ${existsSync(certPath) ? certPath : "not created yet (created on first start)"}`,
    `devices: ${active} active, ${revoked} revoked (tokens are not printed)`,
    "",
    "Safety:",
    "- The pairing token can run code on this machine. Do not share the link or screenshot.",
    "- Default bind is 127.0.0.1. --lan and --tailscale expose that token; prefer Tailscale.",
    "- In GradatiON, confirm the cert fingerprint matches this machine before trusting it.",
    "- Plan mode rejects writes and terminal commands on the bridge, not only in the agent.",
    "",
    `permission default: ${config.defaultPermissionMode}`,
    `allowed roots: ${config.allowedRoots.length ? config.allowedRoots.join(", ") : "(none — every path is refused)"}`,
    "",
    "Harnesses:",
  ];

  const harnesses = listHarnesses(config);
  if (harnesses.length === 0) {
    lines.push("- (none configured)");
  }
  for (const h of harnesses) {
    const args = h.args.length ? ` ${h.args.join(" ")}` : "";
    lines.push(`- ${h.id} [${h.readiness}] ${h.command}${args}`);
    lines.push(`    ${h.detail}`);
    if (h.notice) lines.push(`    notice: ${h.notice}`);
    if (h.readiness !== "ready") lines.push(`    install: ${h.install}`);
    if (h.authHint) lines.push(`    auth: ${h.authHint}`);
  }

  lines.push("");
  return lines.join("\n");
}
