import type { ActuationLayout } from '@shared/types/keyboard-settings';
import type { KeyBinding } from '@shared/types/keys';
import type { WriteResult } from '@shared/types/live';
import { actionOfQuad, legacyModTapHold } from '@shared/key-zones';
import type { Driver } from '../devices/drivers/base';

/**
 * Write a saved layout to a keyboard: its Mod-tap and DKS bindings, then its
 * per-key settings.
 *
 * A layout is mostly magnetism pages (`setMagneticKeys`), but a Mod-tap key's
 * hold and tap and a DKS key's extra actions are not on any page. They are
 * key bindings in the zones of the key matrix (`setKeyZoneBindings`; see
 * shared/key-zones.ts — a Mod-tap key's hold in zone 0 and its tap in zone 1,
 * a DKS key's actions 2-4 in zones 1-3), and a layout that left them out put a
 * key back into Mod-tap with whatever hold the board happened to have.
 *
 * Bindings first, as the vendor and the Actuation tab both order it: the mode
 * that makes the board use them comes second. A binding the board refuses
 * stops the apply before any page is written, so a key is never switched into
 * a mode whose bindings did not land. Only keys the layout itself puts in
 * those modes are bound, and only keys this board has — a layout saved on
 * another model has positions this one may not.
 *
 * A Mod-tap entry saved before the zones were known to be the other way round
 * is `[null, hold]`: written as it stands, the key would TAP its hold and HOLD
 * itself. It is turned round on the way out, with the key's own binding — read
 * from the board, once — as the tap; a key whose binding cannot be read is
 * left unbound rather than bound backwards.
 */
export async function writeActuationLayout(
  driver: Driver,
  layout: ActuationLayout,
): Promise<WriteResult> {
  const board = driver.descriptor.spec.keyMatrix?.layout ?? [];
  const slotAt = (row: number, col: number): number | null => {
    const i = board.findIndex((e) => e.row === row && e.col === col);
    return i < 0 ? null : (board[i]!.slot ?? i);
  };
  const modeOf = new Map(
    layout.keys
      .filter((k) => k.mode === 'mt' || k.mode === 'dks')
      .map((k) => [`${k.row}:${k.col}`, k.mode]),
  );

  let base: Record<number, KeyBinding> | null | undefined;
  const ownBinding = async (slot: number): Promise<string | null> => {
    if (base === undefined) base = await driver.readKeyBindings('base').catch(() => null);
    const raw = base?.[slot]?.raw;
    return raw ? actionOfQuad(raw) : null;
  };

  const frames: string[] = [];
  for (const b of layout.zoneBindings ?? []) {
    const mode = modeOf.get(`${b.row}:${b.col}`);
    if (!mode || !b.zones.some((z) => z !== null)) continue;
    const slot = slotAt(b.row, b.col);
    if (slot === null) continue;
    let zones = b.zones;
    const legacyHold = mode === 'mt' ? legacyModTapHold(zones) : null;
    if (legacyHold) {
      const tap = await ownBinding(slot);
      if (!tap) continue;
      zones = [legacyHold, tap];
    }
    const r = await driver.setKeyZoneBindings(slot, zones);
    frames.push(...(r.frames ?? []));
    if (!r.ok) return { ...r, frames };
  }
  const r = await driver.setMagneticKeys(layout.keys);
  return frames.length ? { ...r, frames: [...frames, ...(r.frames ?? [])] } : r;
}
