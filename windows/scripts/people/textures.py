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


skin('young_caucasian_male/young_lightskinned_male_diffuse.png', 'skin-light.jpg')
skin('young_asian_male/young_lightskinned_male_diffuse3.png', 'skin-mid.jpg')
skin('young_african_male/young_darkskinned_male_diffuse.png', 'skin-dark.jpg')
grey_alpha('hair/short02/short02_diffuse.png', 'hair-short.png', 512)
grey_alpha('eyebrows/eyebrow001/eyebrow001.png', 'brows.png', 256)
for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, 'KB')
