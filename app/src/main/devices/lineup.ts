import type { DeviceDescriptor } from '@shared/types/device';
import { KEYBOARD_ROWS } from './catalog/generated/keyboard-rows';
import { KEYBOARDS_BY_ID } from './catalog/keyboards';
import { magneticWritable, slotLayoutFor } from './catalog/keyboard-builder';
import { HUB_CANDIDATES, HUB_MID_CLASS, hubMouseFor } from './catalog/hub-mice';
import { GEARHUB_MICE, GEARHUB_UNSUPPORTED } from './catalog/gearhub-mice';
import { jxcMouseRoster } from './catalog/jxc-mice';

/**
 * The supported-model tables of docs/devices/attack-shark-lineup.md, built
 * from the catalogues Shark Deck actually runs against — so the inventory
 * cannot say a model is driven when it is not. Written between the doc's
 * `generated:lineup` markers by `npm run lineup`; `lineup.test.ts` fails when
 * the doc and the catalogues disagree.
 */

/** art key -> the store's colour names (app/assets/devices/manifest.json). */
export type Colours = Readonly<Record<string, readonly string[]>>;

const HARDWARE_CHECKED: ReadonlySet<string> = new Set(['attack-shark-r85he', 'attack-shark-v8']);
const hex4 = (n: number) => n.toString(16).padStart(4, '0');
const usb = (vid: number, pid: number) => `${hex4(vid)}:${hex4(pid)}`;
const cell = (s: string) => s.replace(/\|/g, '\\|');

function support(d: DeviceDescriptor): string {
  if (d.identity === 'unsupported' || d.driver === 'no-io') return 'named only';
  return HARDWARE_CHECKED.has(d.model) ? '**checked on hardware**' : 'driven, not yet checked';
}

function colours(c: Colours, key: string | undefined): string {
  const list = key ? c[key] : undefined;
  return list?.length ? cell(list.join(', ')) : '—';
}

function keyboards(c: Colours): string {
  const out = [
    '| Model | Model id | USB | Command set | Switches | Key map | Wireless | Colours (photos) | Shark Deck |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  const rows = [...KEYBOARD_ROWS].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  for (const r of rows) {
    const d = KEYBOARDS_BY_ID.get(r.id)!;
    const status = slotLayoutFor(r).status;
    const switches = !r.magnetic
      ? 'mechanical'
      : d.capabilities.includes('magneticSwitches')
        ? 'Hall effect'
        : magneticWritable(r)
          ? 'Hall effect (no actuation menu yet)'
          : 'Hall effect (the vendor offers no settings)';
    const keyMap =
      d.identity === 'unsupported'
        ? '—'
        : status === 'verified'
          ? 'verified'
          : status === 'certain'
            ? 'imported, checked at connect'
            : 'none: whole-board settings';
    const radio =
      [r.sleep24 && '2.4 GHz', r.sleepBT && 'Bluetooth'].filter(Boolean).join(', ') || 'no';
    out.push(
      `| ${cell(d.displayName.replace(/^Attack Shark /, ''))} | ${r.id} | ${usb(r.vid, r.pid)} | ${r.family} | ${switches} | ${keyMap} | ${radio} | ${colours(c, d.artKey ?? d.model)} | ${support(d)} |`,
    );
  }
  return out.join('\n');
}

function mice(c: Colours): string {
  const out = [
    '| Model | Platform | USB | Identified by | Sensor | DPI | Colours (photos) | Shark Deck |',
    '|---|---|---|---|---|---|---|---|',
  ];
  const row = (d: DeviceDescriptor, platform: string, by: string, endpoints: string) =>
    out.push(
      `| ${cell(d.displayName.replace(/^Attack Shark /, ''))} | ${platform} | ${endpoints} | ${by} | ${d.spec.dpi?.sensor ?? '—'} | ${d.spec.dpi ? `${d.spec.dpi.min}–${d.spec.dpi.max}` : '—'} | ${colours(c, d.artKey ?? d.model)} | ${support(d)} |`,
    );
  const hubIds = 'receiver 3554:f517, fb44, fb35; cable f515, f516, fb43';
  row(hubMouseFor(5, 5), 'Compx Hub', 'cid 124, mid 5', hubIds);
  row(hubMouseFor(11, 5), 'Compx Hub', 'cid 124, mid 11', hubIds);
  row(hubMouseFor(20, 5), 'Compx Hub', 'cid 124, mid 20', hubIds);
  for (const [classKey, models] of Object.entries(HUB_CANDIDATES)) {
    const mids = Object.entries(HUB_MID_CLASS)
      .filter(([, v]) => `${v.sensor}-${v.maxDpi}` === classKey)
      .map(([mid]) => mid);
    const d = hubMouseFor(Number(mids[0]), 5);
    for (const m of models) {
      out.push(
        `| ${cell(m.name)} | Compx Hub | ${hubIds} | cid 124, mid not yet known (one of ${mids.join(', ')}) | ${d.spec.dpi?.sensor} | ${d.spec.dpi?.min}–${d.spec.dpi?.max} | ${colours(c, m.artKey)} | driven by its sensor class, not yet checked |`,
      );
    }
  }
  for (const d of new Set(GEARHUB_MICE.values())) {
    const ids = [...GEARHUB_MICE].filter(([, x]) => x === d).map(([i]) => i);
    row(d, 'GearHub-V5', `device id ${ids.join(', ')}`, 'cable 3151:4026, receiver 402d');
  }
  for (const [id, name] of GEARHUB_UNSUPPORTED) {
    out.push(
      `| ${cell(name.replace(/^Attack Shark /, ''))} (newer MCU) | GearHub | 3151:5043 | device id ${id} | — | — | ${colours(c, 'attack-shark-r2')} | named only |`,
    );
  }
  for (const d of jxcMouseRoster()) {
    const cable = {
      'attack-shark-r5-ultra': 0x46,
      'attack-shark-r6': 0x21,
      'attack-shark-r8': 0x3a,
    }[d.model];
    row(d, 'JXC', 'its PID', `cable 373e:${hex4(cable ?? 0)}, receiver ${hex4(d.pid)}`);
  }
  return out.join('\n');
}

/** The generated block, markers excluded. */
export function lineupTables(c: Colours): string {
  return [
    '### Keyboards',
    '',
    `${KEYBOARD_ROWS.length} Attack Shark model ids from the vendor's registry (via sharkfin).`,
    '',
    keyboards(c),
    '',
    '### Mice',
    '',
    mice(c),
  ].join('\n');
}

export const LINEUP_START = '<!-- generated:lineup — `npm run lineup` rewrites this block -->';
export const LINEUP_END = '<!-- /generated:lineup -->';

/** The doc with its generated block replaced. */
export function withLineup(doc: string, c: Colours): string {
  const a = doc.indexOf(LINEUP_START);
  const b = doc.indexOf(LINEUP_END);
  if (a < 0 || b < a) throw new Error('lineup markers not found');
  return doc.slice(0, a + LINEUP_START.length) + '\n\n' + lineupTables(c) + '\n\n' + doc.slice(b);
}

/** art key -> colour names, from the manifest's JSON. */
export function coloursOf(manifest: {
  models: Record<string, { variants: Record<string, { colour: string }> }>;
}): Colours {
  return Object.fromEntries(
    Object.entries(manifest.models).map(([k, m]) => [
      k,
      Object.values(m.variants).map((v) => v.colour),
    ]),
  );
}
