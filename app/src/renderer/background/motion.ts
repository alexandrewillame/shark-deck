import { useSyncExternalStore } from 'react';

const REDUCED = '(prefers-reduced-motion: reduce)';

function subscribe(fn: () => void): () => void {
  const query = window.matchMedia(REDUCED);
  query.addEventListener('change', fn);
  return () => query.removeEventListener('change', fn);
}

const reducedNow = (): boolean => window.matchMedia(REDUCED).matches;

/**
 * Whether the background moves: the Animate switch, once it has been flipped,
 * and until then the system's own setting — still where it asks for reduced
 * motion (on Windows, Settings > Accessibility > Visual effects > Animation
 * effects off).
 *
 * The system used to stop the background outright, under a switch that still
 * read on: "all background animations are stopped, even if the animate button
 * is on". A choice made in the app wins over a system-wide default.
 */
export function useBackgroundAnimates(stored: boolean | undefined): boolean {
  const reduced = useSyncExternalStore(subscribe, reducedNow);
  return stored ?? !reduced;
}
