# Device art

A model can ship one plain image (`<model>.webp`, wired through
`DeviceDescriptor.art`) or several cosmetic colour/edition photos
(`<model>-<variant>.webp` per entry, wired through `DeviceDescriptor.
colorVariants` — see `DeviceColorVariant` in `src/shared/types.ts`), where
`<model>` is the `model` field from that device's descriptor in
[`../../src/main/devices/catalog/`](../../src/main/devices/catalog/) and
`<variant>` is a `DeviceColorVariant.id`.

Wiring a new file:

1. Drop the `.webp` here.
2. Add an `import` + map entry in
   [`../../src/renderer/components/deviceArtAssets.ts`](../../src/renderer/components/deviceArtAssets.ts)
   (imports are static — Vite bundles them, so a runtime file scan isn't an
   option under the renderer's strict CSP).
3. Add the matching `{ id, labelKey, swatch }` to that model's
   `colorVariants` array in its catalog file, and the `labelKey` string to
   `src/shared/i18n/en.ts` (+ `fr.ts`/`es.ts` if you have the translation).

The renderer resolves art in this order: a chosen colour variant, then the
legacy single-image `art` field, then a generated SVG silhouette (see
`src/renderer/components/DeviceArt.tsx`). Keep images roughly 800×800,
transparent background, < 100 KB. The filename doesn't have to exactly match
the model slug (see the R85HE entries below, which predate this note) — the
map in `deviceArtAssets.ts` is what actually resolves it, not a naming
convention alone.
