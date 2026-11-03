/**
 * Tight bounding box of an image's non-transparent pixels, as fractions
 * (0..1) of its own width/height, plus its natural aspect ratio — lets a
 * caller align an image's *visible silhouette* to a target rect instead of
 * its full canvas, which can carry a few percent of transparent padding
 * around the actual product photo (see PersistentDeviceArt's keyboard-mode
 * alignment: the photo's own padding, stacked with the anchor/board
 * mismatch it used to have, is enough to visibly throw off where the
 * keyboard shape lands relative to the interactive key grid underneath it).
 */
export interface ContentBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** naturalWidth / naturalHeight */
  aspect: number;
}

const ALPHA_THRESHOLD = 10;
const cache = new Map<string, ContentBox | null>();
const pending = new Map<string, Promise<ContentBox | null>>();

function computeContentBox(img: HTMLImageElement): ContentBox | null {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    // Bundled same-origin assets never taint the canvas, but fail closed
    // (caller falls back to treating the whole image as content) rather
    // than throw into a render path.
    return null;
  }
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w * 4;
    for (let x = 0; x < w; x++) {
      const a = data[rowOffset + x * 4 + 3]!;
      if (a > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // fully transparent — nothing to crop to
  return { x0: minX / w, y0: minY / h, x1: (maxX + 1) / w, y1: (maxY + 1) / h, aspect: w / h };
}

/** Cached per URL — the same bundled asset is reused across every device
 *  tab and every card, so it's only ever decoded once. Resolves to `null`
 *  if the image has no alpha channel worth cropping to (fully opaque) or
 *  failed to decode; callers should then fall back to the plain full-image
 *  behaviour (e.g. `object-fit: contain`). */
export function getContentBox(src: string): Promise<ContentBox | null> {
  const cached = cache.get(src);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = pending.get(src);
  if (inflight) return inflight;
  const promise = new Promise<ContentBox | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const box = computeContentBox(img);
      cache.set(src, box);
      pending.delete(src);
      resolve(box);
    };
    img.onerror = () => {
      cache.set(src, null);
      pending.delete(src);
      resolve(null);
    };
    img.src = src;
  });
  pending.set(src, promise);
  return promise;
}

/**
 * Where to draw the *full* image (as an absolutely-positioned box, in the
 * coordinate space of a `target` rect's own container) so that its content
 * box — not the full image — is what ends up contained-and-centred within
 * `target`, the same way `object-fit: contain` would centre the whole image
 * if it had no transparent padding at all.
 */
export function fitContentBoxToTarget(
  box: ContentBox,
  target: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const cw = box.x1 - box.x0;
  const ch = box.y1 - box.y0;
  if (cw <= 0 || ch <= 0 || !Number.isFinite(box.aspect) || box.aspect <= 0) {
    return { left: 0, top: 0, width: target.width, height: target.height };
  }
  // Parameterise the full image's rendered size as (scale * aspect, scale);
  // pick the largest scale that still lets the *content* sub-rect fit
  // inside the target (the "contain" part).
  const scale = Math.min(target.width / (box.aspect * cw), target.height / ch);
  const imgWidth = scale * box.aspect;
  const imgHeight = scale;
  const contentWidth = imgWidth * cw;
  const contentHeight = imgHeight * ch;
  // Centre the content box within the target (the "centred" part of
  // object-fit: contain), then back out where that puts the image's own
  // top-left corner.
  const offsetX = (target.width - contentWidth) / 2;
  const offsetY = (target.height - contentHeight) / 2;
  return {
    left: offsetX - box.x0 * imgWidth,
    top: offsetY - box.y0 * imgHeight,
    width: imgWidth,
    height: imgHeight,
  };
}
