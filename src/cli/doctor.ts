/**
 * `gradation-bridge doctor` — harness readiness, TLS prerequisites, and
 * pairing safety. Never prints device tokens.
 */

import { join } from "node:path";
import { inspectTlsFiles } from "../auth/cert.js";
import { listDevices } from "../auth/token.js";
import { configPath, dataDir } from "../config/load.js";
import type { BridgeConfig } from "../config/types.js";
import { listHarnesses } from "../harness/registry.js";
import { which } from "../harness/path.js";

export function formatDoctorReport(config: BridgeConfig, version?: string): string {
  const devices = listDevices();
  const active = devices.filter((d) => !d.revokedAt).length;
  const revoked = devices.length - active;
  const tls = inspectTlsFiles();
  const tlsDetail =
    tls.state === "ready"
      ? `ready (${tls.certPath})`
      : tls.state === "stub"
        ? `stub (${tls.certPath}) — not a certificate; install openssl and delete this file`
        : tls.state === "incomplete"
          ? `incomplete (${tls.certPath}) — ${tls.detail ?? "certificate or key is missing"}; delete the remaining file to mint a new pair`
          : tls.state === "invalid"
            ? `invalid (${tls.certPath}) — ${tls.detail ?? "key and certificate do not match"}; delete server.key and server.crt to mint a new pair`
            : `missing (${tls.certPath}) — created on first start when openssl is on PATH`;
  const npx = which("npx");
  const npm = which("npm");
  const lines: string[] = [
    version ? `gradation-bridge doctor (${version})` : "gradation-bridge doctor",
    `config:  ${configPath()}`,
    `data:    ${dataDir()}`,
    `sessions: ${join(dataDir(), "sessions")} (restored on startup; session/delete removes one, including a closed session)`,
    `port:    ${config.port ?? 8787}`,
    `openssl: ${which("openssl") ? "on PATH" : "missing — needed to mint the self-signed cert"}`,
    `npx:     ${npx ? "on PATH" : "missing — on-demand harnesses cannot start"}`,
    `tls:     ${tlsDetail}`,
  ];
  if (tls.fingerprintSha256) {
    lines.push(`cert fp: ${tls.fingerprintSha256}`);
    lines.push(
      `cert san: ${tls.subjectAltName ?? "(none — phones may reject TLS)"}`,
    );
    lines.push(
      "         Reconnect to a host in that SAN with this fingerprint. A different host fails TLS; the pinned cert is not replaced.",
    );
    lines.push("         Compare the fingerprint with GradatiON before trusting the machine. The pairing token is not printed.");
  }
  lines.push(
    `devices: ${active} active, ${revoked} revoked (tokens are not printed)`,
    "",
    "Safety:",
    "- The pairing token can run code on this machine. Do not share the link or screenshot.",
    "- Default bind is 127.0.0.1. --lan and --tailscale expose that token; prefer Tailscale.",
    "- In GradatiON, confirm the cert fingerprint matches this machine before trusting it.",
    "- Plan mode rejects writes and terminal commands on the bridge, not only in the agent.",
    "- Harness env PATH cannot replace the binary. The command is resolved on this process's PATH, then that file is started.",
    "- Harness and terminal children drop blocked host env names (GIT_TRACE*, LD_PRELOAD, NODE_OPTIONS, JAVA_TOOL_OPTIONS, DOTNET_STARTUP_HOOKS, SSLKEYLOGFILE, …).",
    "- Digit-string wire ids (methodId, optionId, sessionId, JSON-RPC id) may arrive as JSON numbers or \"5.0\"; session/* / bridge session methods and harness session/new canonicalize them to the agent-advertised form.",
    "- The harness cannot read or write the config or data directory, even when an allowed root contains them. An approved terminal command can still read files this user can read.",
    "",
    `permission default: ${config.defaultPermissionMode}`,
    `allowed roots: ${config.allowedRoots.length ? config.allowedRoots.join(", ") : "(none — every path is refused)"}`,
    "",
    "Harnesses:",
  );

  const harnesses = listHarnesses(config);
  if (harnesses.length === 0) {
    lines.push("- (none configured)");
  }
  for (const h of harnesses) {
    const args = h.args.length ? ` ${h.args.join(" ")}` : "";
    lines.push(`- ${h.id} (${h.name}) [${h.readiness}] ${h.command}${args}`);
    lines.push(`    ${h.detail}`);
    if (h.notice) lines.push(`    notice: ${h.notice}`);
    const launcherMissing =
      (h.command === "npx" && !npx) || (h.command === "npm" && !npm && !npx);
    if (h.readiness === "on-demand" && launcherMissing) {
      lines.push("    notice: the launcher is not on PATH, so this on-demand harness cannot start");
    }
    if (h.commandPath) lines.push(`    bin: ${h.commandPath}`);
    if (h.readiness !== "ready") lines.push(`    install: ${h.install}`);
    if (h.authHint) lines.push(`    auth: ${h.authHint}`);
  }

  lines.push("");
  return lines.join("\n");
}
