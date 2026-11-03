/**
 * Mouse button-action model — the full vendor `KeyOptions` tree (from
 * `Language/en.json`) with the region-A wire encoding for each action.
 *
 * `wire` provenance:
 *   - a number  → confirmed against the 2026-08-30 captures
 *     (session-v8.jsonl / session-v8-verify.jsonl).
 *   - `null`    → the vendor offers it but no capture pinned the action byte;
 *     the driver writes a best-guess byte and relies on the read-back diff.
 *
 * `param` for actions with a sub-selection is the vendor child `value`
 * (`0x0100` Left / `0x0200` DPI+ / `0x00E9` Volume+ …); the driver takes its
 * high byte for `Button` / `DPI Switch` / `Scroll` and passes multimedia codes
 * through to the region-B record.
 */

export interface ButtonSubAction {
  /** vendor child value, e.g. 0x0100 */
  value: number;
  labelEn: string;
}

export interface ButtonActionDef {
  /** stable key used by the renderer + IPC */
  key: string;
  /** vendor category value (as shown in mouse-options.ts BUTTON_ACTIONS) */
  vendorValue: string;
  /** region-A action byte, or null when unconfirmed */
  wire: number | null;
  /** i18n key for the category label */
  labelKey: string;
  /** sub-selection, if any */
  children?: ButtonSubAction[];
  /** needs the region-B combo record */
  combo?: boolean;
  /** needs the region-B consumer record */
  multimedia?: boolean;
  /** reveals the fire-count / interval fields */
  fire?: boolean;
  /** reveals the macro-library picker */
  macro?: boolean;
}

const sub = (pairs: [number, string][]): ButtonSubAction[] =>
  pairs.map(([value, labelEn]) => ({ value, labelEn }));

export const BUTTON_ACTIONS_TREE: ButtonActionDef[] = [
  {
    key: 'button',
    vendorValue: '1',
    wire: 0x01,
    labelKey: 'btnact.button',
    children: sub([
      [0x0100, 'Left Click'],
      [0x0200, 'Right Click'],
      [0x0400, 'Wheel Click'],
      [0x0800, 'Backward'],
      [0x1000, 'Forward'],
    ]),
  },
  {
    key: 'dpiSwitch',
    vendorValue: '2',
    wire: 0x02,
    labelKey: 'btnact.dpiSwitch',
    children: sub([
      [0x0100, 'DPI loop'],
      [0x0200, 'DPI +'],
      [0x0300, 'DPI -'],
    ]),
  },
  {
    key: 'scrollLR',
    vendorValue: '3',
    wire: 0x03,
    labelKey: 'btnact.scrollLR',
    children: sub([
      [0x0100, 'Scroll Left'],
      [0x0200, 'Scroll Right'],
    ]),
  },
  {
    key: 'scrollUD',
    vendorValue: 'B',
    wire: 0x0b, // inferred: vendor value "B" == 0x0b
    labelKey: 'btnact.scrollUD',
    children: sub([
      [0x0100, 'Scroll Up'],
      [0x0200, 'Scroll Down'],
    ]),
  },
  { key: 'firepower', vendorValue: '4', wire: 0x04, labelKey: 'btnact.firepower', fire: true },
  { key: 'combo', vendorValue: '5', wire: 0x05, labelKey: 'btnact.combo', combo: true },
  {
    key: 'multimedia',
    vendorValue: '1005',
    wire: 0x05,
    labelKey: 'btnact.multimedia',
    multimedia: true,
    children: sub([
      [0x0183, 'Media player'],
      [0x00cd, 'Play/Pause'],
      [0x00b5, 'Next Track'],
      [0x00b6, 'Previous Track'],
      [0x00b7, 'Stop Playback'],
      [0x00e2, 'Mute'],
      [0x00e9, 'Volume+'],
      [0x00ea, 'Volume-'],
      [0x018a, 'Email'],
      [0x0192, 'Calculator'],
      [0x0194, 'My Computer'],
      [0x0223, 'Homepage'],
      [0x0221, 'Search'],
      [0x0225, 'Next page'],
      [0x0224, 'Previous page'],
      [0x0226, 'Stop page'],
      [0x0227, 'Refresh page'],
      [0x022a, 'Favorites'],
    ]),
  },
  { key: 'macro', vendorValue: '6', wire: 0x06, labelKey: 'btnact.macro', macro: true },
  { key: 'pollRateSwitch', vendorValue: '7', wire: 0x07, labelKey: 'btnact.pollRateSwitch' },
  { key: 'configSwitch', vendorValue: '9', wire: null, labelKey: 'btnact.configSwitch' },
  { key: 'dpiLock', vendorValue: '12', wire: 0x0a, labelKey: 'btnact.dpiLock' },
  { key: 'dpiLedToggle', vendorValue: '14', wire: null, labelKey: 'btnact.dpiLedToggle' },
  { key: 'lightToggle', vendorValue: '13', wire: null, labelKey: 'btnact.lightToggle' },
  { key: 'decorLamp', vendorValue: '11', wire: null, labelKey: 'btnact.decorLamp' },
  { key: 'stripToggle', vendorValue: '15', wire: null, labelKey: 'btnact.stripToggle' },
  { key: 'stripCycle', vendorValue: '16', wire: null, labelKey: 'btnact.stripCycle' },
  { key: 'undefined', vendorValue: '10', wire: null, labelKey: 'btnact.undefined' },
  { key: 'disable', vendorValue: '0', wire: 0x00, labelKey: 'btnact.disable' },
];

