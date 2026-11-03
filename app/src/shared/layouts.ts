import type { KeyLayoutEntry } from './types/keys';

/**
 * Pragmatic ANSI 75% layout for the interactive keyboard map, shared by the
 * renderer (rendering) and the HE driver (matrix index derivation). `row`/`col`
 * are render coordinates; `provenance: inferred` until the exact R85HE matrix is
 * confirmed by capture — see docs/protocol/keyboard-compx.md.
 */
/**
 * One row. A bare number in `items` is a GAP in key-units rather than a key —
 * that is what puts the F-key clusters and the nav column where a real board
 * has them instead of running every row edge to edge.
 *
 * `r` is the matrix row (and, with `col`, a key's stable identity); `y` is
 * where it is DRAWN, which is a different thing on a 75% — the F-row sits a
 * quarter unit above the number row. They were one parameter, so the board
 * could not have that gap without renumbering every key.
 */
type RowItem = [string, number?] | number;

function row(r: number, items: RowItem[], y: number = r): KeyLayoutEntry[] {
  let x = 0;
  let col = 0;
  const out: KeyLayoutEntry[] = [];
  for (const it of items) {
    if (typeof it === 'number') {
      x += it;
      continue;
    }
    const [label, w = 1] = it;
    out.push({ label, row: r, col: col++, x, y, w });
    x += w;
  }
  return out;
}

export const ANSI_75: KeyLayoutEntry[] = [
  // Row 0 ends at 14u against every other row's 15-16, and the arrow row has a
  // gap before the cluster: both are what `ANSI_79_SG9047` measures, and a
  // generic board that does not share them is visibly a different keyboard from
  // the one the Remap and Actuation tabs draw. `layouts.test.ts` pins the two
  // row-width patterns together.
  ...row(0, [
    ['ESC'],
    0.5,
    ['F1'],
    ['F2'],
    ['F3'],
    ['F4'],
    0.25,
    ['F5'],
    ['F6'],
    ['F7'],
    ['F8'],
    0.25,
    ['F9'],
    ['F10'],
    ['F11'],
    ['F12'],
  ]),
  ...row(
    1,
    [
      ['`'],
      ['1'],
      ['2'],
      ['3'],
      ['4'],
      ['5'],
      ['6'],
      ['7'],
      ['8'],
      ['9'],
      ['0'],
      ['-'],
      ['='],
      ['Bksp', 2],
      ['DEL'],
    ],
    1.25,
  ),
  ...row(
    2,
    [
      ['TAB', 1.5],
      ['Q'],
      ['W'],
      ['E'],
      ['R'],
      ['T'],
      ['Y'],
      ['U'],
      ['I'],
      ['O'],
      ['P'],
      ['['],
      [']'],
      ['\\', 1.5],
      ['PgUp'],
    ],
    2.25,
  ),
  ...row(
    3,
    [
      ['CAPS', 1.75],
      ['A'],
      ['S'],
      ['D'],
      ['F'],
      ['G'],
      ['H'],
      ['J'],
      ['K'],
      ['L'],
      [';'],
      ["'"],
      ['Enter', 2.25],
      ['PgDn'],
    ],
    3.25,
  ),
  ...row(
    4,
    [
      ['SHIFT', 2.25],
      ['Z'],
      ['X'],
      ['C'],
      ['V'],
      ['B'],
      ['N'],
      ['M'],
      [','],
      ['.'],
      ['/'],
      ['SHIFT', 1.75],
      ['Up'],
    ],
    4.25,
  ),
  ...row(
    5,
    [
      ['CTRL', 1.25],
      ['WIN', 1.25],
      ['ALT', 1.25],
      ['Space', 6.25],
      ['FN', 1.25],
      ['CTRL', 1.25],
      0.5,
      ['Left'],
      ['Down'],
      ['Right'],
    ],
    5.25,
  ),
];

/**
 * Attack Shark R85HE — key layout `Common79_SG9047`. Extracted from Driver v4
 * chunk 322d1e41.js (`defaultMatrix`, the firmware wire-slot order) and
 * 960d1a27.js (`keyboard_79_sg9047_keymappings_ui_info`, the 737x281 UI grid).
 * Regenerate with `npm run extract:kb` -> app/scripts/_raw/kb-r85he-layout.json.
 *
 * `slot` is the firmware matrix position — column-major, `slot = col*6 + row`
 * for the 96-slot main block. **Every per-key wire operation (magnetic
 * actuation, per-key lighting, remap) is indexed by `slot`, not by this
 * array's order.** `row`/`col` are the matrix coordinates (and a stable id);
 * `x`/`y`/`w` are render grid units. `provenance: ported-from-vendor`.
 */
