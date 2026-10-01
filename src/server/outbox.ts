/**
 * Per-socket outbound queue.
 *
 * When the kernel buffer (`bufferedAmount`) is over the high-water mark, frames
 * wait here instead of growing an unbounded `ws` buffer. Session updates are
 * droppable once the queue is full; responses and control frames are not.
 * A hard cap closes a consumer that never reads.
 */

export interface OutboxSocket {
  readonly OPEN: number;
  readyState: number;
  readonly bufferedAmount: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close?(code?: number, reason?: string): void;
}

export interface OutboxOptions {
  highWaterBytes?: number;
  maxQueued?: number;
  onDrop?: (dropped: number) => void;
}

const DEFAULT_HIGH_WATER = 1024 * 1024;
const DEFAULT_MAX_QUEUED = 500;

interface QueuedFrame {
  json: string;
  droppable: boolean;
}

export class SocketOutbox {
  dropped = 0;
  private readonly queue: QueuedFrame[] = [];
  private readonly highWaterBytes: number;
  private readonly maxQueued: number;
  private readonly onDrop?: (dropped: number) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private disposed = false;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly ws: OutboxSocket,
    opts?: OutboxOptions,
  ) {
    this.highWaterBytes = opts?.highWaterBytes ?? DEFAULT_HIGH_WATER;
    this.maxQueued = opts?.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.onDrop = opts?.onDrop;
  }

  get queued(): number {
    return this.queue.length;
  }

  /**
   * Enqueue or write immediately. Droppable frames may be discarded when the
   * queue is at capacity; non-droppable frames are kept until the hard cap.
   */
  trySend(obj: unknown, droppable = false): boolean {
    if (this.disposed || this.ws.readyState !== this.ws.OPEN) return false;
    const json = JSON.stringify(obj);
    if (this.queue.length === 0 && this.ws.bufferedAmount <= this.highWaterBytes) {
      return this.writeNow(json);
    }
    if (this.queue.length >= this.maxQueued) {
      if (droppable) {
        const idx = this.queue.findIndex((q) => q.droppable);
        if (idx >= 0) this.queue.splice(idx, 1);
        this.noteDrop();
        if (idx < 0) return false;
      } else if (this.queue.length >= this.maxQueued * 4) {
        try {
          this.ws.close?.(1013, "backpressure");
        } catch {
          // ignore
        }
        return false;
      }
    }
    this.queue.push({ json, droppable });
    this.schedule();
    return true;
  }

  /**
   * Deliver a frame that must not be dropped (replay, RPC response).
   * Waits until the queue has room or the socket dies.
   */
  async send(obj: unknown, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length >= this.maxQueued) {
      if (this.disposed || this.ws.readyState !== this.ws.OPEN) return false;
      if (Date.now() >= deadline) {
        try {
          this.ws.close?.(1013, "backpressure");
        } catch {
          // ignore
        }
        return false;
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        this.schedule();
      });
    }
    return this.trySend(obj, false);
  }

  flush(): void {
    if (this.disposed || this.flushing) return;
    this.flushing = true;
    try {
      while (
        this.queue.length > 0 &&
        this.ws.readyState === this.ws.OPEN &&
        this.ws.bufferedAmount <= this.highWaterBytes
      ) {
        const next = this.queue.shift()!;
        if (!this.writeNow(next.json)) break;
      }
    } finally {
      this.flushing = false;
    }
    if (this.queue.length > 0 && this.ws.readyState === this.ws.OPEN) {
      this.schedule();
    }
    this.wake();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.wake();
  }

  private writeNow(json: string): boolean {
    try {
      this.ws.send(json, () => {
        if (!this.flushing) this.flush();
      });
      return true;
    } catch {
      return false;
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 25);
    this.timer.unref?.();
  }

  private noteDrop(): void {
    this.dropped += 1;
    this.onDrop?.(this.dropped);
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const fn of waiters) fn();
  }
}
