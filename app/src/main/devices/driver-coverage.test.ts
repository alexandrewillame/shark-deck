import { describe, expect, it } from 'vitest';
import { GATES, openGates, type GateId } from '@shared/menuGates';
import type { DeviceDescriptor } from '@shared/types/device';
import { createDriver } from './drivers';
import { Driver } from './drivers/base';
import { virtualDescriptors } from './virtual';
import { deviceUi } from './deviceUi';
import { isReadOnly } from './identity';

/**
 * What a model's menus draw, its driver does.
 *
 * Each control the menus draw (`shared/menuGates.ts`) makes the same reads and
 * writes whatever the model. The base driver answers each of them with "… not
 * supported" or with nothing, which the tab shows as "couldn't read this from
 * the device". So for every real model, one of each shape (the demo roster),
 * every call of every control its menus draw must be its driver's own.
 *
 * The X8 PRO shipped a DPI tab whose stage picker its driver refused ("DPI
 * stage not supported") and whose current stage it never answered, though
 * both were in its owner's recordings (issue #1, 2026-11-24). Nothing checked
 * the real drivers against the menus: the demo driver answers everything.
 */
type Call = keyof Driver;
const CALLS: Partial<Record<GateId, Call[]>> = {
  'tab.buttons': ['readButtons', 'setButtonMapping'],
  'tab.macros': ['readMacros', 'saveMacro'],
  'dpi.section': ['readDpiStages', 'setDpiStages', 'readActiveDpiStage', 'setActiveDpiStage'],
  'poll.section': ['readPollRate', 'setPollRate'],
  'sensor.section': ['readSensor', 'setSensor'],
  'debounce.mouse': ['readDebounce', 'setDebounce'],
  'debounce.keyboard': ['readDebounce', 'setDebounce'],
  'perf.section': ['readPerformance', 'setPerformance'],
  'dpiDynamic.section': ['readDpiDynamic', 'setDpiDynamic'],
  'kb.fnLayout': ['readKeyboardOptions', 'setKeyboardOptions'],
  'power.section': ['readPower', 'setPower'],
  'keys.base': ['readKeyBindings', 'setKeyRemap'],
  'keys.fn': ['readKeyBindings', 'setKeyRemap'],
  'act.perKey': ['readMagnetic', 'setMagneticKey', 'readKeyZoneBindings', 'setKeyZoneBindings'],
  'act.wholeBoard': ['readMagnetic', 'setMagneticKeys'],
  'light.kbEffects': ['readLighting', 'setLighting'],
  'light.perKeyPaint': ['readPerKeyLighting', 'setPerKeyLighting'],
  'light.side': ['readSideLighting', 'setSideLighting'],
  'light.receiver': ['readReceiverLed', 'setReceiverLed'],
  'light.dpiLed': ['readDpiLed', 'setDpiLed'],
  'light.body': ['readLighting', 'setLighting'],
  'dev.switches': ['readSwitchTypes', 'setSwitchTypes'],
};

/** The controls that make no driver call of their own, and why. */
const NO_CALLS: Partial<Record<GateId, string>> = {
  'tab.keys': 'its views are keys.base / keys.fn',
  'tab.actuation': 'its sections are the act.* gates',
  'tab.lighting': 'its sections are the light.* gates',
  'dpi.stageColors': 'part of dpi.section',
  'sensor.lod': 'part of sensor.section (readSensor / setSensor)',
  'sensor.mode': 'part of sensor.section',
  'sensor.motionSync': 'part of sensor.section',
  'sensor.angleSnap': 'part of sensor.section',
  'sensor.angleMode': 'part of sensor.section',
  'sensor.ripple': 'part of sensor.section',
  'sensor.highFps': 'part of sensor.section',
  'sensor.longRange': 'part of sensor.section',
  'act.test': 'the live travel stream, which answers "unsupported" itself',
  'act.rapidTrigger': 'part of act.perKey',
  'act.triggerOptions': 'part of act.perKey',
  'act.deadZoneTop': 'part of act.perKey',
  'dev.colour': "the photo's colour, kept by the app",
  'dev.pair': 'pairing, checked by its own tests',
  'dev.restore': 'the backup path (guarded-write tests)',
  'dev.identity': 'a card, no call',
  'dev.support': 'the invitation to record, no device call',
  'dev.log': 'the log Shark Deck keeps, no device call',
};

const models: DeviceDescriptor[] = virtualDescriptors()
  .filter((d) => !isReadOnly(d) && d.identity !== 'pending')
  .map(({ simulated: _s, ...d }) => d);

const subject = (d: DeviceDescriptor) => ({
  kind: d.kind,
  wireless: d.wired ? false : d.kind === 'mouse' || !!d.spec.wireless,
  capabilities: d.capabilities,
  ui: deviceUi(d),
});

describe('what a model shows, its driver does', () => {
  it('knows what every control calls, or why it calls nothing', () => {
    const unclassified = (Object.keys(GATES) as GateId[]).filter(
      (id) => !(id in CALLS) && !(id in NO_CALLS),
    );
    expect(unclassified).toEqual([]);
    expect(models.length).toBeGreaterThan(20);
  });

  it('implements every read and write of every control its menus draw', () => {
    const base = Driver.prototype as unknown as Record<string, unknown>;
    const missing = new Set<string>();
    for (const d of models) {
      const drv = createDriver({ descriptor: d, channel: {} as never, onWarning: () => {} });
      const own = drv as unknown as Record<string, unknown>;
      for (const id of openGates(subject(d))) {
        for (const call of CALLS[id] ?? []) {
          if (typeof own[call] !== 'function' || own[call] === base[call])
            missing.add(`${d.model} (${d.driver}): ${id} → ${String(call)}`);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });
});
