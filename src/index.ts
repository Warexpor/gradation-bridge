#!/usr/bin/env node
/**
 * gradation-bridge — ACP bridge daemon for GradatiON Code mode.
 *
 * Usage:
 *   npx gradation-bridge              # bind 127.0.0.1
 *   npx gradation-bridge --lan        # bind LAN interface
 *   npx gradation-bridge --tailscale  # bind Tailscale IP if present
 *   npx gradation-bridge devices
 *   npx gradation-bridge revoke <id>
 */

import { hostname, networkInterfaces } from "node:os";
import { chooseBindHost, formatListenUrl, isTailscaleAddress, type BindCandidate } from "./net/bind.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureTlsMaterial } from "./auth/cert.js";
import { printPairingBanner } from "./auth/pairing.js";
import {
  ensurePrimaryToken,
  listDevices,
  revokeDevice,
} from "./auth/token.js";
import { formatDoctorReport } from "./cli/doctor.js";
import { ensureDirs, loadConfig } from "./config/load.js";
import { log, parseLogLevel, setLogLevel } from "./log/diagnostics.js";
import { SessionManager } from "./session/manager.js";
import { startBridgeServer } from "./server/ws.js";

const VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/index.js → ../package.json ; src via tsx → ../package.json
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseArgs(argv: string[]): {
  lan: boolean;
  tailscale: boolean;
  port?: number;
  command?: "devices" | "revoke" | "doctor";
  revokeId?: string;
} {
  const out: ReturnType<typeof parseArgs> = { lan: false, tailscale: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--lan") out.lan = true;
    else if (a === "--tailscale") out.tailscale = true;
    else if (a === "--port" && args[i + 1]) {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        process.stderr.write(`Invalid port: ${args[i]}\n`);
        process.exit(2);
      }
      out.port = n;
    } else if (a === "devices") out.command = "devices";
    else if (a === "doctor") out.command = "doctor";
    else if (a === "revoke" && args[i + 1]) {
      out.command = "revoke";
      out.revokeId = args[++i];
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--version" || a === "-v") {
      process.stdout.write(`gradation-bridge ${VERSION}\n`);
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      printHelp();
      process.exit(2);
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`gradation-bridge ${VERSION}

ACP bridge daemon for GradatiON Code mode.

Usage:
  gradation-bridge [--lan | --tailscale] [--port N]
  gradation-bridge doctor
  gradation-bridge devices
  gradation-bridge revoke <deviceId>

Options:
  --lan         Bind to a non-loopback IPv4 address (LAN)
  --tailscale   Bind to a Tailscale (100.64.0.0/10 or fd7a:) address if present
  --port N      Override listen port (default from config, usually 8787)

doctor prints harness readiness and pairing safety without printing tokens.
The pairing link is a secret: anyone with it can run code on this machine.

On first run a 32-byte bearer token and self-signed TLS cert are generated.
Config: ~/.config/gradation-bridge/config.json
`);
}

function pickBindHost(flags: { lan: boolean; tailscale: boolean }): string {
  const candidates: BindCandidate[] = [];
  for (const list of Object.values(networkInterfaces())) {
    if (!list) continue;
    for (const info of list) {
      if (info.family !== "IPv4" && info.family !== "IPv6") continue;
      candidates.push({
        address: info.address,
        family: info.family,
        internal: info.internal,
      });
    }
  }
  const host = chooseBindHost(flags, candidates);
  if (flags.tailscale && !isTailscaleAddress(host)) {
    process.stderr.write("warning: no Tailscale address found; falling back to LAN/loopback\n");
  }
  return host;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv);

  if (flags.command === "devices") {
    ensureDirs();
    const devices = listDevices();
    if (devices.length === 0) {
      process.stdout.write("No devices. Start the bridge once to mint a token.\n");
      return;
    }
    for (const d of devices) {
      const status = d.revokedAt ? `revoked@${d.revokedAt}` : "active";
      process.stdout.write(`${d.id}\t${status}\t${d.label ?? ""}\t${d.createdAt}\n`);
    }
    return;
  }

  if (flags.command === "doctor") {
    ensureDirs();
    const config = loadConfig();
    applyLogLevel(config.logLevel);
    process.stdout.write(formatDoctorReport(config));
    return;
  }

  if (flags.command === "revoke") {
    ensureDirs();
    const ok = revokeDevice(flags.revokeId!);
    process.stdout.write(ok ? `revoked ${flags.revokeId}\n` : `device not found: ${flags.revokeId}\n`);
    process.exit(ok ? 0 : 1);
  }

  ensureDirs();
  const config = loadConfig();
  applyLogLevel(config.logLevel);
  const { token, created: tokenCreated } = ensurePrimaryToken();
  const host = pickBindHost(flags);
  const port = flags.port ?? config.port ?? 8787;
  const tls = ensureTlsMaterial({ bindHost: host });
  const sessions = new SessionManager({ config, version: VERSION });

  const hasRealCert = tls.usable;
  const server = await startBridgeServer({
    host,
    port,
    config,
    sessions,
    tls: hasRealCert ? { keyPem: tls.keyPem, certPem: tls.certPem } : undefined,
    version: VERSION,
  });

  // Prefer advertising the listen host; for loopback, wss://127.0.0.1 works for same-machine tests.
  const scheme = hasRealCert ? "wss" : "ws";
  const advertiseUrl = formatListenUrl(scheme, host, port);

  printPairingBanner({
    url: advertiseUrl,
    token,
    fingerprintSha256: hasRealCert ? tls.fingerprintSha256 : undefined,
    name: config.hostName ?? hostname(),
    host,
    port,
    tlsWarning: tls.sanWarning,
    created: tokenCreated || tls.created,
  });
  log("info", `listening on ${advertiseUrl}`);

  if (!hasRealCert) {
    process.stderr.write(
      "warning: no TLS cert (openssl missing?). Serving plain ws:// — install openssl and delete ~/.local/share/gradation-bridge/certs/server.crt to regenerate.\n",
    );
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write("\nshutting down…\n");
    try {
      await server.close();
    } catch (err) {
      process.stderr.write(
        `shutdown error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function applyLogLevel(configLevel: string | undefined): void {
  const level = parseLogLevel(process.env.GRADATION_LOG) ?? parseLogLevel(configLevel) ?? "info";
  setLogLevel(level);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
