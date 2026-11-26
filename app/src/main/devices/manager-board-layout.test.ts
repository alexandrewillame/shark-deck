import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceDescriptor } from '@shared/types/device';
import type { KeyBinding } from '@shared/types/keys';
import { layoutAddressable } from '@shared/menuGates';

/**
 * A board with a drawing but no slot map — the R98 HE and most of the line —
 * gets its keys placed from its own factory key map when it attaches
 * (manager.ts `placeLayout`), and with them every per-key menu its row has.
 */

const files = vi.hoisted(() => new Map<string, unknown>());
vi.mock('node-hid', () => ({
  default: { devicesAsync: async () => [], HID: class {}, HIDAsync: { open: vi.fn() } },
}));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sharkdeck-test', isPackaged: false } }));
const mockSettings = { demoMode: false, language: 'en', batteryLowThreshold: 15 };
vi.mock('../settings', () => ({
  getSettingsSync: () => mockSettings,
  getSettings: async () => mockSettings,
  setSettings: async () => mockSettings,
}));
vi.mock('../store', () => ({
  paths: {
    deviceState: () => '/tmp/device-state.json',
    deviceColors: () => '/tmp/device-colors.json',
    onboardProfileNames: () => '/tmp/onboard-names.json',
    keyGroups: () => '/tmp/key-groups.json',
  },
  readJson: async (p: string, d: unknown) => (files.has(p) ? structuredClone(files.get(p)) : d),
  writeJson: async (p: string, v: unknown) => void files.set(p, structuredClone(v)),
  withFileLock: <T>(_p: string, fn: () => Promise<T>) => fn(),
  listBackupFiles: async () => [],
  writeBackup: async () => 'f.json',
}));

// The R98 PRO and R98 GT as boards with a drawing and no slot map: Driver
// v4's factory matrices give both one now, and placing a board from its own
// key map is what this file is about.
vi.mock('./catalog/generated/keyboard-rows', async (importOriginal) => {
  const m = await importOriginal<typeof import('./catalog/generated/keyboard-rows')>();
  return {
    KEYBOARD_ROWS: m.KEYBOARD_ROWS.map((r) =>
      r.id === 3754 || r.id === 3748 ? { ...r, slotLayout: null } : r,
    ),
  };
});

import { DeviceManager } from './manager';
import { KEYBOARDS_BY_ID } from './catalog/keyboards';
import { decodeQuad } from './drivers/compx-keyboard';
import { VirtualDriver } from './virtual';
import { r98hePages } from './r98he-keymap.fixture';

/** The R98 PRO: the R98 HE's drawing, and no recording of its own (and,
 *  here, no slot map: see the catalogue mock above). */
const BOARD = KEYBOARDS_BY_ID.get(3754)!;

/** The R98 HE's recorded factory base layer (the same drawing), as the driver reads it. */
function r98Map(): Record<number, KeyBinding> {
  const out: Record<number, KeyBinding> = {};
  r98hePages().forEach((bytes, p) => {
    for (let q = 0; q < 16; q++) {
      const raw = bytes.slice(q * 4, q * 4 + 4) as [number, number, number, number];
      out[p * 16 + q] = decodeQuad(p * 16 + q, raw);
    }
  });
  return out;
}

interface TestEntry {
  descriptor: DeviceDescriptor;
  driver: { readKeyBindings: (layer: 'base' | 'fn') => Promise<Record<number, KeyBinding> | null> };
  layoutChecked?: boolean;
  relayout?: boolean;
  live: { id: string; capabilities: string[]; ui: unknown };
}

function attach(m: DeviceManager, descriptor: DeviceDescriptor, map = r98Map()) {
  const reads = vi.fn(async () => map);
  const e = {
    descriptor,
    channel: { isOpen: () => true, close: async () => undefined },
    driver: { readKeyBindings: reads },
    live: { id: 'kb', capabilities: descriptor.capabilities, ui: {} },
  };
  (m as unknown as { entries: Map<string, unknown> }).entries.set('kb', e);
  const check = () => (m as unknown as { checkLayout(e: unknown): Promise<void> }).checkLayout(e);
  return { e: e as unknown as TestEntry, reads, check };
}

const kept = () =>
  (files.get('/tmp/device-state.json') as Record<string, Record<string, unknown>> | undefined)?.[
    BOARD.model
  ]?.boardLayout;

