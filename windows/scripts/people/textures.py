"""Game-sized textures for the people of Spindown World from the MakeHuman system assets (CC0).

    python3 scripts/people/textures.py <makehuman dir>     (needs Pillow)

Writes JPEG skins and grey+alpha PNGs (hair, eyebrows) into src/renderer/game3d/people/. Development-time only.
"""
import os
import sys
from PIL import Image

MH = sys.argv[1]
SYS = os.path.join(MH, 'system')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'renderer', 'game3d', 'people')
os.makedirs(OUT, exist_ok=True)


def skin(src, name, size=1024):
    im = Image.open(os.path.join(SYS, 'skins', src)).convert('RGB').resize((size, size), Image.LANCZOS)
    im.save(os.path.join(OUT, name), quality=86, optimize=True, progressive=True)


def grey_alpha(src, name, size):
    im = Image.open(os.path.join(SYS, src)).convert('RGBA').resize((size, size), Image.LANCZOS)
    r, g, b, a = im.split()
    lum = Image.merge('RGB', (r, g, b)).convert('L')
    # Normalise the brightness so the game can tint it to any hair colour.
    lo, hi = lum.getextrema()
    lum = lum.point(lambda v: int(255 * min(1.0, max(0.0, (v - lo) / max(1, hi - lo))) ** 0.9))
    Image.merge('LA', (lum, a)).save(os.path.join(OUT, name), optimize=True)


import json
import math

import numpy as np
from PIL import ImageDraw, ImageFilter


# Where the MakeHuman logo and wordmark sit on each tee texture (x0, y0, x1, y1 as fractions of the image).
LOGO_BOXES = {
    'male_casualsuit06': [(0.44, 0.112, 0.628, 0.208), (0.192, 0.112, 0.298, 0.168), (0.733, 0.152, 0.752, 0.178)],
    'female_casualsuit01': [(0.655, 0.13, 0.885, 0.36)],
    'female_casualsuit02': [(0.655, 0.13, 0.885, 0.36), (0.755, 0.405, 0.805, 0.465)],
    'male_casualsuit04': [(0.455, 0.075, 0.632, 0.258)],
    'male_casualsuit02': [(0.445, 0.045, 0.622, 0.228)],
}


def remove_logo(im, boxes):
    """Paints out the MakeHuman logo and wordmark (a trademark: CC0 does not waive trademarks) by diffusion
    inpainting inside the given boxes, then restores the fabric grain."""
    a = np.asarray(im.convert('RGB')).astype(np.float32)
    h, w, _ = a.shape
    mask = np.zeros((h, w), bool)
    for (x0, y0, x1, y1) in boxes:
        X0, X1, Y0, Y1 = int(x0 * w), int(x1 * w), int(y0 * h), int(y1 * h)
        sub = a[Y0:Y1, X0:X1]
        med = np.median(sub.reshape(-1, 3), axis=0)
        dev = np.abs(sub - med).sum(axis=2)
        r, g, b = sub[..., 0], sub[..., 1], sub[..., 2]
        orange = (r > g + 30) & (g > b + 15)
        mask[Y0:Y1, X0:X1] |= (dev > 36) | orange
    if not mask.any():
        return im
    m = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9))
    mask = np.asarray(m) > 0
    out = a.copy()
    out[mask] = np.median(a[~mask], axis=0)
    for _ in range(220):
        avg = (np.roll(out, 1, 0) + np.roll(out, -1, 0) + np.roll(out, 1, 1) + np.roll(out, -1, 1)) / 4
        out[mask] = avg[mask]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def yorkshire_flag(size):
    """The Yorkshire flag: a white rose on a sky-blue field (drawn from scratch)."""
    im = Image.new('RGB', (size, size), (0, 112, 184))
    d = ImageDraw.Draw(im)
    cx, cy, R = size * 0.5, size * 0.5, size * 0.27
    for k in range(5):
        a = -math.pi / 2 + k * 2 * math.pi / 5
        px, py = cx + math.cos(a) * R * 0.55, cy + math.sin(a) * R * 0.55
        d.ellipse([px - R * 0.55, py - R * 0.55, px + R * 0.55, py + R * 0.55], fill=(250, 250, 248))
    for k in range(5):
        a = -math.pi / 2 + (k + 0.5) * 2 * math.pi / 5
        px, py = cx + math.cos(a) * R * 1.0, cy + math.sin(a) * R * 1.0
        d.polygon([(cx + math.cos(a - 0.2) * R * 0.6, cy + math.sin(a - 0.2) * R * 0.6), (px, py), (cx + math.cos(a + 0.2) * R * 0.6, cy + math.sin(a + 0.2) * R * 0.6)], fill=(40, 120, 60))
    d.ellipse([cx - R * 0.3, cy - R * 0.3, cx + R * 0.3, cy + R * 0.3], fill=(236, 204, 70))
    d.ellipse([cx - R * 0.16, cy - R * 0.16, cx + R * 0.16, cy + R * 0.16], fill=(214, 168, 40))
    return im


def crowd_atlas():
    layout_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'crowd-atlas.json')
    if not os.path.exists(layout_file):
        return
    layout = json.load(open(layout_file))
    W, H = 2048, 2560
    atlas = Image.new('RGB', (W, H), (128, 128, 128))
    mask = Image.new('L', (W // 2, H // 2), 255)
    for key, entry in layout.items():
        x, y, w, h = entry['rect']
        if entry['src'] == '@flag':
            atlas.paste(yorkshire_flag(w), (x, y))
            continue
        src = Image.open(os.path.join(SYS, entry['src']))
        rgba = src.convert('RGBA')
        rgb = rgba.convert('RGB')
        if key in LOGO_BOXES:
            rgb = remove_logo(rgb, LOGO_BOXES[key])
        if entry.get('alpha'):
            # Hair: grey (tinted in the game), alpha into the mask.
            lum = rgb.convert('L')
            lo, hi = lum.getextrema()
            lum = lum.point(lambda v: int(255 * min(1.0, max(0.0, (v - lo) / max(1, hi - lo))) ** 0.9))
            rgb = Image.merge('RGB', (lum, lum, lum))
            alpha = rgba.split()[3].resize((w // 2, h // 2), Image.LANCZOS)
            mask.paste(alpha, (x // 2, y // 2))
        atlas.paste(rgb.resize((w, h), Image.LANCZOS), (x, y))
    atlas.save(os.path.join(OUT, 'crowd-atlas.jpg'), quality=84, optimize=True, progressive=True)
    mask.save(os.path.join(OUT, 'crowd-mask.png'), optimize=True)


crowd_atlas()
skin('young_caucasian_male/young_lightskinned_male_diffuse.png', 'skin-light.jpg')
skin('young_asian_male/young_lightskinned_male_diffuse3.png', 'skin-mid.jpg')
skin('young_african_male/young_darkskinned_male_diffuse.png', 'skin-dark.jpg')
grey_alpha('hair/short02/short02_diffuse.png', 'hair-short.png', 512)
grey_alpha('eyebrows/eyebrow001/eyebrow001.png', 'brows.png', 256)
for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, 'KB')
