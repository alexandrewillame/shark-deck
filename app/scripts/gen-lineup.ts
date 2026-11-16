/**
 * Rewrites the generated block of docs/devices/attack-shark-lineup.md from the
 * device catalogues (src/main/devices/lineup.ts).
 * `npm run lineup`; src/main/devices/lineup.test.ts fails when it is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withLineup } from '../src/main/devices/lineup';

const app = resolve(__dirname, '..');
const doc = resolve(app, '../docs/devices/attack-shark-lineup.md');
writeFileSync(doc, withLineup(readFileSync(doc, 'utf8').replace(/\r\n/g, '\n')));
console.log('wrote', doc);
