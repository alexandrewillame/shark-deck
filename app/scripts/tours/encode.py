"""Downscale a recorded run to 800x500 and encode it as an animated WebP.

    python -E -P encode.py <runDir> <out.webp> --mode independent|delta [--q 75] [--method 6]
           [--fade 6] [--frames N]

--mode independent: every frame encoded whole and kept (mux.py). For the moving
  background, which changes a little everywhere in every frame.
--mode delta: Pillow's own animation encoder (sub-frames, identical frames merged;
  --minimize: no key frames, so a still background is encoded once). Fine when the
  background is still and only the UI and the cursor change; it is also what
  made the old tour's background step every 3-5 frames (see mux.py).
--fade N: the last N frames dissolve into frame 0, so the loop has no seam.
"""
import argparse
import os
import sys
import time

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mux  # noqa: E402


def load(run, limit):
    """The run's frames at 800x500. Where the recording's manifest gives a camera
    rect for a frame (CSS px of the 1280x800 window), that part of the 1600x1000
    capture is cropped and scaled to the frame: the zooms of tour 2."""
    src = os.path.join(run, 'frames')
    names = sorted(n for n in os.listdir(src) if n.endswith('.png'))
    if limit:
        names = names[:limit]
    zooms = {}
    mf = os.path.join(run, 'manifest.json')
    if os.path.exists(mf):
        import json
        m = json.load(open(mf))
        for e in m.get('log', []):
            z = e.get('zoom')
            if z and (abs(z[0]) > 0.01 or abs(z[1]) > 0.01 or abs(z[2] - 1280) > 0.01 or abs(z[3] - 800) > 0.01):
                zooms[e['k']] = z
    cache = os.path.join(run, 'small')
    os.makedirs(cache, exist_ok=True)
    frames = []
    for k, n in enumerate(names):
        c = os.path.join(cache, n)
        if os.path.exists(c):
            im = Image.open(c).convert('RGB')
        else:
            im = Image.open(os.path.join(src, n)).convert('RGB')
            if k in zooms:
                x, y, w, h = zooms[k]
                sx = im.width / 1280
                im = im.resize((800, 500), Image.LANCZOS, box=(x * sx, y * sx, (x + w) * sx, (y + h) * sx))
            else:
                im = im.resize((800, 500), Image.LANCZOS)
            im.save(c, compress_level=1)
        frames.append(im)
    return frames


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run')
    ap.add_argument('out')
    ap.add_argument('--mode', choices=['independent', 'delta'], required=True)
    ap.add_argument('--q', type=float, default=75)
    ap.add_argument('--method', type=int, default=6)
    ap.add_argument('--fade', type=int, default=6)
    ap.add_argument('--frames', type=int, default=0)
    ap.add_argument('--minimize', action='store_true', help='delta mode: minimize_size (no key frames, smallest file)')
    a = ap.parse_args()

    t0 = time.time()
    frames = load(a.run, a.frames)
    print(f'{len(frames)} frames loaded/downscaled in {time.time() - t0:.1f}s', flush=True)

    # Seamless loop: dissolve the last `fade` frames into the first.
    if a.fade:
        first = frames[0]
        n = len(frames)
        for j in range(a.fade):
            k = n - a.fade + j
            frames[k] = Image.blend(frames[k], first, (j + 1) / (a.fade + 1))

    # 15 fps exactly: 67, 67, 66 ms repeating (WebP durations are whole ms).
    durs = [67 if i % 3 != 2 else 66 for i in range(len(frames))]

    t1 = time.time()
    if a.mode == 'independent':
        sizes = mux.write_anim(a.out, frames, durs, quality=a.q, method=a.method)
        print(f'per-frame bytes: min {min(sizes)}, mean {sum(sizes) / len(sizes):.0f}, max {max(sizes)}')
    else:
        frames[0].save(
            a.out, 'WEBP', save_all=True, append_images=frames[1:], duration=durs, loop=0,
            lossless=False, quality=a.q, method=a.method, minimize_size=a.minimize,
        )
    size = os.path.getsize(a.out)
    print(f'{a.out}: {size / 1e6:.2f} MB ({size} bytes), {len(frames)} frames, {sum(durs) / 1000:.3f} s, '
          f'encoded in {time.time() - t1:.1f}s')


if __name__ == '__main__':
    main()
