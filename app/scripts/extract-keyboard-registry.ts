/**
 * Our own extraction of the Attack Shark keyboard registry from the installed
 * Driver v4, the vendor's desktop app (its renderer ships unpacked under
 * resources/app/dist/js): every device row the app knows (every brand), the
 * key grid of each layout an Attack Shark board uses, and each Attack Shark
 * board's factory key matrix. The bundle is read as text, never run.
 *
 *   npm run extract:registry
 *
 * Writes scripts/_raw/driverv4/registry.json (git-ignored), which
 * `npm run import:kb` turns into src/main/devices/catalog/generated/.
 *
 * Set ASHARK_KB_APP to another …/resources/app/dist/js to read another copy.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hidUsageForBrowserCode } from '../src/shared/keys';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(APP, 'scripts/_raw/driverv4');
const DIST =
  process.env.ASHARK_KB_APP ||
  join(
    process.env.USERPROFILE ?? process.env.HOME ?? '',
    'AppData/Local/Programs/Attack Shark Driver v4/resources/app/dist/js',
  );

export interface DriverV4Row {
  id: number;
  vid: number;
  pid: number;
  displayName: string;
  company: string;
  type: string;
  internalName: string;
  keyLayout: string | null;
  profiles: number | null;
  magnetic: boolean;
  sideLight: boolean;
  switchReplaceable: boolean;
  /** The vendor's own names (Chinese), in its order. */
  switchTypes: string[];
  travel: Record<string, { min: number; max: number; step: number; default?: number }> | null;
  screen: { w: number; h: number } | null;
  knobKeyCodes: string[];
  debounce: boolean;
  sleep24: boolean;
  sleepBT: boolean;
  /** The app's own chip flags. */
  chip: { yc3123: boolean; ry6602: boolean };
}

export interface DriverV4Key {
  code: string;
  type: 'key' | 'knob';
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  matrixIndex: null;
  matrixEntry: number[];
  hidUsage: number | null;
  consumerUsage: number | null;
}

export interface DriverV4Registry {
  source: { app: string; version: string | null; bundle: string; extracted: string };
  rows: DriverV4Row[];
  /** Key grids by layout stem (`Common98_SG9097_F`). */
  layouts: Record<string, { canvas: { width: number; height: number }; keys: DriverV4Key[] }>;
  /** Factory key matrices (4 bytes a slot) by model id, Attack Shark boards only. */
  matrices: Record<number, number[]>;
  missing: { layouts: string[]; matrices: string[] };
}

const files = () => readdirSync(DIST).filter((f) => f.endsWith('.js'));
const read = (f: string) => readFileSync(join(DIST, f), 'utf8');

/** The object or array literal opening at `from` (balanced, strings skipped). */
function balanced(src: string, from: number): string {
  const open = src[from]!;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let q: string | null = null;
  for (let j = from; j < src.length; j++) {
    const c = src[j]!;
    if (q) {
      if (c === '\\') j++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0 && c === close) return src.slice(from, j + 1);
    }
  }
  return src.slice(from);
}

