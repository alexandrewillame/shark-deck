import type { DeviceDescriptor } from '@shared/types/device';
import { KEYBOARD_ROWS } from './catalog/generated/keyboard-rows';
import { KEYBOARDS_BY_ID } from './catalog/keyboards';
import { slotLayoutFor } from './catalog/keyboard-builder';
import { HUB_CANDIDATES, HUB_MID_CLASS, hubMouseFor } from './catalog/hub-mice';
import { GEARHUB_MICE, GEARHUB_UNSUPPORTED } from './catalog/gearhub-mice';
import { jxcMouseRoster, jxcUnconfirmedNames } from './catalog/jxc-mice';
import { bekenRoster } from './catalog/beken-mice';

/**
 * The device tables of docs/devices/attack-shark-lineup.md, built from the
 * catalogues Shark Deck actually runs against — so the list cannot say a model
 * is supported when it is not. Written between the doc's `generated:lineup`
 * markers by `npm run lineup`; `lineup.test.ts` fails when the doc and the
 * catalogues disagree.
 *
 * Every row carries one status, with its colour (GitHub draws no cell colours,
 * but it draws emoji in colour, in both themes), and the rows are sorted by it:
 * what is tested first, what cannot be changed last.
 */

type Status = 'tested' | 'works' | 'partial' | 'recognised';

const STATUS: Record<Status, { cell: string; rank: number }> = {
  tested: { cell: '🟢 Tested', rank: 0 },
  works: { cell: '🟡 Should work', rank: 1 },
  partial: { cell: '🟠 Partial', rank: 2 },
  recognised: { cell: '⚪ Recognised', rank: 3 },
};

/** Checked on a real unit: frames confirmed, read back, written. */
const HARDWARE_CHECKED: ReadonlySet<string> = new Set(['attack-shark-r85he', 'attack-shark-v8']);

interface Row {
  status: Status;
  name: string;
  /** Tie-break within a name (keyboards: the model id). */
  order: number;
  cells: string[];
}

const cell = (s: string) => s.replace(/\|/g, '\\|');
const shortName = (d: DeviceDescriptor) => d.displayName.replace(/^Attack Shark /, '');

function sorted(rows: Row[]): Row[] {
  return [...rows].sort(
    (a, b) =>
      STATUS[a.status].rank - STATUS[b.status].rank ||
      a.name.localeCompare(b.name) ||
      a.order - b.order,
  );
}

function table(head: string[], rows: Row[]): string {
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...sorted(rows).map((r) => `| ${[STATUS[r.status].cell, ...r.cells].join(' | ')} |`),
  ].join('\n');
}

function keyboardRows(): Row[] {
  return KEYBOARD_ROWS.map((r) => {
    const d = KEYBOARDS_BY_ID.get(r.id)!;
    const layout = slotLayoutFor(r).status;
    const radio = [r.sleep24 && '2.4 GHz', r.sleepBT && 'Bluetooth'].filter(Boolean).join(', ');
    let status: Status;
    let note = '';
    if (d.identity === 'unsupported' || d.driver === 'no-io') {
      status = 'recognised';
      note = 'Its command set has no driver yet.';
    } else if (HARDWARE_CHECKED.has(d.model)) {
      status = 'tested';
    } else if (layout === 'none') {
      status = 'partial';
      note = 'Whole-keyboard settings only: its key map is not known yet.';
    } else if (r.magnetic && !d.capabilities.includes('magneticSwitches')) {
      status = 'partial';
      note = 'No actuation menu yet: its magnetic settings use other units.';
    } else {
      status = 'works';
    }
    return {
      status,
      name: shortName(d),
      order: r.id,
      cells: [
        cell(shortName(d)),
        String(r.id),
        r.magnetic ? 'Hall effect' : 'mechanical',
        radio || '—',
        note,
      ],
    };
  });
}

function mouseRows(): Row[] {
  const rows: Row[] = [];
  const add = (status: Status, name: string, d: DeviceDescriptor | null, note = '') =>
    rows.push({
      status,
      name,
      order: 0,
      cells: [
        cell(name),
        d?.spec.dpi?.sensor ?? '—',
        d?.spec.dpi ? `${d.spec.dpi.min}–${d.spec.dpi.max}` : '—',
        note,
      ],
    });
  const driven = (d: DeviceDescriptor) =>
    add(HARDWARE_CHECKED.has(d.model) ? 'tested' : 'works', shortName(d), d);

  // Compx Hub: the models whose number (mid) is known, by name.
  for (const mid of [5, 11, 20]) driven(hubMouseFor(mid, 5));
  // …and the ones still driven by the settings their sensor class shares.
  for (const [classKey, models] of Object.entries(HUB_CANDIDATES)) {
    const mid = Object.entries(HUB_MID_CLASS).find(
      ([, v]) => `${v.sensor}-${v.maxDpi}` === classKey,
    )![0];
    const d = hubMouseFor(Number(mid), 5);
    for (const m of models) {
      add(
        'partial',
        m.name,
        d,
        'Its sensor’s common settings only: its model number is not known yet.',
      );
    }
  }
  for (const d of new Set(GEARHUB_MICE.values())) driven(d);
  for (const [, name] of GEARHUB_UNSUPPORTED) {
    add(
      'recognised',
      `${name.replace(/^Attack Shark /, '')} (newer chip)`,
      null,
      'Its command set has no driver yet.',
    );
  }
  for (const d of jxcMouseRoster()) driven(d);
  for (const name of jxcUnconfirmedNames()) {
    add(
      'recognised',
      name,
      null,
      'Its USB ids are another brand’s too; shown until one is confirmed.',
    );
  }
  for (const m of bekenRoster()) {
    add(
      'recognised',
      m.name.replace(/^Attack Shark /, ''),
      null,
      'Beken chip: the settings protocol is not confirmed yet — [why](../protocol/mouse-beken.md).',
    );
  }
  return rows;
}

/** The generated block, markers excluded. */
export function lineupTables(): string {
  const mice = mouseRows();
  const keyboards = keyboardRows();
  const count = (s: Status) => [...mice, ...keyboards].filter((r) => r.status === s).length;
  return [
    `**At a glance:** ${(['tested', 'works', 'partial', 'recognised'] as const)
      .map((s) => `${STATUS[s].cell} ${count(s)}`)
      .join(' · ')}`,
    '',
    '## Mice',
    '',
    table(['Status', 'Model', 'Sensor', 'DPI', 'Notes'], mice),
    '',
    '## Keyboards',
    '',
    'One row per firmware model id: a name can cover several versions (wired or wireless, Hall effect or mechanical), and Shark Deck tells them apart when the keyboard connects.',
    '',
    table(['Status', 'Model', 'Model id', 'Switches', 'Wireless', 'Notes'], keyboards),
  ].join('\n');
}

export const LINEUP_START = '<!-- generated:lineup — `npm run lineup` rewrites this block -->';
export const LINEUP_END = '<!-- /generated:lineup -->';

/** The doc with its generated block replaced. */
export function withLineup(doc: string): string {
  const a = doc.indexOf(LINEUP_START);
  const b = doc.indexOf(LINEUP_END);
  if (a < 0 || b < a) throw new Error('lineup markers not found');
  return doc.slice(0, a + LINEUP_START.length) + '\n\n' + lineupTables() + '\n\n' + doc.slice(b);
}
