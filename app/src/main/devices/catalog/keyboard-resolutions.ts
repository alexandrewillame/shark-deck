/**
 * Reviewed disagreements between our own Driver v4 extraction
 * (`scripts/_raw/kb-devices.json`) and sharkfin's registry, and how each is
 * resolved. The importer (`scripts/import-keyboard-registry.ts`) applies them;
 * `generated/crosscheck.test.ts` pins them, so any NEW disagreement fails the
 * test until it is reviewed and listed here.
 */
export const KEYBOARD_RESOLUTIONS: Record<number, { field: string; resolution: string }> = {
  2755: {
    field: 'layout',
    resolution: "sharkfin: its `~k2` copy is the same picture with this board's own slots",
  },
  2938: {
    field: 'profiles',
    resolution: 'the smaller count (3): selecting a slot the board lacks is the riskier error',
  },
  2964: {
    field: 'layout',
    resolution:
      'sharkfin: an owner-baked layout (sharkfin issue #99) under the corrected name X98 HE',
  },
};
