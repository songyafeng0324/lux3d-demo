"""T16 D2 materials: Poly Haven CC0 sets (assets/t16/textures/polyhaven, fetched by
scripts/fetch-t16-textures.mjs) and the user's ChatGPT patterns (docs/design/t16/textures).

Textures are prepared with numpy into assets/t16/textures/.build (git-ignored, rebuilt every run):
tints, polished roughness, a normal map derived from the cloud relief, metal/roughness masks for the
gilt patterns and an alpha mask for the lattice. Node graphs use only what the glTF exporter maps
1:1 (image → base colour / roughness / normal / emission / alpha-clip, Separate Color G/B → roughness/
metallic), so three.js sees the same material."""
import bpy, json, math
import numpy as np
from pathlib import Path
import t16_kit as kit

ROOT = Path(__file__).resolve().parents[2]
PH = ROOT / 'assets/t16/textures/polyhaven'
USER = ROOT / 'docs/design/t16/textures'
BUILD = ROOT / 'assets/t16/textures/.build'; BUILD.mkdir(parents=True, exist_ok=True)
MANIFEST = json.loads((PH / 'manifest.json').read_text())
SIZE = 1024


# ---------------------------------------------------------------- numpy image helpers
def _load(path, size=SIZE):
    img = bpy.data.images.load(str(path), check_existing=False)
    if size and (img.size[0] != size or img.size[1] != size * img.size[1] // img.size[0]):
        img.scale(size, size * img.size[1] // img.size[0])
    w, h = img.size
    a = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)


def _save(a, name, alpha=False):
    h, w = a.shape[:2]
    path = BUILD / (name + ('.png' if alpha else '.jpg'))
    img = bpy.data.images.new(name, w, h, alpha=alpha)
    img.pixels.foreach_set(np.ascontiguousarray(a, np.float32).ravel())
    img.filepath_raw = str(path); img.file_format = 'PNG' if alpha else 'JPEG'
    img.save(quality=88)
    bpy.data.images.remove(img)
    return path


def _lum(a): return a[..., 0] * .299 + a[..., 1] * .587 + a[..., 2] * .114


def ph_maps(set_id, tint=(1, 1, 1), rough=1.0):
    maps = MANIFEST['sets'][set_id]['maps']; d = PH / set_id
    col = _load(d / maps['Diffuse']); col[..., :3] = np.clip(col[..., :3] * np.array(tint, np.float32), 0, 1)
    tag = f'{set_id}-{abs(hash((tint, rough))) % 10**6}'
    out = {'color': _save(col, tag + '-col'), 'normal': d / maps['nor_gl']}
    r = _load(d / maps['Rough']); r[..., :3] = np.clip(r[..., :3] * rough, 0.03, 1)
    out['rough'] = _save(r, tag + '-rough')
    return out


def normal_from_height(a, strength):
    """Tangent-space (OpenGL, +Y up) normal map from luminance; wraps, so seamless inputs stay seamless."""
    L = _lum(a)
    L = (L + np.roll(L, 1, 0) + np.roll(L, -1, 0) + np.roll(L, 1, 1) + np.roll(L, -1, 1)) / 5   # soften JPEG noise
    dx = (np.roll(L, -1, 1) - np.roll(L, 1, 1)) * strength; dy = (np.roll(L, -1, 0) - np.roll(L, 1, 0)) * strength
    n = np.stack([-dx, -dy, np.ones_like(L)], -1); n /= np.linalg.norm(n, axis=-1, keepdims=True)
    out = np.ones(a.shape, np.float32); out[..., :3] = n * .5 + .5
    return out


def gilt_mr(a):
    """Gold strokes on black lacquer: bright → metallic and glossy, dark → dielectric lacquer."""
    m = np.clip((_lum(a) - .16) / .22, 0, 1)
    out = np.ones(a.shape, np.float32); out[..., 1] = .62 - .38 * m; out[..., 2] = m
    return out


# ---------------------------------------------------------------- materials
SPECS = {}


def spec(name, **kw): SPECS[name] = kw


def build_specs():
    lac = ph_maps('lacquered_cherry_wood', (.50, .36, .33), 1.0)
    spec('Lacquer', tex=lac, tile=1.0, normal=.5)
    spec('Door', tex=ph_maps('lacquered_cherry_wood', (1.05, .42, .36), 1.0), tile=1.0, normal=.5)
    spec('WallWood', tex=ph_maps('dark_wood', (.52, .40, .36), 1.1), tile=2.0, normal=.6)
    spec('Slab', tex=ph_maps('dark_wooden_planks', (.85, .66, .55), .9), tile=2.0, normal=.7)
    spec('Ceiling', tex=ph_maps('dark_wooden_planks', (.55, .40, .32), 1.0), tile=2.0, normal=.7)
    spec('Floor', tex=ph_maps('granite_tile', (.50, .50, .56), .42), tile=2.3, normal=.6)
    spec('Marble', tex=ph_maps('marble_01', (1, 1, 1), .75), tile=1.5, normal=.5)
    spec('Stone', tex=ph_maps('marble_01', (.95, .88, .78), .85), tile=1.5, normal=.6)
    spec('RoofTile', tex=ph_maps('grey_roof_tiles', (.55, .58, .62), 1.0), tile=3.0, normal=1.0)
    spec('Gold', color=(.92, .62, .26), metal=1.0, rough=.36)
    spec('LanternRed', color=(.55, .04, .03), rough=.75)
    # Emissive panels: near-black base so nearby lantern lights cannot wash them out; the colour is all emission.
    spec('Glow', color=(.04, .02, .01), emit=(1.0, .5, .18), strength=0.65)
    a1 = _load(USER / 'A1-cloud-relief.png')
    a1c = a1.copy(); a1c[..., :3] = np.clip(a1c[..., :3] * np.array((.85, .70, .62), np.float32), 0, 1)
    spec('Relief', tex={'color': _save(a1c, 'A1-relief-col'), 'normal': _save(normal_from_height(a1, 6.0), 'A1-relief-nor')}, rough=.62, tile=2.4, normal=1.0)
    a2 = _load(USER / 'A2-gold-band.png')
    spec('GoldBand', tex={'color': _save(a2, 'A2-band-col'), 'mr': _save(gilt_mr(a2), 'A2-band-mr')})
    a8 = _load(USER / 'A8-plaque.png')
    spec('Plaque', tex={'color': _save(a8, 'A8-plaque-col'), 'mr': _save(gilt_mr(a8), 'A8-plaque-mr')})
    a4 = _load(USER / 'A4-lattice-mask.png', 512)
    lat = np.empty(a4.shape, np.float32); L = _lum(a4)
    for _ in range(3): L = np.maximum.reduce([L, np.roll(L, 1, 0), np.roll(L, -1, 0), np.roll(L, 1, 1), np.roll(L, -1, 1)])   # thicker bars
    lat[..., 0], lat[..., 1], lat[..., 2] = .09 * (.8 + .3 * L), .035 * (.8 + .3 * L), .025 * (.8 + .3 * L)
    lat[..., 3] = np.clip((L - .35) / .3, 0, 1)
    spec('Lattice', tex={'color': _save(lat, 'A4-lattice', alpha=True)}, rough=.5, clip=True, double=True)
    spec('Carpet', tex={'color': _save(_load(USER / 'A5-carpet.png'), 'A5-carpet')}, rough=.95)
    spec('Array', tex={'color': _save(_load(USER / 'A6-array-stars.png'), 'A6-array')}, rough=.4, metal=.3, emit_tex=True, strength=1.6)
    spec('Caisson', tex={'color': _save(_load(USER / 'A3-caisson.png'), 'A3-caisson')}, rough=.7)
    spec('Banner1', tex={'color': _save(_load(USER / 'A7-banner-1.png'), 'A7-banner-1')}, rough=.85, double=True)
    spec('Banner2', tex={'color': _save(_load(USER / 'A7-banner-2.png'), 'A7-banner-2')}, rough=.85, double=True)
    a9 = _load(USER / 'A9-lantern-paper.png', 512); a9d = a9.copy(); a9d[..., :3] *= .3
    spec('LanternPaper', tex={'color': _save(a9d, 'A9-paper-base'), 'emit': _save(a9, 'A9-paper')}, rough=.8, strength=0.9)
    spec('Portal', tex={'color': _save(_load(USER / 'A10-moon-gate-view.png'), 'A10-portal')}, rough=.9, emit_tex=True, strength=1.0)
    for n, s in SPECS.items():
        if 'tile' in s: kit.TILE[n] = s['tile']


MAT = {}


def make_materials():
    build_specs()
    for name, s in SPECS.items():
        m = bpy.data.materials.new('T16_' + name); m.use_nodes = True; nt = m.node_tree
        p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        tex = s.get('tex', {})
        def image(path, color=True):
            node = nt.nodes.new('ShaderNodeTexImage'); node.image = bpy.data.images.load(str(path), check_existing=True)
            node.image.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
            return node
        if 'color' in tex:
            c = image(tex['color']); nt.links.new(c.outputs['Color'], p.inputs['Base Color'])
            if s.get('emit_tex'):
                nt.links.new(c.outputs['Color'], p.inputs['Emission Color']); p.inputs['Emission Strength'].default_value = s.get('strength', 1.0)
            if s.get('clip'):
                rnd = nt.nodes.new('ShaderNodeMath'); rnd.operation = 'ROUND'
                nt.links.new(c.outputs['Alpha'], rnd.inputs[0]); nt.links.new(rnd.outputs[0], p.inputs['Alpha'])
        else:
            p.inputs['Base Color'].default_value = (*s['color'], 1)
        if 'rough' in tex:
            r = image(tex['rough'], False); nt.links.new(r.outputs['Color'], p.inputs['Roughness'])
        else:
            p.inputs['Roughness'].default_value = s.get('rough', .6)
        if 'mr' in tex:
            mr = image(tex['mr'], False); sep = nt.nodes.new('ShaderNodeSeparateColor')
            nt.links.new(mr.outputs['Color'], sep.inputs['Color'])
            nt.links.new(sep.outputs['Green'], p.inputs['Roughness']); nt.links.new(sep.outputs['Blue'], p.inputs['Metallic'])
        else:
            p.inputs['Metallic'].default_value = s.get('metal', 0.0)
        if 'normal' in tex:
            nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = s.get('normal', 1.0)
            n = image(tex['normal'], False); nt.links.new(n.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
        if 'emit' in tex:
            e = image(tex['emit']); nt.links.new(e.outputs['Color'], p.inputs['Emission Color']); p.inputs['Emission Strength'].default_value = s.get('strength', 1.0)
        if 'emit' in s:
            p.inputs['Emission Color'].default_value = (*s['emit'], 1); p.inputs['Emission Strength'].default_value = s.get('strength', 1.0)
        m.use_backface_culling = not s.get('double', False)
        MAT[name] = m
    return MAT


def caisson_hole_fraction():
    """Radius of the black oculus at the centre of A3, as a fraction of the image width, so the mesh
    hole in the caisson board lines up with the painted one."""
    a = _load(USER / 'A3-caisson.png', 512); h, w = a.shape[:2]; L = _lum(a)
    rs = []
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        r = 0
        while r < w // 2 - 1 and L[h // 2 + dy * r, w // 2 + dx * r] < 0.08: r += 1
        rs.append(r)
    return (sum(rs) / len(rs) + 1) / w
