"""Run after build_t10.py through Blender MCP: normals, GLB, source save, audit."""
import bpy,bmesh,json,hashlib
from pathlib import Path
ROOT=Path('/Users/yafeng/Documents/ChatGPT/hackathon/aholo-lux3d');OUT=ROOT/'assets/t10'
scene=bpy.data.scenes['T10_Pavilion_v1'];bpy.context.window.scene=scene
for ob in scene.objects:
    if ob.type!='MESH':continue
    bm=bmesh.new();bm.from_mesh(ob.data);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(ob.data);bm.free();ob.data.update()
# Physical materials must remain visible on both sides of the single-sheet roof.
for ob in scene.objects:
    if ob.type=='MESH':
        for mat in ob.data.materials:mat.use_backface_culling=False
scene.camera=scene.objects['T10_Entry']
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'pavilion-v1.blend'))
prop=bpy.ops.export_scene.gltf.get_rna_type().properties['export_format']
print('glTF format default:',prop.default)
bpy.ops.export_scene.gltf(filepath=str(OUT/'pavilion-v1.glb'),export_format='GLB',use_active_scene=True,export_yup=True,export_apply=True,export_lights=False,export_cameras=True,export_extras=True)
meshes=[o for o in scene.objects if o.type=='MESH']
# Raycasts from above identify the actual holes and treads in Blender geometry.
dg=bpy.context.evaluated_depsgraph_get()
def down(x,z,from_y):
    hit,loc,n,face,obj,m=scene.ray_cast(dg,(x,-z,from_y),(0,0,-1),distance=from_y+1)
    return {'hit':hit,'y':round(loc.z,4) if hit else None,'object':obj.name if hit else None}
checks={'atriumBelowUpper':down(0,1,4.79),'upperNorthBridge':down(0,-5.7,4.85),'landingBelowUpper':down(0,-12.25,4.79),'upperSideWalk':down(8,0,4.85),'upperSouthWalk':down(0,10,4.85)}
checks['eastTreads']=[down(1.5,-6.7-(i+.5)*.32,4.79) for i in range(15)]
checks['westTreads']=[down(-1.5,-11.5+(i+.5)*.32,5.1) for i in range(15)]
# GLB JSON inspect confirms exporter coordinate mapping and output composition.
raw=(OUT/'pavilion-v1.glb').read_bytes();n=int.from_bytes(raw[12:16],'little');gltf=json.loads(raw[20:20+n])
audit={'scene':scene.name,'objects':len(scene.objects),'meshObjects':len(meshes),'triangles':sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in meshes),'exportBytes':len(raw),'glbMagic':raw[:4].decode(),'gltfMeshCount':len(gltf.get('meshes',[])),'gltfMaterials':len(gltf.get('materials',[])),'groundSlotIds':sorted(set(o.get('slot_id') for o in meshes if o.get('slot_id') and int(o['slot_id'][1:])<=18)),'upperSlotIds':sorted(set(o.get('slot_id') for o in meshes if o.get('slot_id') and int(o['slot_id'][1:])>18)),'raycasts':checks,'sourceSHA256':{name:hashlib.sha256((ROOT/'scripts/blender'/name).read_bytes()).hexdigest() for name in ['build_t10.py','finalize_t10.py']},'scope':'Static asset geometry audit, not navigation collision or game implementation'}
(OUT/'geometry-audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in audit.items() if k not in ['raycasts','groundSlotIds','upperSlotIds','sourceSHA256']},ensure_ascii=False))
print('Raycast overview:',json.dumps({k:v for k,v in checks.items() if not k.endswith('Treads')},ensure_ascii=False))
