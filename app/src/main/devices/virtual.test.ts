import { describe, expect, it } from 'vitest';
import type { Capability } from '@shared/types/capability';
import type { DeviceDescriptor } from '@shared/types/device';
import { CAPABILITY_META } from '@shared/capabilities';
import { CATALOG } from './catalog';
import { VirtualDriver, virtualDescriptors } from './virtual';

/**
 * Developer mode's simulated devices only earn their keep if the UI cannot
 * tell them from real hardware. Two properties matter, and both are easy to
 * regress silently by adding a capability without a matching seed:
 *
 *  - a read that settles on `null` makes `useDeviceData` raise the "couldn't
 *    read this device" banner, on a card that claims to be online;
 *  - a write that isn't `{ok, verified:'match'}` makes `useWrite` toast.
 *
 * Both are asserted per descriptor, driven off `capabilities`, so a new
 * capability with no seed fails here instead of looking broken in the app.
 */

function driverFor(d: DeviceDescriptor): VirtualDriver {
  return new VirtualDriver({
    descriptor: d,
    // VirtualDriver overrides everything that would touch the channel; a real
    // one is never constructed for these tests.
    channel: null as never,
    onWarning: () => undefined,
  });
}

/** Reads that must answer, keyed by the capability that surfaces them. */
const READS_BY_CAPABILITY: Partial<Record<Capability, (d: VirtualDriver) => Promise<unknown>>> = {
  dpi: (d) => d.readDpiStages(),
  pollRate: (d) => d.readPollRate(),
  sensorTuning: (d) => d.readSensor(),
  sleepTimer: (d) => d.readPower(),
  buttonRemap: (d) => d.readButtons(),
  magneticSwitches: (d) => d.readMagnetic(),
  replaceableSwitches: (d) => d.readSwitchTypes(),
  perKeyLighting: (d) => d.readPerKeyLighting(),
  sideLighting: (d) => d.readSideLighting(),
  receiverLed: (d) => d.readReceiverLed(),
  dpiIndicatorLed: (d) => d.readDpiLed(),
  keyRemap: (d) => d.readKeyBindings('base'),
  fnLayer: (d) => d.readFnLayer(),
  macros: (d) => d.readMacros(),
  debounce: (d) => d.readDebounce(),
  keyboardOptions: (d) => d.readKeyboardOptions(),
  mouseDebounce: (d) => d.readDebounce(),
  perfMode: (d) => d.readPerformance(),
  dpiDynamic: (d) => d.readDpiDynamic(),
  pairing: (d) => d.getPairingStatus(),
};

/**
 * Capabilities that deliberately have no entry in READS_BY_CAPABILITY, with
 * the reason. READS_BY_CAPABILITY is a Partial<Record<...>>, so without this
 * the map silently skips any capability nobody added -- "forgot to seed a
 * read" was invisible rather than a failure.
 *
 * Adding a capability to the union now forces a decision: give it a read
 * above, or record here why it does not need one.
 */
const NO_READ: Partial<Record<Capability, string>> = {
  // Fields of SensorSettings; exercised through sensorTuning's readSensor().
  motionSync: 'field of readSensor()',
  angleSnapping: 'field of readSensor()',
  rippleControl: 'field of readSensor()',
  lod: 'field of readSensor()',
  highFpsScan: 'field of readSensor()',
  longDistanceMode: 'field of readSensor()',
  angleMode: 'field of readSensor()',
  sensorMode: 'field of readSensor()',

  // Fields of MagneticKeySettings; exercised through magneticSwitches.
  rapidTrigger: 'field of readMagnetic()',
  dks: 'field of readMagnetic()',
  socd: 'field of readMagnetic()',
  modTap: 'field of readMagnetic()',

  // Read off LiveDevice / the manager rather than through a driver read.
  profiles: 'LiveDevice.activeProfile, not a driver read',
  firmwareUpdate: 'getFirmware() lives on the manager, not in this map',

  // No device read at all.
  restore: 'backup/restore path, nothing to read',
  autoSwitch: 'app-level feature, no device state',
  keystroke: 'surfaced inside KeyboardOptions',

  // Declared by no descriptor today (neither CATALOG nor the synthetic
  // registry families), so no simulated device can exercise them. If a model
  // ever declares one it needs a read seed above, and its entry here removed.
  mouseLighting: 'no descriptor declares it yet',
  screen: 'no descriptor declares it yet',
};

