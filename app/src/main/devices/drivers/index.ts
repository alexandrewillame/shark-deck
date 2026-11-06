import type { DriverContext } from './base';
import { Driver } from './base';
import { CompxMouse8K } from './compx-mouse-8k';
import { CompxKeyboard } from './compx-keyboard';
import { CompxHeKeyboard } from './compx-he-keyboard';
import { HubIdentify, NoIo, RoyuanIdentify } from './identify';
import { Yc500Keyboard } from './yc500-keyboard';
import { GearHubMouse } from './gearhub-mouse';
import { JxcMouse } from './jxc-mouse';

type DriverCtor = new (ctx: DriverContext) => Driver;

/** Exported for test/contract/backup-policy.test.ts, which holds every entry to a policy. */
export const DRIVERS: Readonly<Record<string, DriverCtor>> = {
  'compx-mouse-8k': CompxMouse8K,
  'compx-keyboard': CompxKeyboard,
  'compx-he-keyboard': CompxHeKeyboard,
  // The older YC3121 command set — never CompxKeyboard: its opcodes collide (yc500-keyboard.ts).
  'yc500-keyboard': Yc500Keyboard,
  // Mice on the same chip, their own options-block protocol (gearhub-mouse.ts).
  'gearhub-mouse': GearHubMouse,
  // Attack Shark's JXC mice on VID 0x373E, known by PID (jxc-mouse.ts).
  'jxc-mouse': JxcMouse,
  // A device attached before it has identified sends nothing but identify;
  // a read-only card sends nothing at all (see drivers/identify.ts).
  'royuan-identify': RoyuanIdentify,
  'hub-identify': HubIdentify,
  'no-io': NoIo,
};

export function createDriver(ctx: DriverContext): Driver {
  const Ctor = DRIVERS[ctx.descriptor.driver];
  if (!Ctor) throw new Error(`No driver registered for "${ctx.descriptor.driver}"`);
  return new Ctor(ctx);
}

export { Driver } from './base';
export type { DriverContext } from './base';
