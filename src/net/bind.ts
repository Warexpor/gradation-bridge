/**
 * Listen-address selection for loopback, LAN, and Tailscale.
 * Tailscale IPv4 is 100.64.0.0/10, not every 100.x address. IPv6 is fd7a::/16.
 */

import { isIP } from "node:net";

export interface BindCandidate {
  address: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
}

/** True for Tailscale CGNAT IPv4 and fd7a: IPv6. Other 100.x addresses are LAN. */
export function isTailscaleAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) {
    const [a, b] = bare.split(".").map((part) => Number(part));
    return a === 100 && b >= 64 && b <= 127;
  }
  if (isIP(bare) === 6) return bare.toLowerCase().startsWith("fd7a:");
  return false;
}

/**
 * Default is loopback. `--tailscale` prefers an IPv4 Tailscale address, then
 * fd7a:. `--lan` and a Tailscale miss use the first non-Tailscale IPv4.
 */
export function chooseBindHost(
  flags: { lan: boolean; tailscale: boolean },
  candidates: BindCandidate[],
): string {
  if (!flags.lan && !flags.tailscale) return "127.0.0.1";
  const external = candidates.filter(
    (c) => !c.internal && (c.family === "IPv4" || c.family === "IPv6"),
  );
  if (flags.tailscale) {
    const v4 = external.find((c) => c.family === "IPv4" && isTailscaleAddress(c.address));
    if (v4) return v4.address;
    const v6 = external.find((c) => c.family === "IPv6" && isTailscaleAddress(c.address));
    if (v6) return v6.address;
  }
  if (flags.lan || flags.tailscale) {
    const lan = external.find((c) => c.family === "IPv4" && !isTailscaleAddress(c.address));
    if (lan) return lan.address;
  }
  return "127.0.0.1";
}

/** Bracket IPv6 so the pairing URL has a single host. */
export function formatAdvertiseHost(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}
