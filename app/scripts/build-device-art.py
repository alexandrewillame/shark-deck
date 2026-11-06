"""Build Shark Deck's device photos from the official store's colour photos.

    python -E -P scripts/build-device-art.py                 # fetch + build what is missing
    python -E -P scripts/build-device-art.py --force         # rebuild every output
    python -E -P scripts/build-device-art.py --only attack-shark-x11 attack-shark-r2
    python -E -P scripts/build-device-art.py --gallery DIR   # contact sheet for review
    python -E -P scripts/build-device-art.py --defringe FILE...  # older art, no source

Reads app/assets/devices/manifest.json. For each variant with a `src`, the
store photo is downloaded once into app/scripts/_raw/art-cache/ (git-ignored),
cut out from its white background, trimmed, scaled to the conventions the
existing art uses (mice portrait, keyboards landscape) and written as a
<= 50 KB transparent webp to app/assets/devices/<art key>-<variant>.webp. The
output's size and sha256 are written back into the manifest.

How the cut-out works (Pillow; rembg optional, step 3):

1. Outline. A variant's `crop` is applied first. The near-white pixels
   connected to the image border are then found by a flood fill on a ~480 px
   copy, so a white shell enclosed by its own darker outline is never
   hollowed out; the largest blob is kept, which drops a dongle or dock
   beside the product.
2. Silhouette, at full size, in a band around that outline: a pixel joined to
   the backdrop through backdrop-coloured pixels is out, one joined to the
   device is in, an isolated speck is neither. Measured on a 3x3 median,
   lightly blurred, against the noise found just outside the outline (a
   JPEG's border is flat white, its edges are not); the few px of flat
   backdrop that blur adds beside a dark edge are trimmed off again. A
   keyboard's outline is then squared up (`Mask.square_up`). Per variant, by
   hand, where colour
   cannot tell (source pixels after `crop`):
   - `holes` [x0, y0, x1, y1]: backdrop seen THROUGH the device (a slot in a
     case, an open shell); a white legend on a dark keycap looks the same;
   - `floor` [x0, y0, x1, y1, tol]: a glow or shadow cast on the floor beside
     a white device, up to tol levels off white (`Mask.on_floor`);
   - `hull`: the case is the backdrop's very white in places, so its convex
     hull is the silhouette;
   - `solid` [x0, y0, x1, y1]: nothing fades there (step 3) — a light part of
     a dark device that colour takes for a lit rim.
3. Alpha. Only the silhouette's outer EDGE px can be a blend of device and
   backdrop, plus, on a dark or coloured device, the light regions that reach
   the outside and stay within ZONE px of its edge (a lit rim, a floor
   reflection or shadow, a notch, a hairline past a near-white row:
   `Mask.fade`). A segmentation mask (rembg's BiRefNet, `ai_mask`, cached)
   referees what colour cannot: a light region it calls background (a glow
   too wide for ZONE) fades too, on photos where it agrees with the
   silhouette — it loses white shells, so it never decides on those. On a
   white case all of it stays, and on a light-coloured one all but its thin
   highlight lines (`Mask.light_cased`: a white bezel next to dark keycaps
   looks like a lit rim to both rules); nothing inside the device fades,
   only what still reaches the backdrop.
   Everything else is the device as photographed. A 1 px opening of the
   alpha then drops what hairlines remain. In the blend
   pixels, with the backdrop B known and F the device's
   colour just inside, a pixel is C = a*F + (1-a)*B, so
   a = ((B-C).(B-F)) / |B-F|^2. Where F is too close to white for that to be
   stable (a white shell), the alpha is geometry: the matte of the colourway
   with the most rim contrast when the two renders line up to the pixel
   (`Mask.adopt`; it also lends the silhouette parts this photo itself shows
   to be device, `Mask.borrow`, `floor` boxes still applying), else the
   silhouette itself, softened. Fades are decided on that silhouette; the
   matte then follows it trimmed (`Mask.trim`).
4. Colour. An edge pixel takes its un-mixed colour (B + (C-B)/a) where a is
   high and the device's own colour F where it is low: never the white it was
   blended with, which a dark surface shows as a white halo. Transparent
   pixels get F too, so the encoder's chroma subsampling cannot mix a foreign
   colour into the edge.

A variant marked `locked` was edited by hand: never rebuilt, even with
--force; only re-encoded in place when saved over the 50 KB budget.

Run with `python -E -P` (environment ignored, script dir not on sys.path —
`-I` would also hide the user site-packages Pillow lives in): the downloads
are untrusted data and live in a
different directory from this script.
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
import urllib.request
from collections import deque
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageMath

APP = Path(__file__).resolve().parent.parent
ASSETS = APP / "assets" / "devices"
MANIFEST = ASSETS / "manifest.json"
CACHE = APP / "scripts" / "_raw" / "art-cache"

BUDGET = 50 * 1024
BOX = {"mouse": (600, 1000), "keyboard": (1200, 560)}
MASK_MAX = 480  # px, long side of the copy the outline is found on
TOLERANCE = 10  # upper bound on the distance from white counted as background
# The store's backgrounds are exactly pure white on lossless sources, and a
# white shell's highlight can be 3-4 levels off it: a fixed tolerance of 10
# let the flood into white mice. The tolerance is the border's own noise + 3,
# capped at TOLERANCE, unless a variant overrides it in the manifest.
INNER = 6  # px the outline is eroded by: surely the device
OUTER = 4  # px it is dilated by: beyond this, surely the backdrop
EDGE = 2  # px of the silhouette's rim that may be a blend with the backdrop
ZONE = 20  # px from the edge where a dark device's light pixels are examined
CASE_NEAR = 60  # px around a region where the case beside it is looked at
LIGHT_CASE = 60  # a case this close to white (its darkest channel) beside a region is "light"
LIGHT_DEVICE = 100  # ... and all round the device: white shells measured <= 81, dark >= 128
TINTED = 20  # a case band whose channels spread this far is tinted, not white or grey
CASE_BAND = (3, 12)  # px from the edge: the case's outer band, where its colour is measured


def whiteness(img: Image.Image) -> Image.Image:
    """L image: 0 for pure white, 255 for black (255 - min(r, g, b))."""
    r, g, b = img.convert("RGB").split()
    return ImageChops.darker(ImageChops.darker(r, g), b).point(lambda v: 255 - v)


def flood(mask: list[bool], w: int, h: int, seeds: list[int]) -> list[bool]:
    """True for every `mask` pixel 4-connected to one of `seeds`."""
    seen = [False] * (w * h)
    q: deque[int] = deque()
    for i in seeds:
        if mask[i] and not seen[i]:
            seen[i] = True
            q.append(i)
    while q:
        i = q.popleft()
        x, y = i % w, i // w
        for j in (i - 1 if x else -1, i + 1 if x < w - 1 else -1, i - w if y else -1, i + w if y < h - 1 else -1):
            if j >= 0 and mask[j] and not seen[j]:
                seen[j] = True
                q.append(j)
    return seen


def border_flood(mask: list[bool], w: int, h: int) -> list[bool]:
    """True for every `mask` pixel connected to the image border."""
    edge = [y * w + x for x in range(w) for y in (0, h - 1)] + [y * w + x for y in range(h) for x in (0, w - 1)]
    return flood(mask, w, h, edge)


def largest_component(fg: list[bool], w: int, h: int) -> list[bool]:
    """Keep only the largest 4-connected foreground blob (drops a dongle or dock)."""
    label = [0] * (w * h)
    sizes = [0]
    for start in range(w * h):
        if not fg[start] or label[start]:
            continue
        n = len(sizes)
        sizes.append(0)
        q = deque([start])
        label[start] = n
        while q:
            i = q.popleft()
            sizes[n] += 1
            x, y = i % w, i // w
            for j in (i - 1 if x else -1, i + 1 if x < w - 1 else -1, i - w if y else -1, i + w if y < h - 1 else -1):
                if j >= 0 and fg[j] and not label[j]:
                    label[j] = n
                    q.append(j)
    if len(sizes) <= 1:
        return fg
    best = max(range(1, len(sizes)), key=lambda k: sizes[k])
    return [lab == best for lab in label]


# --- 0/255 masks, full size -------------------------------------------------


def binary(m: Image.Image, at: int = 128) -> Image.Image:
    return m.point(lambda v: 255 if v >= at else 0)


def erode(m: Image.Image, r: int) -> Image.Image:
    """Square erosion by r px: a box blur is 255 only where the whole box is."""
    return m.filter(ImageFilter.BoxBlur(r)).point(lambda v: 255 if v >= 255 else 0)


def dilate(m: Image.Image, r: int) -> Image.Image:
    return m.filter(ImageFilter.BoxBlur(r)).point(lambda v: 255 if v > 0 else 0)


def either(a: Image.Image, b: Image.Image) -> Image.Image:
    return ImageChops.lighter(a, b)


def without(a: Image.Image, b: Image.Image) -> Image.Image:
    return ImageChops.multiply(a, ImageChops.invert(b))


def count(m: Image.Image) -> int:
    return m.histogram()[255]


def reach(region: Image.Image, through: Image.Image, seed: Image.Image) -> Image.Image:
    """Pixels of `region` that are also `through` and 4-connected to `seed`
    by a path of such pixels."""
    w, h = region.size
    bbox = region.getbbox()
    if not bbox:
        return Image.new("L", region.size, 0)
    x0, y0, x1, y1 = max(0, bbox[0] - 1), max(0, bbox[1] - 1), min(w, bbox[2] + 1), min(h, bbox[3] + 1)
    bw, bh = x1 - x0, y1 - y0
    R = region.crop((x0, y0, x1, y1)).tobytes()
    T = through.crop((x0, y0, x1, y1)).tobytes()
    S = seed.crop((x0, y0, x1, y1)).tobytes()
    out = bytearray(bw * bh)
    q: deque[int] = deque()
    for i in range(bw * bh):
        if R[i] and T[i]:
            x, y = i % bw, i // bw
            if (x and S[i - 1]) or (x < bw - 1 and S[i + 1]) or (y and S[i - bw]) or (y < bh - 1 and S[i + bw]):
                out[i] = 255
                q.append(i)
    while q:
        i = q.popleft()
        x, y = i % bw, i // bw
        for j in (i - 1 if x else -1, i + 1 if x < bw - 1 else -1, i - bw if y else -1, i + bw if y < bh - 1 else -1):
            if j >= 0 and not out[j] and R[j] and T[j]:
                out[j] = 255
                q.append(j)
    res = Image.new("L", region.size, 0)
    res.paste(Image.frombytes("L", (bw, bh), bytes(out)), (x0, y0))
    return res


def backdrop(rgb: Image.Image) -> tuple[int, int, int]:
    """The backdrop's colour: the median of the border ring, per channel."""
    w, h = rgb.size
    px = rgb.load()
    ring = [px[x, y] for x in range(0, w, 3) for y in (0, 2, h - 3, h - 1)]
    ring += [px[x, y] for y in range(0, h, 3) for x in (0, 2, w - 3, w - 1)]
    return tuple(sorted(p[c] for p in ring)[len(ring) // 2] for c in range(3))


def percentile(img: Image.Image, where: Image.Image, q: float) -> int:
    """The q-quantile of `img` over the pixels `where` is set."""
    hist = Image.composite(img, Image.new("L", img.size, 0), where).histogram()
    hist[0] -= where.histogram()[0]  # the pixels outside `where` all landed on 0
    total, acc = sum(hist), 0
    for v, n in enumerate(hist):
        acc += n
        if acc >= q * total:
            return v
    return 0


def push(rgb: Image.Image, mask: Image.Image, radii=(2, 5, 12, 30, 80)) -> Image.Image:
    """`rgb` where `mask` is set, carried outward: every other pixel takes the
    colour of the nearest masked ones (premultiplied blurs, finest first)."""
    src = rgb.convert("RGB")
    src.putalpha(mask)
    pm = src.convert("RGBa")
    out = Image.new("RGBA", rgb.size, (0, 0, 0, 0))
    for r in reversed(radii):
        lvl = pm.filter(ImageFilter.GaussianBlur(r)).convert("RGBA")
        lvl.putalpha(lvl.getchannel("A").point(lambda v: min(255, v * 8)))
        out = Image.alpha_composite(out, lvl)
    return Image.alpha_composite(out, src).convert("RGB")


def lam(fn, **imgs) -> Image.Image:
    return ImageMath.lambda_eval(fn, **imgs)


def convex_hull(mask: Image.Image) -> Image.Image:
    """The filled convex hull of a 0/255 mask (monotone chain over each row's
    two ends). For a variant's `hull`: a clear or white case that is the
    backdrop's very colour in places, which no colour test can find, while
    the case is convex."""
    w, h = mask.size
    data = mask.tobytes()
    pts = []
    for y in range(h):
        row = data[y * w : (y + 1) * w]
        i, j = row.find(255), row.rfind(255)
        if i >= 0:
            pts += [(i, y), (j + 1, y), (i, y + 1), (j + 1, y + 1)]
    if len(pts) < 3:
        return mask
    pts = sorted(set(pts))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    out = Image.new("L", mask.size, 0)
    ImageDraw.Draw(out).polygon(lower[:-1] + upper[:-1], fill=255)
    return either(out, mask)


class Mask:
    """A source photo's foreground, outlined on a small copy (see the module doc)."""

    def __init__(
        self,
        src: Image.Image,
        tolerance: int | None,
        keep: str,
        holes: list[list[int]] | None = None,
        floor: list[list[int]] | None = None,
        solid: list[list[int]] | None = None,
    ):
        self.rgb = src.convert("RGB")
        self.d = whiteness(self.rgb)
        self.size = self.rgb.size
        self.own_alpha = None
        if src.mode in ("RGBA", "LA", "P"):
            a = src.convert("RGBA").getchannel("A")
            w, h = a.size
            border = [a.getpixel((x, 0)) for x in range(0, w, 8)] + [a.getpixel((0, y)) for y in range(0, h, 8)]
            if sum(1 for v in border if v < 16) > 0.9 * len(border):
                self.own_alpha = a  # already transparent: its alpha is the outline
        w, h = self.size
        self.scale = MASK_MAX / max(w, h)
        self.sw, self.sh = max(1, round(w * self.scale)), max(1, round(h * self.scale))
        small = self.d.resize((self.sw, self.sh), Image.Resampling.BILINEAR)
        self.small_d = list(small.get_flattened_data() if hasattr(small, "get_flattened_data") else small.getdata())
        if tolerance is None:
            border = [self.d.getpixel((x, y)) for x in range(0, w, 7) for y in (0, h - 1)]
            border += [self.d.getpixel((x, y)) for y in range(0, h, 7) for x in (0, w - 1)]
            # 90th percentile, not the maximum: a crop's edge can run through a
            # dock or its shadow, and one dark run of border made the flood
            # tolerant enough to eat a white shell.
            tolerance = min(TOLERANCE, sorted(border)[int(len(border) * 0.9)] + 3)
        self.tolerance = tolerance
        self.near = [v <= tolerance for v in self.small_d]
        fg = [not b for b in border_flood(self.near, self.sw, self.sh)]
        self.fg = largest_component(fg, self.sw, self.sh) if keep == "largest" else fg
        self.holes = [tuple(b) for b in holes or ()]
        self.floor = [tuple(b) for b in floor or ()]
        self.solid = [tuple(b) for b in solid or ()]  # boxes where nothing fades
        self.ai: Image.Image | None = None  # segmentation mask, see `ai_mask`
        self.ai_used = False
        self.kind = "mouse"  # set by main: a keyboard's outline is squared up
        self.hull = False  # a variant's `hull`: its case is backdrop white, fill its convex hull
        self.sibling: Mask | None = None
        self.borrowed = 0  # silhouette px taken from the sibling (see `borrow`)
        self._sil: tuple | None = None
        self._cut: Image.Image | None = None

    def area(self) -> int:
        return sum(self.fg)

    def rim_contrast(self) -> float:
        """How far from white the outline's own rim is, on the small copy: the
        colourway with the most is the one whose edge the others can trust."""
        own = Image.new("L", (self.sw, self.sh))
        own.putdata([255 if f else 0 for f in self.fg])
        rim = ImageChops.subtract(own, own.filter(ImageFilter.MinFilter(5)))
        vals = [d for d, r in zip(self.small_d, rim.tobytes()) if r]
        return sum(vals) / len(vals) if vals else 0.0

    def adopt(self, ref: "Mask") -> bool:
        """Lean on a sibling colourway (the one with the most contrast at its
        rim) when the two renders line up to the pixel.

        A white shell on a white background can be eaten by the flood where its
        highlight is pure white, and its rim, white on white, cannot be matted
        at all; the dark colourway of the same render has both unambiguous.
        Only if this photo's clearly-coloured pixels sit inside the
        reference's outline (same canvas, same framing) and, at full size, its
        own silhouette nowhere strays more than a pixel outside the
        reference's. What `cut` then takes from it is limited to what this
        photo itself shows to be device (see `borrow`)."""
        if ref is self or ref.size != self.size or (ref.sw, ref.sh) != (self.sw, self.sh):
            return False
        if self.own_alpha is not None or ref.own_alpha is not None:
            return False
        grown = Image.new("L", (ref.sw, ref.sh))
        grown.putdata([255 if f else 0 for f in ref.fg])
        grown = grown.filter(ImageFilter.MaxFilter(5)).tobytes()
        # This photo's clearly-coloured pixels on and around its own device —
        # not a dongle or dock beside it, which the reference's outline (its
        # largest blob) never includes.
        own = Image.new("L", (self.sw, self.sh))
        own.putdata([255 if f else 0 for f in self.fg])
        around = own.filter(ImageFilter.MaxFilter(21)).tobytes()
        strong = [i for i, v in enumerate(self.small_d) if v > 40 and around[i]]
        if not strong:
            return False
        inside = sum(1 for i in strong if grown[i])
        if inside / len(strong) < 0.98:
            return False
        _, own, _ = self.silhouette()
        _, theirs, _ = ref.silhouette()
        stray = count(without(own, dilate(theirs, 1)))
        rim = count(without(theirs, erode(theirs, 1)))
        # Another render strays by thousands of pixels; the same render, by a
        # few dozen (a glow one photo has and the other lacks).
        if not rim or stray > 0.02 * rim:
            return False
        self.sibling = ref
        return True

    def borrow(self, own: Image.Image, info: dict) -> Image.Image:
        """The parts of the sibling's silhouette this photo lacks AND shows to
        be device: a missing region that holds pixels no backdrop has (a white
        R2's side, its dark interior showing through the struts), or a rim
        whose own border here is a light part of the device (white on white).
        A ring next to a dark edge is backdrop the sibling's softer edge
        reached past: taking it would paint white around the device."""
        theirs = self.sibling.silhouette()[1]
        missing = without(theirs, own)
        w, h = self.size
        bbox = missing.getbbox()
        if not bbox:
            return missing
        M = bytearray(missing.tobytes())
        O = own.tobytes()
        B = info["backdropish"].tobytes()
        Wt = info["white"].tobytes()
        keep = bytearray(w * h)
        for start in range(bbox[1] * w + bbox[0], (bbox[3] - 1) * w + bbox[2]):
            if M[start] != 255:
                continue
            comp, q = [], deque([start])
            M[start] = 1
            device = light = edge = 0
            while q:
                i = q.popleft()
                comp.append(i)
                if not B[i]:
                    device += 1
                x, y = i % w, i // w
                for j in (i - 1 if x else -1, i + 1 if x < w - 1 else -1, i - w if y else -1, i + w if y < h - 1 else -1):
                    if j < 0:
                        continue
                    if M[j] == 255:
                        M[j] = 1
                        q.append(j)
                    elif O[j]:
                        edge += 1
                        if Wt[j] <= 50:
                            light += 1
            if device >= max(20, 0.005 * len(comp)) or (edge and light >= 0.6 * edge):
                for i in comp:
                    keep[i] = 255
        return Image.frombytes("L", self.size, bytes(keep))

    def silhouette(self) -> tuple[Image.Image, Image.Image, dict]:
        """The photo on its backdrop, the device's silhouette to the pixel, and
        what was measured on the way (step 2 of the module doc)."""
        if self._sil:
            return self._sil
        w, h = self.size
        if self.own_alpha is not None:
            # A transparent source is put back on white and matted like the
            # rest, so an edge the vendor cut against white is cleaned too.
            rgba = Image.merge("RGBA", (*self.rgb.split(), self.own_alpha))
            rgb = Image.alpha_composite(Image.new("RGBA", self.size, (255, 255, 255, 255)), rgba).convert("RGB")
            outline = binary(self.own_alpha)
        else:
            rgb = self.rgb
            small = Image.new("L", (self.sw, self.sh))
            small.putdata([255 if f else 0 for f in self.fg])
            outline = binary(small.resize((w, h), Image.Resampling.BILINEAR))
        bg = backdrop(rgb)
        sure_fg = erode(outline, INNER)
        sure_bg = ImageChops.invert(dilate(outline, OUTER))
        band = ImageChops.invert(either(sure_fg, sure_bg))
        meas = rgb.filter(ImageFilter.MedianFilter(3))
        dr, dg, db = ImageChops.difference(meas, Image.new("RGB", self.size, bg)).split()
        dist = either(either(dr, dg), db)
        # Backdrop or not is decided on a lightly blurred copy: a white case a
        # few levels off white, under JPEG noise as large, flickered between
        # the two pixel by pixel, and the trace ate a mottled band into it.
        # A dark edge moves by a pixel at most, into the matted rim.
        smooth = dist.filter(ImageFilter.GaussianBlur(2))
        # The ring just outside the outline is mostly backdrop, but where a
        # crystal case is barely off white the outline runs inside it and the
        # ring crosses the case: a high percentile measured the case, not the
        # noise, and the case then counted as backdrop.
        noise = max(percentile(smooth, without(dilate(outline, OUTER), dilate(outline, 2)), 0.6), 2)
        backdropish = smooth.point(lambda v: 255 if v <= noise + 2 else 0)
        out = reach(band, backdropish, sure_bg)
        joined = reach(band, without(band, out), sure_fg)
        sil = without(either(sure_fg, joined), self.see_through(backdropish))
        sil = without(sil, self.on_floor(sil, dist))
        mr, mg, mb = meas.split()
        white = ImageChops.darker(ImageChops.darker(mr, mg), mb).point(lambda v: 255 - v)
        self._sil = (rgb, sil, {"bg": bg, "noise": noise, "meas": meas, "backdropish": backdropish, "white": white, "dist": dist})
        return self._sil

    @staticmethod
    def trim(sil: Image.Image, dist: Image.Image, noise: int) -> Image.Image:
        """The blur `silhouette` measures on spreads a dark edge a few px out
        into the backdrop (as can a sibling's outline, borrowed), which the
        rim then shows as a white line along it (`cut`): beside clearly dark pixels,
        flat backdrop joined to the outside is trimmed off again, never
        deeper than such a spread (along a dark seam a white shell is flat
        white beside dark pixels too). A white case has no dark pixels
        beside its edge and keeps the blur's steadiness."""
        flat = dist.point(lambda v, t=noise + 2: 255 if v <= t else 0)
        near_dark = dilate(dist.point(lambda v: 255 if v >= 60 else 0), 5)
        overshoot = ImageChops.multiply(ImageChops.multiply(without(sil, erode(sil, 6)), flat), near_dark)
        return without(sil, reach(overshoot, overshoot, ImageChops.invert(sil)))

    def on_floor(self, sil: Image.Image, dist: Image.Image) -> Image.Image:
        """Light cast on the floor beside a white device (a glow, a shadow),
        which neither colour nor the segmentation model can tell from its
        shell: in each `floor` box [x0, y0, x1, y1, tol], the pixels at most
        tol levels off white that reach the backdrop (or the photo's edge)
        through each other. The shell's own shaded edge is further off white
        and blocks the way in."""
        out = Image.new("L", self.size, 0)
        w, h = self.size
        frame = Image.new("L", self.size, 255)
        frame.paste(0, (1, 1, w - 1, h - 1))
        outside = either(ImageChops.invert(sil), frame)
        for x0, y0, x1, y1, tol in self.floor:
            box = Image.new("L", self.size, 0)
            box.paste(255, (x0, y0, x1, y1))
            near = ImageChops.multiply(box, dist.point(lambda v, t=tol: 255 if v <= t else 0))
            out = either(out, reach(ImageChops.multiply(near, sil), near, outside))
        return out

    def see_through(self, backdropish: Image.Image) -> Image.Image:
        """The backdrop seen through the device: in each `holes` box, the
        largest run of joined backdrop-coloured pixels. The box only has to
        hold the opening; a white part beside it inside the box is a separate,
        smaller run and stays."""
        out = Image.new("L", self.size, 0)
        for box in self.holes:
            tile = backdropish.crop(box)
            w, h = tile.size
            px = tile.tobytes()
            label, best, best_n = bytearray(w * h), [], 0
            for start in range(w * h):
                if not px[start] or label[start]:
                    continue
                comp, q = [], deque([start])
                label[start] = 1
                while q:
                    i = q.popleft()
                    comp.append(i)
                    x, y = i % w, i // w
                    for j in (i - 1 if x else -1, i + 1 if x < w - 1 else -1, i - w if y else -1, i + w if y < h - 1 else -1):
                        if j >= 0 and px[j] and not label[j]:
                            label[j] = 1
                            q.append(j)
                if len(comp) > best_n:
                    best, best_n = comp, len(comp)
            if not best:
                print(f"  warning: no backdrop-coloured pixels in hole box {list(box)}", file=sys.stderr)
                continue
            hole = bytearray(w * h)
            for i in best:
                hole[i] = 255
            out.paste(Image.frombytes("L", (w, h), bytes(hole)), box[:2], Image.frombytes("L", (w, h), bytes(hole)))
        return out

    def cut(self) -> Image.Image:
        if self._cut is not None:
            return self._cut
        rgb, sil, info = self.silhouette()
        self.borrowed = 0
        if self.sibling is not None:
            extra = self.borrow(sil, info)
            self.borrowed = count(extra)
            # a sibling's outline can hold the glow this photo's `floor` cleared
            sil = without(either(sil, extra), self.on_floor(either(sil, extra), info["dist"]))
        if self.kind == "keyboard":
            sil = self.square_up(sil, info)
        if self.hull:
            sil = without(convex_hull(sil), self.see_through(info["backdropish"]))
        bg, noise, meas = info["bg"], info["noise"], info["meas"]
        faded = self.fade(sil, rgb, info)
        # The matte follows the trimmed outline; siblings are compared and lent,
        # and fades decided, on the untrimmed one (a black photo trimmed all
        # round no longer frames a white one; a red shell's side panel, once
        # its outline was trimmed, faded with its rim).
        sil = self.trim(sil, info["dist"], info["noise"])
        faded = ImageChops.multiply(faded, sil)
        opaque = without(erode(sil, EDGE), faded)
        rim = without(sil, opaque)
        F = push(rgb, opaque)

        Br, Bg, Bb = (float(c) for c in bg)
        cr, cg, cb = (c.convert("F") for c in meas.split())
        fr, fg, fb = (c.convert("F") for c in F.split())
        den = lam(lambda e: (Br - e["r"]) * (Br - e["r"]) + (Bg - e["g"]) * (Bg - e["g"]) + (Bb - e["b"]) * (Bb - e["b"]), r=fr, g=fg, b=fb)
        dot = lam(
            lambda e: (Br - e["cr"]) * (Br - e["fr"]) + (Bg - e["cg"]) * (Bg - e["fg"]) + (Bb - e["cb"]) * (Bb - e["fb"]),
            cr=cr, cg=cg, cb=cb, fr=fr, fg=fg, fb=fb,
        )
        mag = lam(lambda e: e["d"] ** 0.5, d=den)
        floor = noise * 1.7  # the backdrop's noise, as a share of |B-F|
        a_col = lam(
            lambda e: e["min"](
                e["max"](
                    (e["dot"] / e["max"](e["den"], 1.0) - floor / e["max"](e["mag"], 1.0))
                    / e["max"](1.0 - floor / e["max"](e["mag"], 1.0), 0.05),
                    0.0,
                ),
                1.0,
            ),
            dot=dot, den=den, mag=mag,
        )
        # trust in a_col: none when F is within ~14 levels of white, full by ~54.
        # Where it is low, the edge alpha is geometry: the aligned sibling's
        # own matte if there is one (the same edge, matted against contrast),
        # else this silhouette, softened.
        trust = lam(lambda e: e["min"](e["max"]((e["mag"] - 14.0) / 40.0, 0.0), 1.0), mag=mag)
        shape = self.sibling.cut().getchannel("A") if self.sibling is not None else sil.filter(ImageFilter.GaussianBlur(0.8))
        geo = lam(lambda e: e["float"](e["s"]) / 255.0, s=shape)
        a = lam(lambda e: e["t"] * e["ac"] + (1.0 - e["t"]) * e["ag"], t=trust, ac=a_col, ag=geo)
        # A faded region is not a blend at the device's edge but a band, a
        # rim or a shadow that read as a weak one (a light grey reflection is
        # "28 % of a black case"): under 35 % it goes, what is left is eased in.
        a = Image.composite(lam(lambda e: e["min"](e["max"]((e["a"] - 0.35) / 0.65, 0.0), 1.0), a=a), a, faded)

        def unmix(c, f, B):
            return lam(
                lambda e: (
                    e["min"](e["max"](B - (B - e["c"]) / e["max"](e["a"], 0.05), 0.0), 255.0)
                    * e["min"](e["max"]((e["a"] - 0.5) / 0.45, 0.0), 1.0)
                    + e["f"] * (1.0 - e["min"](e["max"]((e["a"] - 0.5) / 0.45, 0.0), 1.0))
                ),
                c=c, f=f, a=a,
            ).convert("L")

        rim_rgb = Image.merge("RGB", [unmix(c, f, B) for c, f, B in ((cr, fr, Br), (cg, fg, Bg), (cb, fb, Bb))])
        rim_a = lam(lambda e: e["convert"](e["a"] * 255.0 + 0.5, "L"), a=a)
        zero = Image.new("L", self.size, 0)
        alpha = Image.composite(Image.new("L", self.size, 255), Image.composite(rim_a, zero, rim), opaque)
        # A hairline left past a gap (a reflection's edge, a grey line beyond a
        # near-white row) is thinner than any part of a device: a 1 px opening
        # of the alpha takes it away and leaves real edges where they were.
        alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
        # (No cap by the aligned sibling's alpha: it carried a dark sibling's
        # faded lit rims onto a white colourway's case. A glow beside a white
        # shell is a `floor` hint.)
        out = Image.composite(rgb, Image.composite(rim_rgb, F, rim), opaque)
        out.putalpha(alpha)
        self._cut = out
        return out

    def fade(self, sil: Image.Image, rgb: Image.Image, info: dict) -> Image.Image:
        """A dark or coloured device's light pixels near its edge, joined to
        the outside through other light pixels: a lit rim, a white notch, a
        reflection or shadow on the floor, the near-white row between the case
        and a hairline. They are not kept at full strength: `cut` gives them
        the alpha their blend with white implies, in the device's colour. Only
        within ZONE px of the edge, only where the device further in is
        clearly not white (a white shell is nothing but light pixels), and
        "light" is relative to that device: under 60 % of its distance from
        white. A light part enclosed by darker device (a legend, a logo) is
        not joined to the outside and stays.

        With a segmentation mask (`ai_mask`) the model referees what colour
        cannot: a light region it calls background (a glow or shadow on the
        floor too wide for ZONE) fades at any depth. Its only power is to
        fade: a light strip it calls device (a case's lit side wall) still
        goes, as on any dark device. And it is ignored outright on a photo
        where it disagrees with the silhouette, covering less than 90 % of it:
        that is the model losing a white shell, not the device having a
        shadow.

        Last, whatever either rule found that is the case itself stays
        (`light_cased`)."""
        ai = self.ai
        if ai is not None and count(ImageChops.multiply(sil, binary(ai))) < 0.9 * count(sil):
            ai = None
        self.ai_used = ai is not None
        core = ImageChops.multiply(sil, binary(ai)) if ai is not None else sil
        deep = erode(core, ZONE)
        r, g, b = push(rgb, deep).split()
        wd = ImageChops.darker(ImageChops.darker(r, g), b).point(lambda v: 255 - v)
        light = lam(
            lambda e: e["convert"]((e["float"](e["w"]) < e["float"](e["wd"]) * 0.6) * (e["wd"] >= 35) * 255, "L"),
            w=info["white"], wd=wd,
        )
        light = ImageChops.multiply(light, sil)
        outside = ImageChops.invert(sil)
        # Light pixels joined to the outside, as whole regions; a region that
        # runs deeper than ZONE is the device's own light surface (a white
        # bezel going on into white keycaps, next to LED colours that made the
        # "device colour" look dark) and stays. What stays near the edge is a
        # rim, a band, a shadow or a gap, and fades.
        reached = reach(light, light, outside)
        # depth from the outer outline: a slot in a bezel is not an edge the
        # bezel is thin against
        deep_part = ImageChops.multiply(reached, erode(either(sil, self.see_through(info["backdropish"])), ZONE))
        deep = either(deep_part, reach(reached, reached, deep_part))
        cand = without(reached, deep)
        away = None
        if ai is not None:
            away = without(light, binary(ai))
            away = reach(away, away, outside)
        both = either(cand, away) if away is not None else cand
        # What is left fades only where it still reaches the backdrop: a
        # ragged sliver between a kept band and a dark part is inside the
        # device, and fading it would punch a hole there.
        left = without(both, self.light_cased(both, sil, info))
        for box in self.solid:
            # a variant's `solid` box: a light part of a dark device that
            # colour takes for a lit rim (a metal side plate's ends)
            left.paste(0, box)
        return reach(left, left, outside)

    @staticmethod
    def light_cased(both: Image.Image, sil: Image.Image, info: dict, report: list | None = None) -> Image.Image:
        """What `fade` found (both rules) that is the case itself. "Light"
        above is relative to the device colour 20 px in, which on a keyboard
        is often its keycaps: a white case's side wall or front band beside
        LED-lit or coloured keycaps looks like a lit rim, and the model,
        white on white again, calls such a band background (only locally, so
        its 90 % gate does not catch it). A rim, a reflection or a shadow
        worth fading lies beside a dark or coloured case.

        The case is measured on its outer band (CASE_BAND px in). On a white
        or grey device (the band light and untinted all round; keycaps
        crowding a thin bezel darken it locally) everything stays: what is
        light on it is it (the outline's overshoot past a dark part, which
        the rim would show as a white line, is `trim`med). Elsewhere each
        region is judged, the thin ones left out (the outline's own rim would
        join them all into one), so they fade: on a tinted light device
        (lavender, cream, sand, mint) a region from ~7 px thick stays, as
        its white highlight along the edge is a thin line, bright on a dark
        surface; on a dark device one stays only when the case beside it,
        within CASE_NEAR px, is light itself (a white part of a two-tone
        case). Not when merely about as dark as a dark case: a black or red
        mouse's lit rim is."""

        def median(hist: list[int]) -> int:
            n, acc, level = sum(hist), 0, 0
            if not n:
                return 255  # nothing measured: not light
            while acc + hist[level] <= n // 2:
                acc += hist[level]
                level += 1
            return level

        w, h = both.size
        ring = without(without(erode(sil, CASE_BAND[0]), erode(sil, CASE_BAND[1])), both)
        white = info["white"]
        whole = median(white.histogram(ring))
        r, g, b = info["meas"].split()
        tint = ImageChops.subtract(ImageChops.lighter(ImageChops.lighter(r, g), b), ImageChops.darker(ImageChops.darker(r, g), b))
        tinted = median(tint.histogram(ring)) >= TINTED
        white_device = whole < LIGHT_DEVICE and not tinted
        if white_device and report is None:
            return both
        # A tinted light device keeps a region only from ~7 px thick: its
        # highlight is a white line along the edge, its case's own white
        # parts (a camo pattern's shards) are larger.
        k = 3 if whole < LIGHT_DEVICE and tinted else 2
        core = erode(both, k)
        out = bytearray(w * h)
        bbox = core.getbbox()
        if bbox:
            Wt = white.tobytes()
            C = bytearray(core.tobytes())
            for start in range(bbox[1] * w + bbox[0], (bbox[3] - 1) * w + bbox[2]):
                if C[start] != 255:
                    continue
                comp, q = [], deque([start])
                C[start] = 1
                while q:
                    i = q.popleft()
                    comp.append(i)
                    x, y = i % w, i // w
                    for j in (i - 1 if x else -1, i + 1 if x < w - 1 else -1, i - w if y else -1, i + w if y < h - 1 else -1):
                        if j >= 0 and C[j] == 255:
                            C[j] = 1
                            q.append(j)
                xs, ys = [i % w for i in comp], [i // w for i in comp]
                box = (max(0, min(xs) - CASE_NEAR), max(0, min(ys) - CASE_NEAR), min(w, max(xs) + 1 + CASE_NEAR), min(h, max(ys) + 1 + CASE_NEAR))
                hist = white.crop(box).histogram(ring.crop(box))
                if sum(hist) < 50:
                    continue  # no case beside it to judge by: it fades
                case = median(hist)
                own = [0] * 256
                for i in comp:
                    own[Wt[i]] += 1
                level = median(own)
                if whole < LIGHT_DEVICE:
                    keep = True
                else:
                    keep = case < LIGHT_CASE and (not tinted or level >= 0.6 * case)
                if report is not None:
                    report.append({"bbox": box, "area": len(comp), "case": case, "whole": whole, "level": level, "tinted": tinted, "kept": keep})
                if keep:
                    for i in comp:
                        out[i] = 255
        # with its own outer 2 px, which `core` left out
        return ImageChops.multiply(dilate(Image.frombytes("L", both.size, bytes(out)), k), both)

    def square_up(self, sil: Image.Image, info: dict) -> Image.Image:
        """A keyboard's case is orthogonally convex (every row and column of
        it is one run), so a notch in its outline is noise. Where a crystal or
        white case meets the white backdrop it is only a few levels off it,
        and JPEG noise bites notches into its edge; refill them with the
        case's own faintly off-white pixels — not pure backdrop, so the gaps
        between a case's feet stay open — within 12 px of the outline, then
        clear the `holes` again."""
        w, h = self.size

        def runs(mask: Image.Image) -> Image.Image:
            data = bytearray(mask.tobytes())
            W, H = mask.size
            for y in range(H):
                row = data[y * W : (y + 1) * W]
                i, j = row.find(255), row.rfind(255)
                if i >= 0:
                    data[y * W + i : y * W + j + 1] = b"\xff" * (j - i + 1)
            return Image.frombytes("L", mask.size, bytes(data))

        rows = runs(sil)
        cols = runs(sil.transpose(Image.Transpose.TRANSPOSE)).transpose(Image.Transpose.TRANSPOSE)
        faint = info["dist"].point(lambda v: 255 if v >= 4 else 0)
        add = ImageChops.multiply(ImageChops.multiply(rows, cols), faint)
        add = ImageChops.multiply(without(add, sil), dilate(sil, 12))
        sil = either(sil, add)
        # Where the case itself is white, a 15 px majority vote then
        # straightens what noise left ragged; a dark case's edge is exact and
        # left as it is.
        r, g, b = push(self.silhouette()[0], erode(sil, ZONE)).split()
        white_case = ImageChops.darker(ImageChops.darker(r, g), b).point(lambda v: 255 if 255 - v < 35 else 0)
        at_edge = without(dilate(sil, 8), erode(sil, 8))
        vote = sil.filter(ImageFilter.BoxBlur(7)).point(lambda v: 255 if v >= 128 else 0)
        sil = Image.composite(vote, sil, ImageChops.multiply(white_case, at_edge))
        return without(sil, self.see_through(info["backdropish"]))


def fit(img: Image.Image, kind: str, crop: list[int] | None) -> Image.Image:
    if crop:
        img = img.crop(tuple(crop))
    bbox = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if bbox:
        img = img.crop(bbox)
    bw, bh = BOX[kind]
    s = min(bw / img.width, bh / img.height, 1.0)
    if s < 1.0:
        img = img.convert("RGBa").resize(
            (max(1, round(img.width * s)), max(1, round(img.height * s))), Image.Resampling.LANCZOS
        ).convert("RGBA")
    return img


def bleed(img: Image.Image) -> Image.Image:
    """Alpha below 8 (invisible on any surface) dropped and above 247 made
    solid — noise the encoder would spend bytes on — and every transparent
    pixel given the colour of the nearest visible ones (step 4)."""
    a = img.getchannel("A").point(lambda v: 0 if v < 8 else 255 if v > 247 else v)
    filled = push(img.convert("RGB"), a.point(lambda v: 255 if v >= 128 else 0))
    out = Image.composite(img.convert("RGB"), filled, a.point(lambda v: 255 if v else 0))
    out.putalpha(a)
    return out


def defringe(img: Image.Image) -> Image.Image:
    """Steps 3 and 4 on a cut-out made before this pipeline (no source photo
    to re-cut), against the white it was cut from. Its edge pixels — the part-
    transparent ones and the outermost ring, where an older cut left white
    blends fully opaque — get the alpha their colour implies next to the
    device's own (never more than they had; a white shell keeps its own),
    then the un-mixed colour."""
    rgba = img.convert("RGBA")
    rgb = rgba.convert("RGB")
    a = rgba.getchannel("A")
    shown = a.point(lambda v: 255 if v else 0)
    ring = without(shown, erode(shown, 1))
    edge = either(ring, a.point(lambda v: 255 if 0 < v < 250 else 0))
    F = push(rgb, without(a.point(lambda v: 255 if v >= 250 else 0), ring))
    cr, cg, cb = (c.convert("F") for c in rgb.split())
    fr, fg, fb = (c.convert("F") for c in F.split())
    den = lam(lambda e: (255.0 - e["r"]) * (255.0 - e["r"]) + (255.0 - e["g"]) * (255.0 - e["g"]) + (255.0 - e["b"]) * (255.0 - e["b"]), r=fr, g=fg, b=fb)
    dot = lam(
        lambda e: (255.0 - e["cr"]) * (255.0 - e["fr"]) + (255.0 - e["cg"]) * (255.0 - e["fg"]) + (255.0 - e["cb"]) * (255.0 - e["fb"]),
        cr=cr, cg=cg, cb=cb, fr=fr, fg=fg, fb=fb,
    )
    trust = lam(lambda e: e["min"](e["max"]((e["d"] ** 0.5 - 14.0) / 40.0, 0.0), 1.0), d=den)
    old = lam(lambda e: e["float"](e["a"]) / 255.0, a=a)
    af = lam(
        lambda e: e["min"](e["o"], e["t"] * e["min"](e["max"](e["dot"] / e["max"](e["den"], 1.0), 0.0), 1.0) + (1.0 - e["t"]) * e["o"]),
        o=old, t=trust, dot=dot, den=den,
    )
    chans = []
    for c, f in ((cr, fr), (cg, fg), (cb, fb)):
        chans.append(
            lam(
                lambda e: (
                    e["min"](e["max"](255.0 - (255.0 - e["c"]) / e["max"](e["a"], 0.05), 0.0), 255.0)
                    * e["min"](e["max"]((e["a"] - 0.5) / 0.45, 0.0), 1.0)
                    + e["f"] * (1.0 - e["min"](e["max"]((e["a"] - 0.5) / 0.45, 0.0), 1.0))
                ),
                c=c, f=f, a=af,
            ).convert("L")
        )
    new_a = lam(lambda e: e["convert"](e["a"] * 255.0 + 0.5, "L"), a=af)
    out = Image.composite(Image.merge("RGB", chans), rgb, edge)
    out.putalpha(Image.composite(new_a, a, edge))
    return out


def webp(img: Image.Image, q: int) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=q, alpha_quality=90, method=6)
    return buf.getvalue()


def encode(img: Image.Image) -> bytes:
    """The best WebP within BUDGET: the highest quality from 92 down to 32 at
    full size, and only if even that is too big, 5 % smaller steps, each at
    the best of qualities 60 to 36. (A photo a few KB over used to drop
    straight to quality 60 and lose a quarter of its width.)"""
    data = b""
    for q in range(92, 30, -4):
        data = webp(img, q)
        if len(data) <= BUDGET:
            return data
    w, h = img.size
    scale = 1.0
    while w * scale > 200:
        scale *= 0.95
        size = (max(1, round(w * scale)), max(1, round(h * scale)))
        small = bleed(img.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA"))
        for q in (60, 52, 44, 36):
            data = webp(small, q)
            if len(data) <= BUDGET:
                return data
    return data


def fetch(url: str, dest: Path) -> bytes:
    if dest.exists():
        return dest.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": "SharkDeck-art-pipeline"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(body)
    return body


def defringe_files(names: list[str]) -> int:
    """`--defringe FILE...`: clean the edges of art in assets/devices that has
    no `src` to re-cut (see `defringe`). Rewritten in place, same format, same
    size in pixels; a WebP at the best quality that stays within 5 % of the
    file's old size (the browser edition precaches the whole folder)."""
    for name in names:
        path = ASSETS / name
        before = path.stat().st_size
        img = defringe(Image.open(path))
        buf = io.BytesIO()
        if path.suffix == ".png":
            img.save(buf, "PNG", optimize=True)
        else:
            for q in range(92, 70, -4):
                buf = io.BytesIO()
                img.save(buf, "WEBP", quality=q, alpha_quality=100, method=6)
                if len(buf.getvalue()) <= before * 1.05:
                    break
        path.write_bytes(buf.getvalue())
        print(f"{name:48s} {img.width:5d}x{img.height:<5d} {before // 1024:4d} KB -> {len(buf.getvalue()) // 1024:4d} KB")
    return 0


AI_MODEL = "birefnet-general-lite"  # rembg's BiRefNet (MIT); IS-Net hollowed lit keycaps
_ai_session = None


def ai_mask(src: Image.Image, cache: Path) -> Image.Image | None:
    """A salient-object mask of the (cropped) photo from rembg's BiRefNet, as
    a referee for `Mask.fade`, cached beside the photo (~10 s each on a CPU,
    once). Optional: without rembg and without a cached mask the cut falls
    back to colour alone. `pip install --user "rembg[cpu]"`; the model
    (~220 MB) downloads on first use. Never trusted on white-on-white, where
    it drops most of a white shell: the cut only lets it decide on dark or
    coloured devices."""
    global _ai_session
    path = cache.with_name(f"{cache.stem}.{AI_MODEL}.{src.width}x{src.height}.png")
    if path.exists():
        return Image.open(path).convert("L")
    try:
        from rembg import new_session, remove
    except ImportError:
        return None
    if _ai_session is None:
        _ai_session = new_session(AI_MODEL)
    mask = remove(src.convert("RGB"), session=_ai_session, only_mask=True).convert("L")
    path.parent.mkdir(parents=True, exist_ok=True)
    mask.save(path)
    return mask


def keep_hand_edit(v: dict) -> None:
    """A `locked` variant was edited by hand: never rebuilt, even with
    --force. Only re-encoded, its pixels kept, when an editor saved it over
    the 50 KB budget (the browser edition precaches every file); its `bytes`
    and `sha256` follow the file."""
    path = ASSETS / v["file"]
    data = path.read_bytes()
    if len(data) > BUDGET:
        img = Image.open(io.BytesIO(data))
        img.load()
        before = len(data)
        data = encode(bleed(img.convert("RGBA")))
        path.write_bytes(data)
        print(f"{v['file']:58s} hand-edited: re-encoded {before // 1024} KB -> {len(data) // 1024} KB", flush=True)
    v["bytes"] = len(data)
    v["sha256"] = hashlib.sha256(data).hexdigest()


def main(argv: list[str]) -> int:
    if "--defringe" in argv:
        return defringe_files([a for a in argv[argv.index("--defringe") + 1 :] if not a.startswith("--")])
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    force = "--force" in argv
    only = set()
    if "--only" in argv:
        i = argv.index("--only") + 1
        while i < len(argv) and not argv[i].startswith("--"):
            only.add(argv[i])
            i += 1
    built = 0
    for key, model in manifest["models"].items():
        if only and key not in only:
            continue
        want, locked = [], []
        for vid, v in model["variants"].items():
            if not v.get("src"):
                continue
            if v.get("locked"):
                locked.append(vid)
                keep_hand_edit(v)
            elif force or not (ASSETS / f"{key}-{vid}.webp").exists() or not v.get("sha256"):
                want.append(vid)
        if not want:
            continue
        todo = {}
        for vid in want + locked:  # a hand-edited colourway still serves as a reference
            v = model["variants"][vid]
            ext = Path(v["src"]).suffix or ".img"
            raw = fetch(manifest["cdn"] + v["src"], CACHE / key / f"{vid}{ext}")
            src = Image.open(io.BytesIO(raw))
            src.load()
            # Cropped first, so a dock or dongle cut by the crop is a separate
            # blob of its own and dropped, not a sliver left on the edge.
            if v.get("crop"):
                src = src.crop(tuple(v["crop"]))
            # The product is the largest object in the shot; a dongle, dock or
            # cable connector beside it is a separate blob and is dropped.
            keep = v.get("keep", "largest")
            todo[vid] = Mask(src, v.get("tolerance"), keep, v.get("holes"), v.get("floor"), v.get("solid"))
            todo[vid].kind = model["kind"]
            todo[vid].hull = bool(v.get("hull"))
            if vid in want:
                todo[vid].ai = ai_mask(src, CACHE / key / f"{vid}{ext}")
        # The colourway with the most contrast at its rim is the reference.
        ref = max(todo.values(), key=lambda m: m.rim_contrast())
        for vid in want:
            mask = todo[vid]
            v = model["variants"][vid]
            adopted = v.get("adopt", True) and mask.adopt(ref)
            img = bleed(fit(mask.cut(), model["kind"], None))
            adopted = adopted and mask.borrowed > 0
            data = encode(img)
            out_name = f"{key}-{vid}.webp"
            (ASSETS / out_name).write_bytes(data)
            v["file"] = out_name
            v["bytes"] = len(data)
            v["sha256"] = hashlib.sha256(data).hexdigest()
            if adopted:
                v["outline"] = "sibling"
            else:
                v.pop("outline", None)
            built += 1
            note = " (outline and edge from a sibling colourway)" if adopted else ""
            if mask.ai is not None:
                note += " [segmentation used]" if mask.ai_used else " [segmentation ignored: disagrees]"
            print(f"{out_name:58s} {img.width:5d}x{img.height:<5d} {len(data) // 1024:3d} KB{note}", flush=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"built {built}")
    if "--gallery" in argv:
        gallery(manifest, Path(argv[argv.index("--gallery") + 1]))
    return 0


def gallery(manifest: dict, out_dir: Path) -> None:
    """A static contact sheet: every variant on light, dark and checkerboard."""
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for key, model in manifest["models"].items():
        cells = []
        for vid, v in model["variants"].items():
            f = v.get("file")
            if not f or not (ASSETS / f).exists():
                continue
            (out_dir / f).write_bytes((ASSETS / f).read_bytes())
            kb = (ASSETS / f).stat().st_size // 1024
            src = manifest["cdn"] + v["src"] if v.get("src") else ""
            cells.append({"file": f, "colour": v["colour"], "kb": kb, "src": src, "id": vid})
        rows.append({"key": key, "name": model["name"], "kind": model["kind"], "handle": model["handle"], "cells": cells})
    (out_dir / "gallery.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    print(f"gallery data: {out_dir / 'gallery.json'} ({sum(len(r['cells']) for r in rows)} images)")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
