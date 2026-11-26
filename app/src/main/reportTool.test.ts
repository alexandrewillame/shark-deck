import { KEYBOARDS_BY_ID } from './devices/catalog/keyboards';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo/app' } }));
vi.mock('node-hid', () => ({
  default: { devicesAsync: async () => [], HIDAsync: { open: vi.fn() } },
}));
vi.mock('./devices/manager', () => ({ deviceManager: { getDescriptor: () => null } }));

const { previewArgs, reportToolArgs, unixToolCommand, LINUX_TERMINALS, usbHidSummaries } =
  await import('./reportTool');
const { supportPlan } = await import('./devices/support');
const { bekenDescriptorFor, bekenMouseRoster } = await import('./devices/catalog/beken-mice');
const { KEYBOARDS } = await import('./devices/catalog/keyboards');
const { hubMouseRoster } = await import('./devices/catalog/hub-mice');
const { CATALOG } = await import('./devices/catalog');
const { BUTTON_ACTIONS_TREE } = await import('@shared/mouse-buttons');

/**
 * The device report tool, started from a device's invitation: its command
 * line comes from the catalogue alone (what the device lacks), and every
 * step word the catalogue asks for has to be one the tool knows.
 */

const X1 = bekenDescriptorFor(0x2111)!; // an Attack Shark model with no driver
const X8_PRO = bekenMouseRoster()[0]!;
/** The X11 on its cable: its macros are what no recording of it has shown. */
const X11 = bekenDescriptorFor(0xfa55)!;

