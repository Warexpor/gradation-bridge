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

import { networkInterfaces } from "node:os";
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
import { ensureDirs, loadConfig } from "./config/load.js";
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
  command?: "devices" | "revoke";
  revokeId?: string;
} {
  const out: ReturnType<typeof parseArgs> = { lan: false, tailscale: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--lan") out.lan = true;
    else if (a === "--tailscale") out.tailscale = true;
    else if (a === "--port" && args[i + 1]) {
      out.port = Number(args[++i]);
    } else if (a === "devices") out.command = "devices";
    else if (a === "revoke" && args[i + 1]) {
      out.command = "revoke";
      out.revokeId = args[++i];
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--version" || a === "-v") {
      process.stdout.write(`gradation-bridge ${VERSION}\n`);
      process.exit(0);
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`gradation-bridge ${VERSION}

ACP bridge daemon for GradatiON Code mode.

Usage:
  gradation-bridge [--lan | --tailscale] [--port N]
  gradation-bridge devices
  gradation-bridge revoke <deviceId>

Options:
  --lan         Bind to a non-loopback IPv4 address (LAN)
  --tailscale   Bind to a Tailscale (100.x / fd7a:) address if present
  --port N      Override listen port (default from config, usually 8787)

On first run a 32-byte bearer token and self-signed TLS cert are generated.
Config: ~/.config/gradation-bridge/config.json
`);
}

function pickBindHost(flags: { lan: boolean; tailscale: boolean }): string {
  if (!flags.lan && !flags.tailscale) return "127.0.0.1";
  const ifaces = networkInterfaces();
  const candidates: { address: string; kind: "tailscale" | "lan" }[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.internal) continue;
      if (info.family !== "IPv4") continue;
      const addr = info.address;
      if (addr.startsWith("100.")) {
        candidates.push({ address: addr, kind: "tailscale" });
      } else {
        candidates.push({ address: addr, kind: "lan" });
      }
    }
  }
  if (flags.tailscale) {
    const ts = candidates.find((c) => c.kind === "tailscale");
    if (ts) return ts.address;
    process.stderr.write("warning: no Tailscale IPv4 found; falling back to LAN/loopback\n");
  }
  if (flags.lan || flags.tailscale) {
    const lan = candidates.find((c) => c.kind === "lan");
    if (lan) return lan.address;
  }
  return "127.0.0.1";
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

  if (flags.command === "revoke") {
    ensureDirs();
    const ok = revokeDevice(flags.revokeId!);
    process.stdout.write(ok ? `revoked ${flags.revokeId}\n` : `device not found: ${flags.revokeId}\n`);
    process.exit(ok ? 0 : 1);
  }

  ensureDirs();
  const config = loadConfig();
  const { token, created: tokenCreated } = ensurePrimaryToken();
  const tls = ensureTlsMaterial();
  const host = pickBindHost(flags);
  const port = flags.port ?? config.port ?? 8787;
  const sessions = new SessionManager({ config, version: VERSION });

  const hasRealCert = tls.certPem.includes("BEGIN CERTIFICATE");
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
  const advertiseUrl = `${scheme}://${host}:${port}/v1`;

  printPairingBanner({
    url: advertiseUrl,
    token,
    fingerprintSha256: tls.fingerprintSha256,
    host,
    port,
    created: tokenCreated || tls.created,
  });

  if (!hasRealCert) {
    process.stderr.write(
      "warning: no TLS cert (openssl missing?). Serving plain ws:// — install openssl and delete ~/.local/share/gradation-bridge/certs/server.crt to regenerate.\n",
    );
  }

  const shutdown = async () => {
    process.stdout.write("\nshutting down…\n");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
