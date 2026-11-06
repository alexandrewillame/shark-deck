import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { CATALOG } from '../../src/main/devices/catalog';
import { virtualDescriptors } from '../../src/main/devices/virtual';
import { APP_ROOT, parse } from '../lib/ast';
import { commentsOf } from '../lib/comments';

/**
 * CLAUDE.md invariant: every protocol command carries a provenance tag --
 * `verified-capture`, `ported-from-vendor` or `inferred`. Only V8 profile
 * switching is `verified-capture`; everything else is treated as unconfirmed
 * and keeps its read-back diff.
 *
 * This is deliberately the COARSEST of the guardrails, and that is a design
 * decision rather than laziness. There is no reliable way to enumerate "every
 * protocol command": the candidates (SCREAMING_SNAKE consts, numeric literals,
 * a `_CMD` suffix) either miss real cases or fire on innocent ones, and a
 * guardrail that cries wolf costs more than it saves. What it checks instead:
 *
 *  1. the tag vocabulary in the docs and in the `Provenance` type cannot drift
 *     apart (fully robust);
 *  2. every device descriptor carries one of the three, and developer mode
 *     preserves it (fully robust, runtime);
 *  3. every module on the protocol allowlist discusses provenance somewhere in
 *     a comment (coarse, but catches the case that actually happens -- a new
 *     protocol module landing with no confidence level recorded at all);
 *  4. every labelled `provenance: <tag>` note names a canonical tag, so the
 *     vocabulary stays greppable (prose is left alone -- see that test);
 *  5. every file in the protocol directories is classified, so the allowlist
 *     cannot rot by omission. This is the part that keeps 3 honest.
 */

const TAGS = ['verified-capture', 'ported-from-vendor', 'inferred'] as const;

/**
 * Modules that encode reverse-engineered knowledge about the device: wire
 * formats, command tables, option encodings, or empirically-observed transport
 * behaviour. Each must record its confidence level in a comment.
 */
const PROTOCOL_MODULES = [
  'src/main/hid/checksum.ts',
  'src/main/hid/frame.ts',
  'src/main/hid/transport.ts',
  'src/main/devices/drivers/compx-he-keyboard.ts',
  'src/main/devices/drivers/compx-keyboard.ts',
  'src/main/devices/drivers/compx-mouse-8k.ts',
  'src/main/devices/drivers/gearhub-mouse.ts',
  'src/main/devices/drivers/identify.ts',
  'src/main/devices/drivers/jxc-mouse.ts',
  'src/main/devices/drivers/mouse-macro-codec.ts',
  'src/main/devices/drivers/yc500-keyboard.ts',
  'src/shared/battery.ts',
  'src/shared/dks.ts',
  'src/shared/key-zones.ts',
  'src/shared/keyboard-fn-codes.ts',
  'src/shared/keyboard-fn-defaults.ts',
  'src/shared/keyboard-switches.ts',
  'src/shared/keyboard-options.ts',
  'src/shared/keyboard-travel.ts',
  'src/shared/layouts.ts',
  'src/shared/lighting.ts',
  'src/shared/mouse-buttons.ts',
  'src/shared/mouse-options.ts',
  'src/shared/mouse-wire.ts',
  'src/web/hid/node-hid-webhid.ts',
];

/**
 * Files in the same directories that carry no device knowledge, with the
 * reason. A new file in a protocol directory must be added to one list or the
 * other -- that is what stops the allowlist above going stale by omission.
 */
const NOT_PROTOCOL: Record<string, string> = {
  'src/main/devices/drivers/base.ts':
    'the Driver base class: retry/read-back mechanism, no wire data of its own',
  'src/main/devices/drivers/index.ts': 'driver name -> constructor registry',
  'src/shared/backgrounds.ts': 'the app background ids, a UI setting',
  'src/shared/capabilities.ts': 'capability labels and predicates, app-internal',
  'src/shared/device-art.ts': 'which product photos and colours a model has, cosmetic only',
  'src/shared/ipc.ts': 'the renderer<->main contract, app-internal',
  'src/shared/menuGates.ts':
    'which menu controls draw, as predicates over what a descriptor declares — app-internal',
  'src/shared/keys.ts':
    'the standard HID keyboard-usage table, from the USB spec rather than reverse-engineered from the vendor',
  'src/shared/naming.ts': 'unique-name string helper',
  'src/shared/proximityFade.ts': 'pointer-distance fade for floating cards, UI geometry only',
};