describe('reportToolArgs', () => {
  it('records a device with no driver whole, on Windows', () => {
    expect(reportToolArgs(X1, supportPlan(X1)!.record, 'win32')).toEqual([
      '--device',
      '1D57:2111',
      '--record',
      '--kind',
      'mouse',
    ]);
  });

  it('records only what a device lacks', () => {
    // The X11 lacks its macros: the tool's macro steps, after the start-up reads.
    expect(reportToolArgs(X11, supportPlan(X11)!.record, 'win32')).toEqual([
      '--device',
      '1D57:FA55',
      '--record',
      '--kind',
      'mouse',
      '--steps',
      'start,macro',
    ]);
    expect(reportToolArgs(X8_PRO, ['deep', 'macro', 'specific'], 'win32').slice(2)).toEqual([
      '--record',
      '--kind',
      'mouse',
      '--steps',
      'deep,macro,specific',
    ]);
  });

  it('records on Linux as on Windows, and makes the report alone where a report names the model and on macOS', () => {
    expect(reportToolArgs(X8_PRO, ['deep'], 'linux')).toEqual([
      '--device',
      '1D57:FA65',
      '--record',
      '--kind',
      'mouse',
      '--steps',
      'deep',
    ]);
    expect(reportToolArgs(X1, 'all', 'linux')).toEqual([
      '--device',
      '1D57:2111',
      '--record',
      '--kind',
      'mouse',
    ]);
    expect(reportToolArgs(X1, 'report', 'win32')).toEqual(['--device', '1D57:2111', '--no-record']);
    expect(reportToolArgs(X1, 'report', 'linux')).toEqual(['--device', '1D57:2111', '--no-record']);
    expect(reportToolArgs(X8_PRO, 'all', 'darwin')).toEqual(['--device', '1D57:FA65']);
  });

  it('says what the device is, so the recording does not ask', () => {
    const r98 = KEYBOARDS_BY_ID.get(3743)!;
    expect(reportToolArgs(r98, ['other'], 'win32').slice(2, 5)).toEqual([
      '--record',
      '--kind',
      'keyboard',
    ]);
  });

  it('passes only plain words as steps', () => {
    expect(reportToolArgs(X8_PRO, ['deep', 'x & del', 'macro'], 'win32').at(-1)).toBe('deep,macro');
    expect(reportToolArgs(X8_PRO, ['x & del'], 'linux').at(-1)).toBe('specific');
  });

  it('shows a demo device the steps its owner would follow, recording nothing', () => {
    expect(previewArgs('mouse', supportPlan(X11)!.record)).toEqual([
      '--preview-steps',
      'mouse',
      '--steps',
      'start,macro',
    ]);
    expect(previewArgs('keyboard', ['act', 'dks'])).toEqual([
      '--preview-steps',
      'keyboard',
      '--steps',
      'act,dks',
    ]);
    expect(previewArgs('mouse', 'all')).toEqual(['--preview-steps', 'mouse']);
    expect(previewArgs('mouse', 'report')).toBeNull();
  });

  it('keeps the shell window open at the end on macOS and Linux', () => {
    const run = unixToolCommand('/opt/Shark Deck/tools/sharkdeck-device-report.sh', [
      '--device',
      '1D57:2111',
    ]);
    expect(run.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(run[2]).toMatch(/read _$/);
    expect(run.slice(3)).toEqual([
      '/opt/Shark Deck/tools/sharkdeck-device-report.sh',
      '--device',
      '1D57:2111',
    ]);
    expect(LINUX_TERMINALS.map(([t]) => t)).toContain('xterm');
  });
});

describe('the steps the catalogue asks for', () => {
  const bat = readFileSync(resolve(process.cwd(), '../tools/SharkDeck-device-report.bat'), 'utf8');
  // The tool's step table: `<id>|<kind>|<group>|…`, the id's first word its group.
  const groups = new Set(
    [...bat.matchAll(/^([a-z]+)\.[a-z0-9.-]+\|(?:mouse|keyboard|both)\|/gm)].map((m) => m[1]),
  );

  it('reads the tool’s own step table', () => {
    for (const g of ['start', 'dpi', 'deep', 'macro', 'key', 'perkey', 'act', 'light']) {
      expect(groups, g).toContain(g);
    }
    expect(bat).toContain("'--steps'");
    expect(bat).toContain('function StepTableFor');
  });

  it('are all steps the tool has, or its "something specific" one', () => {
    const asked = [...CATALOG, ...KEYBOARDS, ...hubMouseRoster(), ...bekenMouseRoster()]
      .map((d) => d.spec.support?.record)
      .filter((r): r is string[] => Array.isArray(r))
      .flat();
    expect(asked.length).toBeGreaterThan(0);
    for (const w of new Set(asked)) {
      expect(w === 'specific' || groups.has(w), `the tool has no "${w}" step`).toBe(true);
    }
  });

  it('names what it asks for: never only "do one thing the software should learn"', () => {
    // That open step is for an owner who knows what is wrong and chooses it
    // in the tool; what Shark Deck asks for, it names.
    for (const d of [...CATALOG, ...KEYBOARDS, ...hubMouseRoster(), ...bekenMouseRoster()]) {
      const r = d.spec.support?.record;
      if (!r) continue;
      expect(r === 'specific' || (Array.isArray(r) && r.includes('specific')), d.model).toBe(false);
    }
  });

  it("names in its media steps every media key the X8 PRO's first recordings left out", () => {
    const media = [...bat.matchAll(/^media\.[a-z]+\|mouse\|Media keys\|([^|]*)\|/gm)].map(
      (m) => m[1],
    );
    const offered = BUTTON_ACTIONS_TREE.find((a) => a.key === 'multimedia')!.children!.map(
      (c) => c.labelEn,
    );
    // Its owner's two recordings set button 4 to these (btn.b4.*): the rest is guessed or unknown.
    const recorded = ['Play/Pause', 'Next Track', 'Volume-', 'Volume+'];
    const missing = offered.filter((label) => !recorded.includes(label));
    expect(missing.length).toBeGreaterThan(10);
    for (const label of missing) expect(media, label).toContain(label);
    // Its owner recorded them all since (11-23, 11-24): it asks for nothing now.
    expect(supportPlan(X8_PRO)).toBeUndefined();
  });
});

// A device Shark Deck does not list (Settings, "Missing a device?"): what is
// plugged in, one entry per USB id, the keyboards and mice first.
describe('usbHidSummaries', () => {
  const c = (vid: number, pid: number, usagePage: number, usage: number, product?: string) => ({
    path: `${vid}:${pid}:${usagePage}:${usage}`,
    vendorId: vid,
    productId: pid,
    usagePage,
    usage,
    interface: 0,
    product,
  });
  it('gives one entry per USB id, a keyboard collection deciding, the listed ones last', () => {
    const out = usbHidSummaries(
      [
        // The X66's owner: a board Shark Deck has no id for (made-up ids).
        c(0x1234, 0x0066, 1, 2, 'X66'),
        c(0x1234, 0x0066, 1, 6, 'X66'),
        c(0x1234, 0x0066, 0xff00, 1),
        // A board Shark Deck shows.
        c(0x3151, 0x5029, 1, 6, 'R98HE'),
        // A headset: neither.
        c(0x1038, 0x12ad, 12, 1, 'Arctis 7'),
        c(0, 0, 1, 6),
      ],
      (vid) => vid === 0x3151,
    );
    expect(out.map((d) => [d.product, d.kind, d.listed])).toEqual([
      ['X66', 'keyboard', false],
      ['Arctis 7', 'other', false],
      ['R98HE', 'keyboard', true],
    ]);
  });
});
