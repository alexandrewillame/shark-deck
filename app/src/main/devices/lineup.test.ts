import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coloursOf, withLineup } from './lineup';

/**
 * docs/devices/attack-shark-lineup.md says, model by model, what Shark Deck
 * does with each device. Its tables are generated from the catalogues; this
 * fails when a catalogue changed and `npm run lineup` was not run, so the
 * inventory can never claim a model is driven when it is not.
 */
const APP = resolve(__dirname, '../../..');
const DOC = resolve(APP, '../docs/devices/attack-shark-lineup.md');

describe('docs/devices/attack-shark-lineup.md', () => {
  it('matches the catalogues (run `npm run lineup`)', () => {
    const doc = readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
    const manifest = JSON.parse(readFileSync(resolve(APP, 'assets/devices/manifest.json'), 'utf8'));
    expect(withLineup(doc, coloursOf(manifest))).toBe(doc);
  });
});