/** A minified literal of plain data as JSON: quoted keys, !0/!1, .5 -> 0.5. */
function literal<T>(js: string): T {
  const json = js
    .replace(/([{,])\s*([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/:\s*!0\b/g, ':true')
    .replace(/:\s*!1\b/g, ':false')
    .replace(/([:[,])\s*\.(\d)/g, '$10.$2')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(json) as T;
}

const strings = (list: string | undefined): string[] =>
  list ? [...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!) : [];

function rowsOf(bundle: string): DriverV4Row[] {
  const out: DriverV4Row[] = [];
  for (const m of bundle.matchAll(/\{id:(\d+),vid:(\d+),pid:(\d+),/g)) {
    const c = balanced(bundle, m.index!);
    const f = (re: RegExp) => c.match(re)?.[1];
    const travel = c.match(/travelSetting:\{/);
    out.push({
      id: +m[1]!,
      vid: +m[2]!,
      pid: +m[3]!,
      displayName: f(/displayName:"([^"]*)"/) ?? '',
      company: f(/company:"([^"]*)"/) ?? '',
      type: f(/\btype:"([^"]*)"/) ?? '',
      internalName: f(/\bname:"([^"]*)"/) ?? '',
      keyLayout: f(/keyLayout:\w+\.([A-Za-z0-9_]+)/) ?? null,
      profiles: f(/\blayer:(\d+)/) ? +f(/\blayer:(\d+)/)! : null,
      magnetic: /magnetism:!0/.test(c),
      sideLight: /sideLightLayout:/.test(c),
      switchReplaceable: /isSwitchReplaceable:!0/.test(c),
      switchTypes: strings(f(/supportedSwitchTypes:\[([^\]]*)\]/)),
      travel: travel ? literal(balanced(c, travel.index! + 'travelSetting:'.length)) : null,
      // `screen:{mode:"16",size:{w:240,h:135},…}`: the size anywhere in the block.
      screen: (() => {
        const at = c.match(/screen:\{/);
        if (!at) return null;
        const s = balanced(c, at.index! + 'screen:'.length).match(/size:\{w:(\d+),h:(\d+)/);
        return s ? { w: +s[1]!, h: +s[2]! } : null;
      })(),
      knobKeyCodes: strings(f(/knobKeyCodes:\[([^\]]*)\]/)),
      debounce: /deBounce:/.test(c),
      sleep24: /sleep24:\{/.test(c),
      sleepBT: /sleepBT:\{/.test(c),
      chip: { yc3123: /isYC3123:!0/.test(c), ry6602: /isRY6602:!0/.test(c) },
    });
  }
  return out;
}

/** `Common98_SG9097_F` -> `keyboard_98_sg9097_f_keymappings_ui_info`. */
const gridName = (stem: string) => {
  const m = stem.match(/^Common(\d+)_(.+)$/);
  return m ? `keyboard_${m[1]}_${m[2]!.toLowerCase()}_keymappings_ui_info` : null;
};

/** The chunk a loader entry names for `name` (`…/<name>.ts":()=>u(()=>import("./<chunk>.js")`). */
function chunkFor(name: string, bundles: string[]): string | null {
  const re = new RegExp(
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '(?:\\.ts)?"?:\\(\\)=>(?:\\w+\\(\\(\\)=>)?import\\("\\.\\/([0-9a-f]+\\.js)"',
  );
  for (const b of bundles) {
    const m = b.match(re);
    if (m) return m[1]!;
  }
  return null;
}

/** Consumer usages a key grid names (the knob's turn and press). */
const CONSUMER: Record<string, number> = {
  AudioVolumeUp: 0xe9,
  AudioVolumeDown: 0xea,
  AudioVolumeMute: 0xe2,
  MediaPlayPause: 0xcd,
  MediaTrackNext: 0xb5,
  MediaTrackPrevious: 0xb6,
  MediaStop: 0xb7,
};

function keyOf(code: string, k: Record<string, unknown>): DriverV4Key {
  const hex = hidUsageForBrowserCode(code);
  const hid = hex ? parseInt(hex, 16) : null;
  const consumer = CONSUMER[code] ?? null;
  // The 4 bytes the factory matrix holds for this key: a usage at byte 2,
  // a consumer usage tagged 3, Fn as the app's own special binding.
  const matrixEntry =
    code === 'Fn'
      ? [10, 1, 0, 0]
      : hid !== null
        ? [0, (hid >> 8) & 0xff, hid & 0xff, 0]
        : consumer !== null
          ? [3, 0, consumer, 0]
          : [];
  const text = Array.isArray(k.displayText) ? (k.displayText as string[]).join(' ') : undefined;
  return {
    code,
    type: k.type === 'key' ? 'key' : 'knob',
    x: Number(k.x),
    y: Number(k.y),
    w: Number(k.width),
    h: Number(k.height),
    ...(text ? { text } : {}),
    matrixIndex: null,
    matrixEntry,
    hidUsage: hid,
    consumerUsage: consumer,
  };
}

function main() {
  if (!existsSync(DIST)) throw new Error(`Driver v4 not found at ${DIST} (set ASHARK_KB_APP)`);
  const all = files();
  const bundleFile = all.find(
    (f) => /^index\..*\.js$/.test(f) && /\{id:\d+,vid:\d+,pid:\d+,keyLayout:/.test(read(f)),
  );
  if (!bundleFile) throw new Error('no device table in any index.*.js');
  const bundle = read(bundleFile);
  const pkg = join(DIST, '..', '..', 'package.json');
  const version = existsSync(pkg)
    ? ((JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version ?? null)
    : null;
  const rows = rowsOf(bundle);
  const ours = rows.filter((r) => r.company === 'AttackShark' && r.type === 'keyboard');
  // The loader maps live in the index bundle and a few large chunks.
  const loaders = [
    bundle,
    ...all
      .filter((f) => f !== bundleFile)
      .map(read)
      .filter((s) => s.includes('import("./')),
  ];

  const layouts: DriverV4Registry['layouts'] = {};
  const missingLayouts: string[] = [];
  for (const stem of [
    ...new Set(ours.map((r) => r.keyLayout).filter((s): s is string => !!s)),
  ].sort()) {
    const name = gridName(stem);
    const chunk = name ? chunkFor(name, loaders) : null;
    const text = chunk ? read(chunk) : null;
    const at = text?.indexOf('{width:') ?? -1;
    if (!text || at < 0) {
      missingLayouts.push(stem);
      continue;
    }
    const grid = literal<{
      width: number;
      height: number;
      layout: Record<string, Record<string, unknown>>;
    }>(balanced(text, at));
    layouts[stem] = {
      canvas: { width: grid.width, height: grid.height },
      keys: Object.entries(grid.layout).map(([code, k]) => keyOf(code, k)),
    };
  }

  const matrices: Record<number, number[]> = {};
  const missingMatrices: string[] = [];
  for (const r of ours.filter((x) => x.internalName)) {
    const chunk = chunkFor(r.internalName, loaders);
    const m = chunk ? read(chunk).match(/defaultMatrix=\[([0-9,]+)\]/) : null;
    if (!m) missingMatrices.push(`${r.id} ${r.displayName}`);
    else matrices[r.id] = m[1]!.split(',').map(Number);
  }

  const registry: DriverV4Registry = {
    source: {
      app: 'Attack Shark Driver v4',
      version,
      bundle: bundleFile,
      extracted: new Date().toISOString(),
    },
    rows,
    layouts,
    matrices,
    missing: { layouts: missingLayouts, matrices: missingMatrices },
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'registry.json'), JSON.stringify(registry));
  console.log(
    `Driver v4 ${version ?? '?'} (${bundleFile}): ${rows.length} rows, ${ours.length} Attack Shark keyboards`,
  );
  console.log(
    `layouts: ${Object.keys(layouts).length} read, missing: ${missingLayouts.join(', ') || 'none'}`,
  );
  console.log(
    `matrices: ${Object.keys(matrices).length} read, missing: ${missingMatrices.join('; ') || 'none'}`,
  );
  const unknownCodes = new Set<string>();
  for (const l of Object.values(layouts))
    for (const k of l.keys) if (k.type === 'key' && !k.matrixEntry.length) unknownCodes.add(k.code);
  console.log(`key codes with no matrix entry: ${[...unknownCodes].join(', ') || 'none'}`);
}

main();
