import type { FrameLogEntry } from '@shared/types/diagnostics';

/**
 * In-memory ring buffer of the last N HID frames, and of what went wrong
 * around them (a refused change, a read that answered nothing): the developer
 * panel, and the log an owner saves from the Device tab for a report.
 */
class FrameLog {
  private buf: FrameLogEntry[] = [];
  private cap = 6000;
  private listeners = new Set<(e: FrameLogEntry) => void>();

  push(entry: Omit<FrameLogEntry, 'ts'>): void {
    const e: FrameLogEntry = { ...entry, ts: Date.now() };
    this.buf.push(e);
    if (this.buf.length > this.cap) this.buf.shift();
    for (const l of this.listeners) l(e);
  }

  all(): FrameLogEntry[] {
    return [...this.buf];
  }

  clear(): void {
    this.buf = [];
  }

  onPush(cb: (e: FrameLogEntry) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

export const frameLog = new FrameLog();
