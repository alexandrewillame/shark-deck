import { useSyncExternalStore } from 'react';

/**
 * The background intensity while its slider is being dragged.
 *
 * The layer has to follow the slider as it moves, but a settings write per
 * tick would re-render every screen that reads settings (the device grid and
 * config both do) twenty times a second. So the slider pushes its value here
 * — the layer listens directly — and saves to settings once it settles, then
 * clears this so the stored value takes over again.
 */
let live: number | null = null;
const subs = new Set<() => void>();

export function setLiveIntensity(v: number | null): void {
  if (v === live) return;
  live = v;
  for (const fn of subs) fn();
}

export const getLiveIntensity = (): number | null => live;

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function useLiveIntensity(): number | null {
  return useSyncExternalStore(subscribe, getLiveIntensity);
}
