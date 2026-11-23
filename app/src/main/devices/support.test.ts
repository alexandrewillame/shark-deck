import { describe, expect, it } from 'vitest';
import { supportPlan } from './support';
import { CONFIRMED } from './catalog/confirmed';
import { CATALOG } from './catalog';
import { KEYBOARDS_BY_ID } from './catalog/keyboards';
import { bekenMouseRoster } from './catalog/beken-mice';

/**
 * One recording must be enough: the plan Shark Deck asks an owner for covers
 * what the model lacks and every setting it shows that no recording of it
 * confirmed (catalog/confirmed.ts).
 */

const byModel = (model: string) =>
  [...CATALOG, ...bekenMouseRoster()].find((d) => d.model === model)!;

describe('supportPlan', () => {
  it('asks nothing of a model checked on real hardware', () => {
    expect(supportPlan(byModel('attack-shark-r85he'))).toBeUndefined();
    expect(supportPlan(byModel('attack-shark-v8'))).toBeUndefined();
  });

  it('asks a recorded model only for what its recordings did not cover', () => {
    const x11 = supportPlan(byModel('attack-shark-x11'))!;
    expect(x11.record).toEqual(['start', 'macro']);
    expect(x11.unconfirmed).toEqual(['macros']);
    // the X8 PRO's media keys are its gap, named once
    const x8 = supportPlan(byModel('attack-shark-x8-pro'))!;
    expect(x8.record).toEqual(['start', 'media']);
    expect(x8.gaps).toEqual(['mediaKeys']);
    expect(x8.unconfirmed).toBeUndefined();
  });

  it('asks a model no one recorded for every setting it shows', () => {
    const x65 = KEYBOARDS_BY_ID.get(2268)!; // a vendor slot map, nothing recorded
    const plan = supportPlan(x65)!;
    expect(plan.gaps).toEqual([]);
    expect(plan.record[0]).toBe('start');
    for (const w of ['key', 'light', 'perkey', 'act', 'rt', 'dks', 'mt', 'snap', 'sw', 'macro'])
      expect(plan.record, w).toContain(w);
    expect(plan.unconfirmed).toEqual(
      expect.arrayContaining(['keys', 'lighting', 'actuation', 'keyModes', 'switches', 'macros']),
    );
    // no knob on this board: nothing asked about one
    expect(plan.record).not.toContain('knob');
  });

  it('asks the R98 HE for nothing more, once its recordings covered everything', () => {
    const r98 = KEYBOARDS_BY_ID.get(3743)!;
    // its slot map is its recording's (catalog/recorded-keymaps.ts)
    expect(r98.spec.keyMatrix?.layoutStatus).toBe('certain');
    expect(CONFIRMED[r98.model]).toBe('all');
    expect(supportPlan(r98)?.unconfirmed ?? []).toEqual([]);
  });
});
