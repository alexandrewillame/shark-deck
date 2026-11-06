/**
 * Which settings a device's menus show — one table, read by the renderer to
 * draw each control, by the prefetch to decide what to read ahead, and by
 * `renderer/tabs/menuGates.test.tsx` to prove the two agree for every model.
 *
 * Before this table each section decided for itself, and several decided
 * wrongly: motion sync, angle snapping, ripple control, the DPI stage colours
 * and the keyboard effect grid were shown on every mouse/keyboard whatever the
 * model had. A gate is a pure predicate over what the descriptor declares
 * (capabilities + the renderer-facing `DeviceUi`), never over a model name.
 */
import type { Capability } from './types/capability';
import type { DeviceKind } from './types/device';
import type { DeviceUi } from './types/live';

/** The slice of a LiveDevice the gates read. */
export interface GateSubject {
  kind: DeviceKind;
  wireless: boolean;
  capabilities: readonly Capability[];
  ui: DeviceUi;
}

export type TabId = 'profile' | 'buttons' | 'keys' | 'actuation' | 'macros' | 'lighting' | 'device';

interface GateDef {
  /** the config tab the control lives on */
  tab: TabId;
  /** the sub-view inside that tab, when it has several */
  view?: string;
  /** a gate this one only renders inside of (a key of GATES; checked by menuGates.test.ts) */
  parent?: string;
  when: (d: GateSubject) => boolean;
}

const has = (d: GateSubject, c: Capability) => d.capabilities.includes(c);

/**
 * Does Shark Deck configure this device at all? Not until it has said what it
 * is (`pending`), and never for another brand's device, a model id no table
 * knows, or an Attack Shark model whose command set has no driver yet: those
 * show the Device tab's identity panel (`dev.identity`) and nothing else.
 */
export function configurable(d: Pick<GateSubject, 'ui'>): boolean {
  const id = d.ui.identity;
  return id === undefined || id === 'exact' || id === 'class';
}
const mouse = (d: GateSubject) => d.kind === 'mouse';
const keyboard = (d: GateSubject) => d.kind === 'keyboard';

/**
 * True when every key of the board's layout carries a firmware slot, so a
 * per-key write can be addressed. A board without one (most of the line, until
 * its slot map is known) gets whole-board settings only — guessing a slot is
 * how a write lands on the wrong key.
 */
export function layoutAddressable(ui: Pick<DeviceUi, 'keyMatrix'>): boolean {
  const km = ui.keyMatrix;
  if (!km?.layout?.length) return false;
  if (km.layoutStatus === 'none') return false;
  return km.layout.every((k) => k.slot !== undefined);
}

const SENSOR_CAPS: Capability[] = [
  'sensorTuning',
  'motionSync',
  'lod',
  'highFpsScan',
  'longDistanceMode',
  'sensorMode',
  'angleSnapping',
  'rippleControl',
  'angleMode',
];

const LIGHTING_CAPS: Capability[] = [
  'perKeyLighting',
  'sideLighting',
  'mouseLighting',
  'dpiIndicatorLed',
  'receiverLed',
];

