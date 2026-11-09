"""T16 D3: bake ambient occlusion and indirect light for the pavilion shell into lightmaps.

Run after build_t16.py (it saves assets/t16/pavilion-t16.blend with a "UVLight" UV set on every mesh in
LIGHTMAP_RES and exports the same UVs as TEXCOORD_1):
  ~/Applications/Blender.app/Contents/MacOS/Blender -b assets/t16/pavilion-t16.blend --python scripts/blender/bake_t16.py

Per baked mesh it writes assets/t16/lightmaps/<Material>-ao.jpg (linear AO, grey) and <Material>-gi.jpg
(indirect diffuse irradiance, sRGB-encoded after one global scale), plus assets/t16/pavilion-lightmaps.json (next to the GLB and layout it belongs to) with that scale and
the SHA-256 of the GLB the UVs belong to; a stale bake fails the unit tests. The web keeps its real-time
lantern tiers for direct light: the GI map only adds the bounce light those lanterns and the sky would
give, and the AO map darkens corners, column feet and the floor under the props.
The Lux3D props (shared meshes, no unique UVs) are not baked themselves but do occlude.
"""
import bpy, json, math, hashlib, sys
from pathlib import Path
import numpy as np

ROOT = Path(bpy.data.filepath).resolve().parents[2]
OUT = ROOT / 'assets/t16/lightmaps'; OUT.mkdir(parents=True, exist_ok=True)
LAYOUT = json.loads((ROOT / 'assets/t16/pavilion-layout.json').read_text())
GLB = ROOT / 'assets/t16/pavilion-t16.glb'
AO_DISTANCE, AO_SAMPLES, GI_SAMPLES = 1.6, 96, 384

scene = bpy.context.scene
GLB_SHA = hashlib.sha256(GLB.read_bytes()).hexdigest()
if scene.get('t16_glb_sha256') != GLB_SHA:
    sys.exit('pavilion-t16.blend and pavilion-t16.glb come from different exports: rerun build_t16.py, then bake')
scene.render.engine = 'CYCLES'
cy = scene.cycles
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'; prefs.get_devices()
    for d in prefs.devices: d.use = True
    cy.device = 'GPU'
except Exception as e:  # CPU still works, only slower
    print('GPU unavailable, baking on CPU:', e)
cy.use_denoising = False
scene.render.bake.margin = 4
scene.render.bake.margin_type = 'EXTEND'

# Lights mirror the web markers (every lantern, not the web's every-other subset): only their ratios
# matter, the result is normalised below. Sky: a dim dusk blue through the oculus and the door.
for o in [o for o in bpy.data.objects if o.type == 'LIGHT']: bpy.data.objects.remove(o)
for i, m in enumerate(LAYOUT['lights']):
    if m['role'] == 'sky': continue
    ld = bpy.data.lights.new(f'bake-{i}', 'POINT'); ld.energy = m['power'] * 4.0; ld.color = m['color']; ld.shadow_soft_size = 0.4
    lo = bpy.data.objects.new(f'bake-{i}', ld); scene.collection.objects.link(lo)
    x, y, z = m['position']; lo.location = (x, -z, y)
world = bpy.data.worlds.new('T16_Bake'); scene.world = world; world.use_nodes = True
bg = world.node_tree.nodes['Background']; bg.inputs[0].default_value = (0.10, 0.12, 0.25, 1); bg.inputs[1].default_value = 1.0
world.light_settings.distance = AO_DISTANCE

targets = [o for o in scene.objects if o.type == 'MESH' and 'lightmap_res' in o]
print('baking', [o.name for o in targets])


def bake(ob, kind):
    res = int(ob['lightmap_res'])
    img = bpy.data.images.new(f'{ob.name}-{kind}', res, res, float_buffer=True)
    mat = ob.data.materials[0]; nt = mat.node_tree
    node = nt.nodes.new('ShaderNodeTexImage'); node.image = img
    uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.uv_map = 'UVLight'; nt.links.new(uvn.outputs['UV'], node.inputs['Vector'])
    for n in nt.nodes: n.select = False
    node.select = True; nt.nodes.active = node
    me = ob.data; me.uv_layers.active = me.uv_layers['UVLight']
    bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.context.view_layer.objects.active = ob
    if kind == 'ao':
        cy.samples = AO_SAMPLES
        bpy.ops.object.bake(type='AO', margin=4, use_clear=True)
    else:
        cy.samples = GI_SAMPLES
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'INDIRECT'}, margin=4, use_clear=True)
    me.uv_layers.active = me.uv_layers['UVMap']
    a = np.empty(res * res * 4, np.float32); img.pixels.foreach_get(a)
    nt.nodes.remove(node); nt.nodes.remove(uvn); bpy.data.images.remove(img)
    return a.reshape(res, res, 4)[..., :3]


def linear_to_srgb(a):
    """Blender writes byte-image pixels as given (a 0.5 lands as 128), so sRGB-tagged maps are encoded here."""
    a = np.clip(a, 0, 1)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(a, 1 / 2.4) - 0.055)


def save(a, name, srgb):
    if srgb: a = linear_to_srgb(a)
    h, w = a.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    px = np.ones((h, w, 4), np.float32); px[..., :3] = np.clip(a, 0, 1)
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = str(OUT / f'{name}.jpg'); img.file_format = 'JPEG'
    img.save(quality=88)
    bpy.data.images.remove(img)


gi, entries = {}, {}
for ob in targets:
    mat = ob.name[len('T16_'):]
    ao = bake(ob, 'ao')
    save(ao.mean(-1, keepdims=True).repeat(3, -1), f'{mat}-ao', srgb=False)
    gi[mat] = bake(ob, 'gi')
    print('baked', mat, ob['lightmap_res'], flush=True)
# One global scale so the brightest bounce (99.5th percentile over every map) lands near 1.
vals = np.concatenate([g.max(-1).ravel() for g in gi.values()])
scale = float(np.percentile(vals[vals > 0], 99.5)) or 1.0
for mat, g in gi.items():
    save(g / scale, f'{mat}-gi', srgb=True)
    entries['T16_' + mat] = {'ao': f'{mat}-ao.jpg', 'gi': f'{mat}-gi.jpg', 'size': int(bpy.data.objects['T16_' + mat]['lightmap_res'])}
manifest = {
    'source': 'scripts/blender/bake_t16.py', 'glbSHA256': GLB_SHA, 'encoding': {'ao': 'linear', 'gi': 'sRGB (encoded before saving)'},
    'uv': 'TEXCOORD_1 (UVLight)', 'giScale': scale, 'aoDistance': AO_DISTANCE, 'samples': {'ao': AO_SAMPLES, 'gi': GI_SAMPLES},
    'maps': entries,
}
(ROOT / 'assets/t16/pavilion-lightmaps.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n')
print('done', len(entries), 'scale', scale)