/** Directories swept by the classification check. */
const PROTOCOL_DIRS = ['src/main/hid', 'src/main/devices/drivers', 'src/shared', 'src/web/hid'];

function tsFilesDirectlyIn(dir: string): string[] {
  return readdirSync(resolve(APP_ROOT, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => `${dir}/${e.name}`);
}

const read = (rel: string) => readFileSync(resolve(APP_ROOT, rel), 'utf8');

describe('provenance vocabulary', () => {
  it('matches between docs/protocol/README.md and the Provenance type', () => {
    // Drift here would be quiet and corrosive: the docs would define tags the
    // code cannot express, or vice versa.
    const doc = readFileSync(resolve(APP_ROOT, '../docs/protocol/README.md'), 'utf8');
    const documented = [...doc.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gm)].map((m) => m[1]);

    const sf = parse('src/shared/types/device.ts');
    let declared: string[] = [];
    sf.forEachChild((n) => {
      if (
        ts.isTypeAliasDeclaration(n) &&
        n.name.text === 'Provenance' &&
        ts.isUnionTypeNode(n.type)
      ) {
        declared = n.type.types.map((t) => t.getText(sf).replace(/'/g, ''));
      }
    });

    expect(declared, 'could not parse the Provenance union').toHaveLength(3);
    expect([...declared].sort()).toEqual([...TAGS].sort());
    expect(
      [...documented].sort(),
      'the tag table in docs/protocol/README.md no longer matches the Provenance type',
    ).toEqual([...declared].sort());
  });
});

describe('device descriptors declare provenance', () => {
  it('gives every catalog entry one of the three tags', () => {
    expect(CATALOG.length, 'CATALOG is empty').toBeGreaterThan(0);
    for (const d of CATALOG) {
      expect(TAGS, `${d.model} has provenance "${d.provenance}"`).toContain(d.provenance);
    }
  });

  it('preserves provenance on the simulated devices', () => {
    // virtualDescriptors() spreads CATALOG, so a simulated card must not
    // silently claim better provenance than the model it stands in for.
    const virt = virtualDescriptors();
    expect(virt.length).toBeGreaterThan(CATALOG.length - 1);
    for (const v of virt) {
      expect(TAGS, `simulated ${v.model} has provenance "${v.provenance}"`).toContain(v.provenance);
    }
    for (const c of CATALOG) {
      const twin = virt.find((v) => v.model === c.model);
      expect(twin?.provenance, `simulated ${c.model} changed provenance`).toBe(c.provenance);
    }
  });
});

describe('protocol modules record their confidence level', () => {
  it.each(PROTOCOL_MODULES)('%s names a provenance tag in a comment', (rel) => {
    const comments = commentsOf(read(rel));
    // Non-vacuity: a file with no comments at all cannot pass by accident.
    expect(comments.length, `${rel} has no comments to search`).toBeGreaterThan(0);

    const found = TAGS.filter((t) => comments.includes(t));
    expect(
      found,
      `${rel} encodes device knowledge but records no provenance. Add a comment ` +
        `saying which of ${TAGS.join(' / ')} applies, and why.`,
    ).not.toEqual([]);
  });

  it('labels every "provenance:" note with a canonical tag', () => {
    // Narrow on purpose. An earlier version flagged any near-miss WORDING and
    // immediately cried wolf on correct English prose -- "the SET frame layout
    // itself is capture-verified", "ported from vendor chunk 5e635fe2.js" --
    // which is the failure mode this whole file is written to avoid.
    //
    // The convention is a labelled note, `provenance: <tag>`. Checking the
    // value of that label is precise: prose is untouched, and an
    // out-of-vocabulary label (this found `unconfirmed` twice and `derived`
    // once) is a real defect, because neither a reader nor a grep can place
    // its confidence level.
    const LABEL = /provenance:\s*`?([A-Za-z][A-Za-z-]*)/g;
    const offenders: string[] = [];
    let seen = 0;

    for (const rel of PROTOCOL_MODULES) {
      const comments = commentsOf(read(rel));
      for (const m of comments.matchAll(LABEL)) {
        const word = m[1];
        // `provenance: Provenance` is the type annotation, not a claim.
        if (word === 'Provenance') continue;
        seen++;
        if (!(TAGS as readonly string[]).includes(word)) offenders.push(`${rel}: "${word}"`);
      }
    }

    // Non-vacuity, and not hypothetical: the first version of this line lost a
    // backslash in transit, becoming /provenance:s*.../ -- which matches
    // nothing, so the check passed while inspecting zero labels.
    expect(
      seen,
      'found no "provenance:" labels at all -- the pattern is broken, not the code',
    ).toBeGreaterThan(20);

    expect(
      offenders,
      `out-of-vocabulary provenance labels: ${offenders.join('; ')}. A ` +
        `"provenance:" note must name exactly one of ${TAGS.join(' / ')}.`,
    ).toEqual([]);
  });
});

describe('the protocol allowlist cannot go stale', () => {
  it('classifies every file in the protocol directories', () => {
    const all = PROTOCOL_DIRS.flatMap(tsFilesDirectlyIn);
    expect(all.length, 'swept no files').toBeGreaterThan(15);

    const classified = new Set([...PROTOCOL_MODULES, ...Object.keys(NOT_PROTOCOL)]);
    const unclassified = all.filter((f) => !classified.has(f));

    expect(
      unclassified,
      `new file(s) in a protocol directory: ${unclassified.join(', ')}. Add each to ` +
        'PROTOCOL_MODULES (and give it a provenance comment) or to NOT_PROTOCOL ' +
        'with the reason it carries no device knowledge.',
    ).toEqual([]);
  });

  it('has no entries for files that no longer exist', () => {
    const all = new Set(PROTOCOL_DIRS.flatMap(tsFilesDirectlyIn));
    const gone = [...PROTOCOL_MODULES, ...Object.keys(NOT_PROTOCOL)].filter((f) => !all.has(f));
    expect(gone, `listed but missing: ${gone.join(', ')}`).toEqual([]);
  });

  it('lists no file twice', () => {
    const both = PROTOCOL_MODULES.filter((f) => f in NOT_PROTOCOL);
    expect(both, `classified as both protocol and not: ${both.join(', ')}`).toEqual([]);
  });

  it('gives every NOT_PROTOCOL entry a reason', () => {
    const empty = Object.entries(NOT_PROTOCOL)
      .filter(([, why]) => why.trim().length < 10)
      .map(([f]) => f);
    expect(empty, `no reason recorded for: ${empty.join(', ')}`).toEqual([]);
  });
});

describe('the comment scanner itself', () => {
  // The whole check rests on this, and it is subtle enough to be worth
  // pinning: an i18n message KEY called `hint.inferred` must not read as a tag,
  // while a backtick-quoted tag inside JSDoc must.
  it('ignores string literals', () => {
    expect(commentsOf(`const m = { 'hint.inferred': 'not in the catalog' };`)).not.toContain(
      'inferred',
    );
  });

  it('keeps backtick-quoted spans inside comments', () => {
    const src = ['/**', ' * `provenance: verified-capture` (R85HE).', ' */', 'export const X = 1;'];
    expect(commentsOf(src.join('\n'))).toContain('verified-capture');
  });

  it('does not treat an apostrophe in a comment as an open string', () => {
    const src = ["// the device's own reply", '/* inferred */'];
    expect(commentsOf(src.join('\n'))).toContain('inferred');
  });

  it('finds no tag in the real i18n catalogue', () => {
    // The concrete false positive this exists to prevent: a naive search over
    // raw source reports a provenance tag in all eleven locale files.
    const comments = commentsOf(read('src/shared/i18n/en.ts'));
    for (const t of TAGS) expect(comments).not.toContain(t);
  });
});
