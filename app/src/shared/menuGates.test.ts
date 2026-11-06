import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GATES,
  buttonActionAllowed,
  gate,
  layoutAddressable,
  openGates,
  type GateId,
  type GateSubject,
} from './menuGates';
import type { Capability } from './types/capability';
import type { DeviceUi } from './types/live';
import { ANSI_75, ANSI_79_SG9047 } from './layouts';

const ui = (over: Partial<DeviceUi> = {}): DeviceUi => ({
  profileCount: 4,
  pollRates: [1000],
  lightZones: [],
  perKeyLighting: false,
  sleepPresets: [],
  colorVariants: [],
  artKey: 'test',
  ...over,
});

const subject = (
  kind: GateSubject['kind'],
  capabilities: Capability[],
  over: Partial<DeviceUi> = {},
  wireless = false,
): GateSubject => ({ kind, wireless, capabilities, ui: ui(over) });

describe('the gate table', () => {
  it('names only parents that exist', () => {
    for (const [id, g] of Object.entries(GATES)) {
      const parent = (g as { parent?: string }).parent;
      if (parent) expect(Object.keys(GATES), `${id} -> ${parent}`).toContain(parent);
    }
  });

  it('has every gate drawn somewhere in the renderer', () => {
    // A gate no component uses is a setting the table promises and no menu
    // shows; the reverse (a component naming a gate the table lacks) is a
    // type error, since ids are `GateId`.
    const root = resolve(process.cwd(), 'src/renderer');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk(root);
    const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const unused = Object.keys(GATES).filter(
      (id) => !src.includes(`'${id}'`) && !src.includes(`"${id}"`),
    );
    expect(unused).toEqual([]);
  });
});

describe('layoutAddressable', () => {
  it('is true only when every key carries a firmware slot', () => {
    expect(
      layoutAddressable(ui({ keyMatrix: { rows: 6, cols: 16, layout: ANSI_79_SG9047 } })),
    ).toBe(true);
    // ANSI_75 has no slots: drawing a board is not addressing its keys.
    expect(layoutAddressable(ui({ keyMatrix: { rows: 6, cols: 16, layout: ANSI_75 } }))).toBe(
      false,
    );
    expect(layoutAddressable(ui())).toBe(false);
    expect(
      layoutAddressable(
        ui({ keyMatrix: { rows: 6, cols: 16, layout: ANSI_79_SG9047, layoutStatus: 'none' } }),
      ),
    ).toBe(false);
  });
});

describe('gates follow what the model declares', () => {
  const he = (layout: DeviceUi['keyMatrix']) =>
    subject('keyboard', ['magneticSwitches', 'rapidTrigger', 'keyRemap', 'fnLayer', 'macros'], {
      keyMatrix: layout,
    });

  it('gives a mechanical board no actuation settings', () => {
    const mech = subject('keyboard', ['keyRemap', 'fnLayer', 'pollRate', 'debounce']);
    expect(gate('tab.actuation', mech)).toBe(false);
    expect(openGates(mech).filter((id) => id.startsWith('act.'))).toEqual([]);
  });

  it('gives a magnetic board without a slot map whole-board settings only', () => {
    const d = he({ rows: 6, cols: 16, layout: ANSI_75 });
    expect(gate('tab.actuation', d)).toBe(true);
    expect(gate('act.wholeBoard', d)).toBe(true);
    expect(gate('act.perKey', d)).toBe(false);
    expect(gate('act.test', d)).toBe(false);
    expect(gate('tab.keys', d)).toBe(false);
    expect(gate('tab.macros', d)).toBe(false);
  });

  it('gives a magnetic board with a slot map the per-key editor', () => {
    const d = he({ rows: 6, cols: 16, layout: ANSI_79_SG9047 });
    expect(gate('act.perKey', d)).toBe(true);
    expect(gate('act.wholeBoard', d)).toBe(false);
    expect(gate('tab.keys', d)).toBe(true);
  });

  it('shows a mouse sensor row only for the feature it has', () => {
    const d = subject('mouse', ['dpi', 'lod'], {
      lodOptions: [{ wire: 1, mm: 1 }],
      dpiRange: { min: 50, max: 26000, step: 50, stages: 6 },
    });
    const sensor = openGates(d).filter((id) => id.startsWith('sensor.'));
    expect(sensor.sort()).toEqual(['sensor.lod', 'sensor.section'] satisfies GateId[]);
  });

  it('shows DPI stage colours only with an indicator that shows them', () => {
    const dpi = { min: 50, max: 26000, step: 50, stages: 6 };
    expect(gate('dpi.stageColors', subject('mouse', ['dpi'], { dpiRange: dpi }))).toBe(false);
    expect(
      gate('dpi.stageColors', subject('mouse', ['dpi', 'dpiIndicatorLed'], { dpiRange: dpi })),
    ).toBe(true);
    expect(
      gate(
        'dpi.stageColors',
        subject('mouse', ['dpi'], { dpiRange: { ...dpi, colorPerStage: true } }),
      ),
    ).toBe(true);
  });

  it('shows power settings only on a wireless device', () => {
    expect(gate('power.section', subject('keyboard', ['sleepTimer']))).toBe(false);
    expect(gate('power.section', subject('keyboard', ['sleepTimer'], {}, true))).toBe(true);
  });

  it('gives a board with only an edge light no effect grid', () => {
    const d = subject('keyboard', ['sideLighting'], { lightZones: ['side'] });
    expect(gate('light.side', d)).toBe(true);
    expect(gate('light.kbEffects', d)).toBe(false);
  });

  it('offers a button action only when its feature exists', () => {
    expect(buttonActionAllowed('macro', { capabilities: ['dpi'] })).toBe(false);
    expect(buttonActionAllowed('macro', { capabilities: ['macros'] })).toBe(true);
    expect(buttonActionAllowed('dpiLedToggle', { capabilities: [] })).toBe(false);
    expect(buttonActionAllowed('button', { capabilities: [] })).toBe(true);
  });
});