export const ANSI_79_SG9047: KeyLayoutEntry[] = [
  { label: 'ESC', slot: 0, code: 41, row: 0, col: 0, x: 0.02, y: 0.02, w: 0.87 },
  { label: '`~', slot: 1, code: 53, row: 1, col: 0, x: 0.02, y: 1.22, w: 0.87 },
  { label: 'TAB', slot: 2, code: 43, row: 2, col: 0, x: 0.02, y: 2.22, w: 1.43 },
  { label: 'CAPS', slot: 3, code: 57, row: 3, col: 0, x: 0.02, y: 3.22, w: 1.57 },
  { label: 'SHIFT', slot: 4, code: 225, row: 4, col: 0, x: 0.02, y: 4.22, w: 2.02 },
  { label: 'CTRL', slot: 5, code: 224, row: 5, col: 0, x: 0.02, y: 5.22, w: 1.04 },
  { label: 'F1', slot: 6, code: 58, row: 0, col: 1, x: 1.37, y: 0.02, w: 0.87 },
  { label: '1!', slot: 7, code: 30, row: 1, col: 1, x: 1.02, y: 1.22, w: 0.87 },
  { label: 'Q', slot: 8, code: 20, row: 2, col: 1, x: 1.59, y: 2.22, w: 0.87 },
  { label: 'A', slot: 9, code: 4, row: 3, col: 1, x: 1.72, y: 3.22, w: 0.87 },
  { label: 'WIN', slot: 11, code: 227, row: 5, col: 1, x: 1.2, y: 5.22, w: 1.04 },
  { label: 'F2', slot: 12, code: 59, row: 0, col: 2, x: 2.37, y: 0.02, w: 0.87 },
  { label: '2@', slot: 13, code: 31, row: 1, col: 2, x: 2.02, y: 1.22, w: 0.87 },
  { label: 'W', slot: 14, code: 26, row: 2, col: 2, x: 2.59, y: 2.22, w: 0.87 },
  { label: 'S', slot: 15, code: 22, row: 3, col: 2, x: 2.72, y: 3.22, w: 0.87 },
  { label: 'Z', slot: 16, code: 29, row: 4, col: 2, x: 2.17, y: 4.22, w: 0.87 },
  { label: 'ALT', slot: 17, code: 226, row: 5, col: 2, x: 2.37, y: 5.22, w: 1.04 },
  { label: 'F3', slot: 18, code: 60, row: 0, col: 3, x: 3.37, y: 0.02, w: 0.87 },
  { label: '3#', slot: 19, code: 32, row: 1, col: 3, x: 3.02, y: 1.22, w: 0.87 },
  { label: 'E', slot: 20, code: 8, row: 2, col: 3, x: 3.59, y: 2.22, w: 0.87 },
  { label: 'D', slot: 21, code: 7, row: 3, col: 3, x: 3.72, y: 3.22, w: 0.87 },
  { label: 'X', slot: 22, code: 27, row: 4, col: 3, x: 3.17, y: 4.22, w: 0.87 },
  { label: 'F4', slot: 24, code: 61, row: 0, col: 4, x: 4.37, y: 0.02, w: 0.87 },
  { label: '4$', slot: 25, code: 33, row: 1, col: 4, x: 4.02, y: 1.22, w: 0.87 },
  { label: 'R', slot: 26, code: 21, row: 2, col: 4, x: 4.59, y: 2.22, w: 0.87 },
  { label: 'F', slot: 27, code: 9, row: 3, col: 4, x: 4.72, y: 3.22, w: 0.87 },
  { label: 'C', slot: 28, code: 6, row: 4, col: 4, x: 4.17, y: 4.22, w: 0.87 },
  { label: 'F5', slot: 30, code: 62, row: 0, col: 5, x: 5.72, y: 0.02, w: 0.87 },
  { label: '5%', slot: 31, code: 34, row: 1, col: 5, x: 5.02, y: 1.22, w: 0.87 },
  { label: 'T', slot: 32, code: 23, row: 2, col: 5, x: 5.59, y: 2.22, w: 0.87 },
  { label: 'G', slot: 33, code: 10, row: 3, col: 5, x: 5.72, y: 3.22, w: 0.87 },
  { label: 'V', slot: 34, code: 25, row: 4, col: 5, x: 5.17, y: 4.22, w: 0.87 },
  { label: 'F6', slot: 36, code: 63, row: 0, col: 6, x: 6.72, y: 0.02, w: 0.87 },
  { label: '6^', slot: 37, code: 35, row: 1, col: 6, x: 6.02, y: 1.22, w: 0.87 },
  { label: 'Y', slot: 38, code: 28, row: 2, col: 6, x: 6.59, y: 2.22, w: 0.87 },
  { label: 'H', slot: 39, code: 11, row: 3, col: 6, x: 6.72, y: 3.22, w: 0.87 },
  { label: 'B', slot: 40, code: 5, row: 4, col: 6, x: 6.17, y: 4.22, w: 0.87 },
  { label: 'Space', slot: 41, code: 44, row: 5, col: 6, x: 3.54, y: 5.22, w: 6.78 },
  { label: 'F7', slot: 42, code: 64, row: 0, col: 7, x: 7.72, y: 0.02, w: 0.87 },
  { label: '7&', slot: 43, code: 36, row: 1, col: 7, x: 7.02, y: 1.22, w: 0.87 },
  { label: 'U', slot: 44, code: 24, row: 2, col: 7, x: 7.59, y: 2.22, w: 0.87 },
  { label: 'J', slot: 45, code: 13, row: 3, col: 7, x: 7.72, y: 3.22, w: 0.87 },
  { label: 'N', slot: 46, code: 17, row: 4, col: 7, x: 7.17, y: 4.22, w: 0.87 },
  { label: 'F8', slot: 48, code: 65, row: 0, col: 8, x: 8.72, y: 0.02, w: 0.87 },
  { label: '8*', slot: 49, code: 37, row: 1, col: 8, x: 8.02, y: 1.22, w: 0.87 },
  { label: 'I', slot: 50, code: 12, row: 2, col: 8, x: 8.59, y: 2.22, w: 0.87 },
  { label: 'K', slot: 51, code: 14, row: 3, col: 8, x: 8.72, y: 3.22, w: 0.87 },
  { label: 'M', slot: 52, code: 16, row: 4, col: 8, x: 8.17, y: 4.22, w: 0.87 },
  { label: 'F9', slot: 54, code: 66, row: 0, col: 9, x: 10.07, y: 0.02, w: 0.87 },
  { label: '9(', slot: 55, code: 38, row: 1, col: 9, x: 9.02, y: 1.22, w: 0.87 },
  { label: 'O', slot: 56, code: 18, row: 2, col: 9, x: 9.59, y: 2.22, w: 0.87 },
  { label: 'L', slot: 57, code: 15, row: 3, col: 9, x: 9.72, y: 3.22, w: 0.87 },
  { label: ',<', slot: 58, code: 54, row: 4, col: 9, x: 9.17, y: 4.22, w: 0.87 },
  { label: 'F10', slot: 60, code: 67, row: 0, col: 10, x: 11.07, y: 0.02, w: 0.89 },
  { label: '0)', slot: 61, code: 39, row: 1, col: 10, x: 10.02, y: 1.22, w: 0.87 },
  { label: 'P', slot: 62, code: 19, row: 2, col: 10, x: 10.59, y: 2.22, w: 0.87 },
  { label: ';:', slot: 63, code: 51, row: 3, col: 10, x: 10.72, y: 3.22, w: 0.87 },
  { label: '.>', slot: 64, code: 55, row: 4, col: 10, x: 10.17, y: 4.22, w: 0.87 },
  { label: 'FN', slot: 65, code: null, row: 5, col: 10, x: 10.46, y: 5.22, w: 1.04 },
  { label: 'F11', slot: 66, code: 68, row: 0, col: 11, x: 12.07, y: 0.02, w: 0.89 },
  { label: '-_', slot: 67, code: 45, row: 1, col: 11, x: 11.02, y: 1.22, w: 0.87 },
  { label: '[{', slot: 68, code: 47, row: 2, col: 11, x: 11.59, y: 2.22, w: 0.87 },
  { label: '\'"', slot: 69, code: 52, row: 3, col: 11, x: 11.72, y: 3.22, w: 0.87 },
  { label: '/?', slot: 70, code: 56, row: 4, col: 11, x: 11.17, y: 4.22, w: 0.87 },
  { label: 'CTRL', slot: 71, code: 228, row: 5, col: 11, x: 11.63, y: 5.22, w: 1.04 },
  { label: 'F12', slot: 72, code: 69, row: 0, col: 12, x: 13.07, y: 0.02, w: 0.89 },
  { label: '=+', slot: 73, code: 46, row: 1, col: 12, x: 12.02, y: 1.22, w: 0.87 },
  { label: ']}', slot: 74, code: 48, row: 2, col: 12, x: 12.59, y: 2.22, w: 0.87 },
  { label: 'SHIFT', slot: 76, code: 229, row: 4, col: 12, x: 12.17, y: 4.22, w: 1.83 },
  { label: 'Left', slot: 77, code: 80, row: 5, col: 12, x: 13.13, y: 5.22, w: 0.87 },
  { label: 'Bksp', slot: 79, code: 42, row: 1, col: 13, x: 13.02, y: 1.22, w: 1.96 },
  { label: '\\|', slot: 80, code: 49, row: 2, col: 13, x: 13.59, y: 2.22, w: 1.39 },
  { label: 'Enter', slot: 81, code: 40, row: 3, col: 13, x: 12.72, y: 3.22, w: 2.26 },
  { label: 'Up', slot: 82, code: 82, row: 4, col: 13, x: 14.13, y: 4.22, w: 0.87 },
  { label: 'Down', slot: 83, code: 81, row: 5, col: 13, x: 14.13, y: 5.22, w: 0.87 },
  { label: 'DEL', slot: 85, code: 76, row: 1, col: 14, x: 15.11, y: 1.22, w: 0.87 },
  { label: 'PgUp', slot: 86, code: 75, row: 2, col: 14, x: 15.11, y: 2.22, w: 0.87 },
  { label: 'PgDn', slot: 87, code: 78, row: 3, col: 14, x: 15.11, y: 3.22, w: 0.87 },
  { label: 'Right', slot: 89, code: 79, row: 5, col: 14, x: 15.13, y: 5.22, w: 0.87 },
];
