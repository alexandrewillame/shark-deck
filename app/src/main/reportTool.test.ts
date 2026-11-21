import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo/app' } }));
vi.mock('node-hid', () => ({
  default: { devicesAsync: async () => [], HIDAsync: { open: vi.fn() } },
}));
vi.mock('./devices/manager', () => ({ deviceManager: { getDescriptor: () => null } }));

const { previewArgs, reportToolArgs, unixToolCommand, LINUX_TERMINALS } =
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

describe('reportToolArgs', () => {
  it('records a device with no driver whole, on Windows', () => {
    expect(reportToolArgs(X1, supportPlan(X1)!.record, 'win32')).toEqual([
      '--device',
      '1D57:2111',
      '--record',
    ]);
  });

  it('records only what a device lacks', () => {
    // The X8 PRO lacks some media keys: the tool's "Media keys" steps name each.
    expect(reportToolArgs(X8_PRO, supportPlan(X8_PRO)!.record, 'win32')).toEqual([
      '--device',
      '1D57:FA65',
      '--record',
      '--steps',
      'media',
    ]);
    expect(reportToolArgs(X8_PRO, ['deep', 'macro', 'specific'], 'win32').slice(2)).toEqual([
      '--record',
      '--steps',
      'deep,macro,specific',
    ]);
  });

  it('records on Linux as on Windows, and makes the report alone where a report names the model and on macOS', () => {
    expect(reportToolArgs(X8_PRO, ['deep'], 'linux')).toEqual([
      '--device',
      '1D57:FA65',
      '--record',
      '--steps',
      'deep',
    ]);
    expect(reportToolArgs(X1, 'all', 'linux')).toEqual(['--device', '1D57:2111', '--record']);
    expect(reportToolArgs(X1, 'report', 'win32')).toEqual(['--device', '1D57:2111', '--no-record']);
    expect(reportToolArgs(X1, 'report', 'linux')).toEqual(['--device', '1D57:2111', '--no-record']);
    expect(reportToolArgs(X8_PRO, 'all', 'darwin')).toEqual(['--device', '1D57:FA65']);
  });

  it('passes only plain words as steps', () => {
    expect(reportToolArgs(X8_PRO, ['deep', 'x & del', 'macro'], 'win32').at(-1)).toBe('deep,macro');
    expect(reportToolArgs(X8_PRO, ['x & del'], 'linux').at(-1)).toBe('specific');
  });

  it('shows a demo device the steps its owner would follow, recording nothing', () => {
    expect(previewArgs('mouse', supportPlan(X8_PRO)!.record)).toEqual([
      '--preview-steps',
      'mouse',
      '--steps',
      'media',
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

  it('asks the X8 PRO for every media key its driver has not seen recorded', () => {
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
    expect(supportPlan(X8_PRO)!.record).toEqual(['media']);
  });
});
