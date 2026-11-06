/**
 * Import the Attack Shark keyboard registry and key layouts from sharkfin.
 *
 *   npm run import:kb               # download (cached per commit) + regenerate
 *   npm run import:kb -- --offline  # regenerate from the cache only
 *
 * sharkfin (https://github.com/dniminenn/sharkfin, GPL-3.0-or-later, the same
 * licence family as Shark Deck) keeps a registry of ~1400 ROYUAN boards and
 * their key layouts, extracted from the vendor's own web/desktop app and from
 * firmware images on the vendor's update channel. We take:
 *
 *  - every Attack Shark row (+ the AJAZZ x Attack Shark co-brand board) ->
 *    src/main/devices/catalog/generated/keyboard-rows.ts
 *  - layouts where EVERY key has a firmware slot (`matrixIndex`) — stricter
 *    than sharkfin's own "any key has one" — as addressable layouts ->
 *    generated/vendor-layouts.ts
 *  - every other Attack Shark layout as drawing-only geometry (no slots, so
 *    nothing can address a key through it) -> generated/layout-geometry.ts
 *  - every non-Attack-Shark id -> brand, for the "Not an Attack Shark device"
 *    card -> generated/foreign-ids.ts
 *  - an append-only id -> slug lock (generated/slugs.lock.json): every
 *    per-model store (profiles, colours, backups) is keyed by slug, so a
 *    renamed slug would orphan a user's data. The script refuses to rename.
 *
 * Downloads land in scripts/_raw/sharkfin/<commit>/ (git-ignored). Pinned to
 * one commit so a regeneration is reproducible; bump SHARKFIN_REF on purpose
 * and review the diff.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as prettier from 'prettier';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  convertLayout,
  isCertain,
  parseRates,
  parseTravel,
  type SharkfinLayout,
} from '../src/main/devices/catalog/sharkfin-convert';
import type { KeyboardRow } from '../src/main/devices/catalog/keyboard-row';
import { KEYBOARD_RESOLUTIONS } from '../src/main/devices/catalog/keyboard-resolutions';

const SHARKFIN_REF = '8c999ba7d44254f5206fb0ff25ed7cea6ebbb496'; // 2026-11-03
const BASE = `https://raw.githubusercontent.com/dniminenn/sharkfin/${SHARKFIN_REF}`;

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = resolve(APP, 'scripts/_raw/sharkfin', SHARKFIN_REF);
const OUT = resolve(APP, 'src/main/devices/catalog/generated');
const FIXTURES = resolve(APP, 'test/fixtures/sharkfin');
const OFFLINE = process.argv.includes('--offline');

/** The AJAZZ x Attack Shark one-handed board sold on the Attack Shark store. */
const CO_BRANDED = new Set([4244]);

/** Ids whose cleaned vendor name is not the retail name. */
const NAME_OVERRIDES: Record<number, string> = {
  2308: 'X65 PRO HE',
  2938: 'X65 PRO HE',
  3379: 'X65 (UK)',
  4244: 'AK029 V2',
};

/** The R85HE predates the lock; its stores are keyed by this slug. */
const LEGACY_SLUGS: Record<number, string> = { 3123: 'attack-shark-r85he' };

interface RegistryRow {
  id: number;
  displayName: string;
  company?: string;
  vendor?: string;
  vendorId: number;
  productId: number;
  internalName?: string;
  name?: string;
  keyLayout?: string;
  profiles?: number;
  magnetic?: boolean;
  family?: string;
  bulkKeymap?: boolean;
  screen?: { w: number; h: number } | null;
  travel?: unknown;
  switchReplaceable?: boolean;
  switchTypes?: { code: number; name: string }[];
  features?: {
    knob?: string[];
    debounce?: boolean;
    sleep24?: boolean;
    sleepBT?: boolean;
    sideLight?: boolean;
  };
}