describe('a board with a drawing but no slot map', () => {
  beforeEach(() => files.clear());

  it('starts with whole-board settings only', () => {
    expect(BOARD.spec.keyMatrix?.layoutStatus).toBe('none');
    expect(BOARD.capabilities).not.toContain('keyRemap');
    expect(BOARD.spec.support?.gaps).toContain('keymap');
  });

  it('gets its keys placed from its own key map, and every per-key menu', async () => {
    const m = new DeviceManager();
    const { e, reads, check } = attach(m, BOARD);
    await check();
    expect(reads).toHaveBeenCalledTimes(1);
    const d = e.descriptor;
    expect(d.spec.keyMatrix?.layoutStatus).toBe('board');
    expect(d.spec.keyMatrix?.layout).toHaveLength(BOARD.spec.keyMatrix!.layout!.length);
    expect(layoutAddressable({ keyMatrix: d.spec.keyMatrix })).toBe(true);
    for (const cap of ['keyRemap', 'fnLayer', 'macros', 'dks', 'socd', 'modTap'] as const)
      expect(d.capabilities).toContain(cap);
    expect(d.spec.lighting?.perKey).toBe(true);
    // nothing left to ask its owners to record
    expect(d.spec.support).toBeUndefined();
    expect(e.live.capabilities).toEqual(d.capabilities);
    expect(e.layoutChecked).toBe(true);
    expect(kept()).toHaveLength(BOARD.spec.keyMatrix!.layout!.length);
    m.stop();
  });

  it('keeps the placing: a key remapped afterwards stays where it is drawn', async () => {
    const m = new DeviceManager();
    await attach(m, BOARD).check();
    const placed = (m as unknown as { entries: Map<string, TestEntry> }).entries.get('kb')!
      .descriptor.spec.keyMatrix!.layout;

    // Caps Lock remapped to Ctrl, then the board is plugged in again
    const map = r98Map();
    map[3] = decodeQuad(3, [0, 0, 0xe0, 0]);
    const again = attach(new DeviceManager(), BOARD, map);
    await again.check();
    expect(again.reads).not.toHaveBeenCalled();
    expect(again.e.descriptor.spec.keyMatrix!.layout).toEqual(placed);
  });

  it('is placed afresh after a factory reset', async () => {
    const m = new DeviceManager();
    const { e, reads, check } = attach(m, BOARD);
    await check();
    // placing swapped in the board's real driver; the board answers the same
    e.driver = { readKeyBindings: reads };
    files.set('/tmp/device-state.json', { [BOARD.model]: { boardLayout: [[0, 0, 5]] } });
    m.relayout('kb');
    expect(e.layoutChecked).toBe(false);
    await check();
    expect(reads).toHaveBeenCalledTimes(2);
    expect(e.relayout).toBe(false);
    expect(kept()).toHaveLength(BOARD.spec.keyMatrix!.layout!.length);
    m.stop();
  });

  it('stays whole-board when its key map does not match its drawing', async () => {
    const empty: Record<number, KeyBinding> = {};
    for (let s = 0; s < 128; s++) empty[s] = decodeQuad(s, [0, 0, 0, 0]);
    const m = new DeviceManager();
    const { e, check } = attach(m, BOARD, empty);
    await check();
    expect(e.descriptor).toBe(BOARD);
    expect(e.layoutChecked).toBe(true);
    expect(kept()).toBeUndefined();
    m.stop();
  });

  it('is asked again on a later pass when the read fails', async () => {
    const m = new DeviceManager();
    const { e, check } = attach(m, BOARD);
    e.driver.readKeyBindings = async () => null;
    await check();
    expect(e.layoutChecked).toBeFalsy();
    expect(e.descriptor).toBe(BOARD);
    m.stop();
  });

  it("finds a knob board's knob with its keys, and keeps it with them", async () => {
    // The R98 GT: the same drawing, a knob, and nobody's recording.
    const gt = KEYBOARDS_BY_ID.get(3748)!;
    expect(gt.spec.knob).toBe(true);
    const knob = { left: 120, right: 121, press: 122 };
    const m = new DeviceManager();
    const { e, check } = attach(m, gt);
    await check();
    expect(e.descriptor.spec.keyMatrix?.knobSlots).toEqual(knob);
    const state = files.get('/tmp/device-state.json') as Record<string, Record<string, unknown>>;
    expect(state[gt.model]?.boardKnob).toEqual(knob);
    // plugged in again: the kept placing, knob and all, without reading the board
    const again = attach(new DeviceManager(), gt);
    await again.check();
    expect(again.reads).not.toHaveBeenCalled();
    expect(again.e.descriptor.spec.keyMatrix?.knobSlots).toEqual(knob);
    m.stop();
  });

  it('on a demo board, is placed for the session and never stored', async () => {
    const demo: DeviceDescriptor = { ...BOARD, simulated: true };
    const m = new DeviceManager();
    const sim = new VirtualDriver({ descriptor: demo, channel: {} as never, onWarning: () => {} });
    const { e, check } = attach(m, demo, (await sim.readKeyBindings('base'))!);
    await check();
    expect(e.descriptor.spec.keyMatrix?.layoutStatus).toBe('board');
    expect(e.descriptor.simulated).toBe(true);
    expect(e.driver).toBeInstanceOf(VirtualDriver);
    expect(e.descriptor.spec.keyMatrix!.layout!.some((k) => /^fn$/i.test(k.label))).toBe(true);
    expect(files.size).toBe(0);
    m.stop();
  });

  it('leaves a board with its own slot map alone', async () => {
    const x65 = KEYBOARDS_BY_ID.get(2268)!;
    expect(x65.spec.keyMatrix?.layoutStatus).toBe('certain');
    const m = new DeviceManager();
    const { e, check } = attach(m, x65, {});
    await check();
    // the imported map is held to the board's own, which here says nothing
    expect(e.descriptor.spec.keyMatrix?.layoutStatus).toBe('none');
    expect(files.size).toBe(0);
    m.stop();
  });
});
