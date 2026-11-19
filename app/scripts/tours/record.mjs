#!/usr/bin/env node
/**
 * Records the README walkthroughs, start to finish, with nobody at the keys:
 *
 *   npm run tours              every finished tour
 *   npm run tours -- tour3     just that one
 *
 * 1. starts the browser edition's dev server with the desktop look
 *    (vite.tours.config.mjs, http://127.0.0.1:5181), in demo mode;
 * 2. records the tour in a hidden Electron window, one frame at a time on a
 *    virtual clock, so every frame is exact whatever the machine's speed;
 * 3. encodes the frames as docs/media/walkthrough/<file>.webp (Python + Pillow);
 * 4. stops the server and deletes the frames.
 *
 * It does not start the app itself (no single-instance clash with an installed
 * Shark Deck), touches no device, and writes nothing else. About 3 minutes a tour.
 * Windows only for now: the auto-switch tour reads cs2.exe's real icon
 * ($CS2_EXE, or where Steam installs it).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const OUT = resolve(APP, '../docs/media/walkthrough');
const SERVER = 'http://127.0.0.1:5181/';

/** The finished tours: the recorder, its arguments, the file, the encoding. */
const TOURS = {
  tour3: {
    script: 'tour3.cjs',
    args: ['still'],
    file: 'tour-3-auto-switch.webp',
    // A still background: only the cursor and the UI change between frames.
    encode: ['--mode', 'delta', '--minimize', '--q', '80'],
  },
};

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(TOURS);
for (const n of names) {
  if (!TOURS[n]) {
    console.error(`No tour "${n}". Finished tours: ${Object.keys(TOURS).join(', ')}.`);
    process.exit(1);
  }
}

const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function answers() {
  try {
    return (await fetch(SERVER)).ok;
  } catch {
    return false;
  }
}

if (await answers()) {
  console.error(`Something already answers on ${SERVER}: stop it first.`);
  process.exit(1);
}

console.log('Starting the dev server...');
const server = spawn(
  process.execPath,
  [join(APP, 'node_modules/vite/bin/vite.js'), '--config', join(HERE, 'vite.tours.config.mjs')],
  { cwd: APP, stdio: 'ignore' },
);
let failed = false;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await sleep(500);
    up = await answers();
  }
  if (!up) throw new Error(`the dev server did not answer on ${SERVER}`);

  for (const name of names) {
    const tour = TOURS[name];
    const run = mkdtempSync(join(tmpdir(), `sharkdeck-${name}-`));
    try {
      console.log(`\nRecording ${name}...`);
      const rec = spawnSync(electron, [tour.script, run, ...tour.args], {
        cwd: HERE,
        stdio: 'inherit',
      });
      if (rec.status !== 0) throw new Error(`${name}: the recorder failed (${rec.status})`);

      console.log(`Encoding ${tour.file}...`);
      const out = join(OUT, tour.file);
      const enc = spawnSync(
        python,
        ['-E', '-P', join(HERE, 'encode.py'), run, out, ...tour.encode],
        {
          stdio: 'inherit',
        },
      );
      if (enc.status !== 0) throw new Error(`${name}: the encoder failed (${enc.status})`);
      if (!existsSync(out)) throw new Error(`${name}: no ${out}`);
      console.log(`${out}: ${(statSync(out).size / 1e6).toFixed(2)} MB`);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }
} catch (e) {
  failed = true;
  console.error(String(e instanceof Error ? e.message : e));
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
