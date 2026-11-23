import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_ROOT } from '../lib/ast';
import { CAPABILITY_META } from '../../src/shared/capabilities';
import type { Capability } from '../../src/shared/types/capability';
import { CAPABILITY_STEPS } from '../../src/main/devices/recording-steps';
import { virtualDescriptors } from '../../src/main/devices/virtual';

/**
 * One recording must be enough to support a device fully: owners rarely make
 * a second. So every setting Shark Deck shows for a model has steps in the
 * device report tool that record it, and the recording Shark Deck asks for
 * picks them (support.ts). A capability no step records is one no recording
 * could ever confirm.
 */

const bat = readFileSync(resolve(APP_ROOT, '../tools/SharkDeck-device-report.bat'), 'utf8');
const rows = /\$StepTable = @'\r\n([\s\S]*?)\r\n'@/
  .exec(bat)![1]!
  .split('\r\n')
  .map((line) => {
    const [id, kind] = line.split('|');
    return { word: id!.split('.')[0]!, kind: kind! };
  });

describe('recording coverage', () => {
  it('names the steps of every capability, or why there are none', () => {
    for (const cap of Object.keys(CAPABILITY_META) as Capability[]) {
      const words = CAPABILITY_STEPS[cap];
      expect(words, cap).toBeDefined();
      if (!Array.isArray(words)) {
        expect((words as { none: string }).none.length, cap).toBeGreaterThan(10);
        continue;
      }
      for (const w of words)
        expect(
          rows.some((r) => r.word === w),
          `${cap}: ${w}`,
        ).toBe(true);
    }
  });

  it('records every setting each model shows, with steps of its kind', () => {
    const missing: string[] = [];
    for (const d of virtualDescriptors()) {
      for (const cap of d.capabilities) {
        const words = CAPABILITY_STEPS[cap];
        if (!Array.isArray(words)) continue;
        const fits = rows.some(
          (r) => words.includes(r.word) && (r.kind === 'both' || r.kind === d.kind),
        );
        if (!fits) missing.push(`${d.model} (${d.kind}): ${cap}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('leaves out of recordings only what is not on the device', () => {
    const none = (Object.keys(CAPABILITY_STEPS) as Capability[]).filter(
      (c) => !Array.isArray(CAPABILITY_STEPS[c]),
    );
    expect(none.sort()).toEqual(['autoSwitch', 'firmwareUpdate', 'keystroke', 'screen']);
    // screen: no model offers it; the day one does, it needs steps.
    for (const d of virtualDescriptors()) expect(d.capabilities, d.model).not.toContain('screen');
  });
});
