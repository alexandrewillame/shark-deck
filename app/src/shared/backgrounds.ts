/**
 * The app backgrounds, by id — the one list the settings file is checked
 * against (main/settings.ts) and the picker is built from
 * (renderer/background/registry.ts). In the picker's order; `none` is the
 * plain theme. The default is Nebula (main/settings.ts).
 */
export const BACKGROUND_EFFECTS = [
  'none',
  'smoke',
  'fire',
  'electricity',
  'lava',
  'aurora',
  'nebula',
  'landscape',
  'water',
  'rain',
] as const;

export type BackgroundEffect = (typeof BACKGROUND_EFFECTS)[number];

export const isBackgroundEffect = (v: unknown): v is BackgroundEffect =>
  typeof v === 'string' && (BACKGROUND_EFFECTS as readonly string[]).includes(v);

/**
 * Backgrounds that were retired, and what a settings file naming one gets
 * instead. Artistic's marbling became Paint and Paint became Military; then
 * Military and Petrol gave way to Rain, so all four land there. Primal's cave
 * art left the set, and nothing else is like it, so its users go back to the
 * plain theme.
 */
const RETIRED: Record<string, BackgroundEffect> = {
  artistic: 'rain',
  paint: 'rain',
  military: 'rain',
  petrol: 'rain',
  primal: 'none',
};

/** A stored background, as one the app still draws: its successor if it was
 *  retired, `none` if it is not a background at all. */
export const toBackgroundEffect = (v: unknown): BackgroundEffect =>
  isBackgroundEffect(v) ? v : (typeof v === 'string' && RETIRED[v]) || 'none';

/** How strongly a background is drawn, 0-100, until someone says otherwise —
 *  enough to be the room's mood, not so much that it competes with the UI. */
export const BACKGROUND_INTENSITY_DEFAULT = 60;
