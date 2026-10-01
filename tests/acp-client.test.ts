import { describe, expect, it } from "vitest";
import { AcpStdioClient } from "../src/acp/client.js";

describe("ACP stdio client errors", () => {
  it("includes redacted stderr when the harness exits", async () => {
    const client = new AcpStdioClient({
      harness: {
        id: "boom",
        name: "boom",
        command: process.execPath,
        args: [
          "-e",
          "console.error('fail TOKEN=sk-abcdefghijklmnopqrstuvwxyz'); process.exit(2)",
        ],
      },
      cwd: process.cwd(),
    });
    client.start();
    await expect(
      client.initialize({ clientInfo: { name: "t", version: "0" } }),
    ).rejects.toThrow(/exited \(code=2/);
    expect(client.stderrTail()).toContain("TOKEN=[redacted]");
    expect(client.stderrTail()).not.toContain("sk-abc");
  });

  it("reports a missing command instead of hanging", async () => {
    const client = new AcpStdioClient({
      harness: {
        id: "missing",
        name: "missing",
        command: "gradation-bridge-not-a-real-binary",
        args: [],
      },
      cwd: process.cwd(),
    });
    client.start();
    await expect(
      client.initialize({ clientInfo: { name: "t", version: "0" } }),
    ).rejects.toThrow(/command not found: gradation-bridge-not-a-real-binary|ACP process exited/);
  });
});