async function fetchCached(rel: string): Promise<string | null> {
  const file = join(CACHE, rel);
  if (existsSync(file)) return readFileSync(file, 'utf8');
  if (OFFLINE) return null;
  const res = await fetch(`${BASE}/${rel}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  const text = await res.text();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return text;
}

const isAttackShark = (r: RegistryRow) =>
  r.company === 'AttackShark' || r.vendor === 'AttackShark' || CO_BRANDED.has(r.id);

export function marketingName(id: number, vendorName: string): string {
  if (NAME_OVERRIDES[id]) return NAME_OVERRIDES[id]!;
  return vendorName
    .replace(/UItra/g, 'Ultra') // vendor typo: capital I for l
    .replace(/ULTRA/g, 'Ultra')
    .replace(/PROHE/g, 'PRO HE')
    .replace(/^([A-Z]+\d+)(?=[A-Za-z])/, '$1 ') // "X68PRO HE" -> "X68 PRO HE"
    .replace(/\bpro\b/g, 'PRO')
    .replace(/(\S)HE\b/g, '$1 HE')
    .replace(/\s+/g, ' ')
    .trim();
}

const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function layoutPath(stem: string): string {
  // sharkfin keeps the X86's hand-checked picture outside the vendor folder.
  return stem === 'Common80_k72x86'
    ? 'app/src/lib/layouts/x86.json'
    : `app/src/lib/layouts/vendor/${stem}.json`;
}

const banner = (what: string) =>
  `// GENERATED by scripts/import-keyboard-registry.ts — do not edit; run \`npm run import:kb\`.\n` +
  `// ${what}\n` +
  `// Source: sharkfin @ ${SHARKFIN_REF} (https://github.com/dniminenn/sharkfin),\n` +
  `// GPL-3.0-or-later, extracted by its author from the vendor app and firmware.\n` +
  `// provenance: ported-from-vendor (via sharkfin) — unverified on hardware except\n` +
  `// where a hand-written descriptor overlays a row (the R85HE).\n`;

async function main() {
  const devicesText = await fetchCached('app/src-tauri/data/devices.json');
  if (!devicesText) throw new Error('devices.json unavailable (offline with an empty cache?)');
  const registry = JSON.parse(devicesText) as RegistryRow[];

  // An id Attack Shark's own Driver v4 lists as theirs stays ours even where
  // sharkfin's newer table files it under another brand (3379: the X65 UK
  // board, also sold as WINSTAR RK-X44-68 — same internal name and PCB).
  const v4Ids = new Set(driverV4Rows().map((d) => d.id));
  const ours = registry.filter((r) => isAttackShark(r) || v4Ids.has(r.id));
  const foreign = registry.filter((r) => !isAttackShark(r) && !v4Ids.has(r.id));
  ours.push(...driverV4Only(new Set(registry.map((r) => r.id))));
  ours.sort((a, b) => a.id - b.id);
  applyResolutions(ours);

  // --- slugs (append-only) -------------------------------------------------
  const lockFile = join(OUT, 'slugs.lock.json');
  const lock: Record<string, string> = existsSync(lockFile)
    ? JSON.parse(readFileSync(lockFile, 'utf8'))
    : {};
  for (const r of ours) {
    const want =
      LEGACY_SLUGS[r.id] ?? `attack-shark-${kebab(marketingName(r.id, r.displayName))}-${r.id}`;
    const have = lock[r.id];
    if (have && have !== want) {
      console.warn(
        `slug for ${r.id} stays "${have}" (would now be "${want}") — slugs never change`,
      );
    } else if (!have) {
      lock[r.id] = want;
    }
  }

  // --- layouts -------------------------------------------------------------
  const stems = [...new Set(ours.map((r) => r.keyLayout ?? 'Unknown'))].filter(
    (s) => s && s !== 'Unknown',
  );
  const addressable: Record<string, ReturnType<typeof convertLayout>> = {};
  const geometry: Record<string, ReturnType<typeof convertLayout>> = {};
  const pictures: Record<string, SharkfinLayout> = {};
  const missing: string[] = [];
  for (const stem of stems.sort()) {
    const text = await fetchCached(layoutPath(stem));
    if (!text) {
      missing.push(stem);
      continue;
    }
    const layout = JSON.parse(text) as SharkfinLayout;
    pictures[stem] = layout;
    if (isCertain(layout)) addressable[stem] = convertLayout(layout);
    else geometry[stem] = convertLayout(layout, { geometryOnly: true });
    if (stem === 'Common79_SG9047') {
      mkdirSync(FIXTURES, { recursive: true });
      writeFileSync(join(FIXTURES, 'Common79_SG9047.json'), text);
    }
  }

  // --- per-board slot maps (only when vendor matrices are on disk) ---------
  // `npm run extract:kb` against an unpacked Driver v4 writes every board's
  // factory matrix; with it, a drawing-only picture becomes addressable for
  // THAT board (each key's matrixEntry matched to its one slot, or the board
  // stays whole-board if any key is ambiguous).
  const matrices = readMatrices();
  const slotLayoutOf = (r: RegistryRow): string | null => {
    const stem = r.keyLayout ?? 'Unknown';
    if (addressable[stem]) return stem;
    const m = matrices[r.id];
    if (!m || !pictures[stem]) return null;
    try {
      const key = `${stem}#${r.id}`;
      addressable[key] = convertLayout(pictures[stem]!, { defaultMatrix: m });
      return key;
    } catch (e) {
      console.warn(`${r.id}: ${stem} stays whole-board — ${(e as Error).message}`);
      return null;
    }
  };

  // --- rows ----------------------------------------------------------------
  const rows: KeyboardRow[] = ours.map((r) => {
    const family: KeyboardRow['family'] =
      r.family === 'yc500' ? 'yc500' : r.family === 'gen2' ? 'gen2' : 'unknown';
    const internalName = r.internalName ?? r.name ?? '';
    return {
      id: r.id,
      slug: lock[r.id]!,
      name: marketingName(r.id, r.displayName),
      vendorName: r.displayName,
      internalName,
      vid: r.vendorId,
      pid: r.productId,
      family,
      layout: r.keyLayout ?? 'Unknown',
      slotLayout: slotLayoutOf(r),
      profiles: r.profiles ?? 1,
      magnetic: !!r.magnetic,
      travel: parseTravel(r.travel),
      switchReplaceable: !!r.switchReplaceable,
      switchTypes: r.switchTypes ?? [],
      screen: r.screen ? { w: r.screen.w, h: r.screen.h } : null,
      knob: (r.features?.knob ?? []).length > 0,
      debounce: !!r.features?.debounce,
      sleep24: !!r.features?.sleep24,
      sleepBT: !!r.features?.sleepBT,
      sideLight: !!r.features?.sideLight,
      rates: parseRates(internalName),
      bulkKeymap: !!r.bulkKeymap,
    };
  });

  // --- foreign ids ---------------------------------------------------------
  const brands = [...new Set(foreign.map((r) => r.company || r.vendor || 'unknown'))].sort();
  const foreignPairs = foreign
    .map((r) => [r.id, brands.indexOf(r.company || r.vendor || 'unknown')] as const)
    .sort((a, b) => a[0] - b[0]);

  // --- write ---------------------------------------------------------------
  // Through prettier, with the repo's own config: written raw, every re-import
  // would show as a formatting diff after the next `npm run format`.
  const pending = new Map<string, string>();
  const queue = (file: string, text: string) => void pending.set(file, text);
  mkdirSync(OUT, { recursive: true });
  queue(lockFile, JSON.stringify(sortKeys(lock), null, 2) + '\n');

  queue(
    join(OUT, 'keyboard-rows.ts'),
    banner(`${rows.length} Attack Shark keyboard rows.`) +
      `import type { KeyboardRow } from '../keyboard-row';\n\n` +
      `export const KEYBOARD_ROWS: KeyboardRow[] = ${JSON.stringify(rows, null, 2)};\n`,
  );

  queue(
    join(OUT, 'vendor-layouts.ts'),
    banner(
      `Addressable layouts: every key carries a firmware slot (col-major, slot = col*6 + row).`,
    ) +
      `import type { KeyLayoutEntry } from '@shared/types/keys';\n\n` +
      `export const VENDOR_LAYOUTS: Record<string, KeyLayoutEntry[]> = ${JSON.stringify(addressable, null, 2)};\n`,
  );

  queue(
    join(OUT, 'layout-geometry.ts'),
    banner(`Drawing-only layouts: NO slots, so nothing can address a key through them.`) +
      `import type { KeyLayoutEntry } from '@shared/types/keys';\n\n` +
      `export const LAYOUT_GEOMETRY: Record<string, KeyLayoutEntry[]> = ${JSON.stringify(geometry, null, 2)};\n`,
  );

  queue(
    join(OUT, 'foreign-ids.ts'),
    banner(`Model ids the vendor registry gives to OTHER brands, for the read-only card.`) +
      `export const FOREIGN_BRANDS: string[] = ${JSON.stringify(brands)};\n\n` +
      `/** [model id, index into FOREIGN_BRANDS], sorted by id. */\n` +
      `export const FOREIGN_IDS: [number, number][] = ${JSON.stringify(foreignPairs)};\n`,
  );
  for (const [file, text] of pending) {
    const options = { ...(await prettier.resolveConfig(file)), filepath: file };
    writeFileSync(file, await prettier.format(text, options));
  }

  // --- report --------------------------------------------------------------
  console.log(`rows: ${rows.length} Attack Shark (+ co-brand), ${foreign.length} foreign ids`);
  console.log(
    `layouts: ${Object.keys(addressable).length} addressable, ${Object.keys(geometry).length} geometry-only, ${missing.length} missing`,
  );
  if (missing.length) console.log(`  missing: ${missing.join(', ')}`);
  const byLayout = (r: KeyboardRow) =>
    r.slotLayout ? 'addressable' : geometry[r.layout] ? 'geometry' : 'none';
  for (const r of rows) {
    console.log(
      `  ${String(r.id).padStart(4)} ${r.family.padEnd(5)} ${r.vid.toString(16)}:${r.pid.toString(16).padStart(4, '0')} ` +
        `${r.magnetic ? 'HE ' : 'mech'} ${r.name.padEnd(14)} ${r.layout.padEnd(28)} ${byLayout(r)}`,
    );
  }
  crossCheck(rows);
}

interface V4Row {
  id: number;
  vid: number;
  pid: number;
  keyLayout: string | null;
  name: string | null;
  layer: number | null;
  magnetic: boolean;
  hasSideLight: boolean;
  screen: boolean;
  company: string;
  displayName: string;
}

/** Our own Driver v4 extraction (git-ignored, so absent on CI). */
function driverV4Rows(): V4Row[] {
  const v4File = resolve(APP, 'scripts/_raw/kb-devices.json');
  if (!existsSync(v4File)) return [];
  return (JSON.parse(readFileSync(v4File, 'utf8')) as V4Row[]).filter(
    (d) => d.company === 'AttackShark',
  );
}

/**
 * Attack Shark ids our Driver v4 extraction has and sharkfin does not (3379,
 * a UK-layout X65). Built from the v4 row; its wireless/debounce flags are
 * unknown there, so they stay off — the conservative reading.
 */
function driverV4Only(have: Set<number>): RegistryRow[] {
  return driverV4Rows()
    .filter((d) => !have.has(d.id))
    .map((d) => ({
      id: d.id,
      displayName: d.displayName,
      company: 'AttackShark',
      vendorId: d.vid,
      productId: d.pid,
      internalName: d.name ?? '',
      keyLayout: d.keyLayout ?? 'Unknown',
      profiles: d.layer ?? 1,
      magnetic: d.magnetic,
      family: (d.name ?? '').startsWith('ry5088_') ? 'gen2' : 'unknown',
      screen: null,
      features: { sideLight: d.hasSideLight },
    }));
}

function applyResolutions(rows: RegistryRow[]) {
  const v4 = new Map(driverV4Rows().map((d) => [d.id, d]));
  for (const r of rows) {
    const d = v4.get(r.id);
    if (r.id === 2938 && d?.layer != null && r.profiles != null) {
      r.profiles = Math.min(r.profiles, d.layer);
    }
  }
}

/** Compare against our own Driver v4 extraction, when it is on disk. */
function crossCheck(rows: KeyboardRow[]) {
  const v4 = driverV4Rows();
  if (!v4.length) return;
  const diffs: string[] = [];
  for (const d of v4) {
    const r = rows.find((x) => x.id === d.id);
    if (!r) {
      diffs.push(`${d.id} ${d.displayName}: in Driver v4, missing from sharkfin`);
      continue;
    }
    const pairs: [string, unknown, unknown][] = [
      ['pid', d.pid, r.pid],
      ['layout', d.keyLayout, r.layout],
      ['profiles', d.layer, r.profiles],
      ['magnetic', d.magnetic, r.magnetic],
      ['sideLight', d.hasSideLight, r.sideLight],
      ['screen', d.screen, r.screen !== null],
    ];
    for (const [k, a, b] of pairs) {
      if (a === b || KEYBOARD_RESOLUTIONS[d.id]?.field === k) continue;
      diffs.push(`${d.id} ${d.displayName}: ${k} v4=${a} sharkfin=${b}`);
    }
  }
  console.log(`cross-check vs Driver v4: ${v4.length} rows, ${diffs.length} disagreements`);
  for (const d of diffs) console.log(`  ${d}`);
}

/** Per-board factory matrices from `npm run extract:kb`, keyed by model id. */
function readMatrices(): Record<number, number[]> {
  const f = resolve(APP, 'scripts/_raw/kb-matrices.json');
  if (!existsSync(f)) return {};
  const raw = JSON.parse(readFileSync(f, 'utf8')) as Record<string, { defaultMatrix: number[] }>;
  return Object.fromEntries(Object.entries(raw).map(([id, v]) => [Number(id), v.defaultMatrix]));
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort((a, b) => Number(a[0]) - Number(b[0])));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
