import { describe, expect, it } from "vitest";
import { chooseBindHost, formatAdvertiseHost, isTailscaleAddress } from "../src/net/bind.js";

describe("bind address selection", () => {
  it("treats only the Tailscale CGNAT range and fd7a: as Tailscale", () => {
    expect(isTailscaleAddress("100.64.0.1")).toBe(true);
    expect(isTailscaleAddress("100.127.255.1")).toBe(true);
    expect(isTailscaleAddress("100.63.1.1")).toBe(false);
    expect(isTailscaleAddress("100.128.0.1")).toBe(false);
    expect(isTailscaleAddress("fd7a:115c:a1e0::32")).toBe(true);
    expect(isTailscaleAddress("fd00::1")).toBe(false);
  });

  it("prefers Tailscale IPv4, then fd7a:, and does not steal a non-CGNAT 100.x LAN", () => {
    const candidates = [
      { address: "100.1.2.3", family: "IPv4" as const, internal: false },
      { address: "192.168.1.9", family: "IPv4" as const, internal: false },
      { address: "100.64.1.5", family: "IPv4" as const, internal: false },
      { address: "fd7a:115c:a1e0::8", family: "IPv6" as const, internal: false },
      { address: "127.0.0.1", family: "IPv4" as const, internal: true },
    ];
    expect(chooseBindHost({ lan: false, tailscale: true }, candidates)).toBe("100.64.1.5");
    expect(
      chooseBindHost({ lan: false, tailscale: true }, candidates.filter((c) => c.address !== "100.64.1.5")),
    ).toBe("fd7a:115c:a1e0::8");
    expect(
      chooseBindHost(
        { lan: false, tailscale: true },
        candidates.filter((c) => c.address !== "100.64.1.5" && !c.address.startsWith("fd7a:")),
      ),
    ).toBe("100.1.2.3");
    expect(chooseBindHost({ lan: true, tailscale: false }, candidates)).toBe("100.1.2.3");
    expect(chooseBindHost({ lan: false, tailscale: false }, candidates)).toBe("127.0.0.1");
    expect(formatAdvertiseHost("fd7a:115c:a1e0::8")).toBe("[fd7a:115c:a1e0::8]");
    expect(formatAdvertiseHost("127.0.0.1")).toBe("127.0.0.1");
  });
});
