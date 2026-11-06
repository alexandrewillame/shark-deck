import { act } from '@testing-library/react';
import type { DeviceDescriptor } from '@shared/types/device';
import type { LiveDevice } from '@shared/types/live';
import { sdMock } from './sdStub';
import type { VirtualDriver } from '../../src/main/devices/virtual';
import { deviceUi } from '../../src/main/devices/deviceUi';

/**
 * Rendering real panes against developer mode's simulated devices, for the
 * `ui` tier: a `LiveDevice` as the manager would publish it, and every read
 * answered by a `VirtualDriver`.
 */

/** The `LiveDevice` the manager would publish for this descriptor, online. */
export function liveDevice(d: DeviceDescriptor, id: string): LiveDevice {
  return {
    id,
    model: d.model,
    displayName: d.displayName,
    kind: d.kind,
    vid: d.vid,
    pid: d.pid,
    connection: d.wired ? 'usb' : d.kind === 'mouse' ? '2.4g' : 'usb',
    wireless: d.wired ? false : d.kind === 'mouse' || !!d.spec.wireless,
    online: true,
    receiverOnline: true,
    battery: d.kind === 'mouse' ? 80 : null,
    charging: false,
    batteryRaw: null,
    batteryMillivolts: null,
    activeProfile: 1,
    activeDpiStage: 1,
    activeDpi: null,
    pollRate: 1000,
    profileNames: {},
    firmware: null,
    capabilities: d.capabilities,
    provenance: d.provenance,
    art: d.art,
    colorVariant: d.colorVariants?.[0]?.id ?? null,
    hint: null,
    hasBackup: false,
    ui: deviceUi(d),
  };
}

/** Answer every read the panes make from a simulated driver. */
export function bridgeTo(vd: VirtualDriver) {
  const names = new Set<string>();
  for (
    let p = Object.getPrototypeOf(vd);
    p && p !== Object.prototype;
    p = Object.getPrototypeOf(p)
  ) {
    for (const n of Object.getOwnPropertyNames(p)) names.add(n);
  }
  for (const n of names) {
    if (!/^(read|get)[A-Z]/.test(n)) continue;
    const fn = (vd as unknown as Record<string, (...a: unknown[]) => unknown>)[n];
    if (typeof fn !== 'function') continue;
    sdMock[n]!.mockImplementation((_id: unknown, ...args: unknown[]) => fn.apply(vd, args));
  }
  // Libraries kept on the host, not the device: empty is the honest answer.
  for (const n of [
    'listMacroLibrary',
    'listBackups',
    'listKeyGroups',
    'listActuationLayouts',
    'listLightingLayouts',
    'listSavedLayouts',
  ]) {
    sdMock[n]!.mockResolvedValue([]);
  }
  // Actuation stores its key groups by itself once the board's reads land, and
  // keeps whatever the store answers. The host answers with the list as saved;
  // the stub's default `null` crashed any test still on Actuation by then.
  sdMock.replaceKeyGroups!.mockImplementation(
    async (_model: unknown, _profile: unknown, groups: unknown) => groups,
  );
  sdMock.startTravelStream!.mockImplementation(() => vd.startTravelStream());
}

/** Let the reads resolve and the effects they trigger run. */
export async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
