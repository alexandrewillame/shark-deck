import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownVendorIds } from '../devices/registry';

/**
 * `assets/linux/60-sharkdeck.rules` is what a Linux user without the file
 * installed sees as an unusable device rather than an actionable error (see
 * hint.offlinePermission) — a VID missing from the rule is a silent Linux
 * regression the moment a new device catalog entry adds one. This keeps the
 * rules file honest against the same VID list the HID scanner actually uses.
 */
describe('assets/linux/60-sharkdeck.rules', () => {
  const rules = readFileSync(join(__dirname, '../../../assets/linux/60-sharkdeck.rules'), 'utf8');

  const ruleVendorIds = Array.from(rules.matchAll(/ATTRS\{idVendor\}=="([0-9a-fA-F]{4})"/g)).map(
    (m) => parseInt(m[1]!, 16),
  );

  it('covers every VID the HID scanner enumerates', () => {
    for (const vid of knownVendorIds()) {
      expect(ruleVendorIds, `0x${vid.toString(16)} is missing a udev rule line`).toContain(vid);
    }
  });

  it('only lists VIDs the scanner still knows about (no stale entries)', () => {
    const known = new Set(knownVendorIds());
    for (const vid of ruleVendorIds) {
      expect(
        known.has(vid),
        `0x${vid.toString(16)} is in the udev rules but not knownVendorIds()`,
      ).toBe(true);
    }
  });

  it('uses uaccess, not a world-writable MODE, so access is scoped to the logged-in seat', () => {
    // Check actual rule lines only — the file's own comments legitimately
    // mention MODE="0666" in prose, explaining why uaccess was chosen instead.
    const ruleLines = rules
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#'));
    for (const line of ruleLines) expect(line).not.toMatch(/MODE\s*=\s*"0?666"/);
    expect(rules).toContain('TAG+="uaccess"');
  });
});
