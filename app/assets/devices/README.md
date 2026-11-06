# Device art

Every product photo here is named by [`manifest.json`](manifest.json): one
entry per marketing model — its **art key**, which a descriptor names in
`DeviceDescriptor.artKey` (default: its `model`) — and one variant per colour
the official store sells. Several firmware ids often share one art key (the
X68 HE is three), and they share its photos; a colour pick is still kept per
model slug (`src/main/devices/colors.ts`).

The manifest drives everything else:

- **which colours a model offers** — `src/shared/device-art.ts`
  (`colorVariantsOf`): the store's colour name becomes the label (translated
  for a plain colour, `color.<name>`; shown as written for an edition such as
  "Ice Ninja") and `swatches` gives the picker swatch. The V8 and the R85HE
  keep their hand-written lists, whose ids users already have stored.
- **which file each one is** — `src/renderer/components/deviceArtAssets.ts`
  bundles this whole folder (an eager `import.meta.glob`, so the strict CSP
  is untouched) and maps art key + variant to the URL.

## Adding or replacing photos

```bash
cd app
python -E -P scripts/build-device-art.py --only <art-key>       # download, cut out, encode
python -E -P scripts/build-device-art.py --gallery <dir>        # contact sheet for review
python -E -P scripts/build-device-art.py --defringe <file>...   # older art with no `src`
```

Python 3 with Pillow (`-E -P`, not `-I`: `-I` hides the user-site Pillow).
The script cuts each store photo out of its white backdrop, trims it, fits a
mouse into 600×1000 and a keyboard into 1200×560, and encodes WebP at the best
quality that fits **50 KB** (stepping the size down 5 % at a time only when
quality 32 is still too big); it records `bytes` and `sha256`. How the edge is
matted is in the script's header: only a device's outer 2 px may blend with
the backdrop, and they get the device's own colour, never the white the photo
blended in, which a dark surface shows as a halo. On a dark or coloured
device, light regions that stay near its edge (a lit rim, a reflection or a
shadow on the floor, a gap row) are faded out the same way — never on a
white case, and on a light-coloured one only thin highlight lines, as a band
of it is the case itself (a white bezel below dark keycaps). Look at new
photos there, on the app's dark surface, zoomed in. A colourway whose edge
took pixels from an aligned sibling photo (a white shell's rim is white on
white) is marked `"outline": "sibling"`.

**Segmentation (optional).** With `pip install --user "rembg[cpu]"`, a
BiRefNet mask (MIT, ~220 MB model, downloaded on first use, ~10 s a photo on a
CPU) referees glows and shadows too wide for the colour rules. It is cached
beside the source photo in `scripts/_raw/art-cache/`, and ignored on any photo
where it disagrees with the colour silhouette: it loses white shells. Without
rembg and without a cached mask, the colour rules alone decide.

A bad cut-out takes, per variant in the manifest (pixels of the source photo,
after its `crop`):

- `holes`: `[x0, y0, x1, y1]` boxes around backdrop seen _through_ the device,
  such as a slot in a case, an open shell or a carry handle. Listed by hand:
  to a script, a white legend on a dark keycap looks the same.
- `floor`: `[x0, y0, x1, y1, tol]` boxes around a glow or shadow cast on the
  floor beside a _white_ device, where neither colour nor segmentation can
  tell it from the shell: the pixels up to `tol` levels off white that reach
  the backdrop are cleared.
- `hull`: `true` for a clear or white case that is the backdrop's very white
  in places: its convex hull is taken as its outline.
- `solid`: `[x0, y0, x1, y1]` boxes where nothing is faded: a light part of
  a dark device that colour takes for a lit rim (a metal side plate).
- `tolerance`: how far from white the outline's flood reaches, for a white
  shell the flood eats into.
- `crop`: the box to keep, applied before anything else, when something in
  the shot (a dock) touches the device.
- `locked`: `true` for a file edited by hand. It is never rebuilt, even with
  `--force`; if it was saved over 50 KB it is re-encoded in place.

Art with no `src` (made before the pipeline: the V8, the R85HE, the R6 and
the detail close-ups) has no source to re-cut; `--defringe` cleans its edge
in place. **Photos are signed off by the user (the gallery) before they ship.**

## Rules the tests hold

- every file the manifest names exists, and a pipeline-built one is ≤ 50 KB
  (`src/renderer/components/deviceArt.test.ts`);
- no stray file: the folder is bundled — and the browser edition precaches it
  — whole;
- every model that names an art key resolves a photo for every colour it
  offers, its default first;
- the whole folder stays within the browser edition's precache budget,
  8 MiB (`src/web/precacheBudget.test.ts`).

Detail close-ups (the V8's receiver and DPI LEDs, the R85HE's side light) are
named in `DEVICE_ART_DETAIL` in `deviceArtAssets.ts`. The R85HE's files
predate the manifest's naming (`r85-he`, not `r85he`); the manifest is what
maps them.
