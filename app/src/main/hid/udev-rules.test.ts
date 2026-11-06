import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownVendorIds } from '../devices/registry';

/**
 * `assets/linux/60-sharkdeck.rules` is what a Linux user without the file
 * installed sees as an unusable device rather than an actionable error (see
 * hint.offlinePermission) — a VID missing from the rule is a silent Linux
 * regression the moment a new device family adds one. This keeps the rules
 * file honest against the same VID list the HID scanner actually uses.
 *
 * `scripts/linux/install-udev-rules.sh` carries a second copy, the fallback it
 * writes when the canonical file is not beside it. Nothing else reads that
 * copy, so it is held to the same list here.
 */
const APP = join(__dirname, '../../..');
const COPIES = {
  'assets/linux/60-sharkdeck.rules': readFileSync(
    join(APP, 'assets/linux/60-sharkdeck.rules'),
    'utf8',
  ),
  'scripts/linux/install-udev-rules.sh (fallback)': fallbackOf(
    readFileSync(join(APP, 'scripts/linux/install-udev-rules.sh'), 'utf8'),
  ),
};

/** The rules the script writes when the canonical file is missing. */
function fallbackOf(script: string): string {
  const m = /cat > "\$RULE_DEST" <<'EOF'\n([\s\S]*?)\nEOF/.exec(script);
  return m?.[1] ?? '';
}

const vendorIdsIn = (rules: string) =>
  Array.from(rules.matchAll(/ATTRS\{idVendor\}=="([0-9a-fA-F]{4})"/g)).map((m) =>
    parseInt(m[1]!, 16),
  );

describe.each(Object.entries(COPIES))('%s', (_name, rules) => {
  const ruleVendorIds = vendorIdsIn(rules);

  it('has rule lines to check', () => {
    expect(ruleVendorIds.length).toBeGreaterThan(0);
  });

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