export const GATES = {
  // ---- tabs ---------------------------------------------------------------
  'tab.buttons': { tab: 'buttons', when: (d) => has(d, 'buttonRemap') },
  'tab.keys': {
    tab: 'keys',
    when: (d) => (has(d, 'keyRemap') || has(d, 'fnLayer')) && layoutAddressable(d.ui),
  },
  'tab.actuation': { tab: 'actuation', when: (d) => has(d, 'magneticSwitches') },
  'tab.macros': {
    tab: 'macros',
    // A keyboard macro is only reachable through a key binding, which needs
    // the slot map; a mouse binds it to a button.
    when: (d) => has(d, 'macros') && (mouse(d) || layoutAddressable(d.ui)),
  },
  'tab.lighting': { tab: 'lighting', when: (d) => LIGHTING_CAPS.some((c) => has(d, c)) },

  // ---- profile / general --------------------------------------------------
  'dpi.section': { tab: 'profile', when: (d) => mouse(d) && has(d, 'dpi') },
  'dpi.stageColors': {
    tab: 'profile',
    parent: 'dpi.section',
    when: (d) => d.ui.dpiRange?.colorPerStage ?? has(d, 'dpiIndicatorLed'),
  },
  'poll.section': { tab: 'profile', when: (d) => has(d, 'pollRate') },
  'sensor.section': {
    tab: 'profile',
    when: (d) => mouse(d) && SENSOR_CAPS.some((c) => has(d, c)),
  },
  'sensor.lod': {
    tab: 'profile',
    parent: 'sensor.section',
    when: (d) => has(d, 'lod') && (d.ui.lodOptions?.length ?? 0) > 0,
  },
  'sensor.mode': {
    tab: 'profile',
    parent: 'sensor.section',
    when: (d) => has(d, 'sensorMode') && !!d.ui.sensorModes,
  },
  'sensor.motionSync': {
    tab: 'profile',
    parent: 'sensor.section',
    when: (d) => has(d, 'motionSync'),
  },
  'sensor.angleSnap': {
    tab: 'profile',
    parent: 'sensor.section',
    when: (d) => has(d, 'angleSnapping'),
  },
  'sensor.angleMode': {
    tab: 'profile',
    parent: 'sensor.section',
    when: (d) => has(d, 'angleMode'),
  },
  'sensor.ripple': {
    tab: 'profile',
    parent: 'sensor.section',
    when: (d) => has(d, 'rippleControl'),
  },
  'sensor.highFps': {
    tab: 'profile',
    parent: 'sensor.section',
    when: (d) => has(d, 'highFpsScan'),
  },
  'sensor.longRange': {
    tab: 'profile',
    parent: 'sensor.section',
    when: (d) => has(d, 'longDistanceMode'),
  },
  'debounce.mouse': { tab: 'profile', when: (d) => mouse(d) && has(d, 'mouseDebounce') },
  'debounce.keyboard': { tab: 'profile', when: (d) => keyboard(d) && has(d, 'debounce') },
  'perf.section': { tab: 'profile', when: (d) => mouse(d) && has(d, 'perfMode') },
  'dpiDynamic.section': { tab: 'profile', when: (d) => mouse(d) && has(d, 'dpiDynamic') },
  'kb.fnLayout': { tab: 'profile', when: (d) => keyboard(d) && has(d, 'keyboardOptions') },
  'power.section': { tab: 'profile', when: (d) => d.wireless && has(d, 'sleepTimer') },

  // ---- keys -----------------------------------------------------------------
  'keys.base': { tab: 'keys', view: 'base', parent: 'tab.keys', when: (d) => has(d, 'keyRemap') },
  'keys.fn': { tab: 'keys', view: 'fn', parent: 'tab.keys', when: (d) => has(d, 'fnLayer') },

  // ---- actuation ------------------------------------------------------------
  'act.perKey': {
    tab: 'actuation',
    view: 'keys',
    parent: 'tab.actuation',
    when: (d) => layoutAddressable(d.ui),
  },
  'act.wholeBoard': {
    tab: 'actuation',
    view: 'keys',
    parent: 'tab.actuation',
    when: (d) => !layoutAddressable(d.ui),
  },
  'act.test': {
    tab: 'actuation',
    view: 'test',
    parent: 'tab.actuation',
    when: (d) => layoutAddressable(d.ui),
  },
  'act.rapidTrigger': {
    tab: 'actuation',
    view: 'keys',
    parent: 'tab.actuation',
    when: (d) => has(d, 'rapidTrigger'),
  },
  'act.triggerOptions': {
    tab: 'actuation',
    view: 'keys',
    parent: 'act.perKey',
    when: (d) => has(d, 'keyboardOptions'),
  },
  'act.deadZoneTop': {
    tab: 'actuation',
    view: 'keys',
    parent: 'tab.actuation',
    when: (d) => d.ui.magnetic?.deadZoneTop !== false,
  },

  // ---- lighting -------------------------------------------------------------
  'light.kbEffects': {
    tab: 'lighting',
    parent: 'tab.lighting',
    when: (d) => keyboard(d) && has(d, 'perKeyLighting'),
  },
  'light.perKeyPaint': {
    tab: 'lighting',
    parent: 'light.kbEffects',
    when: (d) => d.ui.perKeyLighting && layoutAddressable(d.ui),
  },
  'light.side': {
    tab: 'lighting',
    parent: 'tab.lighting',
    when: (d) => has(d, 'sideLighting') && d.ui.lightZones.includes('side'),
  },
  'light.receiver': { tab: 'lighting', parent: 'tab.lighting', when: (d) => has(d, 'receiverLed') },
  'light.dpiLed': {
    tab: 'lighting',
    parent: 'tab.lighting',
    when: (d) => has(d, 'dpiIndicatorLed'),
  },
  'light.body': { tab: 'lighting', parent: 'tab.lighting', when: (d) => has(d, 'mouseLighting') },

  // ---- device ---------------------------------------------------------------
  'dev.switches': {
    tab: 'device',
    view: 'switches',
    when: (d) => has(d, 'replaceableSwitches') && layoutAddressable(d.ui),
  },
  'dev.colour': { tab: 'device', view: 'device', when: (d) => d.ui.colorVariants.length > 1 },
  'dev.pair': { tab: 'device', view: 'device', when: (d) => d.wireless && has(d, 'pairing') },
  'dev.restore': { tab: 'device', view: 'device', when: (d) => has(d, 'restore') },
  'dev.identity': { tab: 'device', view: 'device', when: (d) => !configurable(d) },
} satisfies Record<string, GateDef>;

export type GateId = keyof typeof GATES;

/** Does this control render for this device (its own predicate AND its parents')? */
export function gate(id: GateId, d: GateSubject): boolean {
  // A device Shark Deck does not configure shows what it is and nothing else,
  // whatever its descriptor happens to carry (an unsupported board keeps its
  // photos and colours, for one).
  if (!configurable(d)) return id === 'dev.identity';
  let g: GateDef | undefined = GATES[id] as GateDef;
  while (g) {
    if (!g.when(d)) return false;
    g = g.parent ? GATES[g.parent as GateId] : undefined;
  }
  return true;
}

/** Every gate that is open for this device, in table order. */
export function openGates(d: GateSubject): GateId[] {
  return (Object.keys(GATES) as GateId[]).filter((id) => gate(id, d));
}

/**
 * Button actions offered per capability: a model without the capability must
 * not be offered the action (a macro button on a mouse with no macros, a
 * DPI-LED toggle on one with no DPI LED).
 */
export const BUTTON_ACTION_GATES: Record<string, Capability> = {
  macro: 'macros',
  dpiLedToggle: 'dpiIndicatorLed',
  pollRateSwitch: 'pollRate',
};

export function buttonActionAllowed(key: string, d: Pick<GateSubject, 'capabilities'>): boolean {
  const c = BUTTON_ACTION_GATES[key];
  return !c || d.capabilities.includes(c);
}
