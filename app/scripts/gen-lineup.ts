/**
 * Rewrites the generated block of docs/devices/attack-shark-lineup.md from the
 * device catalogues and the art manifest (src/main/devices/lineup.ts).
 * `npm run lineup`; src/main/devices/lineup.test.ts fails when it is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { coloursOf, withLineup } from '../src/main/devices/lineup';

const app = resolve(__dirname, '..');
const doc = resolve(app, '../docs/devices/attack-shark-lineup.md');
const manifest = JSON.parse(readFileSync(resolve(app, 'assets/devices/manifest.json'), 'utf8'));
writeFileSync(doc, withLineup(readFileSync(doc, 'utf8'), coloursOf(manifest)));
console.log('wrote', doc);
