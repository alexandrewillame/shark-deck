"""An animated WebP with every frame kept: each frame is encoded on its own as a
full-canvas lossy WebP and muxed as one ANMF chunk (no blending, no disposal).

libwebp's animation encoder (what Pillow's save_all uses) decides per frame what
changed, and in lossy mode counts a pixel within QualityToMaxDiff(quality) of
the previous canvas as unchanged (anim_encode.c); a frame left with no change is
not encoded at all, its time added to the previous frame's. A slowly drifting
background changes by a level or two per frame, so it moved only when the
change had built up past that margin, or at a key frame. Even with kmax=1 a few
frames were still merged here. Muxing frames ourselves leaves nothing to merge.

Container layout (https://developers.google.com/speed/webp/docs/riff_container):
RIFF 'WEBP' > VP8X (animation flag) > ANIM (background, loop) > ANMF per frame
(x/2, y/2, w-1, h-1 as 24-bit, duration 24-bit, flags) wrapping the frame's VP8 chunk.
"""
import io
import struct
from concurrent.futures import ProcessPoolExecutor

from PIL import Image


def _u24(v):
    return struct.pack('<I', v)[:3]


def _chunk(fourcc, payload):
    data = fourcc + struct.pack('<I', len(payload)) + payload
    return data + (b'\0' if len(payload) & 1 else b'')


def _chunks(riff):
    """The chunks of a single-image WebP file, as (fourcc, payload) pairs."""
    assert riff[:4] == b'RIFF' and riff[8:12] == b'WEBP', 'not a WebP file'
    out = []
    i = 12
    while i + 8 <= len(riff):
        fourcc = riff[i : i + 4]
        size = struct.unpack('<I', riff[i + 4 : i + 8])[0]
        out.append((fourcc, riff[i + 8 : i + 8 + size]))
        i += 8 + size + (size & 1)
    return out


def encode_frame(args):
    """One frame -> the bytes of its image data chunks (ALPH? + VP8/VP8L)."""
    png_or_image, quality, method = args
    im = png_or_image if isinstance(png_or_image, Image.Image) else Image.open(png_or_image)
    im = im.convert('RGB')
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=quality, method=method)
    parts = [(f, p) for f, p in _chunks(buf.getvalue()) if f in (b'ALPH', b'VP8 ', b'VP8L')]
    assert any(f in (b'VP8 ', b'VP8L') for f, _ in parts), 'no image chunk'
    return b''.join(_chunk(f, p) for f, p in parts)


def write_anim(path, frames, durations, quality=75, method=6, workers=8, loop=0):
    """frames: PIL images or file paths, all the same size; durations in ms."""
    first = frames[0] if isinstance(frames[0], Image.Image) else Image.open(frames[0])
    w, h = first.size
    jobs = [(f, quality, method) for f in frames]
    if workers > 1:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            datas = list(ex.map(encode_frame, jobs, chunksize=4))
    else:
        datas = [encode_frame(j) for j in jobs]
    body = []
    # VP8X: flags (animation = 0x02), 3 reserved bytes, canvas w-1, h-1 (24-bit each).
    body.append(_chunk(b'VP8X', bytes([0x02, 0, 0, 0]) + _u24(w - 1) + _u24(h - 1)))
    # ANIM: background colour (BGRA) and loop count (0 = forever).
    body.append(_chunk(b'ANIM', struct.pack('<IH', 0xFF000000, loop)))
    for data, d in zip(datas, durations):
        # ANMF: x/2, y/2, w-1, h-1, duration (24-bit each), then flags:
        # bit 1 = do not blend (the frame is opaque and whole), bit 0 = 0, no disposal.
        hdr = _u24(0) + _u24(0) + _u24(w - 1) + _u24(h - 1) + _u24(int(d)) + bytes([0x02])
        body.append(_chunk(b'ANMF', hdr + data))
    payload = b'WEBP' + b''.join(body)
    with open(path, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', len(payload)) + payload)
    return [len(x) for x in datas]
