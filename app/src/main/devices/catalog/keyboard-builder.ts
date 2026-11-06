import type { Capability } from '@shared/types/capability';
import type { DeviceDescriptor, MagneticSpec, TravelRangeSpec } from '@shared/types/device';
import type { KeyLayoutEntry } from '@shared/types/keys';
import { ANSI_79_SG9047 } from '@shared/layouts';
import { KB_TRAVEL_RANGE } from '@shared/keyboard-travel';
import type { KeyboardFamily, KeyboardRow, TravelRange } from './keyboard-row';
import { VENDOR_LAYOUTS } from './generated/vendor-layouts';
import { LAYOUT_GEOMETRY } from './generated/layout-geometry';

/**
 * One Attack Shark keyboard row (the vendor registry, via sharkfin — see
 * keyboard-row.ts) -> the descriptor Shark Deck drives it with.
 *
 * Every capability comes from a rule over the row, never from the model's
 * name: the same marketing name covers different hardware (three X87 Ultra
 * ids, one mechanical), and the menus must show exactly what the firmware
 * behind THIS model id has. `keyboard-builder.test.ts` pins each rule.
 *
 * provenance: ported-from-vendor — the flags are the vendor's own; nothing
 * here has been checked on hardware except the R85HE, whose hand-written
 * descriptor (catalog/r85he.ts) overlays row 3123 in catalog/keyboards.ts.
 */

/** Command sets Shark Deck has a driver for (gen2: compx-keyboard; yc500: yc500-keyboard). */
export const SUPPORTED_FAMILIES: ReadonlySet<KeyboardFamily> = new Set(['gen2', 'yc500']);

/**
 * Layouts whose slot map was verified on real hardware, by vendor layout
 * stem. The R85 Ultra shares the R85HE's PCB (SG9047) and layout name, so it
 * shares the map — re-checked against its own keymap before the first
 * per-key write, like every non-verified map.
 */
const VERIFIED_LAYOUTS: Record<string, KeyLayoutEntry[]> = {
  Common79_SG9047: ANSI_79_SG9047,
};

/** Photo sets by model id (one product spans several firmware ids). */
export const KEYBOARD_ART: Record<number, string> = {
  3123: 'attack-shark-r85he',
  3909: 'attack-shark-r86-he',
  3973: 'attack-shark-r86-he',
  3743: 'attack-shark-r98-he',
  3903: 'attack-shark-r98-he',
  3650: 'attack-shark-r68-he',
  2844: 'attack-shark-r82-he',
  2270: 'attack-shark-x68-he',
  2472: 'attack-shark-x68-he',
  2902: 'attack-shark-x68-he',
  4298: 'attack-shark-x68-he',
  2370: 'attack-shark-x68-pro-he',
  2901: 'attack-shark-x68-pro-he',
  2755: 'attack-shark-x68-max-he',
  3796: 'attack-shark-x68-max-he',
  1025: 'attack-shark-x65-he',
  2268: 'attack-shark-x65-he',
  2942: 'attack-shark-x65-he',
  3379: 'attack-shark-x65-he',
  2308: 'attack-shark-x65-pro-he',
  2938: 'attack-shark-x65-pro-he',
  2356: 'attack-shark-x82-pro-he',
  2935: 'attack-shark-x82-pro-he',
  1466: 'attack-shark-k85',
  2552: 'attack-shark-k85',
  3334: 'attack-shark-k85',
  1168: 'attack-shark-k86',
  2730: 'attack-shark-k86',
  4094: 'attack-shark-k86',
  1724: 'attack-shark-x85-pro',
  2952: 'attack-shark-x85-pro',
  3451: 'attack-shark-x85-pro',
  3504: 'attack-shark-x85-pro',
  4084: 'attack-shark-x85-pro',
  4039: 'attack-shark-x85',
  1967: 'attack-shark-x86',
  2408: 'attack-shark-x86',
  1996: 'attack-shark-x98-pro',
  2934: 'attack-shark-x98-pro',
  4109: 'attack-shark-x98-pro',
  2804: 'attack-shark-x820-ultra',
  3461: 'attack-shark-x820-ultra',
  3922: 'attack-shark-x820-ultra',
  3438: 'attack-shark-x87-ultra',
  4012: 'attack-shark-m86',
};

/**
 * Travel limits the store states for boards whose registry row carries none.
 * The K85 stops at 0.2 mm in 0.1 mm steps (its product page) — offering 0.1
 * would write a value the firmware rejects or rounds.
 */
const TRAVEL_OVERRIDES: Record<number, Partial<Record<'travel', TravelRangeSpec>>> = {
  1466: { travel: { min: 0.2, max: 3.8, step: 0.1, default: 2.0 } },
  2552: { travel: { min: 0.2, max: 3.8, step: 0.1, default: 2.0 } },
  3334: { travel: { min: 0.2, max: 3.8, step: 0.1, default: 2.0 } },
};

const POLL_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

/**
 * The firmware lineage (internal-name prefix) that accepts per-key magnetic
 * writes, as sharkfin gates them: `ry5088_` on gen2, `yc3121_` on yc500. A
 * magnetic flag without it (the X65 HE 1025, `attackshark_x65he`) means the
 * vendor app shows no Hall-effect settings either.
 */
export function magneticWritable(row: Pick<KeyboardRow, 'family' | 'internalName' | 'magnetic'>) {
  if (!row.magnetic) return false;
  if (row.family === 'gen2') return row.internalName.startsWith('ry5088_');
  if (row.family === 'yc500') return row.internalName.startsWith('yc3121_');
  return false;
}

