import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lineupTables, withLineup } from './lineup';

/**
 * docs/devices/attack-shark-lineup.md says, model by model, how well Shark
 * Deck supports each device. Its tables are generated from the catalogues;
 * this fails when a catalogue changed and `npm run lineup` was not run, so the
 * list can never claim a model is supported when it is not.
 */
const APP = resolve(__dirname, '../../..');
const DOC = resolve(APP, '../docs/devices/attack-shark-lineup.md');

describe('docs/devices/attack-shark-lineup.md', () => {
  it('matches the catalogues (run `npm run lineup`)', () => {
    const doc = readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
    expect(withLineup(doc)).toBe(doc);
  });

  it('says plainly which devices were tested on hardware, and puts them first', () => {
    const tables = lineupTables();
    const tested = tables.split('\n').filter((l) => l.startsWith('| 🟢 Tested'));
    expect(tested.map((l) => l.split(' | ')[1])).toEqual(['V8', 'R85 HE']);
    // Sorted by status: a mouse table that starts on anything but the tested row is out of order.
    const mice = tables.slice(tables.indexOf('## Mice'));
    expect(mice.split('\n').find((l) => l.startsWith('| 🟢') || l.startsWith('| 🟡'))).toMatch(
      /^\| 🟢 Tested \| V8 /,
    );
  });

  it('lists the original X11 as itself, not as the X11 ULTRA it is not', () => {
    const tables = lineupTables();
    expect(tables).toMatch(/^\| 🟡 Should work \| X11 \|/m);
    expect(tables).toMatch(/^\| 🟡 Should work \| X11 ULTRA \|/m);
  });
});
