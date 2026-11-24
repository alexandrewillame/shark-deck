import { describe, expect, it } from 'vitest';
import type { LiveDevice } from '@shared/types/live';
import type { FrameLogEntry } from '@shared/types/diagnostics';
import { deviceLogName, deviceLogText } from './deviceLog';

const device = {
  id: 'x8',
  model: 'attack-shark-x8-pro',
  displayName: 'Attack Shark X8 PRO',
  vid: 0x1d57,
  pid: 0x2126,
  connection: 'usb',
  firmware: { device: '11.03', receiver: null },
  online: true,
  battery: null,
  charging: true,
  activeDpiStage: 1,
  pollRate: 1000,
} as unknown as LiveDevice;

const at = (s: number) => Date.UTC(2026, 10, 24, 10, 22, s);
const frames: FrameLogEntry[] = [
  { ts: at(1), deviceId: 'x8', dir: 'rx', hex: '', note: 'announcements: listening on 000a:0000' },
  { ts: at(2), deviceId: 'x8', dir: 'tx', hex: '04 38 01 11', note: undefined },
  { ts: at(3), deviceId: 'other', dir: 'tx', hex: 'ff ff', note: undefined },
  { ts: at(4), deviceId: 'x8', dir: 'rx', hex: '03 08 40 03 64', note: 'event' },
  {
    ts: at(5),
    deviceId: 'x8',
    dir: 'tx',
    hex: '',
    note: 'setActiveDpiStage refused: no DPI stage 7',
  },
];

describe('the device log an owner attaches to a report', () => {
  it('says what the device is, then its own lines only, oldest first', () => {
    const text = deviceLogText(
      device,
      frames,
      { version: '0.3.8', host: 'desktop, win32' },
      new Date(at(9)),
    );
    expect(text).toContain('Shark Deck 0.3.8 (desktop, win32), saved 2026-11-24T10:22:09.000Z');
    expect(text).toContain('Device: Attack Shark X8 PRO — attack-shark-x8-pro, 1D57:2126, usb');
    expect(text).toContain('Now: online; battery charging; DPI stage 2; polling 1000 Hz');
    const lines = text.split('\n').filter((l) => /^\d\d:\d\d:\d\d\.\d{3} /.test(l));
    expect(lines).toEqual([
      '10:22:01.000 · announcements: listening on 000a:0000',
      '10:22:02.000 → 04 38 01 11',
      '10:22:04.000 ← 03 08 40 03 64  event',
      '10:22:05.000 · setActiveDpiStage refused: no DPI stage 7',
    ]);
  });

  it('is named by model and time', () => {
    expect(deviceLogName(device, new Date(at(9)))).toBe(
      'SharkDeck-log-attack-shark-x8-pro-20261124-1022.txt',
    );
  });
});
