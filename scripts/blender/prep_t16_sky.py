"""T16 D3: downscale the user's backdrop paintings for the web sky (assets/t16/sky/, committed).

A11 (a misty mountain cluster, transparent) and A12 (a 2×2 atlas of floating isles, transparent) become
billboards around the pavilion (apps/web/src/game/sky.ts). Alpha is kept; nothing else is changed.
  ~/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python scripts/blender/prep_t16_sky.py
"""
import bpy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC, OUT = ROOT / 'docs/design/t16/textures', ROOT / 'assets/t16/sky'
OUT.mkdir(parents=True, exist_ok=True)
for src, dst, width in (('A11-mountain-layers.png', 'mountains.png', 1024), ('A12-floating-isles.png', 'isles.png', 1024)):
    img = bpy.data.images.load(str(SRC / src))
    w, h = img.size
    img.scale(width, round(h * width / w))
    img.filepath_raw = str(OUT / dst); img.file_format = 'PNG'
    bpy.context.scene.render.image_settings.color_mode = 'RGBA'
    img.save()
    print(dst, tuple(img.size), (OUT / dst).stat().st_size)
