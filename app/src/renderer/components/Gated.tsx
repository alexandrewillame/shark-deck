import { createContext, useContext, type ReactNode } from 'react';
import { gate, type GateId, type GateSubject } from '@shared/menuGates';

/**
 * Test-only: when provided, every `<Gated>` that renders records its id here,
 * so `tabs/menuGates.test.tsx` can compare what a model's menus actually drew
 * against what `shared/menuGates.ts` says they should draw.
 */
export const GateProbe = createContext<Set<GateId> | null>(null);

/**
 * Render `children` only when the device's gate is open (see
 * shared/menuGates.ts). Place it exactly where the control renders, so a
 * section that bails out (loading, read failed) does not count as drawn.
 */
export function Gated({
  id,
  device,
  children,
}: {
  id: GateId;
  device: GateSubject;
  /** omitted: a marker only — records an offered option (a pane in a list) */
  children?: ReactNode;
}) {
  const probe = useContext(GateProbe);
  if (!gate(id, device)) return null;
  probe?.add(id);
  return <>{children}</>;
}