export const BUTTON_ACTION_BY_KEY: Record<string, ButtonActionDef> = Object.fromEntries(
  BUTTON_ACTIONS_TREE.map((a) => [a.key, a]),
);

/** The subset a model's `spec.buttonActions` may list; absent = the V8 default. */
export const V8_BUTTON_ACTION_KEYS = [
  'button',
  'dpiSwitch',
  'scrollLR',
  'scrollUD',
  'firepower',
  'combo',
  'multimedia',
  'macro',
  'pollRateSwitch',
  'configSwitch',
  'dpiLock',
  'dpiLedToggle',
  'disable',
] as const;

/** Best-effort region-A action byte for an action key (falls back to the
 *  low byte of the vendor value for the unconfirmed ones). */
export function actionWireByte(key: string): number {
  const def = BUTTON_ACTION_BY_KEY[key];
  if (!def) return 0;
  if (def.wire !== null) return def.wire;
  const n = parseInt(def.vendorValue, def.vendorValue.match(/[a-f]/i) ? 16 : 10);
  return n & 0xff;
}

/** Recover the action key from a region-A action byte (best match). */
export function actionKeyFromWire(wire: number): string {
  const hit = BUTTON_ACTIONS_TREE.find((a) => a.wire === wire);
  if (hit) return hit.key;
  const guess = BUTTON_ACTIONS_TREE.find((a) => actionWireByte(a.key) === wire);
  return guess?.key ?? 'button';
}

interface RegionAButton {
  actionKey?: string;
  action?: number;
  param?: number;
  fire?: { times: number; interval: number };
  macroSlot?: number;
  macroRepeat?: number;
}

/**
 * `[action, param1, param2]` for the region-A 4-byte button slot (the driver
 * appends the companion). Encodings are from the captures:
 *   button / dpi-switch / scroll : p1 = param >> 8   (`01 10 00` = Forward)
 *   firepower                    : p1 = interval, p2 = times   (`04 0a 03`)
 *   macro                        : p1 = slot, p2 = repeat      (`06 05 fe`)
 *   dpi-lock                     : p1 = 0x0f (vendor constant) (`0a 0f 00`)
 *   combo / multimedia           : p1 = p2 = 0 (payload is region B)
 */
export function encodeButtonRegionA(m: RegionAButton): [number, number, number] {
  const def = m.actionKey ? BUTTON_ACTION_BY_KEY[m.actionKey] : undefined;
  const action = m.action ?? (m.actionKey ? actionWireByte(m.actionKey) : 0);
  if (def?.fire && m.fire) return [action, m.fire.interval & 0xff, m.fire.times & 0xff];
  if (def?.macro) return [action, (m.macroSlot ?? 1) & 0xff, (m.macroRepeat ?? 0xfe) & 0xff];
  if (m.actionKey === 'dpiLock') return [action, 0x0f, 0x00];
  if (def?.combo || def?.multimedia) return [action, 0x00, 0x00];
  if (def?.children && m.param !== undefined)
    return [action, (m.param >> 8) & 0xff, m.param & 0xff];
  return [action, 0x00, 0x00];
}