describe('the capability read map is exhaustive', () => {
  it('classifies every Capability as either read-seeded or documented NO_READ', () => {
    const all = Object.keys(CAPABILITY_META) as Capability[];
    // Non-vacuity guard: CAPABILITY_META is a Record<Capability, ...> so tsc
    // keeps it exhaustive, but an import regression here would empty it and
    // make every assertion below trivially true.
    expect(all.length, 'CAPABILITY_META looks empty').toBeGreaterThan(35);

    const unclassified = all.filter((c) => !(c in READS_BY_CAPABILITY) && !(c in NO_READ));
    expect(
      unclassified,
      'Capabilities with neither a read seed nor a NO_READ reason: ' +
        unclassified.join(', ') +
        '. Add a read to READS_BY_CAPABILITY, or a documented entry to NO_READ.',
    ).toEqual([]);

    const both = all.filter((c) => c in READS_BY_CAPABILITY && c in NO_READ);
    expect(both, 'Capabilities listed as both read-seeded and NO_READ: ' + both.join(', ')).toEqual(
      [],
    );
  });
});

describe('virtualDescriptors()', () => {
  const all = virtualDescriptors();

  it('covers every catalog model plus both synthetic families', () => {
    for (const c of CATALOG) {
      expect(
        all.some((d) => d.model === c.model),
        c.model,
      ).toBe(true);
    }
    // the two `inferred` fallbacks in registry.ts
    expect(all.some((d) => d.driver === 'compx-keyboard' && d.provenance === 'inferred')).toBe(
      true,
    );
    expect(all.some((d) => d.kind === 'mouse' && d.provenance === 'inferred')).toBe(true);
    expect(all.length).toBe(CATALOG.length + 2);
  });

  it('tags every descriptor simulated — the flag every write guard keys on', () => {
    for (const d of all) expect(d.simulated, d.model).toBe(true);
  });

  it('never mutates the real catalog entries it is derived from', () => {
    for (const c of CATALOG) expect(c.simulated).toBeUndefined();
  });

  it('gives every descriptor a distinct device identity', () => {
    const ids = all.map((d) => `${d.vid}:${d.pid}:${d.model}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('VirtualDriver', () => {
  for (const descriptor of virtualDescriptors()) {
    describe(descriptor.model, () => {
      it('answers (non-null) every read its capabilities expose', async () => {
        const drv = driverFor(descriptor);
        for (const cap of descriptor.capabilities) {
          const read = READS_BY_CAPABILITY[cap];
          if (!read) continue;
          expect(await read(drv), `${descriptor.model}: ${cap}`).not.toBeNull();
        }
      });

      /**
       * The live-monitoring probe. A simulated card is the only place this
       * path runs without hardware, and if `VirtualDriver.readLiveState` ever
       * drifts from what `CompxMouse8K.readLiveState` reports, the simulated
       * DPI/poll-rate readouts go quietly stale instead of failing loudly.
       */
      it('answers the cheap live probe with whatever its capabilities imply', async () => {
        const drv = driverFor(descriptor);
        const live = (await drv.readLiveState())!;
        expect(live, descriptor.model).not.toBeNull();
        if (descriptor.capabilities.includes('pollRate')) {
          expect(live.pollRate, `${descriptor.model}: pollRate`).not.toBeNull();
        }
        if (descriptor.capabilities.includes('dpi')) {
          expect(live.activeDpiStage, `${descriptor.model}: activeDpiStage`).not.toBeNull();
          expect(live.dpiStageCount, `${descriptor.model}: dpiStageCount`).not.toBeNull();
        }
      });

      it('reports online, a firmware version and a profile so the UI unlocks', async () => {
        const drv = driverFor(descriptor);
        // DeviceConfig disables its whole fieldset when a device is offline.
        expect(await drv.ping()).toBe(true);
        expect((await drv.getFirmware())?.device).toBeTruthy();
        expect(await drv.getActiveProfile()).not.toBeNull();
      });

      it('reads back what was written', async () => {
        const drv = driverFor(descriptor);

        const poll = descriptor.spec.pollRates?.[0];
        if (poll !== undefined) {
          expect((await drv.setPollRate(poll)).verified).toBe('match');
          expect(await drv.readPollRate()).toBe(poll);
          // The live probe and the full read must agree — the manager trusts
          // the cheap one, the UI's cold start trusts the other.
          expect((await drv.readLiveState())?.pollRate).toBe(poll);
        }

        if (descriptor.capabilities.includes('dpi')) {
          expect((await drv.setActiveDpiStage(1)).verified).toBe('match');
          expect((await drv.readLiveState())?.activeDpiStage).toBe(1);
        }

        if (descriptor.capabilities.includes('dpi')) {
          const stages = (await drv.readDpiStages())!.map((s) => ({ ...s, dpi: 1234 }));
          const r = await drv.setDpiStages(stages);
          expect(r.ok).toBe(true);
          expect((await drv.readDpiStages())!.every((s) => s.dpi === 1234)).toBe(true);
        }

        if (descriptor.capabilities.includes('magneticSwitches')) {
          expect((await drv.setMagneticGlobal(2.4)).ok).toBe(true);
          expect((await drv.readMagnetic()).every((k) => k.actuationMm === 2.4)).toBe(true);
        }

        expect((await drv.setActiveProfile(3)).verified).toBe('match');
        expect(await drv.getActiveProfile()).toBe(3);
      });

      it('keeps per slot exactly what the slot carries', async () => {
        // A simulated device that shows the same values on every slot makes a
        // profile switch look broken in developer mode, which is where every
        // renderer change is walked — and one that shows DIFFERENT values
        // where the hardware has one register makes a shared setting look
        // per-profile. So: what `profileFieldsFor` says follows the slot does,
        // and nothing else.
        const rates = descriptor.spec.pollRates ?? [];
        const [a, b] = [rates[0], rates[rates.length - 1]];
        const canRate =
          descriptor.capabilities.includes('pollRate') &&
          a !== undefined &&
          b !== undefined &&
          a !== b;
        const drv = driverFor(descriptor);

        if (canRate) {
          await drv.setActiveProfile(1);
          await drv.setPollRate(a!);
          await drv.setActiveProfile(2);
          await drv.setPollRate(b!);
          expect(await drv.readPollRate()).toBe(b);
          await drv.setActiveProfile(1);
          if (descriptor.kind === 'keyboard') {
            expect(await drv.readPollRate(), 'a keyboard poll rate is one register').toBe(b);
          } else {
            expect(await drv.readPollRate(), 'slot 1 was clobbered by slot 2').toBe(a);
          }
        }

        if (descriptor.capabilities.includes('magneticSwitches')) {
          await drv.setActiveProfile(1);
          await drv.setMagneticGlobal(1.1);
          await drv.setActiveProfile(2);
          await drv.setMagneticGlobal(3.3);
          expect((await drv.readMagnetic()).every((k) => k.actuationMm === 3.3)).toBe(true);
          await drv.setActiveProfile(1);
          expect(
            (await drv.readMagnetic()).every((k) => k.actuationMm === 1.1),
            'slot 1 actuation was clobbered by slot 2',
          ).toBe(true);
        }
      });

      it('takes no backup, so ensureBackup() cannot write a file for this model', async () => {
        expect(await driverFor(descriptor).backup()).toEqual({});
      });
    });
  }
});

/**
 * The V8 wire has no per-stage disable — only DPI_STAGE_COUNT, which makes
 * slots 0..count-1 the set the mouse cycles. A stage that reaches a slot is a
 * stage the mouse can land on, so a disabled one has to be dropped before the
 * write, and the active index has to be re-clamped onto what survives.
 * Regression guard for "disabling the second stage switched the mouse into it".
 */
describe('a disabled DPI stage is never applied', () => {
  const mouse = virtualDescriptors().find((d) => d.capabilities.includes('dpi'))!;
  const stage = (index: number, dpi: number, enabled: boolean) => ({
    index,
    dpi,
    color: [0, 0, 0] as [number, number, number],
    enabled,
  });

  it('drops a disabled stage instead of storing it as a cycled slot', async () => {
    const drv = driverFor(mouse);
    await drv.setDpiStages([stage(0, 800, true), stage(1, 1600, false)]);
    const back = (await drv.readDpiStages())!;
    expect(back.map((s) => s.dpi)).toEqual([800]);
    expect(back.every((s) => s.enabled)).toBe(true);
  });

  it('pulls the active stage back into range when the set it pointed at shrinks', async () => {
    const drv = driverFor(mouse);
    await drv.setDpiStages([stage(0, 800, true), stage(1, 1600, true)]);
    expect((await drv.setActiveDpiStage(1)).verified).toBe('match');
    expect(await drv.readActiveDpiStage()).toBe(1);

    // Stage 2 goes away — the mouse must not be left selecting it.
    await drv.setDpiStages([stage(0, 800, true), stage(1, 1600, false)]);
    expect(await drv.readActiveDpiStage()).toBe(0);
  });

  it('clamps an out-of-range active stage rather than writing it through', async () => {
    const drv = driverFor(mouse);
    await drv.setDpiStages([stage(0, 800, true), stage(1, 1600, true)]);
    await drv.setActiveDpiStage(99);
    expect(await drv.readActiveDpiStage()).toBe(1);
    await drv.setActiveDpiStage(-4);
    expect(await drv.readActiveDpiStage()).toBe(0);
  });
});
