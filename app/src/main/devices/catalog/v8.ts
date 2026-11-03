import type { DeviceDescriptor } from '@shared/types/device';
import { LOD_OPTIONS } from '@shared/mouse-options';
import { V8_BUTTON_SLOT_ORDER, DEBOUNCE_RANGE } from '@shared/mouse-wire';

/**
 * Attack Shark V8 — wireless 8 kHz mouse, PAW3950 sensor, 8K dongle.
 *
 * Detection, the vendor config collection (MI_01 / usage-page 0xFF02 / usage
 * 0x02, 17-byte reports), the `(0x55 - Σ)` checksum and the profile-switch
 * frame are all VERIFIED against real traffic — see
 * docs/reverse-engineering/FINDINGS.md. DPI / sensor / button /
 * LED encodings reuse the same `0x08` frame family and the Config.ini spec but
 * are not yet capture-confirmed (driver marks them per-command).
 */
export const ATTACK_SHARK_V8: DeviceDescriptor = {
  model: 'attack-shark-v8',
  displayName: 'Attack Shark V8',
  vendor: 'Attack Shark',
  kind: 'mouse',
  vid: 0x3554,
  pid: 0xf517,
  usagePage: 0xff02,
  usage: 0x02,
  reportLength: 17,
  transport: 'output-report',
  checksum: 'shark-sum',
  driver: 'compx-mouse-8k',
  provenance: 'verified-capture',
  art: null,
  // Purely cosmetic — which product photo to show on the card (see
  // renderer/components/deviceArtAssets.ts and colors.ts). Never sent to
  // the device.
  colorVariants: [
    { id: 'black', labelKey: 'color.v8.black', swatch: '#1a1c20' },
    { id: 'white', labelKey: 'color.v8.white', swatch: '#f2f3f5' },
  ],
  capabilities: [
    'profiles',
    'dpi',
    'pollRate',
    'sensorTuning',
    'motionSync',
    'angleSnapping',
    'rippleControl',
    'lod',
    'highFpsScan',
    'longDistanceMode',
    // Re-added: the 2026-08-30 capture found no such control on the V8 Hub
    // ("off" just means 0°, no wire writes observed at all), but a gap
    // analysis of region A found a plausible unclaimed offset (0xB3, see
    // V8_BLOCK.ANGLE_DEGREES in mouse-wire.ts) — restored speculatively,
    // `provenance: inferred`, pending an on-hardware read-back confirmation.
    'angleMode',
    'sensorMode',
    'buttonRemap',
    'macros',
    'sleepTimer',
    'mouseDebounce',
    'dpiIndicatorLed',
    'receiverLed',
    'pairing',
    'firmwareUpdate',
    'restore',
    'autoSwitch',
  ],
  spec: {
    profileCount: 4,
    // Config.ini [Drive1]: DPIRange=50,26000,50,26100,42000,100,0x11 — a
    // 50–26000 band (step 50) then a 26100–42000 band (step 100). The wire
    // register `dpi/50-1` covers the whole span; the vendor UI max is 42000.
    dpi: { min: 50, max: 42000, step: 50, stages: 6, sensor: 'PAW3950' },
    pollRates: [125, 250, 500, 1000, 2000, 4000, 8000],
    buttons: 6,
    buttonSlotOrder: [...V8_BUTTON_SLOT_ORDER],
    // Physical position of each UI button index, for the numbered badges
    // PersistentDeviceArt.tsx draws directly on the device's own top-down
    // product photo (there is only ever the one photo — see that
    // component's doc comment) — coordinates are percentages of that
    // photo's own frame
    // (assets/devices/attack-shark-v8-*.webp), `provenance: inferred` from
    // the photo itself rather than a hardware capture; nudge against the
    // running app if a badge looks off. The DPI switch isn't visible from
    // this top-down angle (it's a bottom/underside control on this wireless
    // model) — `notVisibleInPhoto` places it at a best-guess spot on the
    // shell with a dashed, dimmed badge instead of a solid one.
    // The index -> physical mapping itself is read from the region-A
    // button-slot DEFAULTS (pre-image capture): slots 0-5 default to Left /
    // Right / Wheel / Backward / Forward / poll-switch; V8_BUTTON_SLOT_ORDER
    // then maps UI index 4/5 to slots 4/3. Not a live per-button press test —
    // verify by rebinding each button to a distinct action and pressing it
    // once hardware is back.
    buttonMap: [
      { index: 0, label: 'Left click', labelKey: 'buttons.name.left', x: 27, y: 22, locked: true },
      { index: 1, label: 'Right click', labelKey: 'buttons.name.right', x: 71, y: 22 },
      { index: 2, label: 'Wheel click', labelKey: 'buttons.name.wheel', x: 49, y: 18 },
      { index: 3, label: 'Forward', labelKey: 'buttons.name.fwd', x: -2, y: 37 },
      { index: 4, label: 'Backward', labelKey: 'buttons.name.back', x: -2, y: 56 },
      {
        index: 5,
        label: 'DPI switch',
        labelKey: 'buttons.name.dpi',
        x: 74,
        y: 55,
        notVisibleInPhoto: true,
      },
    ],
    sleepTimerRange: { min: 10, max: 900 },
    debounceRange: { ...DEBOUNCE_RANGE },
    sensorModes: true,
    lighting: { zones: ['dpi-led', 'receiver-led'] },
    // 0.7 / 1 / 2 mm — vendor Mouse Hub `LODOptions` (wire values 3 / 1 / 2).
    lodOptions: LOD_OPTIONS,
  },
};

/**
 * The same V8, plugged in by USB-C.
 *
 * Confirmed on hardware 2026-09-07: it enumerates as `3554:F515` (the dongle
 * is `F517`), product string "V8", the same serial, the same
 * MI_01 / usage-page 0xFF02 / usage 0x02 vendor collection, and answers the
 * identical `0x08` frame family — status, battery, profile and the region-A
 * block all read back byte-for-byte as they do over the air.
 *
 * It deliberately keeps the SAME `model` string as the wireless entry. Every
 * per-model store — onboard profile names, the colour/edition pick, backups,
 * software profiles, the device-state scratchpad — is keyed by it, and this is
 * one mouse with one set of onboard memory: naming a profile or picking the
 * white photo must not be forgotten the moment you plug the cable in. Identity
 * stays unique because devices are keyed by VID+PID+serial, not by model.
 *
 * Three capabilities are dropped rather than inherited, because over a cable
 * there is no receiver to configure: `receiverLed` (its `0x2D` read answers
 * the bare ACK when nothing is paired, as it should), `pairing`, and
 * `longDistanceMode` (the vendor's own `SetLongRangeMode`, an RF-link
 * setting). Everything else — DPI, poll rate, sensor, buttons, macros, the
 * DPI-indicator LED — is the same mouse and the same memory.
 */
export const ATTACK_SHARK_V8_WIRED: DeviceDescriptor = {
  ...ATTACK_SHARK_V8,
  pid: 0xf515,
  wired: true,
  capabilities: ATTACK_SHARK_V8.capabilities.filter(
    (c) => c !== 'receiverLed' && c !== 'pairing' && c !== 'longDistanceMode',
  ),
  spec: { ...ATTACK_SHARK_V8.spec, lighting: { zones: ['dpi-led'] } },
};
