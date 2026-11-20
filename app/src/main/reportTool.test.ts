import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo/app' } }));
vi.mock('node-hid', () => ({
  default: { devicesAsync: async () => [], HIDAsync: { open: vi.fn() } },
}));
vi.mock('./devices/manager', () => ({ deviceManager: { getDescriptor: () => null } }));

const { reportToolArgs, unixToolCommand, LINUX_TERMINALS } = await import('./reportTool');
const { supportPlan } = await import('./devices/support');
const { bekenDescriptorFor, bekenMouseRoster } = await import('./devices/catalog/beken-mice');
const { KEYBOARDS } = await import('./devices/catalog/keyboards');
const { hubMouseRoster } = await import('./devices/catalog/hub-mice');
const { CATALOG } = await import('./devices/catalog');

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
    // The X8 PRO lacks some button actions only: one thing at a time, described.
    expect(reportToolArgs(X8_PRO, supportPlan(X8_PRO)!.record, 'win32')).toEqual([
      '--device',
      '1D57:FA65',
      '--record',
      '--steps',
      'specific',
    ]);
    expect(reportToolArgs(X8_PRO, ['deep', 'macro', 'specific'], 'win32').slice(2)).toEqual([
      '--record',
      '--steps',
      'deep,macro,specific',
    ]);
  });

  it('makes the report alone where a report names the model, and on macOS and Linux', () => {
    expect(reportToolArgs(X1, 'report', 'win32')).toEqual(['--device', '1D57:2111', '--no-record']);
    expect(reportToolArgs(X8_PRO, ['deep'], 'linux')).toEqual(['--device', '1D57:FA65']);
    expect(reportToolArgs(X8_PRO, 'all', 'darwin')).toEqual(['--device', '1D57:FA65']);
  });

  it('passes only plain words as steps', () => {
    expect(reportToolArgs(X8_PRO, ['deep', 'x & del', 'macro'], 'win32').at(-1)).toBe('deep,macro');
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
});
