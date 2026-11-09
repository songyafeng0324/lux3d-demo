"""T16 D3: prepare the Lux3D props for the pavilion build.

Raw downloads (G1-Turbo image-to-3D, ~38k/20k triangles, two 2048² maps each) live in
assets/t16/props/source/ (git-ignored, ~85 MB). This script makes the committed, lightweight copies in
assets/t16/props/: one mesh, decimated to a per-prop triangle budget, maps shrunk, the model's own
bottom centre at the origin, material renamed Prop_<id>, and writes props-manifest.json with the
Lux3D task facts and the raw file hashes. build_t16.py only reads the prepared copies.

  ~/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python scripts/blender/prep_t16_props.py
"""
import bpy, json, hashlib
from pathlib import Path
from mathutils import Vector, Matrix

ROOT = Path(__file__).resolve().parents[2]
SRC, OUT = ROOT / 'assets/t16/props/source', ROOT / 'assets/t16/props'

# id: (file stem, Lux3D task id, target triangles, map size). Big terrace/hall pieces stay finer;
# cabinet curios are seen from metres away.
PROPS = {
    'B1': ('B1-stone-lion', '5159092', 14000, 1024),
    'B2': ('B2-stone-lamp', '5159129', 10000, 1024),
    'B3': ('B3-incense-burner', '5159207', 12000, 1024),
    'B4': ('B4-vase', '5159230', 4000, 512),
    'B5': ('B5-jade-bi', '5159258', 4000, 512),
    'B6': ('B6-bronze-jue', '5162296', 4000, 512),
    'B7': ('B7-ruyi', '5162645', 4000, 512),
    'B8': ('B8-book-box', '5163559', 4000, 512),
    'B9': ('B9-jade-mountain', '5163582', 4000, 512),
}
LUX3D = {'region': 'cn', 'operation': 'image-to-3d', 'version': 'G1-Turbo', 'outputFormat': ['glb'], 'enablePbr': True,
         'aiPredictSize': False, 'quoteId': 'quote_89be1a1ce23f4f30af56aca91c238a77',
         'references': 'docs/design/t16/props/<stem>.png'}

manifest = {'source': 'scripts/blender/prep_t16_props.py', 'lux3d': LUX3D, 'props': {}}
for pid, (stem, task, target, tex) in PROPS.items():
    raw = SRC / f'{stem}.glb'
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(raw))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes: o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1: bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    for o in list(bpy.context.scene.objects):          # drop import empties, keep the world transform on the mesh
        if o is not ob: bpy.data.objects.remove(o)
    ob.data.transform(ob.matrix_world); ob.matrix_world = Matrix.Identity(4)
    me = ob.data; me.calc_loop_triangles(); raw_tris = len(me.loop_triangles)
    if raw_tris > target:
        mod = ob.modifiers.new('decimate', 'DECIMATE'); mod.ratio = target / raw_tris; mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
    me = ob.data; me.calc_loop_triangles()
    # Bottom centre to the origin (Blender Z up; glTF front = Blender -Y stays the front).
    vs = [v.co for v in me.vertices]
    lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    me.transform(Matrix.Translation((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z)))
    for img in bpy.data.images:
        if img.size[0] > tex: img.scale(tex, tex)
    for i, m in enumerate(me.materials): m.name = f'Prop_{pid}' + (f'_{i}' if i else '')
    ob.name = me.name = f'Prop_{pid}'
    out = OUT / f'{stem}.glb'
    bpy.ops.export_scene.gltf(filepath=str(out), export_format='GLB', use_selection=False, export_yup=True,
                              export_image_format='JPEG', export_jpeg_quality=85, export_image_quality=85)
    size = hi - lo
    manifest['props'][pid] = {
        'file': f'assets/t16/props/{stem}.glb', 'taskId': task, 'rawSHA256': hashlib.sha256(raw.read_bytes()).hexdigest(),
        'rawTriangles': raw_tris, 'triangles': len(me.loop_triangles), 'mapSize': tex, 'bytes': out.stat().st_size,
        # Web metres before placement scaling: width (x), height (y), depth (z); front faces +z.
        'size': [round(size.x, 4), round(size.z, 4), round(size.y, 4)],
    }
    print(pid, manifest['props'][pid]['triangles'], manifest['props'][pid]['bytes'])
(OUT / 'props-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n')
