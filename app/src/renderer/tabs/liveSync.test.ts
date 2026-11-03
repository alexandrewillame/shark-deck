import { describe, expect, it } from 'vitest';
import { nextLiveValue } from './liveSync';

const base = { remote: null, local: 800, pinnedTo: null, pinnedUntil: 0, now: 1_000, held: false };

describe('nextLiveValue', () => {
  it('keeps what is on screen when the device has never been read', () => {
    expect(nextLiveValue({ ...base, remote: null })).toEqual({ value: 800, clearPin: false });
  });

  it('adopts the device value when nothing is pinned or held', () => {
    expect(nextLiveValue({ ...base, remote: 1600 })).toEqual({ value: 1600, clearPin: true });
  });

  it('never moves a value the user is mid-gesture on', () => {
    expect(nextLiveValue({ ...base, remote: 1600, held: true })).toEqual({
      value: 800,
      clearPin: false,
    });
  });

  it('ignores a poll that predates our own write', () => {
    // We just set 1600; the device is still reporting the old 800 because the
    // read was already in flight. Adopting it would undo the user's click.
    expect(
      nextLiveValue({ ...base, local: 1600, remote: 800, pinnedTo: 1600, pinnedUntil: 3_000 }),
    ).toEqual({
      value: 1600,
      clearPin: false,
    });
  });

  it('adopts and stops pinning once our own write echoes back', () => {
    expect(
      nextLiveValue({ ...base, local: 1600, remote: 1600, pinnedTo: 1600, pinnedUntil: 3_000 }),
    ).toEqual({
      value: 1600,
      clearPin: true,
    });
  });

  it('lets the device win again once the pin expires — it really did move', () => {
    // The mouse's own DPI button was pressed after our write; past the window
    // the hardware is the authority, which is the point of polling it at all.
    expect(
      nextLiveValue({ ...base, local: 1600, remote: 3200, pinnedTo: 1600, pinnedUntil: 900 }),
    ).toEqual({
      value: 3200,
      clearPin: true,
    });
  });

  it('holds beats the pin — a gesture is never interrupted', () => {
    expect(
      nextLiveValue({ ...base, local: 1600, remote: 3200, pinnedUntil: 0, held: true }),
    ).toEqual({
      value: 1600,
      clearPin: false,
    });
  });
});
