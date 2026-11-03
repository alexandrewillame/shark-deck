import type { DeviceDescriptor } from '@shared/types/device';
import { SWITCH_CHOICES_DEFAULT } from '@shared/keyboard-switches';
import { ANSI_79_SG9047 } from '../layouts';

/**
 * Attack Shark R85HE — magnetic (Hall-effect) 8 kHz keyboard, **wired only**
 * (no dongle; `GET_RF_VERSION` returns nothing, so no battery).
 * (The device reports its product string as "R85HE"; earlier notes called it
 * "R5HE" — same USB id 0x3151:0x5029.)
 *
 * Vendor Driver v4 device-table row: `{ id: 3123, vid: 0x3151, pid: 0x5029,
 * keyLayout: Common79_SG9047, name: "ry5088_sg9047_1m_8k", layer: 4 }`. Note
 * ~99 other keyboard models share 0x3151:0x5029 — the vendor tells them apart
 * by the model `id` in the `GET_USB_VERSION` reply (bytes [2..3] LE), not by
 * VID/PID. SharkDeck still matches on VID/PID; see registry.ts.
 *
 * Frame format and checksum are **verified** against the real device
 * (`compx-fea`: `[reportId, cmd, checksum, ...args]`, checksum =
 * `(0xFF - Σ) & 0xFF` at byte 2). The key matrix (`ANSI_79_SG9047`) and the
 * command set come from vendor chunks 322d1e41.js / 5e635fe2.js
 * (`ported-from-vendor`). SET_* frame layouts still need the guided capture —
 * see docs/reverse-engineering/{FINDINGS-R85HE.md, CAPTURE-KEYBOARD.md}. A full
 * backup is taken automatically before the first write.
 */
export const ATTACK_SHARK_R85HE: DeviceDescriptor = {
  model: 'attack-shark-r85he',
  displayName: 'Attack Shark R85HE',
  vendor: 'Attack Shark',
  kind: 'keyboard',
  vid: 0x3151,
  pid: 0x5029,
  // Verified from hardware: GET_USB_VERSION reports 0x0c33 = 3123, matching the
  // R85HE row in the vendor device table. Shares its PID with the R86PROHE, so
  // this id is what actually tells the two apart.
  modelId: 3123,
  usagePage: 0xffff,
  usage: 0x02,
  reportLength: 65, // 64-byte vendor payload + leading report id
  // MI_02 config collection: HidD_SetFeature / HidD_GetFeature, confirmed
  // against the real device (GET_MACRO round-trips only with the right checksum).
  transport: 'feature-report',
  checksum: 'compx-fea',
  driver: 'compx-he-keyboard',
  provenance: 'ported-from-vendor',
  art: null,
  // Purely cosmetic — which product photo to show on the card (see
  // renderer/components/deviceArtAssets.ts and colors.ts). Never sent to
  // the device. Two case colours, each available with two keycap sets.
  colorVariants: [
    // The vendor's "green" colourway: a black case with a green light bar,
    // green Esc/Enter caps and green legends (see the bundled photo, which was
    // already named `-green.webp`). The swatch pairs the case with the accent
    // so it is distinguishable from `black-gradient`, which really is a plain
    // black board.
    {
      id: 'green',
      labelKey: 'color.r85he.green',
      swatch: 'linear-gradient(135deg,#1a1c20 55%,#3ddc55)',
    },
    {
      id: 'black-gradient',
      labelKey: 'color.r85he.blackGradient',
      swatch: 'linear-gradient(135deg,#1a1c20,#5a5f68)',
    },
    { id: 'white', labelKey: 'color.r85he.white', swatch: '#f2f3f5' },
    {
      id: 'white-contour',
      labelKey: 'color.r85he.whiteContour',
      swatch: 'linear-gradient(135deg,#f2f3f5,#c9d3ff)',
    },
  ],
  capabilities: [
    // Real onboard slots. The earlier reading - that SET_PROFILE(4) "only
    // flips a slot flag" with nothing behind it - was an assumption, and
    // acting on it is what made a profile switch a 30-second replay of every
    // setting: SharkDeck held the settings itself and wrote all of them on
    // every switch, which also meant auto-switch stamping a stale global
    // lighting effect over per-key lighting the user had just set.
    //
    // What is actually known: SET_PROFILE is verified against GET_PROFILE on
    // this board (see compx-keyboard.ts), GET_PROFILE answers reliably enough
    // to be the driver's liveness ping, and the Fn layer and key matrix are
    // already profile-indexed on the wire (SET_FN byte 3, GET_KEYMATRIX byte
    // 5). Lighting is the one thing that is NOT - SET_LEDPARAM, SET_SLEDPARAM
    // and SET_USERPIC carry no slot byte - so whether the board's lighting
    // follows the slot is the firmware's business, not ours.
    'profiles',
    'magneticSwitches',
    'rapidTrigger',
    // Both are backed by real write paths (magnetic pages 9 and 5); the vendor
    // UI offers them on this board too.
    'socd',
    'modTap',
    'dks',
    // Confirmed on hardware: writing magnetism page 252 sticks, and the board
    // reports it back once it has committed (~100-140ms — see
    // setSwitchTypes' read-back poll). A stored 0 means "this model's stock
    // switch", so a factory board reads as 79 zeros, which is why an earlier
    // pass mistook an uncommitted read-back for "the firmware ignores this
    // page". The ID SPACE is still `ported-from-vendor` and unconfirmed beyond
    // the six this board offers — see shared/keyboard-switches.ts.
    'replaceableSwitches',
    'keyRemap',
    'fnLayer',
    // beyond the vendor software: Driver v4 hides its debounce control for this
    // board (device-table row has no `deBounce` flag), but the firmware answers
    // GET_DEBOUNCE/SET_DEBOUNCE (6/134) — SharkDeck surfaces it anyway.
    'debounce',
    'keyboardOptions',
    'keystroke',
    'perKeyLighting',
    'sideLighting',
    'pollRate',
    'macros',
    // wired-only board — no `sleep24`/`sleepBT` in the vendor row and
    // GET_RF_VERSION returns nothing. `sleepTimer` kept for the software
    // auto-switch model, but there is no real sleep timer to program.
    'sleepTimer',
    'firmwareUpdate',
    'restore',
    'autoSwitch',
  ],
  spec: {
    profileCount: 4,
    pollRates: [125, 250, 500, 1000, 2000, 4000, 8000],
    // 16 columns x 6 rows of firmware matrix slots; 79 physical keys. `layout`
    // entries carry their `slot` (column-major, slot = col*6 + row).
    keyMatrix: { rows: 6, cols: 16, layout: ANSI_79_SG9047 },
    // The vendor's canonical six: this board's stock Outemu plus the five
    // types that fit the same housing. See SWITCH_CHOICES_DEFAULT.
    supportedSwitches: SWITCH_CHOICES_DEFAULT,
    lighting: { zones: ['per-key', 'side'], perKey: true },
  },
};