/** The slot map for a row, and how far it is trusted. */
export function slotLayoutFor(row: KeyboardRow): {
  layout: KeyLayoutEntry[] | undefined;
  status: 'verified' | 'certain' | 'none';
} {
  if (row.id === 3123) return { layout: ANSI_79_SG9047, status: 'verified' };
  const verified = VERIFIED_LAYOUTS[row.layout];
  if (verified) return { layout: verified, status: 'certain' };
  if (row.slotLayout && VENDOR_LAYOUTS[row.slotLayout]) {
    return { layout: VENDOR_LAYOUTS[row.slotLayout], status: 'certain' };
  }
  return { layout: LAYOUT_GEOMETRY[row.layout], status: 'none' };
}

const toSpecRange = (r: TravelRange, fallback: TravelRangeSpec): TravelRangeSpec => ({
  min: r.min,
  max: r.max,
  step: r.step,
  default: r.default ?? Math.min(Math.max(fallback.default, r.min), r.max),
});

function magneticSpec(row: KeyboardRow): MagneticSpec {
  const ranges: MagneticSpec['ranges'] = {};
  const t = row.travel;
  if (t?.travel) ranges.travel = toSpecRange(t.travel, KB_TRAVEL_RANGE.travel);
  // sharkfin's firePress/fireLift are the rapid-trigger sensitivities.
  if (t?.firePress) ranges.rt = toSpecRange(t.firePress, KB_TRAVEL_RANGE.rt);
  if (t?.deadzone) ranges.deadzone = toSpecRange(t.deadzone, KB_TRAVEL_RANGE.deadzone);
  Object.assign(ranges, TRAVEL_OVERRIDES[row.id] ?? {});
  return {
    ranges,
    // The top dead zone (page 251) is "only if supported" in the vendor app;
    // the ry5088 lineage has it (verified on the R85HE).
    deadZoneTop: row.internalName.startsWith('ry5088_'),
  };
}

export function buildKeyboardDescriptor(row: KeyboardRow): DeviceDescriptor {
  const supported = SUPPORTED_FAMILIES.has(row.family);
  const yc500 = row.family === 'yc500';
  const { layout, status } = slotLayoutFor(row);
  const addressable = status !== 'none';
  // The yc500 driver has no magnetic pages yet (different units, 126 one-byte
  // slots, a board-wide record below revision 2.00): its one magnetic board,
  // the K85 1466, gets no actuation menu rather than gen2's.
  const magnetic = supported && !yc500 && magneticWritable(row);
  const wireless = row.sleep24 || row.sleepBT;
  const caps: Capability[] = [];

  if (supported) {
    if (row.profiles > 1) caps.push('profiles', 'autoSwitch');
    // yc500 has no report-rate command at all (the vendor's setter is a stub).
    if (row.family === 'gen2') caps.push('pollRate');
    caps.push('perKeyLighting'); // every Attack Shark row has a main RGB backlight
    if (row.sideLight) caps.push('sideLighting');
    if (row.debounce) caps.push('debounce');
    // KBOPTION's layout is known for the ry5088 lineage (qmk.top's
    // `___getKBOption_ry5088`, confirmed on the R85HE); its fields are
    // undocumented elsewhere, so other lineages do not get it.
    if (row.internalName.startsWith('ry5088_')) caps.push('keyboardOptions');
    if (wireless) caps.push('sleepTimer');
    // Macros are gen2's: the yc500 driver writes no macro pages yet.
    if (addressable) caps.push('keyRemap', 'fnLayer', ...(yc500 ? [] : (['macros'] as const)));
    if (magnetic) {
      caps.push('magneticSwitches', 'rapidTrigger');
      if (addressable) caps.push('dks', 'socd', 'modTap');
      if (addressable && row.switchReplaceable) caps.push('replaceableSwitches');
    }
    caps.push('restore');
  }

  const cableMax = row.rates.cable ?? 1000;
  const coBrand = row.vendorName.startsWith('AK0');
  return {
    model: row.slug,
    displayName: coBrand ? `AJAZZ × Attack Shark ${row.name}` : `Attack Shark ${row.name}`,
    vendor: 'Attack Shark',
    kind: 'keyboard',
    vid: row.vid,
    pid: row.pid,
    modelId: row.id,
    usagePage: 0xffff,
    usage: 0x02,
    reportLength: 65,
    transport: 'feature-report',
    checksum: 'compx-fea',
    driver:
      row.family === 'yc500' ? 'yc500-keyboard' : magnetic ? 'compx-he-keyboard' : 'compx-keyboard',
    provenance: 'ported-from-vendor',
    art: null,
    artKey: KEYBOARD_ART[row.id],
    identity: supported ? 'exact' : 'unsupported',
    capabilities: caps,
    spec: {
      profileCount: Math.max(1, row.profiles),
      // Only for a board that has the setting: a list on a yc500 board (no
      // report-rate command) would be a menu entry the family cannot answer.
      ...(caps.includes('pollRate') ? { pollRates: POLL_RATES.filter((r) => r <= cableMax) } : {}),
      keyMatrix: { rows: 6, cols: 22, layout, layoutStatus: status },
      lighting: {
        zones: row.sideLight ? ['per-key', 'side'] : ['per-key'],
        // yc500 per-key colours write flash and read back stale: not offered.
        perKey: addressable && !yc500,
      },
      ...(yc500 ? { debounceRange: { min: 1, max: 10 } } : {}),
      ...(yc500 && row.magnetic ? { profileByteStride: 4 } : {}),
      ...(magnetic ? { magnetic: magneticSpec(row) } : {}),
      ...(row.switchTypes.length ? { supportedSwitches: row.switchTypes.map((s) => s.code) } : {}),
      ...(wireless ? { wireless: true } : {}),
    },
  };
}
