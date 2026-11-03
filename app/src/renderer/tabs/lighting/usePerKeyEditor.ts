import { useCallback, useEffect, useState } from 'react';
import type { LightingSettings, PerKeyColor } from '@shared/types/lighting';
import { useUndoHistory } from '../../state/useUndoHistory';

/** Painted keys by firmware slot. A slot that is absent is unlit. */
export type ColorMap = Record<number, [number, number, number]>;

const isBlack = (c: readonly number[]) => c[0] === 0 && c[1] === 0 && c[2] === 0;

/**
 * A board read as an editor value. Black keys are left out — black IS "off",
 * and the write zero-fills every slot it is not given — so a read of the board
 * just written compares equal to what was sent, rather than registering as a
 * phantom change because the read reports every slot.
 */
export function toColorMap(list: readonly PerKeyColor[]): ColorMap {
  const m: ColorMap = {};
  for (const k of list) if (!isBlack(k.color)) m[k.index] = k.color;
  return m;
}

/** One key painted. Painting black clears it, for the reason above. */
export function withKey(m: ColorMap, slot: number, rgb: [number, number, number]): ColorMap {
  const next = { ...m };
  if (isBlack(rgb)) delete next[slot];
  else next[slot] = rgb;
  return next;
}

export const asKeys = (m: ColorMap): PerKeyColor[] =>
  Object.entries(m).map(([i, c]) => ({ index: Number(i), color: c }));

/** Order-independent — two maps built in a different order are the same picture. */
export function sameColorMap(a: ColorMap, b: ColorMap): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[Number(k)]!;
    const y = b[Number(k)];
    if (!y || x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) return false;
  }
  return true;
}

/**
 * The per-key editor's state, held by the pane ABOVE both sub-views
 * (MainLightingPane) so painting survives a trip to Global and back — the
 * colours, their undo history, the brush and the brightness.
 *
 * `lighting` is what the board's main effect is believed to be, which carries
 * the per-key layer's brightness.
 */
export function usePerKeyEditor(lighting: LightingSettings | null) {
  const history = useUndoHistory<ColorMap>({}, { equals: sameColorMap });
  const [paint, setPaint] = useState('#3df8e8');
  /**
   * Brightness of the per-key layer, stated explicitly and sent with the
   * colours. `null` until the board's own value arrives, so an Apply never
   * writes a made-up default over a real one — and never "whatever a read
   * reports", since a read of 0 behind the colour burst would make an Apply
   * look like it switched the lighting off.
   */
  const [bright, setBright] = useState<number | null>(null);
  useEffect(() => {
    if (lighting) setBright((prev) => prev ?? lighting.brightness);
  }, [lighting]);
  const brightness = bright ?? lighting?.brightness ?? 100;
  /** What the board runs the layer at: the read, moved on by every Apply. */
  const appliedBrightness = lighting?.brightness ?? brightness;
  const dirty = history.dirty || brightness !== appliedBrightness;

  const { revert } = history;
  /** Cancel: the colours back to the board, undoably, and the brightness too
   *  (brightness is not a history step of its own). */
  const cancel = useCallback(() => {
    revert();
    setBright(appliedBrightness);
  }, [revert, appliedBrightness]);
  /** After an explicit Read: take the board's brightness again. */
  const resetBrightness = useCallback(() => setBright(lighting?.brightness ?? null), [lighting]);

  return {
    history,
    colors: history.present,
    paint,
    setPaint,
    brightness,
    setBrightness: setBright,
    dirty,
    cancel,
    resetBrightness,
  };
}

export type PerKeyEditor = ReturnType<typeof usePerKeyEditor>;
