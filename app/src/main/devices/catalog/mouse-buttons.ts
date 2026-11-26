import type { ButtonMapEntry } from '@shared/types/device';

/**
 * Where a mouse's buttons sit on its top-down photo, in % of the photo, for
 * the numbered badges of the Buttons tab (components/PersistentDeviceArt.tsx).
 * Measured on the V8's photos; every Attack Shark mouse photographed has its
 * buttons in the same places: the two main buttons, the wheel, Forward above
 * Backward on the left side, and the DPI button, which no top-down photo
 * shows (underneath on the V8 and the X8 PRO): its badge is drawn dashed, at
 * a spot on the shell.
 *
 * The index is the one readButtons()/setButtonMapping() use: Left, Right,
 * Wheel, Forward, Backward, DPI. A model lists as many as it lets you remap.
 * `click` is the "Button" action's value each gives from the factory, so
 * choosing that action starts on the button's own click, not Left click (the
 * X8 PRO's owner asked, 2026-11-25).
 */
export const MOUSE_BUTTON_MAP: readonly ButtonMapEntry[] = [
  {
    index: 0,
    label: 'Left click',
    labelKey: 'buttons.name.left',
    x: 27,
    y: 22,
    locked: true,
    click: 0x0100,
  },
  { index: 1, label: 'Right click', labelKey: 'buttons.name.right', x: 71, y: 22, click: 0x0200 },
  { index: 2, label: 'Wheel click', labelKey: 'buttons.name.wheel', x: 49, y: 18, click: 0x0400 },
  { index: 3, label: 'Forward', labelKey: 'buttons.name.fwd', x: -2, y: 37, click: 0x1000 },
  { index: 4, label: 'Backward', labelKey: 'buttons.name.back', x: -2, y: 56, click: 0x0800 },
  {
    index: 5,
    label: 'DPI switch',
    labelKey: 'buttons.name.dpi',
    x: 74,
    y: 55,
    notVisibleInPhoto: true,
  },
];

/** The badges for a mouse with `buttons` remappable buttons, in that order. */
export const mouseButtonMap = (buttons: number): ButtonMapEntry[] =>
  MOUSE_BUTTON_MAP.filter((e) => e.index < buttons).map((e) => ({ ...e }));
