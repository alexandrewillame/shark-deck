import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every keyboard reply decode must resolve its payload offset with
 * `feaPayloadStart`, never a hardcoded index.
 *
 * The firmware sometimes overwrites the echoed query checksum at byte 2 with
 * real reply data and sometimes leaves it, which is the whole reason the
 * helper exists. `readKeyboardOptions` was the one read still hardcoding
 * `r[2]`, so on a reply that kept the echo it read all five KBOPTION switches
 * one byte early — `swapWasd` came off the RT-stabilisation byte, the toggle
 * appeared to do nothing, and the poisoned cache fed the next write wrong
 * values for every switch (they share one frame).
 *
 * A source-text assertion rather than a wire test: there is no captured
 * GET_KBOPTION reply to check a decode against, so what is pinned is the rule
 * — a decode that indexes a reply buffer goes through the helper.
 */
describe('keyboard reply decodes resolve their payload offset', () => {
  const src = readFileSync(join(__dirname, 'compx-keyboard.ts'), 'utf8');

  /** Body of a named method, delimited by matching braces rather than by
   *  indentation guesswork. */
  const methodBody = (name: string): string => {
    const start = src.indexOf(`async ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const open = src.indexOf('{', src.indexOf(')', start));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
    }
    throw new Error(`unterminated method body: ${name}`);
  };

  // Reads that decode a short scalar reply by index. Chunked/paged reads
  // (readKeyBindings, readPerKeyLighting, readMacros) use their own documented
  // stride constants and are deliberately out of scope here.
  const SCALAR_READS = [
    'readKeyboardOptions',
    'readLighting',
    'readSideLighting',
    'getActiveProfile',
    'readDebounce',
  ];

  for (const name of SCALAR_READS) {
    it(`${name} uses feaPayloadStart`, () => {
      expect(methodBody(name)).toContain('feaPayloadStart');
    });
  }

  /** Comments discuss offsets by name; only real code counts. */
  const codeOnly = (body: string): string =>
    body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('no scalar read indexes a reply at a hardcoded numeric offset', () => {
    for (const name of SCALAR_READS) {
      expect(codeOnly(methodBody(name)), `${name} hardcodes a reply offset`).not.toMatch(
        /\br\[\d+\]/,
      );
    }
  });

  /**
   * `writeVerified`'s read-back sends a BARE `frame(getCommand)` — the command
   * with all-zero arguments. That is only a valid query for a command that
   * takes no arguments. A paged/bulk GET takes a chunk index and a layout
   * byte, and this file's own `readKeyBindings` records what sending the wrong
   * shape costs: "not a soft failure: the wrong shape hangs the MCU on the
   * very first frame."
   *
   * `setKeyRemap` used to pass `GET_KEYMATRIX` here, so every remap fired a
   * malformed paged query. It reported `match` regardless (no `compare` means
   * any reply passes), then left the firmware mid-sweep so the next real read
   * came back empty — "applied and confirmed", then a blank pane, then a dead
   * key.
   */
  it('no write read-back uses a paged GET as its verification query', () => {
    const PAGED_GETS = [
      'GET_KEYMATRIX',
      'GET_FN',
      'GET_USERPIC',
      'GET_MACRO',
      'GET_MULTI_MAGNETISM',
    ];
    const used = [...src.matchAll(/getCommand:\s*KB_CMD\.(\w+)/g)].map((m) => m[1]);
    for (const g of used) {
      expect(
        PAGED_GETS,
        `${g} takes a chunk argument; a bare frame is a malformed query`,
      ).not.toContain(g);
    }
  });
});
