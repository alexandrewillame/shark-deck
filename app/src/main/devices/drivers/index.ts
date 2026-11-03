import type { DriverContext } from './base';
import { Driver } from './base';
import { CompxMouse8K } from './compx-mouse-8k';
import { CompxKeyboard } from './compx-keyboard';
import { CompxHeKeyboard } from './compx-he-keyboard';

type DriverCtor = new (ctx: DriverContext) => Driver;

const DRIVERS: Record<string, DriverCtor> = {
  'compx-mouse-8k': CompxMouse8K,
  'compx-keyboard': CompxKeyboard,
  'compx-he-keyboard': CompxHeKeyboard,
};

export function createDriver(ctx: DriverContext): Driver {
  const Ctor = DRIVERS[ctx.descriptor.driver];
  if (!Ctor) throw new Error(`No driver registered for "${ctx.descriptor.driver}"`);
  return new Ctor(ctx);
}

export { Driver } from './base';
export type { DriverContext } from './base';
