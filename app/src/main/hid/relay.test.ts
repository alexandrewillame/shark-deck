import { describe, expect, it, vi } from 'vitest';

/**
 * The 2.4 GHz receiver relay (transport.ts `relaySendUnlocked`) against a fake
 * ROYUAN receiver that behaves the way sharkfin's notes describe: it drops a
 * packet whose target was not selected first, raises "reply waiting" in its
 * status once the device behind it has answered, and hands that reply over
 * only after 0xFC.
 */

class FakeReceiver {
  selected: number | null = null;
  replyWaiting = false;
  released = false;
  pending: number[] | null = null;
  lastCmd = 0;
  readonly log: string[] = [];
  /** what the device behind it answers, by opcode */
  constructor(private readonly device: (frame: number[]) => number[] | null) {}

  async sendFeatureReport(bytes: number[]) {
    const cmd = bytes[1]!;
    this.lastCmd = cmd;
    this.log.push(cmd.toString(16));
    if (cmd === 0xf7) return bytes.length;
    if (cmd === 0xf6) {
      this.selected = bytes[2]!;
      return bytes.length;
    }
    if (cmd === 0xfc) {
      this.released = true;
      return bytes.length;
    }
    // a device packet: carried only to a selected target, once
    if (this.selected === 0x0a) {
      this.pending = this.device(bytes);
      this.replyWaiting = this.pending !== null;
    }
    this.selected = null;
    return bytes.length;
  }

  async getFeatureReport(_id: number, len: number) {
    if (this.lastCmd === 0xf7) {
      const status = [this.replyWaiting ? 1 : 0, 87, 0, 0, 1, 1, 1];
      return [0x00, ...status, ...new Array(len - 8).fill(0)];
    }
    if (this.lastCmd === 0xfc && this.released && this.pending) {
      const r = this.pending;
      this.pending = null;
      this.replyWaiting = false;
      this.released = false;
      return r;
    }
    return [];
  }

  async close() {}
}

let receiver: FakeReceiver;
vi.mock('node-hid', () => ({
  default: {
    devicesAsync: async () => [],
    HIDAsync: { open: vi.fn(async () => receiver) },
  },
}));

const { HidChannel } = await import('./transport');
const { buildFrame } = await import('./frame');

const candidate = { path: 'rx', vendorId: 0x3151, productId: 0x4011, interface: 2 };
const identify = () =>
  buildFrame({ reportId: 0, command: 0x8f, args: [], reportLength: 65, checksum: 'compx-fea' });

/** A keyboard behind the receiver: answers identify with model id 1967 (an X86). */
const keyboard = (f: number[]) =>
  f[1] === 0x8f ? [0x00, 0x8f, 0xaf, 0x07, ...new Array(61).fill(0)] : null;

describe('the receiver relay', () => {
  it('carries a request to the keyboard and its reply back', async () => {
    receiver = new FakeReceiver(keyboard);
    const ch = new HidChannel(candidate, undefined, 'feature-report', 'compx-fea', {
      relay: { target: 0x0a },
    });
    const r = await ch.request(identify(), 0x8f, 1, 1, true);
    expect(r).not.toBeNull();
    expect((r![3]! << 8) | r![2]!).toBe(1967);
    // status, select, the packet, status until the reply waits, release, read
    const sent = receiver.log.join(' ');
    expect(sent).toMatch(/^f7 f6 8f (f7 )+fc$/);
  });

  it('reports the receiver status, keyboard battery included', async () => {
    receiver = new FakeReceiver(keyboard);
    const ch = new HidChannel(candidate, undefined, 'feature-report', 'compx-fea', {
      relay: { target: 0x0a },
    });
    expect(ch.isRelayed()).toBe(true);
    expect(await ch.relayStatus()).toMatchObject({ keyboardBattery: 87, ready: true, paired: 1 });
  });

  it('times out instead of hanging when the device behind it never answers', async () => {
    receiver = new FakeReceiver(() => null);
    const ch = new HidChannel(candidate, undefined, 'feature-report', 'compx-fea', {
      relay: { target: 0x0a },
    });
    const t0 = Date.now();
    expect(await ch.request(identify(), 0x8f, 1, 1, true)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('leaves a direct channel exactly as it was: no relay frames at all', async () => {
    receiver = new FakeReceiver(keyboard);
    const ch = new HidChannel(candidate, undefined, 'feature-report', 'compx-fea');
    expect(ch.isRelayed()).toBe(false);
    await ch.write(identify());
    expect(receiver.log).toEqual(['8f']);
  });
});
