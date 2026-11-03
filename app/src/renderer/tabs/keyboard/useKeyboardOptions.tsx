import type { KeyboardOptions } from '@shared/types/keyboard-settings';
import { useEffect, useState } from 'react';
import { type TabProps, sd, useDeviceBusy, useWrite } from '../common';
import { useT } from '../../state/i18n';

/**
 * The keyboard's `KBOPTION` register — Fn layout, anti-mistouch, rapid-trigger
 * stabilisation and the hardware WASD/arrow swap.
 *
 * All five switches share ONE wire frame, which is why this is a hook rather
 * than a component: the four settings belong on four different tabs (they are
 * about triggering, remapping and profile layout respectively, not about
 * "device maintenance"), but each write must still merge over the last read or
 * it would clobber the other fields. The driver's `setKeyboardOptions` already
 * merges a partial change over its cached read, so several UI homes writing
 * different fields of the same register is safe by construction.
 */
export function useKeyboardOptions(device: TabProps['device']) {
  const t = useT();
  const [opts, setOpts] = useState<KeyboardOptions | null>(null);
  const { busy, whileBusy } = useDeviceBusy(device.id);
  const { run } = useWrite();

  useEffect(() => {
    let stale = false;
    sd.readKeyboardOptions(device.id).then((o) => {
      if (!stale) setOpts(o);
    });
    return () => {
      stale = true;
    };
  }, [device.id]);

  const patch = async (label: string, p: Partial<KeyboardOptions>) => {
    if (!opts) return;
    const next = { ...opts, ...p };
    setOpts(next); // optimistic, so the control does not lag the click
    // The write AND the confirming re-read are both inside the block: the
    // panel must not become operable again while it is still showing a guess.
    return whileBusy(t('busy.keyboardOption'), async () => {
      const r = await run(label, () => sd.setKeyboardOptions(device.id, p));
      // the driver re-reads after every write — trust the device over the guess
      const back = await sd.readKeyboardOptions(device.id);
      if (back) setOpts(back);
      return r;
    });
  };

  return { opts, busy, patch };
}
