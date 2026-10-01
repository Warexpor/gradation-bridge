import { describe, expect, it } from "vitest";
import { SocketOutbox, type OutboxSocket } from "../src/server/outbox.js";

function fakeSocket(): OutboxSocket & {
  sent: string[];
  setBuffered(n: number): void;
  closed: { code?: number; reason?: string } | null;
} {
  let buffered = 0;
  const sent: string[] = [];
  const sock = {
    OPEN: 1,
    readyState: 1,
    sent,
    closed: null as { code?: number; reason?: string } | null,
    get bufferedAmount() {
      return buffered;
    },
    setBuffered(n: number) {
      buffered = n;
    },
    send(data: string, cb?: (err?: Error) => void) {
      sent.push(data);
      buffered += data.length;
      cb?.();
    },
    close(code?: number, reason?: string) {
      this.readyState = 3;
      this.closed = { code, reason };
    },
  };
  return sock;
}

describe("SocketOutbox", () => {
  it("writes immediately when the socket is under the high-water mark", () => {
    const sock = fakeSocket();
    const box = new SocketOutbox(sock, { highWaterBytes: 1024 });
    expect(box.trySend({ hello: "world" })).toBe(true);
    expect(sock.sent).toEqual([JSON.stringify({ hello: "world" })]);
    expect(box.queued).toBe(0);
    box.dispose();
  });

  it("queues above the high-water mark and drops the oldest update when full", () => {
    const sock = fakeSocket();
    sock.setBuffered(50);
    const box = new SocketOutbox(sock, { highWaterBytes: 10, maxQueued: 2 });
    expect(box.trySend({ n: 1 }, true)).toBe(true);
    expect(box.trySend({ n: 2 }, true)).toBe(true);
    expect(box.trySend({ n: 3 }, true)).toBe(true);
    expect(box.dropped).toBe(1);
    expect(box.queued).toBe(2);
    expect(box.trySend({ keep: true }, false)).toBe(true);
    expect(box.queued).toBe(3);
    expect(sock.sent).toEqual([]);

    sock.setBuffered(0);
    box.flush();
    sock.setBuffered(0);
    box.flush();
    const bodies = sock.sent.map((line) => JSON.parse(line) as { n?: number; keep?: boolean });
    expect(bodies).toEqual([{ n: 2 }, { n: 3 }, { keep: true }]);
    box.dispose();
  });

  it("waits to send a must-deliver frame until the queue has room", async () => {
    const sock = fakeSocket();
    sock.setBuffered(50);
    const box = new SocketOutbox(sock, { highWaterBytes: 10, maxQueued: 1 });
    expect(box.trySend({ n: 1 }, false)).toBe(true);
    let settled = false;
    const pending = box.send({ n: 2 }).then((ok) => {
      settled = true;
      return ok;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(settled).toBe(false);
    sock.setBuffered(0);
    box.flush();
    await expect(pending).resolves.toBe(true);
    expect(sock.sent.some((line) => line.includes('"n":2'))).toBe(true);
    box.dispose();
  });

  it("drops frames after dispose so a closed socket cannot keep a login result", () => {
    const sock = fakeSocket();
    const box = new SocketOutbox(sock, { highWaterBytes: 10 });
    sock.setBuffered(50);
    expect(box.trySend({ token: "queued" }, false)).toBe(true);
    box.dispose();
    expect(box.queued).toBe(0);
    expect(box.trySend({ token: "late" })).toBe(false);
    expect(sock.sent).toEqual([]);
  });
});
